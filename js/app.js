// ============================================================
// Free Player — aplicación principal
// ============================================================

import { AudioEngine } from './audio-engine.js';
import * as db from './db.js';
import { parseTags } from './id3.js';
import { isAudioFile, acceptAttribute, extOf, friendlyList } from './formats.js';
import { onDecodeProgress } from './decoder.js';
import { extractArtwork } from './artwork.js';
import {
  isNative, scanDevice, readNativeFile,
  nativeArtworksByFile, nativeIndex, applyStatusBar, stageAudioUrl,
  hasSystemVolume, getSystemVolume, setSystemVolume, watchSystemVolume,
  nativeMissingTracks, startLibraryWatch,
} from './native.js';
import {
  mediaAvailable, mediaUpdate, mediaHide, mediaRequestPermission, onMediaAction,
} from './media-bridge.js';
import { CHANGELOG } from './changelog.js';
import {
  uid, formatTime, hashColor, escapeHtml, toast, artworkDataUrl, clamp, debounce,
} from './utils.js';

const engine = new AudioEngine();

// Oculta canciones de 30 s o menos (tonos, avisos de WhatsApp, notas de
// voz…): siguen guardadas, pero no aparecen en biblioteca, búsqueda ni
// carpetas. Se aplica en todas las listas que salen de filteredTracks().
const MIN_DURATION = 30;
const isShort = (t) => !!t && t.duration > 0 && t.duration <= MIN_DURATION;

const state = {
  tracks: [],          // {id,title,artist,album,duration,size,addedAt,modifiedAt,ext}
  playlists: [],       // {id,name,trackIds:[],addedAt}
  queue: [],           // ids en orden de reproducción
  queueIndex: -1,
  currentId: null,
  playing: false,
  shuffle: false,
  repeat: 'off',       // off | all | one
  sort: 'title',
  sortDir: 'asc',      // asc | desc
  query: '',
  tab: 'library',
  openPlaylist: null,  // id de playlist abierta en edición
  ctxTrackId: null,
  ctxFrom: null,       // 'library' | 'playlist' | 'queue'
  sleepTimer: null,
  sleepAtEnd: false,
  crossfadePending: false,
  view: 'tracks',      // 'tracks' | 'folders'  (biblioteca)
  folder: null,        // carpeta abierta en la biblioteca
  version: 0,          // se suma al cambiar la biblioteca (para cachear orden)
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const bufferCache = new Map(); // id -> AudioBuffer (LRU pequeño)

// ---------- carátulas ----------
// Solo en MEMORIA (nunca en disco): se leen del propio archivo de cada
// canción. Se mantiene una VENTANA de ~30-40 miniaturas alrededor de lo que
// estás viendo, como un reproductor normal: al deslizar, las que salen de
// pantalla se liberan y se leen las nuevas. Así la memoria no crece con
// 5000 canciones y todo va fluido.
const artCache = new Map();     // artKey -> objectURL pintable (LRU)
const artBlobs = new Map();     // artKey -> Blob (reproductor/notificación)
const artLo = new Set();        // claves cargadas solo como miniatura
const artMiss = new Set();      // canciones comprobadas sin carátula
const artWant = [];             // ids pendientes de leer
const artTouched = new Map();   // artKey -> cuándo se vio por última vez
const artPinned = new Set();    // no liberar (canción que está sonando)
let artSweepTimer = null;
let artWantTimer = null;
let artLoading = false;
let artObserver = null;

/** Miniaturas vivas a la vez (~30 visibles + margen de precarga). */
const ART_WINDOW = 44;
/** Margen de precarga: filas que se leen antes de entrar en pantalla. */
const ART_MARGIN = '700px 0px';
/** Tiempo que se conserva una miniatura tras salir de pantalla. */
const ART_GRACE = 5000;

function artKeyOf(t) {
  // Clave propia de la canción (carátula incrustada en su archivo) tiene
  // prioridad: así cada canción puede mostrar SU miniatura.
  if (t.artKey) return t.artKey;
  if (t.albumId != null && t.albumId >= 0) return 'alb' + t.albumId;
  // Sin id de MediaStore: se agrupa por artista+álbum para compartir la
  // misma carátula entre canciones de un disco (y leer solo un archivo).
  const al = (t.album || '').trim().toLowerCase();
  if (al) return 'nm' + String(t.artist || '').trim().toLowerCase() + '|' + al;
  return t.id;
}

function folderOf(t) {
  return t.folder || '';
}

/**
 * Pinta las miniaturas que ya están en memoria y pone a observar las que
 * faltan: al acercarse a pantalla se leen del archivo de esa canción.
 */
function refreshArt(root = document) {
  const imgs = [...root.querySelectorAll('img[data-art-id]')];
  for (const img of imgs) {
    const key = img.dataset.artId;
    if (!key) { img.removeAttribute('src'); continue; }
    const url = artCache.get(key);
    if (url) {
      if (img.getAttribute('src') !== url) img.src = url;
      img.hidden = false;
    } else {
      // Sin src se ve el degradado/letra de detrás, pero el <img> sigue
      // ocupando su caja: si se ocultara con display:none, el observador
      // nunca lo vería y la carátula no llegaría a pedirse.
      img.removeAttribute('src');
      img.hidden = false;
    }
  }
  observeArt(root);
}

/** Observa las miniaturas: al entrar se leen, al salir se liberan solas. */
function observeArt(root) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  const imgs = [...scope.querySelectorAll('img[data-track]')];
  if (!imgs.length) return;

  if (typeof IntersectionObserver !== 'function') {
    for (const el of imgs) wantArt(el.dataset.track);
    return;
  }
  if (!artObserver) {
    artObserver = new IntersectionObserver((entries) => {
      for (const en of entries) markArtVisible(en.target, en.isIntersecting);
    }, { rootMargin: ART_MARGIN });
  }
  for (const el of imgs) artObserver.observe(el);
}

/** Al entrar en pantalla se lee; al salir se programa su liberación. */
function markArtVisible(el, visible) {
  const key = el.dataset.artId || ('own' + el.dataset.track);
  if (visible) {
    artTouched.set(key, Date.now());
    wantArt(el.dataset.track);
  } else {
    scheduleArtSweep();
  }
}

/** Programa la limpieza de las miniaturas que ya no se ven. */
function scheduleArtSweep() {
  if (artSweepTimer) return;
  artSweepTimer = setTimeout(sweepArt, ART_GRACE);
}

/** Claves de las miniaturas que están ahora mismo cerca de la pantalla. */
function visibleArtKeys() {
  const keys = new Set();
  const h = window.innerHeight || 800;
  document.querySelectorAll('img[data-art-id]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width && r.bottom > -700 && r.top < h + 700) keys.add(el.dataset.artId);
  });
  return keys;
}

/** Libera las miniaturas que salieron de pantalla (solo memoria). */
function sweepArt() {
  artSweepTimer = null;
  const now = Date.now();
  const visible = visibleArtKeys();
  for (const key of [...artCache.keys()]) {
    if (visible.has(key) || artPinned.has(key)) {
      artTouched.set(key, now);
      continue;
    }
    if (now - (artTouched.get(key) || 0) < ART_GRACE) continue;
    releaseArt(key);
  }
  // Tope de seguridad para un scroll muy rápido.
  if (artCache.size > ART_WINDOW + 20) {
    for (const key of [...artCache.keys()]) {
      if (artCache.size <= ART_WINDOW) break;
      if (visible.has(key) || artPinned.has(key)) continue;
      releaseArt(key);
    }
  }
  if (artCache.size > ART_WINDOW) scheduleArtSweep();
}

function releaseArt(key) {
  const url = artCache.get(key);
  artCache.delete(key);
  artBlobs.delete(key);
  artTouched.delete(key);
  if (url) URL.revokeObjectURL(url);
  document.querySelectorAll('img[data-track]').forEach((el) => {
    // Se compara también la URL: al cambiar la clave de una fila (álbum →
    // canción) podía quedarse apuntando a una URL ya revocada.
    if (el.dataset.artId === key || (url && el.getAttribute('src') === url)) {
      el.removeAttribute('src');
      // No se oculta: la caja debe seguir midiendo para que, al volver a
      // la fila, el observador la detecte y se relea la carátula.
      el.hidden = false;
    }
  });
}

/**
 * Canciones cuyas miniaturas están a menos de `dist` px de la pantalla.
 * Sirve para descartar la cola que dejó un deslizamiento rápido: filas que
 * ya pasaron de largo y solo gastarían disco (y podrían microcortar el audio).
 */
function tracksNearViewport(dist = 1000) {
  const h = window.innerHeight || 800;
  const near = new Set();
  document.querySelectorAll('img[data-track]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width && r.bottom > -dist && r.top < h + dist) near.add(el.dataset.track);
  });
  return near;
}

/** Anota una canción para leer su carátula YA (se agrupan las del mismo cuadro). */
function wantArt(trackId) {
  if (!trackId || artMiss.has('own' + trackId)) return;
  const key = 'own' + trackId;
  if (artCache.has(key)) return;                 // ya está en memoria
  if (!artWant.includes(trackId)) artWant.push(trackId);
  if (artWantTimer) return;
  artWantTimer = setTimeout(loadWantedArt, 16);
}

/** Lee las carátulas pendientes en tandas y las pinta al instante. */
async function loadWantedArt() {
  artWantTimer = null;
  if (artLoading) {
    if (artWant.length) artWantTimer = setTimeout(loadWantedArt, 40);
    return;
  }
  if (!artWant.length) return;
  let ids = artWant.splice(0, 16);
  // Al deslizar rápido la cola crece con filas que ya pasaron. En ese caso se
  // rehace la cola con lo que está cerca de la pantalla AHORA: las visibles se
  // leen en la primera tanda y el resto se descarta (antes esperaban detrás de
  // cientos de canciones y el audio competía con lecturas inútiles).
  if (artWant.length > 20) {
    const near = tracksNearViewport(1000);
    const priority = [];
    document.querySelectorAll('img[data-track]').forEach((el) => {
      const id = el.dataset.track;
      if (!near.has(id) || priority.includes(id)) return;
      if (artCache.has('own' + id) || artMiss.has('own' + id)) return;
      priority.push(id);
    });
    ids = priority.slice(0, 16);
    artWant.length = 0;
    for (const id of priority.slice(16)) artWant.push(id);
  }
  if (!ids.length) return;
  artLoading = true;
  try {
    const tracks = ids.map((id) => trackById(id)).filter(Boolean);
    const natives = tracks.filter((t) => t.nativeUri);

    if (natives.length && isNative()) {
      // maxPx 384: la miniatura llega ligera y ya reducida, sin decodificar
      // una portada de 1500 px por cada fila (eso era lo que la hacía lenta).
      const map = await nativeArtworksByFile(
        natives.map((t) => ({ uri: t.nativeUri, key: t.id })), 384
      ).catch(() => null);
      for (const t of natives) {
        const blob = map && map.get(t.id);
        if (blob) {
          const key = 'own' + t.id;
          artBlobs.set(key, blob);
          artLo.add(key);           // versión ligera (miniatura)
          artTouched.set(key, Date.now());
          t.artKey = key;
          t.hasArt = true;
          retagArt(t.id, key);
          setArt(key, blob);        // pinta las filas de esta canción YA
        } else {
          artMiss.add('own' + t.id);
          t.hasArt = false;
          hideArt(t.id);
        }
      }
    }

    // Canciones importadas: su carátula (extraída al importar) sí vive en
    // la base de datos local, porque el archivo no está en el teléfono.
    for (const t of tracks.filter((x) => !x.nativeUri)) {
      if (artCache.has(artKeyOf(t))) continue;
      const rec = await db.getArtwork(artKeyOf(t)).catch(() => null);
      if (rec && rec.blob) setArt(artKeyOf(t), rec.blob);
      else hideArt(t.id);
    }
  } catch {
    // sin permiso o archivo ilegible: se reintenta al volver a verlo
  } finally {
    artLoading = false;
    if (artWant.length) artWantTimer = setTimeout(loadWantedArt, 60);
  }
}

/** Oculta la miniatura de una canción (queda la letra del color). */
function hideArt(trackId) {
  document.querySelectorAll('img[data-track="' + trackId + '"]').forEach((el) => {
    el.hidden = true;
  });
}

/**
 * Crea (o reutiliza) la URL en memoria de una carátula. No toca el DOM:
 * cada llamante pinta solo lo que necesita.
 */
function cacheArtUrl(key, blob) {
  const prev = artCache.get(key);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  artCache.delete(key);
  artCache.set(key, url);
  artBlobs.set(key, blob);
  artTouched.set(key, Date.now());
  // Si se pasa de la ventana, la limpieza periódica libera lo que ya no
  // se ve (no se mide aquí para no forzar cálculos de posición en cada
  // imagen que llega).
  if (artCache.size > ART_WINDOW + 24) scheduleArtSweep();
  return url;
}

/** Guarda la carátula en memoria y la pinta en todos los <img> de esa clave. */
function setArt(key, blob) {
  const url = cacheArtUrl(key, blob);
  document.querySelectorAll('img[data-art-id]').forEach((el) => {
    if (el.dataset.artId === key) { el.src = url; el.hidden = false; }
  });
  for (const cb of artWaiters) {
    try { cb(key); } catch { /* un aviso no debe romper el resto */ }
  }
}

/**
 * Cambia la clave de carátula de las filas de UNA canción y las repinta ya.
 * Al resolver la carátula propia, las filas seguían apuntando a la clave del
 * álbum: por eso la primera carga "se quedaba en cero" y la carátula solo
 * aparecía al re-renderizar (el usuario lo veía como una doble carga).
 */
function retagArt(trackId, key) {
  const id = String(trackId);
  document.querySelectorAll('img[data-track="' + id + '"]').forEach((el) => {
    el.dataset.artId = key;
  });
}

// Avisos de "la carátula X ya está en caché" (fondo del reproductor, etc.)
const artWaiters = new Set();
function onArtReady(cb) {
  artWaiters.add(cb);
  return () => artWaiters.delete(cb);
}

function artURL(id) {
  return artCache.get(id) || '';
}

/**
 * Reduce una carátula a como mucho 384 px de lado y la guarda en JPEG.
 * Es lo que evita que la biblioteca ocupe cientos de MB: una portada de
 * 2000×2000 (1,5 MB) pasa a ~25 KB sin perder calidad visible en la lista.
 */
async function shrinkImage(blob, maxSide = 384) {
  if (!blob || !blob.size) return null;
  // Muy pequeña ya: no merece decodificarla ni recodificarla (es lo que
  // frenaba la primera carga de carátulas en gama baja).
  if (blob.size < 90 * 1024) return blob;
  try {
    let src;
    if (typeof createImageBitmap === 'function') {
      src = await createImageBitmap(blob);
    } else {
      src = await new Promise((res, rej) => {
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); res(im); };
        im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('imagen')); };
        im.src = url;
      });
    }
    const w = src.width;
    const h = src.height;
    if (!w || !h) return blob;
    if (Math.max(w, h) <= maxSide && blob.type === 'image/jpeg') return blob;

    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#141418';          // fondo por si la imagen es transparente
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    if (typeof src.close === 'function') src.close();
    const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    return out || blob;
  } catch {
    return blob; // si no se puede recortar, guardamos la original
  }
}

