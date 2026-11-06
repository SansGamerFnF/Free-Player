// ============================================================
// Free Player — puente con el APK (Capacitor)
//
// En el navegador normal NO existe window.Capacitor, así que todo
// queda inerte y el botón de escaneo usa el selector de carpetas.
// Dentro del APK sí está el plugin AudioScanner (MediaStore), que
// devuelve todas las canciones del dispositivo: memoria interna,
// externa y tarjeta SD.
// ============================================================

const cap = (typeof window !== 'undefined' && window.Capacitor) || null;
const plugin = cap && cap.Plugins ? cap.Plugins.AudioScanner : null;

const CHUNK = 1024 * 1024;   // 1 MB por llamada al puente: menos idas y
                             // vueltas = la canción empieza a sonar antes

/** ¿Estamos dentro de la app instalada en el teléfono? */
export function isNative() {
  return !!(plugin && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

/**
 * Escanea MediaStore y devuelve todas las canciones del dispositivo:
 * [{ id, uri, title, artist, album, duration (ms), size, path, ext, folder, albumId, modifiedAt (ms) }]
 */
export async function scanDevice() {
  if (!plugin) throw new Error('Escaneo nativo no disponible');
  const res = await plugin.scan();
  return (res && res.tracks) || [];
}

/** Plugin resuelto en cada llamada: Capacitor puede inyectarlo tarde. */
function audioPlugin() {
  const c = (typeof window !== 'undefined' && window.Capacitor) || null;
  if (!c || !c.Plugins) return null;
  return c.Plugins.AudioScanner || null;
}

/**
 * Canciones de MediaStore que NO están entre los ids conocidos.
 * Devuelve solo las nuevas (con su fecha real) para no enviar las ~6000
 * pistas completas por el puente cada vez que se comprueba la biblioteca.
 * Devuelve null si el APK no soporta la detección automática.
 */
export async function nativeMissingTracks(ids) {
  const p = audioPlugin();
  if (!p || typeof p.missing !== 'function') return null;
  try {
    const res = await p.missing({ ids: (ids || []).map(String) });
    return (res && res.tracks) || [];
  } catch (e) {
    // Sin permiso (o APK antiguo): se reintenta en la próxima comprobación.
    return null;
  }
}

/**
 * Avisa cuando cambia la biblioteca del teléfono (canción copiada,
 * descargada o borrada). El APK escucha MediaStore y espera ~1,2 s para
 * agrupar ráfagas. Devuelve la función para dejar de escuchar.
 */
export function startLibraryWatch(cb) {
  const p = audioPlugin();
  if (!p || typeof p.addListener !== 'function') return () => {};
  let handle = null;
  let cancelled = false;
  const attach = (h) => {
    if (!h || typeof h.remove !== 'function') return;
    if (cancelled) {
      try { h.remove(); } catch { /* ya quitado */ }
    } else {
      handle = h;
    }
  };
  try {
    const ret = p.addListener('libraryChanged', () => cb());
    // Según la versión de Capacitor devuelve una promesa o el handle directo.
    if (ret && typeof ret.then === 'function') ret.then(attach).catch(() => {});
    else attach(ret);
  } catch {
    // sin eventos: queda la comprobación al volver a primer plano
  }
  return () => {
    cancelled = true;
    if (handle) {
      try { handle.remove(); } catch { /* ya quitado */ }
    }
  };
}

/**
 * Carátulas INCORPORADAS en los propios archivos (una por CANCIÓN), en
 * tandas de ~24. Es lo que evita que todas las canciones de un mismo
 * álbum (p. ej. mil nightcore de una carpeta) muestren la MISMA miniatura.
 *
 *  entrada: [{ uri, key }], maxPx (lado mayor de la imagen devuelta)
 *  salida:  Map key → Blob
 * Si el APK no tiene este método devuelve null (se usa la carátula del álbum).
 */
export async function nativeArtworksByFile(entries, maxPx = 1024) {
  if (!plugin || typeof plugin.getArtworksByFile !== 'function') return null;
  if (!entries || !entries.length) return new Map();
  let res = null;
  try {
    res = await plugin.getArtworksByFile({
      files: entries.map((e) => ({ uri: e.uri })),
      maxPx,
    });
  } catch (e) {
    if (e && (e.code === 'E_PERM' || /permiso/i.test(String(e.message || '')))) {
      throw e;   // sin permiso: se repite en el próximo arranque
    }
    return new Map();
  }
  const out = new Map();
  const items = (res && res.items) || [];
  for (const it of items) {
    try {
      if (!it || !it.data || !it.uri) continue;
      const entry = entries.find((e) => e.uri === it.uri);
      if (!entry) continue;
      out.set(entry.key, new Blob([b64ToBytes(it.data)], { type: it.mime || 'image/jpeg' }));
    } catch {
      // una imagen corrupta no debe tumbar el resto del lote
    }
  }
  return out;
}

/**
 * Deja el audio listo para SONAR en streaming: el APK copia el archivo a
 * su caché una sola vez (con extensión, para que el navegador acierte el
 * tipo y el servidor local pueda servir rangos al buscar). Devuelve la URL.
 *
 * Copiar 5 MB es cosa de décimas de segundo y evita decodificar la canción
 * entera (que ocupaba 100–200 MB de RAM y retrasaba el cambio de pista).
 */
const stagedAudio = new Map();   // nativeUri → URL (máx. 3, igual que el APK)

export async function stageAudioUrl(track) {
  if (!track || !track.nativeUri) return null;
  if (!plugin || typeof plugin.stageAudio !== 'function') return null;
  const hit = stagedAudio.get(track.nativeUri);
  if (hit) {
    stagedAudio.delete(track.nativeUri);
    stagedAudio.set(track.nativeUri, hit);   // reordena: el reciente al final
    return hit;
  }
  const res = await plugin.stageAudio({ uri: track.nativeUri, ext: track.ext || 'mp3' });
  if (!res || !res.path) return null;
  const url = (cap && typeof cap.convertFileSrc === 'function')
    ? cap.convertFileSrc(res.path) : null;
  if (!url) return null;
  stagedAudio.set(track.nativeUri, url);
  while (stagedAudio.size > 4) stagedAudio.delete(stagedAudio.keys().next().value);
  return url;
}

/**
 * Índice ligero de MediaStore: id → carpeta, álbum y fecha de modificación.
 * Sirve para completar canciones importadas con versiones antiguas (una sola
 * consulta rápida).
 */
export async function nativeIndex() {
  if (!plugin || typeof plugin.index !== 'function') return [];
  try {
    const res = await plugin.index();
    return (res && res.rows) || [];
  } catch {
    return [];
  }
}

/**
 * Pide al APK la altura de la barra de estado y pinta su fondo con el
 * color del tema. Devuelve la altura en px (0 si no hay nativo).
 */
export async function applyStatusBar(color, light) {
  if (!plugin || typeof plugin.setStatusBar !== 'function') return 0;
  try {
    const res = await plugin.setStatusBar({
      color: String(color || '#0f0f10'),
      light: !!light,
    });
    return (res && res.height) || 0;
  } catch {
    return 0;
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function nativeChunk(uri, offset, length = CHUNK) {
  const res = await plugin.readChunk({ uri, offset, length });
  return res && res.data ? b64ToBytes(res.data) : new Uint8Array(0);
}
/**
 * Lee el archivo COMPLETO desde el teléfono (para reproducir).
 * Los trozos se piden EN PARALELO: antes se leían de 256 KB en 256 KB
 * esperando a cada uno, y con un MP3 de 5 MB eso eran 20 idas y vueltas
 * al puente (¡5 segundos de espera antes de sonar!).
 * onProgress(0..1) mientras se va cargando.
 */
export async function readNativeFile(track, onProgress) {
  const uri = track.nativeUri;
  const total = track.size || 0;
  const PARALLEL = 8;          // lecturas simultáneas al puente

  if (!total) {
    // Sin tamaño conocido: no se puede repartir, se lee seguido.
    const parts = [];
    let off = 0;
    for (;;) {
      const bytes = await nativeChunk(uri, off);
      if (!bytes.length) break;
      parts.push(bytes);
      off += bytes.length;
      if (onProgress) onProgress(1);
      if (bytes.length < CHUNK) break;
    }
    if (!parts.length) throw new Error('No se pudo leer el archivo del dispositivo');
    return new Blob(parts, { type: mimeFor(track.ext) });
  }

  const count = Math.ceil(total / CHUNK);
  const parts = new Array(count);
  let done = 0;
  let next = 0;
  let broken = false;

  async function worker() {
    while (next < count) {
      const i = next++;
      const offset = i * CHUNK;
      const want = Math.min(CHUNK, total - offset);
      let bytes = new Uint8Array(0);
      try {
        bytes = await nativeChunk(uri, offset, want);
      } catch {
        broken = true;
        return;
      }
      if (bytes.length < want) broken = true;   // llega menos de lo pedido
      parts[i] = bytes;
      done++;
      if (onProgress) onProgress(Math.min(1, done / count));
      if (bytes.length === 0) { broken = true; return; }
    }
  }

  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  if (broken) {
    // Se usa lo que se pudo leer (a veces un trozo puntual falla y el
    // resto del archivo está bien): solo se aborta si falta mucho.
    const have = parts.reduce((n, p) => n + (p ? p.length : 0), 0);
    if (have < total * 0.5) throw new Error('No se pudo leer el archivo del dispositivo');
  }
  const filled = parts.filter(Boolean);
  if (!filled.length) throw new Error('No se pudo leer el archivo del dispositivo');
  return new Blob(filled, { type: mimeFor(track.ext) });
}

function mimeFor(ext = '') {
  const e = String(ext).toLowerCase();
  if (e === 'mp3') return 'audio/mpeg';
  if (e === 'm4a' || e === 'mp4' || e === 'alac') return 'audio/mp4';
  if (e === 'flac') return 'audio/flac';
  if (e === 'wav') return 'audio/wav';
  if (e === 'ogg' || e === 'opus') return 'audio/ogg';
  if (e === 'aac') return 'audio/aac';
  if (e === 'webm') return 'audio/webm';
  if (e === '3gp') return 'audio/3gpp';
  if (e === 'amr') return 'audio/amr';
  return 'application/octet-stream';
}

// ------------------------------------------------------------
// Volumen multimedia REAL del teléfono (plugin SystemVolume)
// ------------------------------------------------------------
// Se resuelve en cada llamada: al cargar este módulo, Capacitor todavía
// puede no haber inyectado los plugins nativos.
function sysVolPlugin() {
  const c = (typeof window !== 'undefined' && window.Capacitor) || null;
  if (!c || !c.Plugins) return null;
  return c.Plugins.SystemVolume || null;
}

/** ¿El APK puede leer y cambiar el volumen del sistema? */
export function hasSystemVolume() {
  return !!sysVolPlugin();
}

/** Volumen actual: { percent, max } o null si no hay APK. */
export async function getSystemVolume() {
  const p = sysVolPlugin();
  if (!p) return null;
  try {
    const r = await p.get();
    return r && typeof r.percent === 'number' ? r : null;
  } catch {
    return null;
  }
}

/** Cambia el volumen multimedia (0-100) y devuelve el valor real aplicado. */
export async function setSystemVolume(percent) {
  const p = sysVolPlugin();
  if (!p) return null;
  try {
    const v = Math.max(0, Math.min(100, Math.round(percent)));
    const r = await p.set({ percent: v });
    return r && typeof r.percent === 'number' ? r : null;
  } catch {
    return null;
  }
}

/** Avisa cuando cambia el volumen (botones físicos). Devuelve el cleanup. */
export function watchSystemVolume(cb) {
  const p = sysVolPlugin();
  if (!p || typeof p.addListener !== 'function') return () => {};
  let handle = null;
  let cancelled = false;
  const attach = (h) => {
    if (!h || typeof h.remove !== 'function') return;
    if (cancelled) {
      try { h.remove(); } catch { /* ya quitado */ }
    } else {
      handle = h;
    }
  };
  try {
    const ret = p.addListener('change', (d) => {
      if (d && typeof d.percent === 'number') cb(d.percent);
    });
    // Según la versión de Capacitor devuelve una promesa o el handle directo.
    if (ret && typeof ret.then === 'function') ret.then(attach).catch(() => {});
    else attach(ret);
  } catch {
    // sin eventos: el resto de la app sigue funcionando
  }
  return () => {
    cancelled = true;
    if (handle) {
      try { handle.remove(); } catch { /* ya quitado */ }
    }
  };
}
