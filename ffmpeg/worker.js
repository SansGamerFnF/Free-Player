/* ============================================================
   Free Player — worker de conversión (ffmpeg.wasm)
   Se crea solo cuando aparece un formato que el navegador no
   decodifica. Descarga el núcleo (≈30 MB) con progreso y
   transcodifica a un formato nativo.
   ============================================================ */

let core = null;
let loading = null;
// id del trabajo en curso: así el progreso siempre llega al correcto
let activeId = 0;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

async function fetchWithProgress(url, id) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' al descargar el motor');
  const total = Number(res.headers.get('Content-Length')) || 0;

  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    post({ id, type: 'progress', phase: 'download', pct: 100 });
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    post({
      id,
      type: 'progress',
      phase: 'download',
      pct: Math.min(99, Math.round((received / total) * 100)),
    });
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  post({ id, type: 'progress', phase: 'download', pct: 100 });
  return out;
}

async function ensureCore(id) {
  if (core) return core;
  if (loading) return loading;

  loading = (async () => {
    // Carga clásica: el worker vive en /ffmpeg/ y el núcleo al lado
    if (typeof self.createFFmpegCore !== 'function') {
      importScripts('ffmpeg-core.js');
    }
    if (typeof self.createFFmpegCore !== 'function') {
      throw new Error('No se pudo cargar ffmpeg-core.js');
    }

    post({ id: activeId, type: 'progress', phase: 'download', pct: 0 });
    const wasmBinary = await fetchWithProgress('ffmpeg-core.wasm', activeId);

    core = await self.createFFmpegCore({
      mainScriptUrlOrBlob: self.location.href,
      wasmBinary,
      print: (m) => post({ id: activeId, type: 'log', data: String(m) }),
      printErr: (m) => post({ id: activeId, type: 'log', data: String(m) }),
    });
    core.setLogger((d) =>
      post({ id: activeId, type: 'log', data: String(d && d.message != null ? d.message : d) })
    );
    core.setProgress((d) =>
      post({ id: activeId, type: 'progress', phase: 'encode', pct: Math.round((d.progress || 0) * 100) })
    );
    return core;
  })();

  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

function runFFmpeg(c, args) {
  c.reset();
  try {
    c.exec(...args);
  } catch (e) {
    // exec lanza si ffmpeg termina con error; el código queda en ret
    if (typeof c.ret !== 'number') throw e;
  }
  return c.ret;
}

async function transcode({ id, bytes, ext }) {
  const c = await ensureCore(id);
  const input = '/input.' + (ext || 'bin');
  const candidates = [
    // salida nativa compacta → se puede guardar y volver a decodificar
    { args: ['-c:a', 'aac', '-b:a', '192k', '-f', 'mp4'], out: '/out.m4a' },
    { args: ['-c:a', 'flac', '-compression_level', '5', '-f', 'flac'], out: '/out.flac' },
    // último recurso: PCM sin comprimir
    { args: ['-f', 'wav'], out: '/out.wav' },
  ];

  const clean = (p) => { try { c.FS.unlink(p); } catch {} };
  clean(input);
  for (const cand of candidates) clean(cand.out);
  c.FS.writeFile(input, new Uint8Array(bytes));

  let result = null;
  let used = null;
  const errors = [];

  for (const cand of candidates) {
    post({ id, type: 'progress', phase: 'encode', pct: 0 });
    const ret = runFFmpeg(c, [
      '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', input, '-vn', '-sn', '-dn',
      ...cand.args, cand.out,
    ]);
    if (ret === 0) {
      try {
        const data = c.FS.readFile(cand.out);
        if (data && data.length > 44) {
          result = data;
          used = cand.out;
          break;
        }
      } catch (e) {
        errors.push(String(e));
      }
    } else {
      errors.push(cand.out + ' exit=' + ret);
    }
  }

  clean(input);
  if (used) clean(used);
  c.reset();

  if (!result) {
    throw new Error('No se pudo convertir .' + ext + ' (' + errors.join(' / ') + ')');
  }

  const buf = result.buffer.slice(
    result.byteOffset,
    result.byteOffset + result.byteLength
  );
  post(
    { id, type: 'done', bytes: buf, kind: used },
    [buf]
  );
}

self.onmessage = (e) => {
  const { id, type, data } = e.data || {};
  if (type === 'transcode') {
    activeId = id;
    transcode({ ...(data || {}), id }).catch((err) => {
      post({ id, type: 'error', message: String((err && err.message) || err) });
    });
  }
};