// ============================================================
// ARRANQUE
// ============================================================
async function boot() {
  await Promise.all([
    (state.tracks = await db.allTracks()),
    (state.playlists = await db.allPlaylists()),
  ]);
  reindexTracks();

  state.sort = (await db.getSetting('sort', 'title'));
  // Compatibilidad: la opción antigua "added" ahora es "modified" (fecha
  // real de modificación del archivo, no la de haberlo añadido).
  if (state.sort === 'added') state.sort = 'modified';
  state.sortDir = (await db.getSetting('sortDir', 'asc')) === 'desc' ? 'desc' : 'asc';
  state.shuffle = (await db.getSetting('shuffle', false)) === true || state.shuffle;
  state.repeat = await db.getSetting('repeat', 'off');
  engine.speed = await db.getSetting('speed', 1);
  engine.pitch = await db.getSetting('pitch', 0);
  engine.eq = await db.getSetting('eq', 'flat');
  engine.crossfadeSec = await db.getSetting('crossfade', 0);
  engine.boost = await db.getSetting('boost', 1);
  engine.volume = await db.getSetting('volume', 1);
  state.view = (await db.getSetting('libView', 'tracks')) === 'folders' ? 'folders' : 'tracks';
  const savedTheme = await db.getSetting('theme', 'auto');
  applyTheme(savedTheme);
  applyAccent(await db.getSetting('accent', 'indigo'), false);
  // el tema automático puede cambiar al cambiar el sistema
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener?.('change', () => { if (themeIsDark()) syncStatusBar(); });

  $('#sort-select').value = state.sort;
  $('#speed').value = engine.speed;
  $('#pitch').value = engine.pitch;
  $('#eq-preset').value = engine.eq;
  $('#crossfade').value = engine.crossfadeSec;
  $('#boost').value = String(Math.round(engine.boost * 100));
  const vol = $('#vol');
  if (vol) vol.value = String(Math.round(engine.volume * 100));
  initSystemVolume().catch(() => {});
  syncAdvancedLabels();
  $('#btn-shuffle').classList.toggle('on', state.shuffle);
  updateRepeatUI();
  renderFormatHints();

  renderAll();
  wireEvents();
  setInterval(tick, 250);   // 4 veces por segundo: cero coste entre medias
  hideSplash();

  // La barra de estado del teléfono: sin este ajuste el reloj y la batería
  // se quedan encima del título de la app.
  syncStatusBar();

  // Cuando llega la carátula de la canción sonando, se actualiza el
  // reproductor, el fondo difuminado y la notificación/widget.
  onArtReady((key) => {
    const t = trackById(state.currentId);
    if (!t) return;
    if (artKeyOf(t) !== key && ('own' + t.id) !== key) return;
    paintArt($('#player-art'), $('#art-img'), $('#art-letter'), t);
    paintArt($('#mini-art'), $('#mini-img'), $('#mini-letter'), t);
    paintBackdrop(t);
    artPushVersion++;        // la notificación/widget reciben la nueva
    pushMediaState(true);
  });

  // Controles de la notificación (bandeja / lockscreen / widget)
  wireMediaActions();

  // Algunos navegadores mantienen el AudioContext suspendido hasta el
  // primer gesto real del usuario: lo reanudamos en cuanto ocurre.
  const kickAudio = () => { Promise.resolve(engine.resume()).catch(() => {}); };
  document.addEventListener('pointerdown', kickAudio, true);
  document.addEventListener('keydown', kickAudio, true);

  // Tareas pesadas en segundo plano: no retrasan el arranque ni bloquean
  // la interfaz (antes corrían en serie y con una escritura por canción).
  enrichNativeTracks().catch((e) => console.warn('enriquecimiento', e));
  backfillArtwork().catch((e) => console.warn('carátulas', e));
  purgeNativeArtwork().catch(() => {});

  // Canciones nuevas: MediaStore avisa y se añaden solas, en su sitio por
  // fecha, sin volver a pulsar "Escanear el teléfono".
  startAutoLibrarySync();
}

/**
 * Libera el espacio que ocupaban las carátulas de versiones anteriores
 * (se guardaban cientos de MB). Solo se ejecuta una vez.
 */
async function purgeNativeArtwork() {
  if ((await db.getSetting('artPurge', 0)) >= 2) return;
  await db.clearNativeArtworks();
  await db.setSetting('artPurge', 2);
}

