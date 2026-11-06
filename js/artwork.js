// ============================================================
// Free Player — extractor de carátulas incrustadas
//
// Soporta:
//   • MP3   → frame ID3v2 APIC (v2.2 PICT, v2.3/v2.4 APIC)
//   • M4A   → átomo iTunes "covr" dentro de moov/udta/meta/ilst
//   • FLAC  → bloque de metadatos PICTURE (tipo 6)
//   • WAV   → lista INFO "ICMT"? no; devuelve null
//
// Devuelve un Blob (image/*) o null si no hay carátula.
// ============================================================

const MAX_HEADER = 6 * 1024 * 1024; // tope de lectura de cabeceras

export function imageMime(bytes) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  return '';
}

function blobOf(bytes, mime) {
  const m = mime || imageMime(bytes);
  if (!m || bytes.length < 100) return null;
  return new Blob([bytes], { type: m });
}

// ---------- detección de contenedor ----------
export async function extractArtwork(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (head.byteLength < 12) return null;
    const a = (o, n) => String.fromCharCode(...head.subarray(o, o + n));

    if (a(0, 3) === 'ID3') return fromID3(file);
    if (a(4, 4) === 'ftyp') return fromMP4(file);
    if (a(0, 4) === 'fLaC') return fromFLAC(file);
    if (a(0, 4) === 'RIFF' && a(8, 4) === 'WAVE') return fromRIFF(file); // BEXT/ICMT no; pero por si acaso
  } catch {
    /* sin carátula */
  }
  return null;
}

// ============================================================
// ID3v2 — APIC / PICT
// ============================================================
async function fromID3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head.byteLength < 10) return null;
  const dv = new DataView(head.buffer);
  const ver = head[3];
  const tagSize =
    ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  if (!tagSize) return null;

  const limit = Math.min(10 + tagSize, MAX_HEADER);
  const buf = await file.slice(0, limit).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  let off = 10;
  const end = Math.min(10 + tagSize, bytes.length);
  while (off + 6 <= end) {
    const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id) && id !== 'PICT') break;

    const size =
      ver === 4
        ? ((bytes[off + 4] & 0x7f) << 21) | ((bytes[off + 5] & 0x7f) << 14) |
          ((bytes[off + 6] & 0x7f) << 7) | (bytes[off + 7] & 0x7f)
        : view.getUint32(off + 4);
    if (size <= 0 || off + 10 + size > end) break;

    if (id === 'APIC' || id === 'PICT') {
      const frame = bytes.subarray(off + 10, off + 10 + size);
      const art = parseAPIC(frame);
      if (art) return art;
    }
    off = off + 10 + size;
  }
  return null;
}

function parseAPIC(frame) {
  if (frame.length < 8) return null;
  const enc = frame[0]; // 0=latin1 1=utf16 2=utf16be 3=utf8

  // 1) tipo MIME (terminado en 0, o en 00 00 si es UTF-16)
  let i = 1;
  let mime = '';
  if (enc === 1 || enc === 2) {
    let t = -1;
    for (let k = i; k + 1 < frame.length; k += 2) {
      if (frame[k] === 0 && frame[k + 1] === 0) { t = k; break; }
    }
    if (t < 0) return null;
    mime = 'image/jpeg'; // los APIC en UTF-16 suelen llevar extensión en vez de MIME
    i = t + 2;
  } else {
    let t = -1;
    for (let k = i; k < frame.length; k++) if (frame[k] === 0) { t = k; break; }
    if (t < 0) return null;
    mime = latin1(frame.subarray(i, t));
    i = t + 1;
  }

  // 2) tipo de imagen (1 byte) — ignorado, identificamos por magia
  i += 1;

  // 3) descripción (terminada según codificación)
  if (enc === 1 || enc === 2) {
    let t = -1;
    for (let k = i; k + 1 < frame.length; k += 2) {
      if (frame[k] === 0 && frame[k + 1] === 0) { t = k; break; }
    }
    if (t < 0) return null;
    i = t + 2;
  } else {
    let t = -1;
    for (let k = i; k < frame.length; k++) if (frame[k] === 0) { t = k; break; }
    if (t < 0) return null;
    i = t + 1;
  }

  const data = frame.slice(i);
  if (data.length < 100) return null;
  if (!mime || !/^image\//i.test(mime)) mime = imageMime(data);
  return blobOf(data, mime);
}

function latin1(u8) {
  try { return new TextDecoder('windows-1252').decode(u8); } catch { return ''; }
}

// ============================================================
// MP4 / M4A / 3GP — átomo "covr"
//
// El átomo "moov" puede estar al principio (faststart) o al final
// del archivo, así que localizamos su OFFSET leyendo solo las
// cabeceras y después leemos únicamente ese trozo.
// ============================================================
async function fromMP4(file) {
  const moov = await locateMoov(file);
  if (!moov) return null;

  const buf = await file.slice(moov.offset, moov.offset + Math.min(moov.size, MAX_HEADER)).arrayBuffer();
  const u8 = new Uint8Array(buf);

  const udta = findBox(u8, 0, u8.length, 'udta');
  if (udta < 0) return null;
  const meta = findBox(u8, udta.s, udta.e, 'meta');
  if (meta < 0) return null;
  // "meta" lleva 4 bytes de versión/flags antes de sus hijos
  const ilst = findBox(u8, meta.s + 4, meta.e, 'ilst');
  if (ilst < 0) return null;
  const covr = findBox(u8, ilst.s, ilst.e, 'covr');
  if (covr < 0) return null;
  const data = findBox(u8, covr.s, covr.e, 'data');
  if (data < 0) return null;

  // data: [version+flags (4)] [locale (4)] [payload]
  const payload = u8.slice(data.s + 8, data.e);
  return blobOf(payload, '');
}

/** Recorre las cajas de nivel superior leyendo solo 16 bytes de cabecera. */
async function locateMoov(file) {
  let p = 0;
  while (p + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(p, p + 16).arrayBuffer());
    if (h.byteLength < 8) return null;
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    let header = 8;
    if (size === 1) {
      if (h.byteLength < 16) return null;
      size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
      header = 16;
    } else if (size === 0) {
      size = file.size - p;
    }
    if (size < header || p + size > file.size + 8) return null;
    if (type === 'moov') return { offset: p + header, size: size - header };
    p += size;
  }
  return null;
}

