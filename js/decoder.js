// ============================================================
// Free Player — cadena de decodificación de audio
//
//  1) Intento NATIVO: ctx.decodeAudioData (rápido, sin coste)
//  2) Fallback ffmpeg.wasm: transcodifica a AAC/FLAC/WAV en un
//     worker (se descarga el núcleo solo la primera vez).
//
// Soporta entrada Blob | File | ArrayBuffer.
// ============================================================

import { extOf, tierOf } from './formats.js';

let worker = null;
let seq = 0;
const pending = new Map();
const progressListeners = new Set();

// ---------- progreso global (para toasts) ----------
export function onDecodeProgress(cb) {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}
function emitProgress(info) {
  for (const cb of progressListeners) {
    try { cb(info); } catch { /* ignorar */ }
  }
}

// ---------- worker ----------
function getWorker() {
  if (worker) return worker;
  worker = new Worker('ffmpeg/worker.js');
  worker.onmessage = (e) => {
    const { id, type, pct, phase, bytes, message } = e.data || {};
    const job = pending.get(id);
    if (!job) return;

    if (type === 'progress') {
      emitProgress({ id, phase, pct, name: job.name });
      if (job.onProgress) job.onProgress(phase, pct);
      return;
    }
    if (type === 'log') return; // ruido de ffmpeg

    pending.delete(id);
    if (type === 'done') {
      job.resolve(bytes);
    } else {
      job.reject(new Error(message || 'Error de conversión'));
    }
  };
  worker.onerror = (e) => {
    const err = new Error('Motor de conversión falló: ' + (e.message || 'error desconocido'));
    for (const [, job] of pending) job.reject(err);
    pending.clear();
    try { worker.terminate(); } catch { /* ignorar */ }
    worker = null;
  };
  return worker;
}

/** Transcodifica bytes con ffmpeg.wasm. Devuelve ArrayBuffer. */
export function transcode(bytes, ext, { name = '', onProgress } = {}) {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress, name });
    // copia transferible para no consumir los bytes originales
    const copy = new Uint8Array(bytes);
    w.postMessage({ id, type: 'transcode', data: { bytes: copy.buffer, ext } }, [copy.buffer]);
  });
}

// ---------- identificación por contenido (sin extensión) ----------
export function sniffExt(u8) {
  const b = u8;
  const has = (off, ...sig) => sig.every((v, i) => b[off + i] === v);
  const ascii = (off, n) => String.fromCharCode(...b.subarray(off, off + n));

  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(4, 4) === 'ftyp') return 'm4a';
  if (ascii(0, 4) === 'MAC ') return 'ape';
  if (ascii(0, 4) === 'wvpk') return 'wv';
  if (ascii(0, 4) === 'TTA1') return 'tta';
  if (ascii(0, 3) === 'ID3' ) return 'mp3';
  if (ascii(0, 4) === '.snd') return 'au';
  if (ascii(0, 4) === 'FORM' && ascii(8, 3) === 'AIF') return 'aiff';
  if (ascii(0, 4) === 'caff') return 'caf';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'W64 ') return 'w64';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) == 'ASF ') return 'wma';
  if (has(0, 0x2e, 0x72, 0x61, 0x66)) return 'ra';
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'wma';
  if (ascii(0, 4) === 'ftyp' ) return 'm4a';
  if (ascii(4, 4) === 'moov' || ascii(4, 4) === 'mdat') return 'm4a';
  if (ascii(0, 4) === '\x1aE\xdf\xa3') return 'mka'; // EBML / Matroska
  if (has(0, 0xff, 0xf1) || has(0, 0xff, 0xf9)) return 'aac';
  if (has(0, 0xff, 0xfb) || has(0, 0xff, 0xfa) || has(0, 0xff, 0xf3) || has(0, 0xff, 0xf2)) return 'mp3';
  return '';
}

// ---------- API principal ----------
async function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input && typeof input.arrayBuffer === 'function') {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new Error('Entrada de audio no válida');
}

/**
 * Decodifica a AudioBuffer.
 * @param {BaseAudioContext} ctx
 * @param {Blob|File|ArrayBuffer} input
 * @param {object} opt  { name, ext, onProgress }
 */
export async function decodeAudio(ctx, input, opt = {}) {
  const { name = '', onProgress = null } = opt;
  const bytes = await toBytes(input);

  // extensión declarada → identificación por contenido → nombre del archivo
  const ext = (opt.ext || sniffExt(bytes) || extOf(name)).toLowerCase();
  const tier = tierOf(ext);
  let nativeErr = null;

  if (tier === 'unsupported') {
    throw new Error(
      `Formato .${ext} no soportado (chiptune/MIDI). Usa MP3, M4A, FLAC, WAV, OGG u Opus.`
    );
  }

  // --- 1) intento nativo sobre una copia (decodeAudioData consume el buffer) ---
  try {
    const copy = bytes.slice();
    const buf = await ctx.decodeAudioData(copy.buffer);
    if (buf && buf.duration > 0) return buf;
  } catch (e) {
    nativeErr = e;
  }

  // --- 2) fallback ffmpeg.wasm (también si el navegador "soporta" el
  //        formato pero su decodificador falla con ese archivo concreto) ---
  if (!ext) {
    throw new Error('Formato de audio no reconocido' + (nativeErr ? ': ' + (nativeErr.message || nativeErr) : ''));
  }

  emitProgress({ id: 0, phase: 'start', pct: 0, name });
  let out;
  try {
    out = await transcode(bytes, ext, { name, onProgress });
  } catch (e) {
    emitProgress({ id: 0, phase: 'error', pct: 100, name });
    throw e;
  }
  try {
    const buf = await ctx.decodeAudioData(out);
    if (!buf || buf.duration <= 0) throw new Error('salida vacía');
    emitProgress({ id: 0, phase: 'done', pct: 100, name });
    return buf;
  } catch (e) {
    emitProgress({ id: 0, phase: 'error', pct: 100, name });
    throw new Error('Conversión fallida para .' + ext + ': ' + (e && e.message));
  }
}
