// ============================================================
// Free Player — persistencia en IndexedDB
// Guarda metadatos + referencias, playlists y ajustes.
// ============================================================

const DB_NAME = 'freeplayer';
const DB_VERSION = 2;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('files')) {
        // blob por id de track
        db.createObjectStore('files', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('artwork')) {
        // carátula incrustada en el archivo (blob por id de track)
        db.createObjectStore('artwork', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqAll(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// ---------- Tracks ----------
export async function allTracks() {
  const r = await reqAll((await tx('tracks')).getAll());
  return r || [];
}

export function putTrack(track) {
  return tx('tracks', 'readwrite').then((s) => reqAll(s.put(track)));
}

/**
 * Guarda MUCHOS tracks en UNA sola transacción. Es la diferencia entre
 * escanear 5000 canciones en ~1 s y en dos minutos (antes se abría una
 * transacción por canción).
 */
export async function putTracksBulk(tracks) {
  if (!tracks || !tracks.length) return;
  const d = await open();
  const t = d.transaction('tracks', 'readwrite');
  const store = t.objectStore('tracks');
  for (const tr of tracks) store.put(tr);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(tracks.length);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transacción cancelada'));
  });
}

export function deleteTrack(id) {
  return open().then(async (db) => {
    const t = db.transaction(['tracks', 'files', 'artwork'], 'readwrite');
    t.objectStore('files').delete(id);
    t.objectStore('artwork').delete(id);
    t.objectStore('tracks').delete(id);
    return new Promise((res, rej) => {
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  });
}

// ---------- Carátulas ----------
export function putArtwork(id, blob) {
  return tx('artwork', 'readwrite').then((s) => reqAll(s.put({ id, blob })));
}

export async function getArtwork(id) {
  const rec = await reqAll((await tx('artwork')).get(id));
  return rec || null;
}

export function deleteArtwork(id) {
  return tx('artwork', 'readwrite').then((s) => reqAll(s.delete(id)));
}

/**
 * Borra las carátulas que guardaban las versiones anteriores (claves
 * 'sh…' por huella, 'alb…' por álbum y 'nm…' por nombre). Ahora la
 * carátula se lee del propio archivo y solo vive en memoria, así que
 * esto libera el espacio que ocupaban (cientos de MB en bibliotecas
 * grandes). Las carátulas de canciones importadas se conservan.
 */
export async function clearNativeArtworks() {
  const store = await tx('artwork', 'readwrite');
  return new Promise((resolve) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      if (/^(sh|alb|nm)/.test(String(cur.key))) cur.delete();
      cur.continue();
    };
    req.onerror = () => resolve();
  });
}

// ---------- Archivos (blobs) ----------
export function putFile(id, blob) {
  return tx('files', 'readwrite').then((s) => reqAll(s.put({ id, blob })));
}

export async function getFile(id) {
  const rec = await reqAll((await tx('files')).get(id));
  return rec ? rec.blob : null;
}

export async function hasFile(id) {
  const rec = await reqAll((await tx('files')).get(id));
  return !!rec;
}

// ---------- Playlists ----------
export async function allPlaylists() {
  const r = await reqAll((await tx('playlists')).getAll());
  return r || [];
}

export function putPlaylist(pl) {
  return tx('playlists', 'readwrite').then((s) => reqAll(s.put(pl)));
}

export function deletePlaylist(id) {
  return tx('playlists', 'readwrite').then((s) => reqAll(s.delete(id)));
}

// ---------- Ajustes ----------
export async function getSetting(key, fallback = null) {
  const rec = await reqAll((await tx('settings')).get(key));
  return rec ? rec.value : fallback;
}

export function setSetting(key, value) {
  return tx('settings', 'readwrite').then((s) => reqAll(s.put({ key, value })));
}
