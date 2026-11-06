// ============================================================
// Free Player — registro de formatos de audio
//
// Tres niveles:
//   NATIVE    → los decodifica el propio navegador (rápido)
//   EXTENDED  → necesita el motor ffmpeg.wasm (se descarga bajo demanda)
//   NO        → sin soporte (tracker / MIDI): se informa claramente
// ============================================================

// --- Nativos del navegador (Web Audio decodeAudioData) ---
export const NATIVE = [
  'mp3', 'm4a', 'm4b', 'mp4', 'aac', 'adts', 'wav', 'wave', 'flac',
  'ogg', 'oga', 'opus', 'weba', 'webm', 'mka', 'm4v',
];

// --- Conversión con ffmpeg.wasm (bajo demanda) ---
export const EXTENDED = {
  wma: 'Windows Media Audio',
  asf: 'Windows Media',
  aiff: 'Audio IFF',
  aif: 'Audio IFF',
  ac3: 'Dolby AC-3',
  eac3: 'Dolby E-AC-3',
  dts: 'DTS',
  tta: 'True Audio',
  tak: "TAK's Audio",
  wv: 'WavPack',
  ape: "Monkey's Audio",
  mpc: 'Musepack',
  mp2: 'MPEG Audio Layer II',
  mpga: 'MPEG Audio',
  alac: 'Apple Lossless',
  caf: 'Apple CAF',
  w64: 'Sony Wave64',
  au: 'Sun AU',
  snd: 'Sun AU',
  voc: 'Creative Voice',
  ircam: 'IRCAM/Berkeley',
  paf: 'Ensoniq PAF',
  pvf: 'PVF',
  xi: 'FastTracker II XI',
  sds: 'MIDI SDS',
  avr: 'Audio Vertraje',
  iff: 'IFF',
  svx: 'IFF SVX',
  '3gp': '3GPP',
  '3g2': '3GPP2',
  amr: 'AMR',
  ra: 'RealAudio',
  ram: 'RealAudio',
  gsm: 'GSM',
  mlp: 'Dolby MLP',
  spx: 'Speex',
  aiffc: 'AIFF-C',
  tta1: 'True Audio',
};

// --- Sin soporte (chiptunes / MIDI) ---
export const UNSUPPORTED = [
  'mod', 'xm', 'it', 's3m', 'mtm', 'ult', '669', 'mid', 'midi', 'rmi', 'kar',
];

const ALL_EXT = new Set([
  ...NATIVE, ...Object.keys(EXTENDED), ...UNSUPPORTED,
  // alias/contenedores habituales
  'aac3', 'aifc', 'mp+', 'mp1', 'mpc', 'ofr', 'ofs', 'tta2', 'ape1',
]);

/** Extensión en minúsculas sin punto, o ''. */
export function extOf(name = '') {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function isAudioFile(name = '') {
  const e = extOf(name);
  if (ALL_EXT.has(e)) return true;
  // acepta también por MIME cuando el navegador lo informa
  return false;
}

export function labelFor(ext = '') {
  return EXTENDED[ext] || null;
}

export function tierOf(ext = '') {
  if (NATIVE.includes(ext)) return 'native';
  if (ext in EXTENDED) return 'extended';
  if (UNSUPPORTED.includes(ext)) return 'unsupported';
  return 'unknown';
}

export function isSupported(ext = '') {
  return tierOf(ext) !== 'unsupported';
}

/** Atributo `accept` del input de archivos. */
export function acceptAttribute() {
  const exts = [...new Set([...NATIVE, ...Object.keys(EXTENDED)])].sort();
  const list = exts.map((e) => '.' + e).join(',');
  const mimes = [
    'audio/*', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac',
    'audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/x-ms-wma',
    'audio/aiff', 'audio/mp3',
  ].join(',');
  return `${mimes},${list}`;
}

/** Lista de formato para mostrar en la interfaz. */
export function friendlyList() {
  const native = ['MP3', 'M4A/AAC', 'FLAC', 'WAV', 'OGG', 'Opus', 'WebM'];
  const extended = ['WMA', 'AIFF', 'AC3', 'ALAC', 'TTA', 'WavPack', 'APE', 'MP2', 'CAF', 'AU', 'VOC', '3GP', 'AMR', 'DTS', 'MPC'];
  return { native, extended, unsupported: ['MOD', 'XM', 'IT', 'MIDI'] };
}

/** Matriz real de soporte del navegador (para diagnóstico). */
export function browserSupport() {
  const probes = {
    'audio/mpeg': 'MP3', 'audio/mp4': 'M4A/AAC', 'audio/aac': 'AAC',
    'audio/flac': 'FLAC', 'audio/ogg': 'OGG Vorbis',
    'audio/ogg; codecs=opus': 'Opus', 'audio/webm': 'WebM',
    'audio/wav': 'WAV', 'audio/x-wav': 'WAV', 'audio/aiff': 'AIFF',
    'audio/x-ms-wma': 'WMA', 'audio/amr': 'AMR', 'audio/midi': 'MIDI',
  };
  const el = document.createElement('audio');
  const out = {};
  for (const [mime, label] of Object.entries(probes)) {
    out[label] = el.canPlayType(mime) || 'no';
  }
  return out;
}
