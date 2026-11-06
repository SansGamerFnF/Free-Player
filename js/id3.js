// ============================================================
// Free Player — lector mínimo de etiquetas ID3v2 / ID3v1
// Extrae título, artista y álbum del archivo MP3.
// ============================================================

const dec = (bytes, enc) => {
  try {
    const label = { 0: 'windows-1252', 1: 'utf-16', 2: 'utf-16be', 3: 'utf-8' }[enc] || 'utf-8';
    return new TextDecoder(label).decode(bytes).replace(/\0+$/, '').trim();
  } catch {
    return '';
  }
};

const syncsafe = (dv, off) =>
  (dv.getUint8(off) << 21) | (dv.getUint8(off + 1) << 14) | (dv.getUint8(off + 2) << 7) | dv.getUint8(off + 3);

export async function parseTags(file) {
  const out = {};
  try {
    const head = await file.slice(0, 10).arrayBuffer();
    const hdv = new DataView(head);
    if (
      hdv.byteLength < 10 ||
      String.fromCharCode(hdv.getUint8(0), hdv.getUint8(1), hdv.getUint8(2)) !== 'ID3'
    ) {
      return parseV1(file);
    }

    const ver = hdv.getUint8(3);
    const tagSize = syncsafe(hdv, 6);
    const limit = Math.min(10 + tagSize, 1024 * 1024); // tope de 1 MB
    const buf = await file.slice(0, limit).arrayBuffer();
    const dv = new DataView(buf);

    let off = 10;
    const end = Math.min(10 + tagSize, dv.byteLength);
    while (off + 10 <= end) {
      const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = ver === 4 ? syncsafe(dv, off + 4) : dv.getUint32(off + 4);
      if (size <= 0 || off + 10 + size > end) break;

      const dataOff = off + 10;
      if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') {
        const enc = dv.getUint8(dataOff);
        const bytes = new Uint8Array(buf, dataOff + 1, size - 1);
        const val = dec(bytes, enc);
        if (val) {
          if (id === 'TIT2') out.title = val;
          if (id === 'TPE1') out.artist = val;
          if (id === 'TALB') out.album = val;
        }
      }
      if (id === 'TCON') {
        const v = dec(new Uint8Array(buf, dataOff + 1, size - 1), dv.getUint8(dataOff));
        if (v) out.genre = v;
      }
      off = dataOff + size;
    }
  } catch {
    /* sin tags válidos */
  }

  if (!out.title) return parseV1(file);
  return out;
}

async function parseV1(file) {
  try {
    const size = file.size;
    if (size < 128) return {};
    const buf = await file.slice(size - 128).arrayBuffer();
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2)) !== 'TAG') return {};
    const read = (off, len) =>
      new TextDecoder('windows-1252').decode(new Uint8Array(buf, off, len)).replace(/\0.*$/, '').trim();
    return { title: read(3, 30), artist: read(33, 30), album: read(63, 30) };
  } catch {
    return {};
  }
}