// ============================================================
// BARRA DE ESTADO (reloj/batería del teléfono)
// ============================================================
function themeIsDark() {
  const mode = document.body.dataset.theme || 'auto';
  return mode === 'dark' ||
    (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function syncStatusBar() {
  const dark = themeIsDark();
  const color = dark ? '#0f0f10' : '#fafafa';
  applyStatusBar(color, dark)
    .then((h) => {
      document.documentElement.style.setProperty('--safe-top', `${h || 0}px`);
    })
    .catch(() => {});
}

// ============================================================
// ENRIQUECIMIENTO + CARÁTULAS DEL TELÉFONO
// ============================================================
/**
 * Canciones importadas con versiones antiguas: no guardaban la carpeta ni
 * el álbum de MediaStore. Se recuperan con una sola consulta rápida para
 * poder agrupar por carpetas y reutilizar la carátula de cada álbum.
 */
async function enrichNativeTracks() {
  const missing = state.tracks.filter(
    (t) => t.nativeUri && (t.albumId == null || !t.folder || t.modifiedAt == null)
  );
  if (!missing.length || !isNative()) return;

  let rows = [];
  try { rows = await nativeIndex(); } catch (e) { return; }
  if (!rows || !rows.length) return;

  const byId = new Map(rows.map((r) => [String(r.id), r]));
  let updates = [];
  let changed = 0;
  for (const t of missing) {
    const r = byId.get(String(t.nativeId));
    if (!r) continue;
    if (r.folder && !t.folder) t.folder = r.folder;
    if (r.albumId != null && t.albumId == null) t.albumId = r.albumId;
    // Fecha de modificación real del archivo (para ordenar por ella).
    if (r.modifiedAt != null) t.modifiedAt = r.modifiedAt;
    updates.push(t);
    changed++;
    if (updates.length >= 300) await db.putTracksBulk(updates.splice(0));
  }
  if (updates.length) await db.putTracksBulk(updates);
  if (changed) { state.version++; renderAll(); }
}

/**
 * Carátulas de los archivos importados desde el navegador (una por pista).
 * Se ejecuta en segundo plano y nunca vuelve a tocarlas después.
 */
async function backfillArtwork() {
  const pending = state.tracks.filter((t) => !t.artChecked && !t.nativeUri);
  if (!pending.length) return;

  let found = 0;
  let dirty = [];
  for (const t of pending) {
    try {
      const local = await db.getFile(t.id);
      if (local) {
        let art = await extractArtwork(local);
        if (art) {
          art = await shrinkImage(art);
          await db.putArtwork(t.id, art);
          setArt(t.id, art);
          t.hasArt = true;
          found++;
        }
      }
      t.artChecked = true;
      dirty.push(t);
      if (dirty.length >= 50) {
        await db.putTracksBulk(dirty.splice(0));
        refreshArt(document);
      }
    } catch (e) {
      console.warn('carátula', t.id, e);
      if (!t.nativeUri) { t.artChecked = true; dirty.push(t); }
    }
  }
  if (dirty.length) await db.putTracksBulk(dirty);
  if (found) {
    state.version++;
    renderAll();
    toast(`✓ ${found} ${found === 1 ? 'carátula extraída' : 'carátulas extraídas'}`, 3000);
  }
}

// Informa en la interfaz qué formatos acepta (y cuáles se convierten)
function renderFormatHints() {
  const { native, extended } = friendlyList();
  const nativeLine = 'Soporta directamente: ' + native.join(' · ');
  const extLine = 'Y también: ' + extended.join(' · ') + ' — se convierten automáticamente';
  const a = $('#formats-hint');
  if (a) a.innerHTML = `${nativeLine}<br>${extLine}`;
  const b = $('#dropzone-formats');
  if (b) b.textContent = nativeLine + ' · ' + extended.join(' · ');
  const c = $('#settings-formats');
  if (c) c.innerHTML = `${nativeLine}<br>${extLine}`;
  const d = $('#about-formats');
  if (d) d.innerHTML = `${nativeLine}<br>${extLine}`;
}

/**
 * Quita la pantalla de apertura cuando la app ya arrancó.
 * (En las pruebas automáticas ni se muestra: se oculta en el <head>.)
 */
function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  const remove = () => el.remove();
  if (document.documentElement.classList.contains('no-splash')) return remove();
  setTimeout(remove, 2400);
}

// ============================================================
// PERSISTENCIA DE AJUSTES
// ============================================================
// Un temporizador POR CLAVE: antes había un solo debounce compartido y, si
// se cambiaban dos ajustes seguidos (p. ej. volumen y luego shuffle), el
// primero se perdía al reiniciar la app.
const saveTimers = new Map();
function saveSetting(k, v) {
  clearTimeout(saveTimers.get(k));
  saveTimers.set(k, setTimeout(() => {
    saveTimers.delete(k);
    db.setSetting(k, v).catch(() => {});
  }, 300));
}

// ============================================================
// RENDER
// ============================================================
function renderAll() {
  renderLibrary();
  renderFavorites();
  renderPlaylists();
  renderQueue();
  renderSettings();
  updatePlayerUI();
  refreshArt(document);
}

function filteredTracks(base = state.tracks) {
  const q = state.query.trim().toLowerCase();
  // La biblioteca completa es la lista que más se repinta: se memoriza
  // mientras no cambien ni los datos ni el orden ni la búsqueda.
  const memo = base === state.tracks;
  const key = `${state.version}|${state.sort}|${state.sortDir}|${q}`;
  if (memo && libMemo && libMemo.key === key) return libMemo.list;

  let list = base.slice();
  if (q) {
    list = list.filter((t) =>
      `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
    );
  }
  // canciones de 30 s o menos: fuera (tonos, avisos…)
  list = list.filter((t) => !isShort(t));
  const by = state.sort;
  const dir = state.sortDir === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    // Fecha de modificación real del archivo (no la de añadido a la app).
    if (by === 'modified') return ((a.modifiedAt || 0) - (b.modifiedAt || 0)) * dir;
    return (a[by] || '').localeCompare(b[by] || '', 'es', { sensitivity: 'base' }) * dir;
  });
  if (memo) libMemo = { key, list };
  return list;
}
let libMemo = null;

/** Pinta la flecha del orden: ascendente (↑) o descendente (↓). */
function paintSortDir() {
  const b = document.getElementById('sort-dir');
  if (!b) return;
  const up = state.sortDir !== 'desc';
  b.textContent = up ? '↑' : '↓';
  b.setAttribute('aria-label', up ? 'Orden ascendente' : 'Orden descendente');
  b.title = up
    ? 'Ascendente (A→Z / antiguas primero)'
    : 'Descendente (Z→A / recientes primero)';
}

/** Lista que se está viendo ahora mismo en la biblioteca (para reproducir). */
function currentLibraryIds() {
  const base = state.folder
    ? state.tracks.filter((t) => folderOf(t) === state.folder)
    : state.tracks;
  // En la vista de carpetas (sin carpeta abierta) se reproduce todo:
  // así el botón grande nunca se queda sin nada que hacer.
  return filteredTracks(base).map((t) => t.id);
}

function trackById(id) {
  return trackIndex.get(id) || null;
}

/** Índice por id: antes era una búsqueda lineal repetida mil veces. */
let trackIndex = new Map();
function reindexTracks() {
  trackIndex = new Map(state.tracks.map((t) => [t.id, t]));
  state.version++;
  libMemo = null;
}

function trackRowHTML(t, opts = {}) {
  const isCurrent = t.id === state.currentId;
  const color = hashColor(t.album || t.title);
  const sub = [t.artist, t.album].filter(Boolean).join(' · ') || 'Desconocido';
  const dur = t.duration ? formatTime(t.duration) : '--:--';
  const handle = opts.handle
    ? `<span class="drag-handle" draggable="true">⠿</span>` : '';
  const removeBtn = opts.removable
    ? `<button class="track-more" data-act="remove-from-playlist" aria-label="Quitar">✕</button>`
    : `<button class="track-more" data-act="menu" aria-label="Más">⋯</button>`;
  return `<li class="track ${opts.cls ? opts.cls + ' ' : ''}${isCurrent ? 'playing' : ''} ${isCurrent && !state.playing ? 'paused' : ''}"
      data-id="${t.id}" draggable="true" tabindex="0">
    ${handle}
    <div class="track-art" style="background:linear-gradient(135deg,${color}, ${hashColor(t.title, 60, 42)})">
      <img class="art-thumb" data-art-id="${artKeyOf(t)}" data-track="${t.id}" alt="" loading="lazy" decoding="async" />
      <span>${escapeHtml((t.title || '?').charAt(0).toUpperCase())}</span>
      <span class="eq-bars"><i></i><i></i><i></i></span>
    </div>
    <div class="track-info">
      <div class="track-title">${escapeHtml(t.title)}</div>
      <div class="track-sub">${escapeHtml(sub)}</div>
    </div>
    <span class="track-dur">${dur}</span>
    ${removeBtn}
  </li>`;
}

// ============================================================
// LISTAS POR PÁGINAS
// Pintar 5000 filas de golpe congelaba la app y la hacía crashear:
// ahora se pintan tandas de ~120 y se siguen cargando al hacer scroll.
// ============================================================
const PAGE = 60;

function setPagedList(ul, list, { head = '', row = {} } = {}) {
  if (ul._moreBtn) { ul._moreBtn.remove(); ul._moreBtn = null; }
  ul._rows = list;
  ul._shown = 0;
  ul._rowOpts = row;
  ul.innerHTML = head;
  appendRows(ul, PAGE * 2);
}

function appendRows(ul, n = PAGE) {
  const list = ul._rows || [];
  const from = ul._shown || 0;
  if (from >= list.length) return;
  if (ul._moreBtn) ul._moreBtn.remove();

  const to = Math.min(list.length, from + n);
  let html = '';
  for (let i = from; i < to; i++) {
    const t = list[i];
    if (!t) continue;
    const row = ul._rowOpts || {};
    const opts = row.queue
      ? { ...row, cls: i === state.queueIndex ? 'queue-current' : `qpos-${i}` }
      : row;
    html += trackRowHTML(t, opts);
  }
  ul.insertAdjacentHTML('beforeend', html);
  ul._shown = to;
  refreshArt(ul);
  updateMore(ul);
}

function updateMore(ul) {
  const list = ul._rows || [];
  const more = list.length > (ul._shown || 0);
  if (!more) { ul._moreBtn = null; return; }
  if (!ul._moreBtn) {
    const li = document.createElement('li');
    li.className = 'list-more';
    li.innerHTML = `<button class="btn ghost" style="width:100%">Mostrar más (${list.length - (ul._shown || 0)} restantes)</button>`;
    li.querySelector('button').onclick = () => appendRows(ul, PAGE * 3);
    ul._moreBtn = li;
  }
  ul.appendChild(ul._moreBtn);
}

/** Carga más filas cuando el scroll llega al final de la lista visible. */
function loadMoreVisible() {
  for (const id of ['library-list', 'favorites-list', 'queue-list', 'pl-track-list']) {
    const ul = document.getElementById(id);
    if (!ul || !ul._rows || !ul.closest('.panel.active')) continue;
    if (!ul._moreBtn) continue;
    const c = $('#content');
    if (c && c.scrollTop + c.clientHeight >= c.scrollHeight - 800) appendRows(ul, PAGE * 2);
  }
}

// ============================================================
// CARPETAS (canciones agrupadas por ubicación)
// ============================================================
function folderTitle(f) {
  if (!f) return 'Sin carpeta';
  const i = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\'));
  return i >= 0 && i < f.length - 1 ? f.slice(i + 1) : f;
}

function folderRowHTML(folder, n, sample) {
  const color = hashColor(folder || 'sin-carpeta');
  const art = sample
    ? `<img class="art-thumb" data-art-id="${artKeyOf(sample)}" data-track="${sample.id}" alt="" loading="lazy" decoding="async" />` : '';
  return `<li class="playlist folder" data-folder="${escapeHtml(folder)}">
    <div class="playlist-art" style="background:linear-gradient(135deg,${color}, ${hashColor(folderTitle(folder), 60, 40)})">
      ${art}
      <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
    </div>
    <div class="playlist-info">
      <div class="playlist-name">${escapeHtml(folderTitle(folder))}</div>
      <div class="playlist-meta">${n} ${n === 1 ? 'canción' : 'canciones'}${folder ? ' · ' + escapeHtml(folder) : ''}</div>
    </div>
    <span class="track-dur">›</span>
  </li>`;
}

function renderFolderList() {
  const ul = $('#library-list');
  const counts = new Map();
  for (const t of state.tracks) {
    if (isShort(t)) continue;      // mismas reglas que la lista de canciones
    const f = folderOf(t);
    let e = counts.get(f);
    if (!e) { e = { n: 0, sample: null }; counts.set(f, e); }
    e.n++;
    if (!e.sample || (!e.sample.hasArt && t.hasArt)) e.sample = t;
  }

  let rows = [...counts.entries()].map(([f, e]) => ({ folder: f, n: e.n, sample: e.sample }));
  const q = state.query.trim().toLowerCase();
  if (q) rows = rows.filter((x) =>
    folderTitle(x.folder).toLowerCase().includes(q) || String(x.folder).toLowerCase().includes(q));
  rows.sort((a, b) => folderTitle(a.folder)
    .localeCompare(folderTitle(b.folder), 'es', { sensitivity: 'base' }));

  $('#lib-count').textContent =
    `${rows.length} ${rows.length === 1 ? 'carpeta' : 'carpetas'}`;
  $('#library-empty').hidden = state.tracks.length > 0;
  ul.hidden = state.tracks.length === 0;
  ul._rows = [];
  ul._shown = 0;
  ul._moreBtn = null;
  ul.innerHTML = rows.length
    ? rows.map((x) => folderRowHTML(x.folder, x.n, x.sample)).join('')
    : `<li class="empty" style="padding:32px 0"><p>${state.query
        ? `Sin carpetas para “${escapeHtml(state.query)}”`
        : 'No encontré la carpeta de ninguna canción'}</p></li>`;
  refreshArt(ul);
}

function renderLibrary() {
  const ul = $('#library-list');
  const btn = $('#btn-view-folders');
  if (btn) {
    const folders = state.view === 'folders';
    btn.setAttribute('aria-pressed', String(folders));
    btn.textContent = folders ? '🎵 Canciones' : '📁 Carpetas';
  }

  if (state.view === 'folders' && !state.folder) return renderFolderList();

  const base = state.folder
    ? state.tracks.filter((t) => folderOf(t) === state.folder)
    : state.tracks;
  const list = filteredTracks(base);

  const head = state.folder ? `
    <div class="lib-back">
      <button class="back-btn" id="btn-folder-back" aria-label="Volver a todas las canciones">
        <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span class="folder-name">${escapeHtml(folderTitle(state.folder))}
        <span class="folder-sub">${escapeHtml(state.folder || 'Sin carpeta')}</span>
      </span>
    </div>` : '';

  const n = list.length;
  $('#lib-count').textContent = state.folder
    ? `${n} ${n === 1 ? 'canción' : 'canciones'} en esta carpeta`
    : `${n} ${n === 1 ? 'canción' : 'canciones'}`;
  $('#library-empty').hidden = state.tracks.length > 0;
  ul.hidden = state.tracks.length === 0;

  if (state.query && n === 0 && state.tracks.length > 0) {
    if (ul._moreBtn) { ul._moreBtn.remove(); ul._moreBtn = null; }
    ul._rows = [];
    ul._shown = 0;
    ul.innerHTML = head +
      `<li class="empty" style="padding:32px 0"><p>Sin resultados para “${escapeHtml(state.query)}”</p></li>`;
    return;
  }

  setPagedList(ul, list, { head });
  const back = $('#btn-folder-back');
  if (back) back.onclick = () => {
    state.folder = null;
    renderLibrary();
    const c = $('#content');
    if (c) c.scrollTop = 0;
  };
}

// Favoritos: mismo render que la biblioteca, pero solo las marcadas con ❤
function renderFavorites() {
  const favs = state.tracks.filter((t) => t.fav);
  const list = filteredTracks(favs);
  const ul = $('#favorites-list');
  if (!ul) return;

  $('#fav-count').textContent = `${list.length} ${list.length === 1 ? 'favorita' : 'favoritas'}`;
  $('#favorites-empty').hidden = favs.length > 0;
  ul.hidden = favs.length === 0;

  if (favs.length && list.length === 0) {
    ul._rows = [];
    ul._shown = 0;
    ul._moreBtn = null;
    ul.innerHTML = `<li class="empty" style="padding:32px 0"><p>Sin resultados para “${escapeHtml(state.query)}”</p></li>`;
  } else {
    setPagedList(ul, list);
  }
  refreshArt(ul);
}

// Ajustes: contadores y estado del selector de tema
function renderSettings() {
  const lib = $('#set-lib-size');
  if (!lib) return;
  lib.textContent = `${state.tracks.length} ${state.tracks.length === 1 ? 'canción' : 'canciones'}`;
  const favs = state.tracks.filter((t) => t.fav).length;
  $('#set-fav-size').textContent = `${favs} ${favs === 1 ? 'favorita' : 'favoritas'}`;
  syncThemeSeg();
}

function syncThemeSeg() {
  const mode = document.body.dataset.theme;
  $$('[data-theme-set]').forEach((b) =>
    b.classList.toggle('active', b.dataset.themeSet === mode)
  );
  updateModeLabel();
}

// ============================================================
// TEMAS DE COLOR
// ============================================================
// "Fénix" es la combinación carmesí + oro; "Boreal", azul de noche
// + hielo; "Aurora", violeta + rosa. Los demás son colores sueltos.
const ACCENTS = [
  { key: 'indigo', name: 'Índigo', c1: '#6c8cff', c2: '#a06cff' },
  { key: 'carmin', name: 'Carmín', c1: '#e5484d', c2: '#ff8a5c' },
  { key: 'zafiro', name: 'Zafiro', c1: '#2f6fed', c2: '#5ec8ff' },
  { key: 'ambar', name: 'Ámbar', c1: '#f0b429', c2: '#ffd166' },
  { key: 'rosa', name: 'Rosa', c1: '#ec4899', c2: '#ff8ad0' },
  { key: 'fenix', name: 'Fénix', c1: '#d21f3c', c2: '#f2b134' },
  { key: 'boreal', name: 'Boreal', c1: '#3d6bb3', c2: '#9fd4ff' },
  { key: 'aurora', name: 'Aurora', c1: '#7c5cf5', c2: '#ff6ec4' },
  { key: 'menta', name: 'Menta', c1: '#12a594', c2: '#7ee7c7' },
];

function renderColorGrid() {
  const grid = $('#color-grid');
  if (!grid) return;
  const cur = document.body.dataset.accent || 'indigo';
  grid.innerHTML = ACCENTS.map((a) => `
    <button class="color-swatch${a.key === cur ? ' active' : ''}" data-accent-key="${a.key}">
      <span class="color-dot" style="background:linear-gradient(135deg, ${a.c1}, ${a.c2})"></span>
      <span>${a.name}</span>
    </button>`).join('');
  $$('#color-grid .color-swatch').forEach((b) => {
    b.onclick = () => {
      applyAccent(b.dataset.accentKey);
      const a = ACCENTS.find((x) => x.key === b.dataset.accentKey);
      if (a) toast('Color: ' + a.name, 2000);
    };
  });
}

/**
 * Aplica un color de acento a toda la interfaz.
 * 'indigo' es el color original (cambia con el tema claro/oscuro).
 */
function applyAccent(key, persist = true) {
  const k = ACCENTS.some((a) => a.key === key) ? key : 'indigo';
  if (k === 'indigo') delete document.body.dataset.accent;
  else document.body.dataset.accent = k;
  if (persist) saveSetting('accent', k);
  $$('.color-swatch').forEach((b) =>
    b.classList.toggle('active', b.dataset.accentKey === k));
}

function updateModeLabel() {
  const el = $('#top-menu [data-top="mode"]');
  if (!el) return;
  const m = document.body.dataset.theme;
  el.textContent = '🌓 Tema: ' + (m === 'light' ? 'claro' : m === 'dark' ? 'oscuro' : 'automático');
}

function toggleTopMenu(force) {
  const menu = $('#top-menu');
  if (!menu) return;
  const open = force !== undefined ? !!force : menu.hidden;
  menu.hidden = !open;
  const back = $('#top-menu-backdrop');
  if (back) back.hidden = !open;
  if (open) updateModeLabel();
}

// ============================================================
// ESCANEO DEL TELÉFONO (APK) / DE UNA CARPETA (NAVEGADOR)
// ============================================================
let scanCancelled = false;

function setScan(text, pct, count) {
  const t = $('#scan-text');
  if (t) t.textContent = text;
  const b = $('#scan-bar');
  if (b) b.style.width = Math.round(Math.max(0, Math.min(1, pct || 0)) * 100) + '%';
  const c = $('#scan-count');
  if (c) c.textContent = count || '';
}

/** Botón de escaneo: en el APK lee MediaStore, en el navegador pide una carpeta. */
function startScan() {
  if (isNative()) return scanDeviceLibrary();
  const dir = $('#dir-input');
  if (!dir) return toast('Escaneo no disponible aquí');
  dir.value = '';
  dir.click();
}

async function scanDeviceLibrary() {
  scanCancelled = false;
  const cancelBtn = $('#btn-scan-cancel');
  if (cancelBtn) cancelBtn.textContent = 'Cancelar';
  openModal('modal-scan');
  setScan('Buscando todas las canciones…', 0, 'Memoria interna, externa y tarjeta SD');

  let list;
  try {
    list = await scanDevice();
  } catch (err) {
    closeModal('modal-scan');
    console.error('escaneo', err);
    const msg = String((err && err.message) || err);
    toast(/permiso|deneg/i.test(msg)
      ? 'Permiso denegado: activa “Música y audio” en los ajustes del teléfono'
      : 'No se pudo escanear: ' + msg, 6000);
    return;
  }

  if (scanCancelled) { closeModal('modal-scan'); return toast('Escaneo cancelado'); }
  if (!list.length) { closeModal('modal-scan'); return toast('No encontré canciones en el teléfono'); }

  setScan('Añadiendo a tu biblioteca…', 0.05, `0 de ${list.length}`);
  const res = await importNativeTracks(list, (i, n) => {
    setScan('Añadiendo a tu biblioteca…', 0.05 + 0.5 * (i / n), `${i} de ${n}`);
  });

  if (res.cancelled || scanCancelled) {
    renderAll();
    closeModal('modal-scan');
    return toast('Escaneo cancelado');
  }

  // Al terminar el escaneo se pintan las listas y las miniaturas visibles se
  // leen al momento (ventana de ~30). El resto se lee al deslizar, y las
  // que salen de pantalla se liberan: sin ocupar el almacenamiento.
  artMiss.clear();
  artTouched.clear();
  renderAll();
  closeModal('modal-scan');

  if (res.added.length) {
    toast(`✓ ${res.added.length} ${res.added.length === 1 ? 'canción añadida' : 'canciones añadidas'}`
      + ` · ${state.tracks.length} en la biblioteca`
      + (res.skipped ? ` (${res.skipped} ya estaban)` : ''), 5000);
  } else {
    toast('Todo ya estaba en tu biblioteca', 4000);
  }
}

/** Carpeta (directorio) de una ruta completa. */
function folderFromPath(path) {
  if (!path) return '';
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : '';
}

/** Evita duplicados: mismo id de MediaStore, o mismo tamaño + duración. */
function makeDedupe() {
  const ids = new Set();
  const sizes = new Map();
  const remember = (nativeId, size, dur) => {
    if (nativeId) ids.add(String(nativeId));
    if (size) {
      if (!sizes.has(size)) sizes.set(size, []);
      sizes.get(size).push(dur || 0);
    }
  };
  for (const t of state.tracks) remember(t.nativeId, t.size, t.duration);
  return {
    has(nativeId, size, dur) {
      if (nativeId && ids.has(String(nativeId))) return true;
      const arr = sizes.get(size);
      return !!arr && arr.some((d) => Math.abs(d - dur) <= 2);
    },
    add: remember,
  };
}

/**
 * Importa el resultado del escaneo. Todo se guarda por LOTES: antes se
 * abría una transacción de IndexedDB por canción y con 5000 canciones la
 * pantalla se quedaba parada (o la app se cerraba).
 */
async function importNativeTracks(list, onStep) {
  const dedupe = makeDedupe();
  const byNativeId = new Map();
  for (const t of state.tracks) if (t.nativeId) byNativeId.set(t.nativeId, t);

  const added = [];
  let skipped = 0;
  let batch = [];
  let lastStep = 0;

  const flush = async () => {
    if (!batch.length) return;
    const arr = batch.splice(0);
    await db.putTracksBulk(arr);
  };

  for (let i = 0; i < list.length; i++) {
    if (scanCancelled) {
      await flush();
      reindexTracks();
      renderAll();
      return { added, skipped, cancelled: true };
    }
    const s = list[i] || {};
    const dur = Math.round((s.duration || 0) / 1000);
    const size = s.size || 0;
    const folder = folderFromPath(s.path);
    const existing = s.id != null ? byNativeId.get(String(s.id)) : null;

    if (dedupe.has(s.id, size, dur)) {
      skipped++;
      // La canción ya estaba, pero sus datos pueden haber cambiado (fecha
      // del archivo, carpeta, álbum o tamaño). Se actualizan para que el
      // orden por fecha sea el mismo que tras reiniciar la app.
      if (existing) {
        let touched = false;
        if (folder && existing.folder !== folder) { existing.folder = folder; touched = true; }
        if (s.albumId != null && existing.albumId !== s.albumId) {
          existing.albumId = s.albumId;
          touched = true;
        }
        const mod = Number(s.modifiedAt) || 0;
        if (mod && existing.modifiedAt !== mod) { existing.modifiedAt = mod; touched = true; }
        if (s.title && existing.title !== String(s.title).trim()) {
          existing.title = String(s.title).trim();
          touched = true;
        }
        if (touched) batch.push(existing);
      }
    } else {
      const track = {
        id: uid(),
        nativeId: s.id != null ? String(s.id) : '',
        nativeUri: s.uri || '',
        title: String(s.title || '').trim() || 'Sin título',
        artist: String(s.artist || '').trim(),
        album: String(s.album || '').trim(),
        albumId: s.albumId != null ? s.albumId : null,
        folder,
        genre: '',
        duration: dur,
        size,
        ext: String(s.ext || extOf(s.path || s.title || '') || 'AUDIO').toUpperCase(),
        hasArt: false,
        artChecked: false,
        addedAt: Date.now(),
        // Fecha real del archivo. Sin esto la canción recién añadida se
        // ordenaba como 0 (principio de la lista) hasta reiniciar, que es
        // cuando enrichNativeTracks() la recuperaba de MediaStore.
        modifiedAt: Number(s.modifiedAt) || 0,
      };
      state.tracks.push(track);
      batch.push(track);
      added.push(track);
      dedupe.add(track.nativeId, size, dur);
      if (track.nativeId) byNativeId.set(track.nativeId, track);
    }

    if (batch.length >= 400) await flush();
    if (onStep && (i % 200 === 0 || i === list.length - 1)) {
      if (Date.now() - lastStep > 90) { lastStep = Date.now(); onStep(i + 1, list.length); }
    }
  }

  await flush();
  reindexTracks();
  if (added.length) renderAll();
  return { added, skipped, cancelled: false };
}

// ============================================================
// DETECCIÓN AUTOMÁTICA DE CANCIONES NUEVAS
// ============================================================
let librarySyncPromise = null;
let lastLibrarySync = 0;

/** Ids de MediaStore que ya están guardados en la biblioteca. */
function knownNativeIds() {
  const ids = [];
  for (const t of state.tracks) if (t.nativeId) ids.push(t.nativeId);
  return ids;
}

/**
 * Comprueba si hay canciones nuevas y las añade en su sitio, sin pulsar
 * "Escanear el teléfono". Solo pide al APK las que faltan: con 6000
 * canciones guardadas la consulta sigue siendo instantánea.
 */
function syncNewTracks(reason) {
  if (!isNative()) return Promise.resolve(0);
  if (librarySyncPromise) return librarySyncPromise;
  // "visibilidad" y "foco" pueden llegar juntos: una sola comprobación.
  if (reason !== 'inicio' && Date.now() - lastLibrarySync < 1200) {
    return Promise.resolve(0);
  }
  lastLibrarySync = Date.now();

  librarySyncPromise = (async () => {
    const rows = await nativeMissingTracks(knownNativeIds());
    if (!rows || !rows.length) return 0;
    const res = await importNativeTracks(rows);
    const added = res && res.added ? res.added.length : 0;
    if (added > 0) {
      artMiss.clear();
      artTouched.clear();
      renderAll();
      toast(`✓ ${added} ${added === 1 ? 'canción nueva' : 'canciones nuevas'}`
        + ` · ${state.tracks.length} en la biblioteca`, 4000);
      backfillArtwork().catch(() => {});
    }
    return added;
  })().catch((e) => {
    console.warn('sincronización', e);
    return 0;
  }).finally(() => { librarySyncPromise = null; });

  return librarySyncPromise;
}

/** Avisos del teléfono + comprobación al volver a la app. */
function startAutoLibrarySync() {
  if (!isNative()) return;

  // 1) MediaStore avisa en cuanto entra una canción nueva (el APK espera
  //    ~1,2 s para agrupar varias copias en un solo aviso).
  startLibraryWatch(() => syncNewTracks('media'));

  // 2) Al volver a primer plano se comprueba otra vez: un aviso recibido
  //    con la app cerrada o en segundo plano puede no haber llegado.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNewTracks('visible');
  });
  window.addEventListener('focus', () => syncNewTracks('focus'));
  const cap = (typeof window !== 'undefined' && window.Capacitor) || null;
  const app = cap && cap.Plugins ? cap.Plugins.App : null;
  if (app && typeof app.addListener === 'function') {
    app.addListener('appStateChange', (st) => {
      if (st && st.isActive) syncNewTracks('activo');
    });
  }

  // 3) Primera comprobación, con la biblioteca ya cargada.
  setTimeout(() => syncNewTracks('inicio'), 2500);
}

function renderPlaylists() {
  const ul = $('#playlist-list');
  const detail = $('#playlist-detail');
  if (detail) { detail.hidden = true; detail.innerHTML = ''; }

  if (state.openPlaylist) {
    renderPlaylistDetail();
    return;
  }
  if (ul._moreBtn) { ul._moreBtn.remove(); ul._moreBtn = null; }

  ul.innerHTML = state.playlists
    .map((p) => {
      const n = p.trackIds.length;
      const first = trackById(p.trackIds[0]);
      const color = first ? hashColor(first.album || first.title) : null;
      const bg = color
        ? `style="background:linear-gradient(135deg,${color}, ${hashColor(p.name, 60, 40)})"`
        : '';
      return `<li class="playlist" data-id="${p.id}" draggable="false">
        <div class="playlist-art" ${bg}>
          ${first ? `<img class="art-thumb" data-art-id="${artKeyOf(first)}" data-track="${first.id}" alt="" loading="lazy" decoding="async" />` : ''}
          <svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>
        </div>
        <div class="playlist-info">
          <div class="playlist-name">${escapeHtml(p.name)}</div>
          <div class="playlist-meta">${n} ${n === 1 ? 'pista' : 'pistas'}</div>
        </div>
        <button class="track-more" data-act="playlist-menu" aria-label="Más">⋯</button>
      </li>`;
    })
    .join('');

  $('#pl-count').textContent =
    `${state.playlists.length} ${state.playlists.length === 1 ? 'playlist' : 'playlists'}`;
  $('#playlists-empty').hidden = state.playlists.length > 0;
  ul.hidden = state.playlists.length === 0;
  refreshArt(ul);
}

function renderPlaylistDetail() {
  const pl = state.playlists.find((p) => p.id === state.openPlaylist);
  if (!pl) { state.openPlaylist = null; return renderPlaylists(); }

  const items = pl.trackIds.map((id) => trackIndex.get(id)).filter(Boolean);
  const list = $('#playlist-list');
  const detail = $('#playlist-detail');
  if (!detail) return;
  list.hidden = true;
  detail.hidden = false;
  detail.innerHTML = `
    <div class="pl-detail-head">
      <button class="back-btn" id="btn-pl-back" aria-label="Volver">
        <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <input class="pl-title-input" id="pl-name-input" value="${escapeHtml(pl.name)}" maxlength="60" />
      <button class="btn small" id="btn-pl-add">+ Añadir</button>
      <button class="btn small" id="btn-pl-delete" style="color:var(--danger)">Borrar</button>
    </div>
    <ul class="track-list" id="pl-track-list"></ul>
    ${items.length === 0 ? `<div class="empty"><p>Esta playlist está vacía.<br/>Pulsa “+ Añadir” o arrastra canciones.</p></div>` : ''}
  `;
  $('#pl-count').textContent = `${items.length} pistas · ${pl.trackIds.length} en total`;
  $('#playlists-empty').hidden = true;

  $('#btn-pl-back').onclick = () => { state.openPlaylist = null; renderPlaylists(); };
  $('#btn-pl-add').onclick = () => openAddToPlaylistModal(pl.id, true);
  $('#btn-pl-delete').onclick = () => confirmDeletePlaylist(pl);
  $('#pl-name-input').onchange = (e) => {
    pl.name = e.target.value.trim() || 'Playlist sin nombre';
    db.putPlaylist(pl);
    toast('Playlist renombrada');
  };

  setPagedList($('#pl-track-list'), items, { row: { handle: true, removable: true } });
  wireReorder($('#pl-track-list'), pl);
}

function renderQueue() {
  const ul = $('#queue-list');
  const items = state.queue.map((id) => trackIndex.get(id)).filter(Boolean);
  // Total real de la cola: “6134 en cola · 1:45:29”, como en los reproductores
  // que muestran la duración de lo que queda.
  let total = 0;
  for (const t of items) total += t.duration || 0;
  $('#queue-count').textContent = items.length
    ? `${items.length} en cola · ${formatTime(total)}`
    : '0 en cola';
  $('#queue-empty').hidden = items.length > 0;
  ul.hidden = items.length === 0;
  setPagedList(ul, items, { row: { queue: true } });
}

/** Mapa id → posición en la cola (evita recorrer la cola por cada fila). */
function queueIndexMap() {
  const m = new Map();
  for (let i = 0; i < state.queue.length; i++) m.set(state.queue[i], i);
  return m;
}

// ============================================================
// REPRODUCCIÓN
// ============================================================
// URLs de streaming de los archivos importados (blob temporal): se
// mantienen unas pocas y se libera la memoria de las viejas.
const streamBlobs = new Map();

/**
 * URL reproducible de una canción SIN decodificarla:
 *  - del teléfono: el APK deja el archivo listo en su caché (una vez) y el
 *    servidor local lo sirve con extensión y rangos (buscar es instantáneo).
 *  - importada: blob:// del archivo guardado en la app.
 */
async function getStreamUrl(track) {
  if (!track) return null;
  if (track.nativeUri) {
    const url = await stageAudioUrl(track).catch(() => null);
    if (url) return url;
  }
  const hit = streamBlobs.get(track.id);
  if (hit) return hit;
  const blob = await db.getFile(track.id).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  streamBlobs.set(track.id, url);
  if (streamBlobs.size > 4) {
    const [oldId, oldUrl] = streamBlobs.entries().next().value;
    if (oldId !== track.id) { URL.revokeObjectURL(oldUrl); streamBlobs.delete(oldId); }
  }
  return url;
}

async function getBuffer(id, { silent = false } = {}) {
  if (bufferCache.has(id)) return bufferCache.get(id);
  const track = trackById(id);
  let blob = await db.getFile(id);

  // Canción del teléfono: aún no está copiada, se lee bajo demanda.
  // Sin avisos: se lee tan rápido que no hace falta interrumpir al usuario.
  if (!blob && track && track.nativeUri) {
    blob = await readNativeFile(track);
  }
  if (!blob) throw new Error('Archivo no disponible');

  const buf = await engine.decode(blob, {
    ext: track?.ext || '',
    name: track?.title || '',
    onProgress: (phase, pct) => {
      if (phase === 'download') toast(`Descargando motor de formatos… ${pct}%`, 8000);
      else if (phase === 'encode') toast(`Convirtiendo ${track?.title || 'archivo'}… ${pct}%`, 8000);
    },
  });
  bufferCache.set(id, buf);
  // AudioBuffers grandes: con bibliotecas de 5000 canciones hay que
  // mantener pocos en memoria para no quedarse sin RAM. 4 = la que suena
  // + la precargada + la anterior + margen.
  if (bufferCache.size > 4) {
    const first = bufferCache.keys().next().value;
    if (first !== id) bufferCache.delete(first);
  }
  return buf;
}

// ============================================================
// PRECARGA DE LA SIGUIENTE CANCIÓN
// Sin esto, al pasar a la siguiente se esperaba a leer el archivo del
// teléfono + decodificarlo (1-5 s de silencio). Con la precarga ya está
// lista y el salto es instantáneo, como en cualquier otro reproductor.
// ============================================================
let prefetchFor = null;   // pista para la que ya se preparó la siguiente

/**
 * La precarga se dispara cerca del final del tema (desde el timeupdate), no
 * al arrancar: copiar varios MB mientras suena el principio competía con el
 * audio y se notaba como microcorte, sobre todo con la pantalla apagada.
 * Al empezar un tema se olvida la precarga del anterior.
 */
function schedulePrefetch() {
  prefetchFor = null;
}

function prefetchNext() {
  if (!state.currentId || prefetchFor === state.currentId) return;
  if (state.queueIndex < 0 || state.queue.length < 2) return;
  let idx = state.queueIndex + 1;
  if (idx >= state.queue.length) {
    if (state.repeat !== 'all') return;
    idx = 0;
  }
  const id = state.queue[idx];
  if (!id || id === state.currentId || bufferCache.has(id)) return;
  const t = trackById(id);
  if (!t) return;
  prefetchFor = state.currentId;
  // En streaming no hay que decodificar nada: el archivo del teléfono se
  // abre al instante al pulsar siguiente. De los importados solo se deja
  // preparado el blob (para que el salto tampoco espere a la base).
  if (engine.canStream()) {
    getStreamUrl(t).catch(() => { prefetchFor = null; });
    return;
  }
  getBuffer(id, { silent: true }).catch(() => { prefetchFor = null; });
}

async function playTrack(indexInQueue, { autoplay = true, startAt = 0 } = {}) {
  if (indexInQueue < 0 || indexInQueue >= state.queue.length) return;
  const id = state.queue[indexInQueue];
  const track = trackById(id);
  if (!track) return;

  state.queueIndex = indexInQueue;
  state.currentId = id;
  // la barra y la pantalla completa se muestran ya, sin esperar a decodificar
  refreshTrackViews();

  try {
    if (autoplay) {
      let ok = false;
      // Camino normal: streaming (arranque inmediato, sin decodificar).
      if (engine.canStream() && !noStream.has(id)) {
        const url = await getStreamUrl(track).catch(() => null);
        if (url) {
          try {
            await engine.playStream(url, id);
            ok = true;
          } catch {
            ok = false;   // archivo raro: se intenta el camino decodificado
          }
        }
      }
      // Camino decodificado (solo si se usa el cambio de TONO).
      if (!ok) {
        const buf = await getBuffer(id);
        await engine.play(buf, id);
      }
      if (startAt > 0 && engine.duration > 0) {
        engine.seek(Math.min(1, startAt / engine.duration));
      }
      state.playing = true;
    }
    updateMediaSession(track);
    schedulePrefetch();
    pushMediaState(true);
  } catch (err) {
    console.error(err);
    state.playing = false;
    toast('No se pudo reproducir este archivo');
    pushMediaState(true);
  }
  refreshTrackViews();
}

function playFromList(ids, startIndex) {
  state.queue = ids.slice();
  playTrack(startIndex);
}

async function togglePlay() {
  if (!state.currentId) {
    const ids = currentLibraryIds();
    if (ids.length === 0) return toast('No hay canciones en la biblioteca');
    const idx = state.queue.length && trackById(state.queue[state.queueIndex])
      ? Math.max(0, ids.indexOf(state.queue[state.queueIndex]))
      : 0;
    return playFromList(ids, idx >= 0 ? idx : 0);
  }
  if (state.playing) {
    await engine.pause();
    state.playing = false;
  } else {
    await engine.resumePlayback();
    state.playing = true;
  }
  updatePlayUI();
  pushMediaState(true);   // notificación y widget al día (play/pausa)
}

function nextTrack(auto = false) {
  if (state.queue.length === 0) return;
  if (auto && state.repeat === 'one') {
    engine.seek(0);
    return;
  }
  let idx = state.queueIndex;
  if (state.shuffle) {
    if (state.queue.length === 1) idx = 0;
    else {
      do { idx = Math.floor(Math.random() * state.queue.length); } while (idx === state.queueIndex);
    }
  } else {
    idx = state.queueIndex + 1;
  }
  if (idx >= state.queue.length) {
    if (state.repeat === 'all') idx = 0;
    else { stopAll(); return; }
  }
  playTrack(idx);
}

function prevTrack() {
  if (state.queue.length === 0) return;
  if (engine.position > 3) { engine.seek(0); return; }
  let idx = state.queueIndex - 1;
  if (idx < 0) idx = state.repeat === 'all' ? state.queue.length - 1 : 0;
  playTrack(idx);
}

async function stopAll() {
  engine.stop();
  state.playing = false;
  state.currentId = null;
  state.queueIndex = -1;
  refreshTrackViews();
  mediaHide();   // sin música: notificación y widget fuera
}

// Fin natural de la pista
engine.on('end', (id) => {
  if (state.crossfadePending) return; // el cambio lo gestiona el crossfade
  if (state.sleepAtEnd) {
    state.sleepAtEnd = false;
    stopAll();
    toast('⏰ Temporizador: reproducción detenida');
    return;
  }
  if (state.currentId && id !== state.currentId) return; // pista obsoleta
  nextTrack(true);
});

// Si un archivo no se puede abrir en streaming (formato raro o dañado), se
// reintenta UNA vez por el camino decodificado, en el mismo punto.
const noStream = new Set();
engine.on('error', () => {
  const t = trackById(state.currentId);
  if (!t) return;
  noStream.add(t.id);
  playTrack(state.queueIndex, { startAt: engine.position }).catch(() => {});
});

// ============================================================
// UI DEL REPRODUCTOR
// ============================================================
function updatePlayUI() {
  $('#btn-play').classList.toggle('playing', state.playing);
  $('#btn-play').setAttribute('aria-label', state.playing ? 'Pausar' : 'Reproducir');
  const miniPlay = $('#mini-play');
  if (miniPlay) {
    miniPlay.classList.toggle('playing', state.playing);
    miniPlay.setAttribute('aria-label', state.playing ? 'Pausar' : 'Reproducir');
  }
  const qmap = queueIndexMap();
  $$('.track').forEach((el) => {
    const cur = el.dataset.id === state.currentId;
    el.classList.toggle('playing', cur);
    el.classList.toggle('paused', cur && !state.playing);
    if (el.closest('#queue-list')) {
      const qi = qmap.get(el.dataset.id);
      el.classList.toggle('queue-current', qi != null && qi === state.queueIndex);
    }
  });
}

/**
 * Refresca el reproductor y las marcas de "sonando" SIN repintar las listas.
 * Antes se llamaba a renderAll() al cambiar de canción: con 5000 filas eso
 * reconstruía la lista entera (innerHTML + miles de <img>) en cada salto y el
 * teléfono se quedaba sin memoria.
 */
function refreshTrackViews() {
  // La carátula de la canción que suena NUNCA se libera aunque su fila ya
  // no se vea: la están usando el reproductor, la mini barra y el fondo.
  const cur = trackById(state.currentId);
  artPinned.clear();
  if (cur) {
    artPinned.add(artKeyOf(cur));
    artPinned.add('own' + cur.id);
  }
  updatePlayerUI();
  updatePlayUI();
}

// Pinta la carátula (incrustada o degradado de respaldo) en un contenedor
function paintArt(box, img, letter, t) {
  box.style.background = `linear-gradient(135deg, ${hashColor(t.album || t.title)}, ${hashColor(t.title, 60, 42)})`;
  letter.textContent = (t.title || '♪').charAt(0).toUpperCase();
  const key = artKeyOf(t);
  const url = artURL(key);
  if (url) {
    img.dataset.artId = key;
    if (img.getAttribute('src') !== url) img.src = url;
    img.hidden = false;
  } else {
    delete img.dataset.artId;
    img.hidden = true;
    // se lee la carátula del archivo de esta canción ahora mismo
    if (!artMiss.has('own' + t.id)) wantArt(t.id);
  }
}

// Línea técnica del reproductor: MP3 • ~132 kb/s • 48.0 kHz
function techLine(t) {
  const parts = [t.ext || 'AUDIO'];
  if (t.duration > 0 && t.size > 0) {
    const kbps = Math.round((t.size * 8) / t.duration / 1000);
    if (kbps > 0) parts.push(`~${kbps} kb/s`);
  }
  const buf = bufferCache.get(t.id);
  if (buf && buf.sampleRate) parts.push(`${(buf.sampleRate / 1000).toFixed(1)} kHz`);
  return parts.join(' • ');
}

// Fondo difuminado de la pantalla completa
// Fondo del reproductor: una miniatura de 40×40 ampliada, con el desenfoque
// hecho una vez en un canvas. Es casi gratis comparado con filter:blur()
// sobre una capa a pantalla completa, que bajaba los FPS a la mitad.
const backdropCache = new Map();   // clave de carátula → dataURL
const backdropBusy = new Set();

function backdropFor(key, url) {
  const hit = backdropCache.get(key);
  if (hit !== undefined) return hit;
  if (backdropBusy.has(key)) return null;
  backdropBusy.add(key);
  const img = new Image();
  img.onload = () => {
    try {
      const N = 40;
      const c = document.createElement('canvas');
      c.width = N; c.height = N;
      const g = c.getContext('2d');
      g.filter = 'blur(3px)';   // a 40 px cuesta casi nada
      const scale = Math.max(N / img.naturalWidth, N / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      const m = N * 0.12;        // margen para que el desenfoque no corte
      g.drawImage(img, (N - w) / 2 - m, (N - h) / 2 - m, w + m * 2, h + m * 2);
      backdropCache.set(key, c.toDataURL('image/jpeg', 0.7));
      if (backdropCache.size > 8) {
        const oldest = backdropCache.keys().next().value;
        if (oldest !== key) backdropCache.delete(oldest);
      }
    } catch {
      backdropCache.set(key, '');
    }
    backdropBusy.delete(key);
    const cur = trackById(state.currentId);
    if (cur && artKeyOf(cur) === key) paintBackdrop(cur);
  };
  img.onerror = () => {
    backdropBusy.delete(key);
    backdropCache.set(key, '');
  };
  img.src = url;
  return null;
}

function paintBackdrop(t) {
  const bg = $('#fs-bg');
  const key = artKeyOf(t);
  const url = artURL(key);
  if (!url && !artMiss.has('own' + t.id)) {
    // todavía no está en memoria: se pide y el fondo se repinta solo
    wantArt(t.id);
  }
  const tiny = url ? backdropFor(key, url) : '';
  const next = tiny
    ? `url("${tiny}")`
    : `linear-gradient(160deg, ${hashColor(t.album || t.title)}, ${hashColor(t.title, 60, 42)}, ${hashColor(t.album || t.title, 40, 55)})`;
  // Evita volver a pintar si el fondo ya es ese.
  if (bg.style.backgroundImage !== next) bg.style.backgroundImage = next;
}

function updatePlayerUI() {
  const t = trackById(state.currentId);
  const mini = $('#player');
  mini.hidden = !t;
  document.body.style.setProperty(
    '--player-h',
    t ? 'calc(var(--nav-h) + var(--mini-h))' : 'var(--nav-h)'
  );

  if (!t) {
    closeFs();
    return;
  }

  // ---- barra mini ----
  $('#mini-title').textContent = t.title;
  $('#mini-artist').textContent = [t.artist, t.album].filter(Boolean).join(' · ') || 'Desconocido';
  paintArt($('#mini-art'), $('#mini-img'), $('#mini-letter'), t);

  // ---- pantalla completa ----
  const sub = [t.artist, t.album].filter(Boolean).join(' • ') || 'Desconocido';
  $('#track-title').textContent = t.title;
  $('#track-title').title = t.title;
  $('#track-artist').textContent = sub;
  $('#track-tech').textContent = techLine(t);
  paintArt($('#player-art'), $('#art-img'), $('#art-letter'), t);
  paintBackdrop(t);
  $('#time-total').textContent = formatTime(t.duration || engine.duration);

  const fav = $('#btn-fav');
  fav.classList.toggle('on', !!t.fav);
  fav.setAttribute('aria-pressed', String(!!t.fav));
  fav.title = t.fav ? 'Quitar de favoritos' : 'Añadir a favoritos';

  updatePlayUI();
}

function updateRepeatUI() {
  const b = $('#btn-repeat');
  b.classList.toggle('on', state.repeat !== 'off');
  $('#repeat-badge').hidden = state.repeat !== 'one';
  b.title = state.repeat === 'off' ? 'Repetir: no' : state.repeat === 'all' ? 'Repetir: todo' : 'Repetir: una';
}

function syncAdvancedLabels() {
  $('#speed-val').textContent = `${engine.speed.toFixed(2)}×`;
  $('#pitch-val').textContent = `${engine.pitch > 0 ? '+' : ''}${engine.pitch} st`;
  const preset = AudioEngine.presets[engine.eq];
  $('#eq-val').textContent = preset ? preset.label : 'Plano';
  $('#crossfade-val').textContent = engine.crossfadeSec ? `${engine.crossfadeSec} s` : '0 s';
  const boost = $('#boost-val');
  if (boost) boost.textContent = `${Math.round(engine.boost * 100)}%`;
  const vol = $('#vol-val');
  if (vol) vol.textContent = `${volumePercent()}%`;
  syncFsMix();
}

// En el APK el control de volumen es el volumen multimedia REAL del
// teléfono (STREAM_MUSIC), no una ganancia interna: así la app y el sistema
// muestran siempre lo mismo. En el navegador se mantiene la ganancia web.
let sysVolumePct = null;
let volumeRestore = 50;   // para el silencio con la tecla M

function volumePercent() {
  return sysVolumePct != null ? sysVolumePct : Math.round(engine.volume * 100);
}

async function initSystemVolume() {
  try {
    // El puente nativo puede tardar un poco en estar listo tras arrancar.
    for (let i = 0; i < 12 && !hasSystemVolume(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!hasSystemVolume()) return;
    engine.setVolume(1);             // el volumen real lo pone Android
    let v = await getSystemVolume();
    for (let i = 0; i < 8 && !v; i++) {
      await new Promise((r) => setTimeout(r, 250));
      v = await getSystemVolume();
    }
    if (v) sysVolumePct = v.percent;
    watchSystemVolume((pct) => {
      sysVolumePct = pct;
      syncAdvancedLabels();
    });
    syncAdvancedLabels();
  } catch {
    // Un fallo del puente de volumen nunca debe frenar la biblioteca.
  }
}

/** Aplica el volumen: sistema en el APK, ganancia web en el navegador. */
async function applyVolume(percent) {
  const p = clamp(Math.round(percent), 0, 100);
  if (hasSystemVolume()) {
    sysVolumePct = p;                // se pinta ya, sin esperar al puente
    syncAdvancedLabels();
    const r = await setSystemVolume(p);
    if (r) {
      sysVolumePct = r.percent;
      syncAdvancedLabels();
    }
    return;
  }
  engine.setVolume(p / 100);
  syncAdvancedLabels();
  saveSetting('volume', engine.volume);
}

/** Volumen y refuerzo en el reproductor, sincronizados con Ajustes. */
function syncFsMix() {
  const pct = volumePercent();
  const v = $('#fs-vol');
  if (v) {
    v.value = String(pct);
    v.style.setProperty('--p', `${pct}%`);
  }
  const vv = $('#fs-vol-val');
  if (vv) vv.textContent = `${pct}%`;
  // El control de Ajustes también refleja el volumen real.
  const adv = $('#vol');
  if (adv) adv.value = String(pct);

  const bst = Math.round(engine.boost * 100);
  const b = $('#fs-boost');
  if (b) {
    b.value = String(bst);
    b.style.setProperty('--p', `${clamp(bst - 100, 0, 100)}%`);
  }
  const bv = $('#fs-boost-val');
  if (bv) bv.textContent = `${bst}%`;
}

// ============================================================
// PANTALLA COMPLETA + MENÚ DEL REPRODUCTOR
// ============================================================
function openFs() {
  if (!state.currentId) return;
  $('#fs-player').hidden = false;
  document.body.classList.add('fs-open');
  closeSheet();
  updatePlayerUI();
  syncFsMix();
}

function closeFs() {
  const fs = $('#fs-player');
  if (fs && !fs.hidden) fs.hidden = true;
  document.body.classList.remove('fs-open');
  closeSheet();
}

function openSheet(view) {
  $('#fs-sheet').hidden = false;
  $('#fs-sheet-backdrop').hidden = false;
  setSheetView(view || 'all');
}

function closeSheet() {
  const sheet = $('#fs-sheet');
  if (!sheet) return;
  sheet.hidden = true;
  $('#fs-sheet-backdrop').hidden = true;
  setSheetView('all');
}

// 'all' (todo) | 'speed' (velocidad y tono) | 'eq' (ecualizador)
function setSheetView(view) {
  const title = view === 'speed' ? 'Velocidad y tono'
    : view === 'eq' ? 'Ecualizador con presets'
    : 'Opciones del reproductor';
  const titleEl = $('#sheet-title');
  if (titleEl) titleEl.textContent = title;

  $$('#advanced .adv-item').forEach((el) => {
    el.hidden = view === 'speed' ? el.dataset.g !== 'speed'
      : view === 'eq' ? el.dataset.g !== 'eq'
      : false;
  });

  if ((view === 'speed' || view === 'eq') && $('#advanced').hidden) {
    $('#btn-adv-toggle').click();
  }
}

function onSheetMenu(item) {
  if (item === 'speed') return openSheet('speed');
  if (item === 'eq') return openSheet('eq');
  if (item === 'queue') { closeSheet(); closeFs(); return setTab('queue'); }
  if (item === 'info') {
    if (!state.currentId) return toast('No hay nada reproduciéndose');
    closeSheet();
    return openInfoModal(state.currentId);
  }
  if (item === 'playlist') {
    if (!state.currentId) return toast('No hay nada reproduciéndose');
    closeSheet();
    return openAddToPlaylistModal(null, false, state.currentId);
  }
}

function toggleFav(id) {
  const t = trackById(id);
  if (!t) return;
  t.fav = !t.fav;
  db.putTrack(t);
  // solo cambian favoritos y contadores: no hace falta repintar todo
  renderFavorites();
  renderSettings();
  refreshTrackViews();
  toast(t.fav ? '❤ Añadida a favoritos' : '💔 Quitada de favoritos');
}

// Deslizar hacia abajo para cerrar la pantalla completa
function wireFsSwipe() {
  const fs = $('#fs-player');
  const inner = fs.querySelector('.fs-inner');
  let startY = null;
  let dy = 0;

  fs.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input, select, .fs-sheet, .fs-backdrop, .progress-row, .controls, .fs-actions')) return;
    startY = e.clientY;
    dy = 0;
    inner.style.transition = 'none';
  });
  fs.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    if (dy > 4) inner.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (startY == null) return;
    inner.style.transition = '';
    inner.style.transform = '';
    const shouldClose = dy > 110;
    startY = null;
    dy = 0;
    if (shouldClose) closeFs();
  };
  fs.addEventListener('pointerup', end);
  fs.addEventListener('pointercancel', end);
  fs.addEventListener('pointerleave', end);
}

// El progreso se refresca ~5 veces por segundo (no en cada frame): antes
// se hacían 4 búsquedas de elementos y 3 escrituras de texto a 60 fps y
// eso era el mayor causante de tirones en gama baja.
let _tickEls = null;
let _lastTickAt = 0;
let _lastSecond = -1;
let _lastPct = -1;

function tick() {
  const dur = engine.duration;
  const pos = engine.position;
  if (dur > 0) {
    const frac = clamp(pos / dur, 0, 1);
    if (!_tickEls) {
      _tickEls = {
        seek: $('#seek'),
        cur: $('#time-current'),
        total: $('#time-total'),
        bar: $('#mini-bar'),
        fs: $('#fs-player'),
      };
    }
    const e = _tickEls;
    if (e.seek && !e.seek.matches(':active')) {
      const v = Math.round(frac * 1000);
      if (Number(e.seek.value) !== v) e.seek.value = String(v);
      // Rellena la parte escuchada (color sólido vs. atenuado). Solo se
      // toca el estilo cuando cambia el porcentaje entero: menos pintados.
      const pct = Math.round(frac * 100);
      if (pct !== _lastPct) {
        _lastPct = pct;
        e.seek.style.setProperty('--p', `${pct}%`);
      }
    }
    const sec = Math.floor(pos);
    if (sec !== _lastSecond) {
      _lastSecond = sec;
      if (e.cur) e.cur.textContent = formatTime(pos);
      if (e.total) e.total.textContent = formatTime(dur);
    }
    // La barra mini queda tapada por el reproductor: no se anima mientras
    // está abierto (su transición se reiniciaba 4 veces por segundo y
    // obligaba a componer cada frame).
    if (e.bar && e.fs && e.fs.hidden) e.bar.style.transform = `scaleX(${frac.toFixed(4)})`;
  }
  // Posición para la notificación/widget: pushMediaState ya limita las
  // llamadas nativas a una cada 4 s, aquí solo se le pasa el estado.
  if (state.playing) pushMediaState();

  // Cerca del final se prepara el siguiente tema. Antes se copiaba a los
  // 1,5 s del arranque y ese trabajo competía con el audio (microcorte con
  // la pantalla apagada); así el salto sigue siendo inmediato pero sin
  // tocar el disco mientras suena el principio.
  if (state.playing) {
    const remain = engine.duration - engine.position;
    if (remain > 0 && remain < 20) prefetchNext();
  }

  // Crossfade solo en el modo decodificado (el streaming no necesita
  // mezclar dos archivos y así no se gasta CPU en gama baja).
  if (
    state.playing && engine.crossfadeSec > 0 && !state.crossfadePending &&
    !engine.isStreaming() && engine.duration > 0 && engine.pendingId == null
  ) {
    const remaining = (engine.duration - engine.position) / engine.speed;
    if (remaining > 0 && remaining <= engine.crossfadeSec) {
      startCrossfade();
    }
  }
}

async function startCrossfade() {
  if (state.queueIndex < 0 || state.queue.length === 0) return;
  let nextIdx = state.queueIndex + 1;
  if (state.repeat === 'one') return;
  if (nextIdx >= state.queue.length) {
    if (state.repeat !== 'all') return;
    nextIdx = 0;
  }
  if (state.shuffle && state.queue.length > 1) {
    do { nextIdx = Math.floor(Math.random() * state.queue.length); } while (nextIdx === state.queueIndex);
  }

  const nextId = state.queue[nextIdx];
  state.crossfadePending = true;
  let buf;
  try {
    buf = await getBuffer(nextId);
  } catch {
    state.crossfadePending = false;
    return;
  }
  if (!engine.current || engine.position > engine.duration - 0.1) {
    state.crossfadePending = false;
    return;
  }

  await engine.crossfadeTo(buf, nextId);
  state.queueIndex = nextIdx;
  state.currentId = nextId;
  state.playing = true;
  updateMediaSession(trackById(nextId));
  state.crossfadePending = false;
  refreshTrackViews();
  pushMediaState(true);   // la notificación/widget siguen la pista nueva
}

// ============================================================
// AÑADIR MÚSICA
// ============================================================
async function addFiles(fileList) {
  const files = [...fileList].filter(
    (f) => (f.type && f.type.startsWith('audio/')) || isAudioFile(f.name)
  );
  const rejected = [...fileList].length - files.length;
  if (files.length === 0) {
    return toast(
      rejected > 0
        ? 'Solo archivos de audio (MP3, M4A, FLAC, WAV, OGG, Opus, WMA, AIFF…)'
        : 'No se detectaron archivos de audio',
      4000
    );
  }

  toast(`Importando ${files.length} archivo${files.length > 1 ? 's' : ''}…`, 4000);
  let ok = 0;
  const errors = [];

  for (const file of files) {
    try {
      const tags = await parseTags(file);
      const id = uid();
      const baseName = file.name.replace(/\.[^.]+$/, '');
      const ext = extOf(file.name);
      // Carátula incrustada (ID3 APIC / MP4 covr / FLAC PICTURE)
      let art = null;
      try {
        art = await extractArtwork(file);
        if (art) art = await shrinkImage(art);   // se guarda ya reducida
      } catch { art = null; }

      // Carpeta de origen (solo si se eligió una carpeta completa)
      const rel = file.webkitRelativePath || '';
      const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

      const track = {
        id,
        title: tags.title || baseName,
        artist: tags.artist || '',
        album: tags.album || '',
        genre: tags.genre || '',
        folder,
        duration: 0,
        size: file.size,
        ext: (ext || 'AUDIO').toUpperCase(),
        hasArt: !!art,
        artChecked: true,
        addedAt: Date.now(),
      };

      // Decodificar para obtener la duración exacta.
      // Si el navegador no sabe leerlo, ffmpeg.wasm lo convierte.
      try {
        const buf = await engine.decode(file, {
          ext,
          name: file.name,
          onProgress: (phase, pct) => {
            if (phase === 'download') toast(`Descargando motor de formatos… ${pct}%`, 15000);
            else if (phase === 'encode') toast(`Convirtiendo ${file.name}… ${pct}%`, 15000);
          },
        });
        track.duration = buf.duration;
      } catch (e) {
        console.error('decode', file.name, e);
        errors.push(file.name + ' (' + (e && e.message ? e.message : 'error') + ')');
        continue;
      }

      await db.putTrack(track);
      await db.putFile(id, file);
      if (art) {
        await db.putArtwork(id, art);
        setArt(id, art);
      }
      state.tracks.push(track);
      ok++;
    } catch (e) {
      console.error(e);
      errors.push(file.name);
    }
  }

  reindexTracks();
  renderAll();
  if (ok) toast(`✓ ${ok} ${ok === 1 ? 'canción añadida' : 'canciones añadidas'}`);
  if (errors.length) toast(`⚠ No se pudo leer: ${errors[0]}`, 4000);
}

// ============================================================
// PLAYLISTS
// ============================================================
async function createPlaylist(name, trackIds = []) {
  const pl = { id: uid(), name: name.trim() || 'Playlist sin nombre', trackIds, addedAt: Date.now() };
  state.playlists.push(pl);
  await db.putPlaylist(pl);
  renderPlaylists();
  toast(`Playlist “${pl.name}” creada`);
  return pl;
}

async function addToPlaylist(plId, trackIds) {
  const pl = state.playlists.find((p) => p.id === plId);
  if (!pl) return;
  let added = 0;
  for (const id of trackIds) if (!pl.trackIds.includes(id)) { pl.trackIds.push(id); added++; }
  await db.putPlaylist(pl);
  renderPlaylists();
  toast(added ? `+${added} en “${pl.name}”` : 'Ya estaba en la playlist');
}

async function removeFromPlaylist(plId, trackId) {
  const pl = state.playlists.find((p) => p.id === plId);
  if (!pl) return;
  pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
  await db.putPlaylist(pl);
  renderPlaylistDetail();
  toast('Quitada de la playlist');
}

function confirmDeletePlaylist(pl) {
  openModal('modal-confirm', () => {
    $('#confirm-title').textContent = '¿Borrar playlist?';
    $('#confirm-text').textContent = `“${pl.name}” se eliminará (las canciones se quedan en tu biblioteca).`;
    $('#btn-confirm-ok').onclick = async () => {
      await db.deletePlaylist(pl.id);
      state.playlists = state.playlists.filter((p) => p.id !== pl.id);
      state.openPlaylist = null;
      closeModal('modal-confirm');
      renderPlaylists();
      toast('Playlist eliminada');
    };
  });
}

// Arrastrar y soltar para reordenar
function wireReorder(container, playlist) {
  if (!container) return;
  let dragEl = null;

  container.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.track');
    if (!li) return;
    dragEl = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });

  container.addEventListener('dragend', async () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    dragEl = null;
    // Si la lista sigue cargando páginas, el orden del DOM no corresponde
    // a la lista completa: reescribirla perdería las canciones que aún no
    // se han pintado, así que se descarta el reordenado.
    if (container._rows && container._shown < container._rows.length) {
      toast('Carga toda la playlist (“Mostrar más”) para reordenarla', 3500);
      return renderPlaylistDetail();
    }
    const ids = [...container.querySelectorAll('.track')].map((el) => el.dataset.id);
    playlist.trackIds = ids;
    await db.putPlaylist(playlist);
    renderPlaylistDetail();
  });

  container.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const after = getAfterElement(container, e.clientY);
    if (after == null) container.appendChild(dragEl);
    else if (after !== dragEl) container.insertBefore(dragEl, after);
  });
}

function getAfterElement(container, y) {
  const els = [...container.querySelectorAll('.track:not(.dragging)')];
  return els.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: -Infinity, element: null }
  ).element;
}

// ============================================================
// MENÚ CONTEXTUAL
// ============================================================
function openContextMenu(x, y, trackId, from) {
  restoreCtxMenu();
  state.ctxTrackId = trackId;
  state.ctxFrom = from;
  const menu = $('#ctx-menu');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top = `${Math.max(8, py)}px`;

  menu.querySelector('[data-action="remove"]').hidden = from === 'library';
  menu.querySelector('[data-action="delete"]').hidden = from === 'queue';
  const favBtn = menu.querySelector('[data-action="fav"]');
  if (favBtn) {
    const t = trackById(trackId);
    favBtn.textContent = t && t.fav ? '💔 Quitar de favoritos' : '❤ Favorito';
  }
}

function closeContextMenu() {
  const menu = $('#ctx-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  restoreCtxMenu();
}

function handleCtxAction(action) {
  if (!action) return;
  const id = state.ctxTrackId;
  const from = state.ctxFrom;
  const pl = state.openPlaylist;
  closeContextMenu();
  if (!id) return;

  switch (action) {
    case 'play': {
      // reproduce exactamente desde la lista donde está la canción
      let list;
      if (from === 'playlist' && pl) {
        list = state.playlists.find((p) => p.id === pl)?.trackIds || [];
      } else if (from === 'queue') {
        list = state.queue.slice();
      } else if (from === 'favorites') {
        list = filteredTracks(state.tracks.filter((t) => t.fav)).map((t) => t.id);
      } else {
        // biblioteca (vista completa, por carpeta o con búsqueda)
        list = currentLibraryIds();
      }
      const i = list.indexOf(id);
      if (i > -1) playFromList(list, i);
      else playFromList([id], 0);
      break;
    }
    case 'fav':
      toggleFav(id);
      break;
    case 'play-next': {
      const pos = state.queueIndex + 1;
      state.queue.splice(pos, 0, id);
      renderQueue();
      toast('Se reproducirá a continuación');
      break;
    }
    case 'add-queue':
      state.queue.push(id);
      renderQueue();
      toast('Añadida a la cola');
      break;
    case 'add-playlist':
      openAddToPlaylistModal(null, false, id);
      break;
    case 'info':
      openInfoModal(id);
      break;
    case 'remove':
      if (from === 'playlist' && pl) removeFromPlaylist(pl, id);
      else if (from === 'queue') {
        const i = state.queue.indexOf(id);
        if (i > -1) state.queue.splice(i, 1);
        if (i <= state.queueIndex) state.queueIndex--;
        renderQueue();
      }
      break;
    case 'delete':
      confirmDeleteTrack(id);
      break;
  }
}

function confirmDeleteTrack(id) {
  const t = trackById(id);
  if (!t) return;
  openModal('modal-confirm', () => {
    $('#confirm-title').textContent = '¿Eliminar canción?';
    $('#confirm-text').textContent = `“${t.title}” se borrará de tu biblioteca y de todas las playlists.`;
    $('#btn-confirm-ok').onclick = async () => {
      await db.deleteTrack(id);
      bufferCache.delete(id);
      if (artCache.has(id)) {
        URL.revokeObjectURL(artCache.get(id));
        artCache.delete(id);
      }
      state.tracks = state.tracks.filter((x) => x.id !== id);
      state.queue = state.queue.filter((x) => x !== id);
      for (const pl of state.playlists) {
        if (pl.trackIds.includes(id)) {
          pl.trackIds = pl.trackIds.filter((x) => x !== id);
          db.putPlaylist(pl);
        }
      }
      if (state.currentId === id) stopAll();
      reindexTracks();
      closeModal('modal-confirm');
      renderAll();
      toast('Canción eliminada');
    };
  });
}

// ============================================================
// MODALES
// ============================================================
let modalStack = [];
window.__modalStack = modalStack; // diagnóstico (?selftest=1)
function openModal(id, beforeShow) {
  beforeShow && beforeShow();
  $('#modal-backdrop').hidden = false;
  $$('#modal-backdrop .modal').forEach((m) => (m.hidden = m.id !== id));
  modalStack.push(id);
}
function closeModal(id) {
  // Se cierra el modal indicado (o el de arriba si no se indica). Cada
  // cierre retira SU entrada: un cierre tardío (tras un `await`) ya no
  // puede cerrar un modal más nuevo que se haya abierto mientras tanto.
  const idx = id ? modalStack.lastIndexOf(id) : modalStack.length - 1;
  if (idx > -1) modalStack.splice(idx, 1);
  const top = modalStack[modalStack.length - 1];
  $$('#modal-backdrop .modal').forEach((m) => {
    m.hidden = top ? m.id !== top : true;
  });
  if (!top) $('#modal-backdrop').hidden = true;
}

/** Pinta el registro de versiones (se abre tocando la versión en "Acerca de"). */
function renderChangelog() {
  const box = $('#changelog-list');
  if (!box) return;
  box.innerHTML = CHANGELOG.map((v, i) => `
    <div class="cl-entry${i === 0 ? ' current' : ''}">
      <div class="cl-head">
        <span class="cl-ver">Versión ${escapeHtml(v.version)}</span>
        <span class="cl-code">build ${v.code}${i === 0 ? ' · actual' : ''}</span>
      </div>
      <ul>${v.items.map((it) => `<li>${escapeHtml(it)}</li>`).join('')}</ul>
    </div>`).join('');
}

function openAddToPlaylistModal(plId, addToNew, trackId) {
  if (addToNew && plId) {
    const pl = state.playlists.find((p) => p.id === plId);
    return openPickerModal(pl);
  }
  openModal('modal-pick-playlist', () => {
    const target = trackId || state.ctxTrackId;
    const ul = $('#pick-list');
    ul.innerHTML = state.playlists.length
      ? state.playlists.map((p) =>
          `<li data-id="${p.id}">${escapeHtml(p.name)}<span>${p.trackIds.length} pistas</span></li>`
        ).join('')
      : `<li style="color:var(--fg-faint)">Aún no tienes playlists</li>`;
    ul.querySelectorAll('li[data-id]').forEach((li) => {
      li.onclick = () => {
        addToPlaylist(li.dataset.id, [target]);
        closeModal('modal-pick-playlist');
      };
    });
    $('#btn-pick-new').onclick = () => {
      promptNewPlaylist([target]);
    };
  });
}

function promptNewPlaylist(trackIds = []) {
  openModal('modal-new-playlist', () => {
    const input = $('#new-playlist-name');
    input.value = '';
    setTimeout(() => input.focus(), 60);
    $('#btn-create-playlist').onclick = async () => {
      const pl = await createPlaylist(input.value, trackIds);
      closeModal('modal-new-playlist');
      if (state.openPlaylist) { state.openPlaylist = pl.id; renderPlaylistDetail(); }
    };
  });
}

// Modal para añadir canciones existentes a la playlist abierta
function openPickerModal(pl) {
  if (!pl) return;
  openModal('modal-pick-playlist', () => {
    const ul = $('#pick-list');
    const available = state.tracks.filter((t) => !pl.trackIds.includes(t.id));
    ul.innerHTML = available.length
      ? available.map((t) => `<li data-id="${t.id}">${escapeHtml(t.title)}<span>${escapeHtml(t.artist || 'Desconocido')}</span></li>`).join('')
      : `<li style="color:var(--fg-faint)">Todas las canciones ya están aquí</li>`;
    ul.querySelectorAll('li[data-id]').forEach((li) => {
      li.onclick = async () => {
        pl.trackIds.push(li.dataset.id);
        await db.putPlaylist(pl);
        li.remove();
        renderPlaylistDetail();
        toast('Añadida');
      };
    });
    $('#btn-pick-new').onclick = () => promptNewPlaylist();
  });
}

function openInfoModal(id) {
  const t = trackById(id);
  if (!t) return;
  openModal('modal-info', () => {
    const rows = [
      ['Título', t.title],
      ['Artista', t.artist || '—'],
      ['Álbum', t.album || '—'],
      ['Género', t.genre || '—'],
      ['Duración', t.duration ? formatTime(t.duration) : '—'],
      ['Formato', t.ext || '—'],
      ['Tamaño', t.size ? `${(t.size / 1024 / 1024).toFixed(2)} MB` : '—'],
      ['Modificada', (t.modifiedAt || t.addedAt)
        ? new Date(t.modifiedAt || t.addedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
        : '—'],
      ['Velocidad', `${engine.speed.toFixed(2)}×`],
      ['Tono', `${engine.pitch} st`],
    ];
    $('#info-list').innerHTML = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
      .join('');
  });
}

// ============================================================
// TEMPORIZADOR DE SUEÑO
// ============================================================
function setSleepTimer(mode) {
  clearTimeout(state.sleepTimer);
  state.sleepTimer = null;
  state.sleepAtEnd = false;

  if (mode === 'off') return toast('Temporizador desactivado');
  if (mode === 'end') {
    state.sleepAtEnd = true;
    return toast('⏰ Se detendrá al final de la pista');
  }
  const mins = parseInt(mode, 10);
  state.sleepTimer = setTimeout(() => {
    stopAll();
    toast('⏰ Temporizador: reproducción detenida');
  }, mins * 60 * 1000);
  toast(`⏰ Se detendrá en ${mins} min`);
}

// ============================================================
// MEDIA SESSION (controles del sistema)
// ============================================================
// ============================================================
// NOTIFICACIÓN DE SEGUNDO PLANO + WIDGET (lado Android)
// ============================================================
const mediaArtB64 = new Map();   // artKey -> base64 (se calcula una sola vez)
function blobToBase64(blob) {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

async function mediaArtwork(t) {
  const k = artKeyOf(t);
  if (mediaArtB64.has(k)) return mediaArtB64.get(k);
  let blob = artBlobs.get(k) || artBlobs.get('own' + t.id) || null;
  // Si solo había una miniatura reducida, se relee en alta para que el
  // reproductor y la notificación se vean nítidos (una vez por canción).
  if (blob && artLo.has(k)) blob = null;
  // Canción sonando cuya carátula aún no se había leído: se lee de su
  // archivo ahora mismo (solo la cabecera, no la canción entera).
  if (!blob && t.nativeUri && isNative()) {
    const map = await nativeArtworksByFile([{ uri: t.nativeUri, key: t.id }], 1024)
      .catch(() => null);
    blob = (map && map.get(t.id)) || null;
    if (blob) {
      const key = 'own' + t.id;
      artBlobs.set(key, blob);
      artLo.delete(key);
      t.artKey = key;
      t.hasArt = true;
      retagArt(t.id, key);
      setArt(key, blob);
    } else if (map) {
      artMiss.add('own' + t.id);   // sin carátula: no reintentar cada vez
    }
  }
  const b64 = blob ? await blobToBase64(blob) : null;
  if (b64) {
    mediaArtB64.set(k, b64);
    // Caché corta: cada base64 puede ocupar cientos de KB.
    if (mediaArtB64.size > 40) {
      const old = mediaArtB64.keys().next().value;
      if (old !== k) mediaArtB64.delete(old);
    }
  }
  return b64;
}

let lastMediaPush = 0;
let artPushVersion = 0;      // sube cada vez que llega/ mejora una carátula
let pushedArtVersion = -1;
let pushedArtKey = null;

/**
 * Manda el estado actual al servicio nativo (notificación, lockscreen y
 * widget). force = true para no esperar al paso de 4 s (al cambiar de
 * canción, pausar, reanudar o buscar).
 */
async function pushMediaState(force = false) {
  if (!mediaAvailable()) return;
  const now = Date.now();
  if (!force && now - lastMediaPush < 4000) return;
  lastMediaPush = now;

  const t = trackById(state.currentId);
  if (!t) {
    mediaHide();
    return;
  }
  // Primera vez que suena música: se pide el permiso de notificaciones
  // (Android 13+), que es lo que permite ver el control del reproductor.
  if (state.playing && !mediaPermAsked) {
    mediaPermAsked = true;
    mediaRequestPermission().catch(() => {});
  }
  // La carátula SOLO se manda cuando cambia (canción nueva o imagen que
  // acaba de llegar). Antes viajaba un base64 de ~100 KB cada 4 s, y ese
  // trasiego por el puente nativo era el pequeño tirón que se notaba.
  const key = artKeyOf(t);
  let artwork = null;
  if (pushedArtVersion !== artPushVersion || pushedArtKey !== key) {
    const b64 = await mediaArtwork(t);
    if (b64) {
      artwork = b64;
      pushedArtVersion = artPushVersion;
      pushedArtKey = key;
    } else if (artMiss.has('own' + t.id) || !t.nativeUri) {
      artwork = '';          // sin carátula: se limpia la anterior
      pushedArtVersion = artPushVersion;
      pushedArtKey = key;
    }
  }
  lastMediaPush = Date.now();
  await mediaUpdate({
    title: t.title,
    artist: t.artist || 'Desconocido',
    album: t.album || '',
    duration: Math.round((t.duration || 0) * 1000),
    position: Math.round((engine.position || 0) * 1000),
    playing: !!state.playing,
    artwork,
  });
}

/** Botones de la notificación/widget → acciones de la app. */
function wireMediaActions() {
  if (!mediaAvailable()) return;
  onMediaAction((action, data) => {
    if (action === 'seek') {
      // Barra de progreso de la notificación / lockscreen.
      const ms = Number(data && data.position);
      if (Number.isFinite(ms) && ms >= 0 && engine.current && engine.duration > 0) {
        engine.seek(Math.min(1, ms / 1000 / engine.duration));
        const cur = $('#time-current');
        if (cur) cur.textContent = formatTime(ms / 1000);
      }
    }
    else if (action === 'play') { if (!state.playing) togglePlay(); }
    else if (action === 'pause') { if (state.playing) togglePlay(); }
    else if (action === 'toggle') togglePlay();
    else if (action === 'next') nextTrack();
    else if (action === 'prev') prevTrack();
    else if (action === 'stop') stopAll();
    setTimeout(() => pushMediaState(true), 60);
  });
}

let mediaPermAsked = false;

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return;
  try {
    const cover = artURL(artKeyOf(track));
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || 'Desconocido',
      album: track.album || 'Free Player',
      artwork: cover
        ? [{ src: cover, sizes: '512x512', type: 'image/jpeg' }]
        : [{ src: artworkDataUrl(track.album || track.title, 512), sizes: '512x512', type: 'image/png' }],
    });
  } catch (e) {
    // algunos navegadores rechazan data:/blob: URLs en artwork
    console.warn('MediaSession metadata no disponible', e);
  }
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  set('play', () => togglePlay());
  set('pause', () => togglePlay());
  set('nexttrack', () => nextTrack());
  set('previoustrack', () => prevTrack());
  set('seekto', (d) => { if (d.seekTime != null) engine.seek(d.seekTime / engine.duration); });
}

// ============================================================
// TEMAS
// ============================================================
function applyTheme(mode) {
  document.body.dataset.theme = mode;
  saveSetting('theme', mode);
  syncThemeSeg();
  syncStatusBar();
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = document.body.dataset.theme || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyTheme(next);
  toast(next === 'auto' ? 'Tema: automático' : next === 'light' ? 'Tema: claro' : 'Tema: oscuro');
}

// ============================================================
// EVENTOS
// ============================================================
// Cambia de sección usando la barra inferior
function setTab(name) {
  state.tab = name;
  $$('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'playlists' && state.openPlaylist) renderPlaylists();
  if (name === 'favorites') renderFavorites();
  // La cola cambia al elegir otra canción o al limpiarla: se repinta al
  // abrirla para que el contador y la duración total nunca queden viejos.
  if (name === 'queue') renderQueue();
  if (name === 'about') renderSettings();
  const content = $('#content');
  if (content) content.scrollTop = 0;
}

function wireEvents() {
  // --- archivos ---
  $('#btn-empty-add').onclick = () => $('#file-input').click();
  const fileInput = $('#file-input');
  fileInput.setAttribute('accept', acceptAttribute());
  fileInput.onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  // Selector de carpeta (escaneo cuando no hay APK)
  const dirInput = $('#dir-input');
  if (dirInput) dirInput.onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) addFiles(files); // addFiles ya filtra solo audio
  };

  // --- escaneo del dispositivo ---
  $('#btn-scan').onclick = startScan;
  $('#btn-empty-scan').onclick = startScan;
  $('#btn-scan-cancel').onclick = () => {
    scanCancelled = true;
    $('#btn-scan-cancel').textContent = 'Cancelando…';
  };

  // --- menú superior (donde antes estaba el botón +) ---
  $('#btn-settings').onclick = () => toggleTopMenu();
  $('#top-menu-backdrop').onclick = () => toggleTopMenu(false);
  $$('#top-menu button').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.top;
      toggleTopMenu(false);
      if (act === 'add') $('#file-input').click();
      else if (act === 'colors') openModal('modal-colors', renderColorGrid);
      else if (act === 'mode') cycleTheme();
      else if (act === 'settings') openModal('modal-settings');
    };
  });

  // --- ajustes, colores y acerca de ---
  $('#set-colors').onclick = () => openModal('modal-colors', renderColorGrid);
  $('#about-colors').onclick = () => openModal('modal-colors', renderColorGrid);
  $('#about-settings').onclick = () => openModal('modal-settings');
  // Tocar la versión abre el registro de cambios de cada versión
  $('#about-version').onclick = () => openModal('modal-changelog', renderChangelog);

  // Aviso global cuando entra en juego el conversor ffmpeg.wasm
  onDecodeProgress(({ phase }) => {
    if (phase === 'start') toast('Formato no nativo: convirtiendo con ffmpeg…', 8000);
    else if (phase === 'done') toast('✓ Conversión completada', 3000);
  });

  // drag & drop global de archivos
  let dragCounter = 0;
  window.addEventListener('dragenter', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      dragCounter++;
      $('#dropzone').hidden = false;
    }
  });
  window.addEventListener('dragleave', () => {
    if (--dragCounter <= 0) { dragCounter = 0; $('#dropzone').hidden = true; }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    $('#dropzone').hidden = true;
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  });

  // --- navegación inferior (5 iconos) ---
  $$('.nav-item').forEach((item) => {
    item.onclick = () => setTab(item.dataset.tab);
  });

  // --- búsqueda ---
  $('#btn-search').onclick = () => {
    const bar = $('#search-bar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#search-input').focus();
    else { state.query = ''; $('#search-input').value = ''; renderLibrary(); }
  };
  $('#btn-search-close').onclick = () => $('#btn-search').click();
  $('#search-input').oninput = debounce((e) => {
    state.query = e.target.value;
    renderLibrary();
  }, 150);

  // --- orden ---
  $('#sort-select').onchange = (e) => {
    state.sort = e.target.value;
    saveSetting('sort', state.sort);
    renderLibrary();
  };
  const sortDirBtn = $('#sort-dir');
  if (sortDirBtn) {
    sortDirBtn.onclick = () => {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      saveSetting('sortDir', state.sortDir);
      paintSortDir();
      renderLibrary();
    };
  }
  paintSortDir();

  // --- tema ---
  $('#btn-theme').onclick = cycleTheme;

  // --- biblioteca: clicks ---
  $('#library-list').addEventListener('click', onTrackListClick);
  $('#library-list').addEventListener('contextmenu', onTrackContext);
  $('#library-list').addEventListener('pointerdown', onLongPress);

  // --- vista por carpetas (agrupar por ubicación) ---
  const viewBtn = $('#btn-view-folders');
  if (viewBtn) viewBtn.onclick = () => {
    state.view = state.view === 'folders' ? 'tracks' : 'folders';
    state.folder = null;
    saveSetting('libView', state.view);
    renderLibrary();
    const c = $('#content');
    if (c) c.scrollTop = 0;
    toast(state.view === 'folders' ? '📁 Ver por carpetas' : '🎵 Ver todas las canciones', 1800);
  };

  // --- cargar más filas al llegar al final del scroll ---
  let scrollPending = false;
  $('#content').addEventListener('scroll', () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => { scrollPending = false; loadMoreVisible(); });
  }, { passive: true });

  // --- playlists ---
  $('#btn-new-playlist').onclick = () => promptNewPlaylist();
  $('#btn-empty-new-playlist').onclick = () => promptNewPlaylist();
  $('#playlist-list').addEventListener('click', onPlaylistClick);
  // Las canciones de la playlist abierta se pintan en #playlist-detail,
  // así que necesitan sus propios manejadores de clic/menú.
  const detail = $('#playlist-detail');
  if (detail) {
    detail.addEventListener('click', onTrackListClick);
    detail.addEventListener('contextmenu', onTrackContext);
    detail.addEventListener('pointerdown', onLongPress);
  }
  $('#playlist-list').addEventListener('dragover', (e) => {
    const pl = e.target.closest('.playlist');
    if (!pl || !e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    $$('.playlist').forEach((x) => x.classList.toggle('drag-over', x === pl));
  });
  $('#playlist-list').addEventListener('dragleave', () => $$('.playlist').forEach((x) => x.classList.remove('drag-over')));
  $('#playlist-list').addEventListener('drop', async (e) => {
    const pl = e.target.closest('.playlist');
    $$('.playlist').forEach((x) => x.classList.remove('drag-over'));
    if (!pl) return;
    const id = e.dataTransfer.getData('text/plain');
    if (id && trackById(id)) { e.preventDefault(); addToPlaylist(pl.dataset.id, [id]); }
  });

  // --- cola ---
  $('#queue-list').addEventListener('click', onTrackListClick);
  $('#queue-list').addEventListener('contextmenu', onTrackContext);
  $('#btn-clear-queue').onclick = () => {
    state.queue = state.currentId ? [state.currentId] : [];
    state.queueIndex = state.currentId ? 0 : -1;
    renderQueue();
    toast('Cola vaciada');
  };

  // --- arrastrar biblioteca -> playlist ---
  document.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.track');
    if (li && !li.closest('#pl-track-list')) {
      e.dataTransfer.setData('text/plain', li.dataset.id);
      e.dataTransfer.effectAllowed = 'copy';
    }
  });

  // --- controles del reproductor ---
  $('#btn-play').onclick = togglePlay;
  $('#btn-next').onclick = () => nextTrack();
  $('#btn-prev').onclick = prevTrack;
  $('#btn-shuffle').onclick = () => {
    state.shuffle = !state.shuffle;
    $('#btn-shuffle').classList.toggle('on', state.shuffle);
    saveSetting('shuffle', state.shuffle);
    toast(state.shuffle ? 'Aleatorio: activado' : 'Aleatorio: desactivado');
  };
  $('#btn-repeat').onclick = () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    updateRepeatUI();
    saveSetting('repeat', state.repeat);
    toast(state.repeat === 'off' ? 'Repetir: no' : state.repeat === 'all' ? 'Repetir: todo' : 'Repetir: una');
  };

  // --- barra mini + pantalla completa ---
  $('#mini-play').onclick = () => togglePlay();
  $('#mini-open').onclick = () => openFs();
  $('#fs-close').onclick = () => closeFs();
  $('#fs-sheet-close').onclick = () => closeSheet();
  $('#fs-sheet-backdrop').onclick = () => closeSheet();
  $('#btn-sleep-2').onclick = () => openModal('modal-sleep');
  $('#btn-fs-queue').onclick = () => { closeFs(); setTab('queue'); };
  $('#btn-fav').onclick = () => toggleFav(state.currentId);
  $('#fs-menu').onclick = () => openSheet('all');
  $$('#sheet-menu [data-menu]').forEach((b) => {
    b.onclick = () => onSheetMenu(b.dataset.menu);
  });
  wireFsSwipe();

  // --- favoritos: clics en la lista ---
  $('#favorites-list').addEventListener('click', onTrackListClick);
  $('#favorites-list').addEventListener('contextmenu', onTrackContext);
  $('#favorites-list').addEventListener('pointerdown', onLongPress);

  // --- ajustes ---
  $$('[data-theme-set]').forEach((b) => {
    b.onclick = () => {
      applyTheme(b.dataset.themeSet);
      syncThemeSeg();
      toast(
        b.dataset.themeSet === 'auto' ? 'Tema: automático'
          : b.dataset.themeSet === 'light' ? 'Tema: claro' : 'Tema: oscuro'
      );
    };
  });
  $('#set-sleep').onclick = () => openModal('modal-sleep');

  // seek
  const seek = $('#seek');
  seek.addEventListener('input', () => {
    if (!engine.current) return;
    $('#time-current').textContent = formatTime((seek.value / 1000) * engine.duration);
  });
  seek.addEventListener('change', () => {
    if (!engine.current) return;
    engine.seek(seek.value / 1000);
    pushMediaState(true);   // la notificación/widget actualizan la posición
  });

  // --- panel avanzado ---
  $('#btn-adv-toggle').onclick = (e) => {
    const adv = $('#advanced');
    const open = adv.hidden;
    adv.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.querySelector('span').textContent = open ? 'Menos controles' : 'Más controles';
  };

  $('#speed').oninput = (e) => {
    engine.setSpeed(parseFloat(e.target.value));
    syncAdvancedLabels();
    saveSetting('speed', engine.speed);
  };
  $('#pitch').oninput = (e) => {
    engine.setPitch(parseInt(e.target.value, 10));
    syncAdvancedLabels();
    saveSetting('pitch', engine.pitch);
  };
  // El cambio de TONO necesita el modo decodificado: al soltar el control,
  // si hay que cambiar de modo se recarga la canción en el mismo punto
  // (no se hace mientras se arrastra, para no cortar el sonido).
  $('#pitch').addEventListener('change', () => {
    if (engine.isStreaming() !== engine.canStream()) {
      playTrack(state.queueIndex, { startAt: engine.position }).catch(() => {});
    }
  });
  $('#eq-preset').onchange = (e) => {
    engine.applyEq(e.target.value);
    syncAdvancedLabels();
    saveSetting('eq', engine.eq);
  };
  $('#crossfade').oninput = (e) => {
    engine.crossfadeSec = parseInt(e.target.value, 10);
    syncAdvancedLabels();
    saveSetting('crossfade', engine.crossfadeSec);
  };
  $('#boost').oninput = (e) => {
    engine.setBoost(parseInt(e.target.value, 10) / 100);
    syncAdvancedLabels();
    saveSetting('boost', engine.boost);
  };
  // Control de volumen (junto al sound boost, como se pidió)
  const volInput = $('#vol');
  if (volInput) volInput.oninput = (e) => {
    applyVolume(parseInt(e.target.value, 10));
  };

  // Mismos controles dentro del reproductor a pantalla completa.
  const fsVol = $('#fs-vol');
  if (fsVol) fsVol.oninput = (e) => {
    if (volInput) volInput.value = e.target.value;
    applyVolume(parseInt(e.target.value, 10));
  };
  const fsBoost = $('#fs-boost');
  if (fsBoost) fsBoost.oninput = (e) => {
    engine.setBoost(parseInt(e.target.value, 10) / 100);
    $('#boost').value = e.target.value;
    syncAdvancedLabels();
    saveSetting('boost', engine.boost);
  };
  $('#btn-reset-audio').onclick = () => {
    engine.resetSpeedPitch();
    $('#speed').value = 1;
    $('#pitch').value = 0;
    syncAdvancedLabels();
    saveSetting('speed', 1);
    saveSetting('pitch', 0);
    toast('Velocidad y tono restablecidos');
  };
  $('#btn-sleep').onclick = () => openModal('modal-sleep');
  $('#btn-add-to-playlist').onclick = () => {
    if (state.currentId) openAddToPlaylistModal(null, false, state.currentId);
    else toast('No hay nada reproduciéndose');
  };
  $('#btn-track-info').onclick = () => {
    if (state.currentId) openInfoModal(state.currentId);
    else toast('No hay nada reproduciéndose');
  };

  // --- menú contextual ---
  $('#ctx-menu').addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (item) handleCtxAction(item.dataset.action);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctx-menu')) closeContextMenu();
  });

  // --- modales ---
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#modal-backdrop')) return closeModal();
    const btn = e.target.closest('[data-close]');
    if (btn) closeModal(btn.closest('.modal')?.id);
  });
  $$('[data-sleep]').forEach((b) => {
    b.onclick = () => { setSleepTimer(b.dataset.sleep); closeModal('modal-sleep'); };
  });
  $('#new-playlist-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-create-playlist').click();
  });

  // --- dropzone hint en playlists ---
  document.addEventListener('dragstart', () => {
    if (state.tab === 'playlists' && !state.openPlaylist) {
      $('#playlist-drop-hint').classList.add('show');
      setTimeout(() => $('#playlist-drop-hint').classList.remove('show'), 2500);
    }
  });

  // --- atajos de teclado ---
  document.addEventListener('keydown', onKeydown);

  // --- visibilidad: NUNCA se pausa al ocultar ---
  // Antes esto pausaba la música al minimizar/ bloquear el teléfono y
  // era el motivo de "al salir de la app se para". La reproducción en
  // segundo plano la mantiene el servicio nativo (notificación + MediaSession).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // al volver: refrescar la barra/notificación por si el sistema la
      // había quedado desactualizada mientras la app estaba oculta
      if (state.playing) pushMediaState(true);
    }
  });
}

function onTrackListClick(e) {
  // --- carpeta: abrir sus canciones (vista agrupada por ubicación) ---
  const folderLi = e.target.closest('#library-list .folder');
  if (folderLi) {
    state.folder = folderLi.dataset.folder || '';
    renderLibrary();
    const c = $('#content');
    if (c) c.scrollTop = 0;
    return;
  }

  const more = e.target.closest('[data-act]');
  const li = e.target.closest('.track');
  if (!li) return;
  // el tirador de arrastre no debe disparar reproducción
  if (e.target.closest('.drag-handle')) return;
  const id = li.dataset.id;

  if (more) {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    if (more.dataset.act === 'menu') return openContextMenu(r.left - 170, r.bottom + 4, id, sourceOf(li));
    if (more.dataset.act === 'remove-from-playlist') {
      return removeFromPlaylist(state.openPlaylist, id);
    }
  }

  const list = li.closest('#library-list')
    ? currentLibraryIds()
    : li.closest('#favorites-list')
      ? filteredTracks(state.tracks.filter((t) => t.fav)).map((t) => t.id)
      : li.closest('#pl-track-list')
        ? (state.playlists.find((p) => p.id === state.openPlaylist)?.trackIds || [])
        : state.queue.slice();

  const idx = list.indexOf(id);
  if (idx > -1) playFromList(list, idx);
}

function sourceOf(li) {
  if (li.closest('#library-list')) return 'library';
  if (li.closest('#favorites-list')) return 'favorites';
  if (li.closest('#pl-track-list')) return 'playlist';
  if (li.closest('#queue-list')) return 'queue';
  return 'library';
}

function onTrackContext(e) {
  const li = e.target.closest('.track');
  if (!li) return;
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY, li.dataset.id, sourceOf(li));
}

let longPressTimer;
function onLongPress(e) {
  if (e.pointerType === 'mouse') return;
  const li = e.target.closest('.track');
  if (!li) return;
  const { clientX: x, clientY: y } = e;
  longPressTimer = setTimeout(() => {
    openContextMenu(x, y, li.dataset.id, sourceOf(li));
    if (navigator.vibrate) navigator.vibrate(12);
  }, 480);
  const clear = () => { clearTimeout(longPressTimer); document.removeEventListener('pointerup', clear); document.removeEventListener('pointermove', clear); };
  document.addEventListener('pointerup', clear);
  document.addEventListener('pointermove', clear);
}

function onPlaylistClick(e) {
  const li = e.target.closest('.playlist');
  if (!li) return;
  const pl = state.playlists.find((p) => p.id === li.dataset.id);
  if (!pl) return;

  const menuBtn = e.target.closest('[data-act="playlist-menu"]');
  if (menuBtn) {
    e.stopPropagation();
    const r = menuBtn.getBoundingClientRect();
    return openPlaylistMenu(r.left - 170, r.bottom + 4, pl);
  }

  state.openPlaylist = pl.id;
  renderPlaylistDetail();
}

function openPlaylistMenu(x, y, pl) {
  const menu = $('#ctx-menu');
  state.ctxTrackId = null;
  menu.innerHTML = `
    <button class="ctx-item" data-pl="open">📂 Abrir playlist</button>
    <button class="ctx-item" data-pl="play">▶ Reproducir</button>
    <button class="ctx-item" data-pl="rename">✎ Renombrar</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item danger" data-pl="delete">🗑 Eliminar playlist</button>`;
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;

  menu.onclick = (e) => {
    const b = e.target.closest('[data-pl]');
    if (!b) return;
    closeContextMenu();
    restoreCtxMenu();
    const a = b.dataset.pl;
    if (a === 'open') { state.openPlaylist = pl.id; renderPlaylistDetail(); }
    if (a === 'play') {
      if (!pl.trackIds.length) return toast('La playlist está vacía');
      state.openPlaylist = null;
      setTab('library');
      playFromList(pl.trackIds, 0);
    }
    if (a === 'rename') { state.openPlaylist = pl.id; renderPlaylistDetail(); setTimeout(() => $('#pl-name-input')?.select(), 80); }
    if (a === 'delete') confirmDeletePlaylist(pl);
  };
}

// Restaura el HTML original del menú contextual
const CTX_HTML = $('#ctx-menu').innerHTML;
function restoreCtxMenu() {
  const menu = $('#ctx-menu');
  menu.innerHTML = CTX_HTML;
  menu.onclick = null;
}

// ============================================================
// ATAJOS DE TECLADO
// ============================================================
function onKeydown(e) {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if (e.key === 'Escape') {
    const menu = $('#top-menu');
    if (menu && !menu.hidden) return toggleTopMenu(false);
    if (!$('#fs-sheet').hidden) return closeSheet();
    if (!$('#fs-player').hidden) return closeFs();
    if (!$('#modal-backdrop').hidden) return closeModal();
    if (!$('#ctx-menu').hidden) return restoreCtxMenu(), closeContextMenu();
    if (!$('#search-bar').hidden) return $('#btn-search').click();
  }
  if (typing) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) nextTrack();
      else if (engine.current) engine.seek((engine.position + 5) / engine.duration);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) prevTrack();
      else if (engine.current) engine.seek((engine.position - 5) / engine.duration);
      break;
    case 'ArrowUp': {
      e.preventDefault();
      const v = clamp(volumePercent() + 5, 0, 100);
      applyVolume(v);
      toast(`Volumen ${v}%`, 900);
      break;
    }
    case 'ArrowDown': {
      e.preventDefault();
      const v = clamp(volumePercent() - 5, 0, 100);
      applyVolume(v);
      toast(`Volumen ${v}%`, 900);
      break;
    }
    case 'n': case 'N': nextTrack(); break;
    case 'p': case 'P': prevTrack(); break;
    case 's': case 'S': $('#btn-shuffle').click(); break;
    case 'r': case 'R': $('#btn-repeat').click(); break;
    case 't': case 'T': cycleTheme(); break;
    case 'm': case 'M': {
      const cur = volumePercent();
      if (cur > 0) {
        volumeRestore = cur;
        applyVolume(0);
        toast('Silenciado', 900);
      } else {
        applyVolume(volumeRestore);
        toast(`Volumen ${volumeRestore}%`, 900);
      }
      break;
    }
    case '/':
      e.preventDefault();
      $('#btn-search').click();
      break;
  }
}

// ============================================================
// ARRANQUE
// ============================================================
boot().catch((e) => {
  console.error(e);
  toast('Error al iniciar: ' + e.message, 5000);
});