/** Localiza un átomo (caja) de 4 letras. Devuelve {s,e} o -1. */
function findBox(u8, start, end, type) {
  let p = start;
  end = Math.min(end, u8.length);
  while (p + 8 <= end) {
    const dv = new DataView(u8.buffer, u8.byteOffset + p, 8);
    let size = dv.getUint32(0);
    const t = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return -1;
      const hi = dv.getUint32(8);
      const lo = dv.getUint32(12);
      size = hi * 4294967296 + lo;
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return -1;
    if (t === type) return { s: p + header, e: p + size };
    p += size;
  }
  return -1;
}

// ============================================================
// FLAC — bloque PICTURE (tipo 6)
// ============================================================
async function fromFLAC(file) {
  const buf = await file.slice(0, Math.min(file.size, MAX_HEADER)).arrayBuffer();
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let p = 4; // tras "fLaC"

  while (p + 4 <= u8.length) {
    const flag = u8[p];
    const type = flag & 0x7f;
    const len = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
    const s = p + 4;
    if (len < 0 || s + len > u8.length) break;

    if (type === 6) {
      const img = parsePictureBlock(dv, u8, s, len);
      if (img) return img;
    }
    if (type === 4 && len > 0) {
      // VORBIS_COMMENT: puede traer METADATA_BLOCK_PICTURE en base64
      const img = parseVorbisPicture(u8.subarray(s, s + len));
      if (img) return img;
    }
    p = s + len;
    if (flag & 0x80) break; // último bloque
  }
  return null;
}

function parsePictureBlock(dv, u8, s, len) {
  let p = s;
  const need = (n) => p + n <= s + len;
  if (!need(4)) return null;
  p += 4; // tipo MIME (enum)
  if (!need(4)) return null;
  const mimeLen = dv.getUint32(p); p += 4;
  if (!need(mimeLen + 4)) return null;
  p += mimeLen;                    // mime
  const descLen = dv.getUint32(p); p += 4;
  if (!need(descLen + 20)) return null;
  p += descLen;                    // descripción
  p += 16;                         // ancho, alto, profundidad, colores
  if (!need(4)) return null;
  const dataLen = dv.getUint32(p); p += 4;
  if (!need(dataLen)) return null;
  const data = u8.slice(p, p + dataLen);
  return blobOf(data, '');
}

function parseVorbisPicture(u8) {
  try {
    const text = new TextDecoder('utf-8').decode(u8);
    const m = text.match(/METADATA_BLOCK_PICTURE\s*=\s*([A-Za-z0-9+/=\s]+)/);
    if (!m) return null;
    const b64 = m[1].replace(/\s+/g, '');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length < 100) return null;
    // cabecera del bloque: 4+4+mime+4+desc+16+4 → saltarla
    const dv = new DataView(bytes.buffer);
    let p = 4;
    const mimeLen = dv.getUint32(p); p += 4 + mimeLen;
    const descLen = dv.getUint32(p); p += 4 + descLen;
    p += 16;
    const dataLen = dv.getUint32(p); p += 4;
    const data = bytes.slice(p, p + dataLen);
    return blobOf(data, '');
  } catch {
    return null;
  }
}

// ============================================================
// RIFF/WAV — sin carátula habitual (devuelve null salvo LIST/INFO)
// ============================================================
async function fromRIFF(file) {
  return null;
}
