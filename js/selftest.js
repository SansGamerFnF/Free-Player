// ============================================================
// Free Player — auto-prueba de UI
// Se activa con ?selftest=1 en la URL. Fase ?seed=1 crea 2
// pistas WAV sintéticas y recarga. Todo se reporta a /__log.
// ============================================================

import * as db from './db.js';
import { decodeAudio } from './decoder.js';
import { extractArtwork } from './artwork.js';
import { tierOf, extOf, browserSupport, acceptAttribute } from './formats.js';

const ENDPOINT = location.origin + '/__log';
const results = [];

function report(obj) {
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  }).catch(() => {});
}
function check(name, pass, extra = '') {
  results.push({ name, pass: !!pass, extra });
}
function step(msg) {
  report({ t: Date.now(), kind: 'STEP', msg, extra: '' });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn, timeout = 6000, every = 80) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(every);
  }
}
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function fire(el, type, init = {}) {
  const E = type.startsWith('drag') || type === 'drop' ? DragEvent : Event;
  el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, ...init }));
}

// ---------- gesto real del usuario ----------
// Firefox/Chrome no arrancan un AudioContext con clics sintéticos:
// esperamos un clic (o tecla) reales antes de medir la reproducción.
let gestureSeen = false;
const markGesture = (e) => { if (e.isTrusted) gestureSeen = true; };
document.addEventListener('click', markGesture, true);
document.addEventListener('pointerdown', markGesture, true);
document.addEventListener('keydown', markGesture, true);

function showHint(text) {
  const el = document.createElement('div');
  el.id = 'selftest-hint';
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed', top: '14px', left: '50%', transform: 'translateX(-50%)',
    zIndex: 99999, background: '#111827', color: '#fff', padding: '14px 22px',
    borderRadius: '16px', font: '600 15px/1.45 system-ui, sans-serif',
    boxShadow: '0 8px 30px rgba(0,0,0,.5)', maxWidth: '92vw', textAlign: 'center',
    cursor: 'pointer', border: '1px solid rgba(255,255,255,.25)',
  });
  document.body.appendChild(el);
  return el;
}

function visibleModals() {
  const v = $$('#modal-backdrop .modal').filter((m) => !m.hidden).map((m) => m.id);
  return v.length ? v.join(',') : 'ninguno';
}

function findPlaylist(name) {
  return [...document.querySelectorAll('.playlist')]
    .find((p) => (p.querySelector('.playlist-name') || {}).textContent === name) || null;
}

// ---------- generador de WAV ----------
function makeWav(freq, fileName, seconds = 1.4) {
  const sr = 44100;
  const n = Math.floor(sr * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 400, (n - i) / 400);
    const v = Math.sin((2 * Math.PI * freq * i) / sr) * 0.55 * env;
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
  }
  return new File([buf], fileName, { type: 'audio/wav' });
}

// ============================================================
// FASE 1: sembrar biblioteca
// ============================================================
async function seed() {
  const specs = [
    { freq: 440, name: 'Test Tono A.wav' },
    { freq: 660, name: 'Test Tono B.wav' },
  ];
  for (const s of specs) {
    const file = makeWav(s.freq, s.name);
    const id = 'selftest-' + s.freq;
    if (await db.hasFile(id)) continue;
    const track = {
      id, title: s.name.replace('.wav', ''), artist: 'AutoTest', album: 'Suite',
      genre: 'Test', duration: 1.4, size: file.size, ext: 'WAV', addedAt: Date.now(),
    };
    await db.putTrack(track);
    await db.putFile(id, file);
  }
  step('semillas creadas');
  location.replace(location.pathname + '?selftest=1');
}

// ============================================================
// FASE 2: pruebas de UI
// ============================================================
async function runTests() {
  step('inicio de pruebas');
  const hint = gestureSeen ? null : showHint(
    '▶️ Toca este aviso para habilitar la reproducción (el navegador exige un gesto real)'
  );

  // --- arranque ---
  await waitFor(() => $$('#library-list .track[data-id^="selftest-"]').length === 2, 6000);
  const seeds = $$('#library-list .track[data-id^="selftest-"]').length;
  check('boot: pistas de prueba en la biblioteca', seeds === 2,
    `${seeds}/2 · ${($('#lib-count') || {}).textContent}`);
  check('boot: sin errores JS', window.__errs.length === 0, window.__errs.join(' | '));
  check('boot: reproductor oculto', $('#player').hidden === true);
  check('nav: 5 iconos en la barra inferior', $$('.nav-item').length === 5,
    $$('.nav-item').length + ' iconos');
  check('nav: activa por defecto Canciones',
    ($('.nav-item.active') || {}).dataset?.tab === 'library',
    ($('.nav-item.active') || {}).dataset?.tab);
  check('boot: panel avanzado oculto', $('#advanced').hidden === true);
  const spSync = $('#speed-val').textContent === parseFloat($('#speed').value).toFixed(2) + '×';
  const pv = parseInt($('#pitch').value, 10);
  const piSync = $('#pitch-val').textContent === (pv > 0 ? '+' : '') + pv + ' st';
  check('boot: etiquetas sincronizadas con los controles', spSync && piSync,
    $('#speed-val').textContent + ' / ' + $('#pitch-val').textContent);

  // --- panel avanzado ---
  fire($('#btn-adv-toggle'), 'click');
  check('adv: se abre', $('#advanced').hidden === false);
  check('adv: botón cambia de texto', $('#btn-adv-toggle').textContent.includes('Menos'),
    $('#btn-adv-toggle').textContent.trim());

  // --- velocidad / tono independientes ---
  const speed = $('#speed');
  speed.value = '1.5'; fire(speed, 'input');
  check('speed: 1.50x', $('#speed-val').textContent === '1.50×', $('#speed-val').textContent);

  const pitch = $('#pitch');
  pitch.value = '5'; fire(pitch, 'input');
  check('pitch: +5 st', $('#pitch-val').textContent === '+5 st', $('#pitch-val').textContent);
  check('independencia: speed NO cambió con pitch', $('#speed-val').textContent === '1.50×', $('#speed-val').textContent);

  pitch.value = '-7'; fire(pitch, 'input');
  check('pitch: -7 st', $('#pitch-val').textContent === '-7 st', $('#pitch-val').textContent);
  check('independencia: speed sigue en 1.50x', $('#speed-val').textContent === '1.50×', $('#speed-val').textContent);

  // --- ecualizador / crossfade ---
  const eq = $('#eq-preset');
  eq.value = 'bass'; fire(eq, 'change');
  check('eq: preset Grave', $('#eq-val').textContent === 'Grave', $('#eq-val').textContent);
  const cf = $('#crossfade');
  cf.value = '5'; fire(cf, 'input');
  check('crossfade: 5 s', $('#crossfade-val').textContent === '5 s', $('#crossfade-val').textContent);

  // --- reset ---
  fire($('#btn-reset-audio'), 'click');
  check('reset: velocidad 1.00x', $('#speed-val').textContent === '1.00×', $('#speed-val').textContent);
  check('reset: tono 0 st', $('#pitch-val').textContent === '0 st', $('#pitch-val').textContent);

  // --- buscar ---
  fire($('#btn-search'), 'click');
  check('búsqueda: se abre', $('#search-bar').hidden === false);
  const total0 = $$('#library-list .track').length;
  const si = $('#search-input');
  si.value = 'zzzznoexiste'; fire(si, 'input');
  await sleep(500);
  check('búsqueda: filtra a 0', $('#lib-count').textContent.startsWith('0'), $('#lib-count').textContent);
  si.value = 'Tono A'; fire(si, 'input');
  await sleep(500);
  check('búsqueda: encuentra Test Tono A', $$('#library-list .track').length === 1,
    $$('#library-list .track').length + ' resultados');
  si.value = ''; fire(si, 'input');
  await sleep(400);
  check('búsqueda: restaura la biblioteca', $$('#library-list .track').length === total0,
    $$('#library-list .track').length + ' de ' + total0);
  fire($('#btn-search-close'), 'click');
  check('búsqueda: se cierra', $('#search-bar').hidden === true);

  // --- orden ---
  const sort = $('#sort-select');
  sort.value = 'artist'; fire(sort, 'change');
  check('orden: artist aplicado', sort.value === 'artist');
  sort.value = 'title'; fire(sort, 'change');

  // --- tema ---
  // El botón alterna/recorre auto → claro → oscuro: se comprueba el modo
  // aplicado (no el color, que además tarda en transicionar).
  const theme0 = document.body.dataset.theme;
  fire($('#btn-theme'), 'click');
  await sleep(350);
  const theme1 = document.body.dataset.theme;
  check('tema: cambia al pulsar', theme1 !== theme0 && !!theme1, theme0 + ' -> ' + theme1);
  let guard = 0;
  while (document.body.dataset.theme !== theme0 && guard++ < 4) {
    fire($('#btn-theme'), 'click');
    await sleep(350);
  }
  check('tema: vuelve al tema inicial', document.body.dataset.theme === theme0,
    document.body.dataset.theme + ' (era ' + theme0 + ')');

  // --- reproducción ---
  check('lista: hay pistas renderizadas', !!$('#library-list .track'));

  // Firefox/Chrome no arrancan el audio con clics sintéticos: pedimos un
  // gesto real (el aviso visible en pantalla) antes de medir la reproducción.
  if (!gestureSeen) {
    step('esperando un clic real del usuario para reproducir (máx. 20 s)');
    await waitFor(() => gestureSeen, 20000, 200);
  }
  if (hint) hint.remove();
  const gesture = gestureSeen;
  check('audio: permiso del navegador (gesto real)', gesture,
    gesture ? 'concedido' : 'sin clic real en 20 s');
  if (!gesture) step('sin gesto real: se omiten las pruebas de audio (posición, pausa, bus)');

  // se relee la fila: la lista puede haberse vuelto a pintar mientras tanto
  const firstTrack = $('#library-list .track');
  const expectedTitle = ((firstTrack || {}).querySelector?.('.track-title') || {}).textContent || '';
  const tPlay = Date.now();
  fire(firstTrack, 'click');
  const started = await waitFor(() => $('#player').hidden === false, 8000);
  check('play: reproductor visible', !!started, 'tras ' + (Date.now() - tPlay) + ' ms');
  check('play: título correcto', ($('#track-title') || {}).textContent === expectedTitle,
    ($('#track-title') || {}).textContent + ' (esperado: ' + expectedTitle + ')');
  check('mini: barra visible', $('#player').hidden === false);
  check('mini: título correcto', $('#mini-title').textContent === expectedTitle,
    $('#mini-title').textContent);
  if (gesture) {
    await waitFor(() => $('#btn-play').classList.contains('playing'), 8000);
    check('play: botón en estado play', $('#btn-play').classList.contains('playing'),
      'arranque en ' + (Date.now() - tPlay) + ' ms');
    step('reproducción lista en ' + (Date.now() - tPlay) + ' ms');
  }

  // --- pantalla completa + menú ---
  fire($('#mini-open'), 'click');
  check('fs: se abre', $('#fs-player').hidden === false);
  check('fs: línea técnica', ($('#track-tech') || {}).textContent.includes('•'),
    ($('#track-tech') || {}).textContent);
  fire($('#fs-menu'), 'click');
  check('fs: menú abierto', $('#fs-sheet').hidden === false);
  check('fs: 5 opciones en el menú', $$('#sheet-menu .sheet-item').length === 5,
    $$('#sheet-menu .sheet-item').length + ' opciones');
  fire($('[data-menu="speed"]'), 'click');
  check('fs: velocidad y tono abre los controles', $('#advanced').hidden === false);
  check('fs: solo filas de velocidad', 
    $$('#advanced .adv-item').every((el) => el.hidden || el.dataset.g === 'speed'));
  fire($('[data-menu="eq"]'), 'click');
  check('fs: ecualizador muestra su fila',
    $('#advanced .adv-item[data-g="eq"]').hidden === false &&
    $('#advanced .adv-item[data-g="speed"]').hidden === true);
  fire($('#fs-sheet-close'), 'click');
  check('fs: menú cerrado', $('#fs-sheet').hidden === true);
  const wasFav = $('#btn-fav').classList.contains('on');
  const fav0 = parseInt($('#fav-count').textContent, 10) || 0;
  fire($('#btn-fav'), 'click');
  await sleep(300);
  check('fs: favorito cambia de estado', $('#btn-fav').classList.contains('on') === !wasFav,
    `marcado=${$('#btn-fav').classList.contains('on')} (estaba ${wasFav})`);
  fire($('#fs-close'), 'click');
  check('fs: se cierra', $('#fs-player').hidden === true);
  fire($('[data-tab="favorites"]'), 'click');
  const favNow = parseInt($('#fav-count').textContent, 10) || 0;
  check('nav: favoritos refleja el cambio', favNow === fav0 + (wasFav ? -1 : 1),
    `${favNow} favoritas (había ${fav0})`);
  fire($('#btn-fav'), 'click');
  await sleep(250);
  check('favorito: se devuelve al estado original',
    $('#btn-fav').classList.contains('on') === wasFav &&
    (parseInt($('#fav-count').textContent, 10) || 0) === fav0,
    `marcado=${$('#btn-fav').classList.contains('on')} · ${$('#fav-count').textContent}`);
  fire($('[data-tab="library"]'), 'click');

  // progreso de audio (requiere AudioContext en ejecución)
  check('audio: duración detectada', $('#time-total').textContent !== '0:00', $('#time-total').textContent);
  if (gesture) {
    const t0 = $('#time-current').textContent;
    await sleep(2000);
    const t1 = $('#time-current').textContent;
    check('audio: la posición avanza', t0 !== t1, `${t0} -> ${t1}`);

    // seek
    const seek = $('#seek');
    seek.value = '500'; fire(seek, 'change');
    await sleep(400);
    check('seek: posición cerca de la mitad', $('#time-current').textContent !== '0:00',
      $('#time-current').textContent);

    // pause / resume
    fire($('#btn-play'), 'click');
    await sleep(300);
    check('pause: se detiene', $('#btn-play').classList.contains('playing') === false);
    const tp = $('#time-current').textContent;
    await sleep(700);
    check('pause: la posición no avanza', $('#time-current').textContent === tp, tp + ' vs ' + $('#time-current').textContent);
    fire($('#btn-play'), 'click');
    await sleep(500);
    check('resume: continúa', $('#btn-play').classList.contains('playing') === true);
  }

  // siguiente / anterior
  const titleBefore = $('#track-title').textContent;
  fire($('#btn-next'), 'click');
  await sleep(700);
  check('next: cambia de pista', $('#track-title').textContent !== titleBefore,
    $('#track-title').textContent + ' (era ' + titleBefore + ')');
  // prev solo retrocede si no ha pasado de los 3 s: volvemos al principio
  const seek2 = $('#seek');
  seek2.value = '0'; fire(seek2, 'change');
  await sleep(300);
  fire($('#btn-prev'), 'click');
  await sleep(700);
  check('prev: vuelve a la anterior', $('#track-title').textContent === titleBefore,
    $('#track-title').textContent + ' (esperado ' + titleBefore + ')');

  // shuffle / repeat
  fire($('#btn-shuffle'), 'click');
  check('shuffle: se activa', $('#btn-shuffle').classList.contains('on'));
  fire($('#btn-shuffle'), 'click');
  check('shuffle: se desactiva', !$('#btn-shuffle').classList.contains('on'));
  fire($('#btn-repeat'), 'click');
  check('repeat: all', $('#btn-repeat').classList.contains('on'));
  fire($('#btn-repeat'), 'click');
  check('repeat: one muestra badge', $('#repeat-badge').hidden === false);
  fire($('#btn-repeat'), 'click');
  check('repeat: off', !$('#btn-repeat').classList.contains('on'));

  // --- atajos de teclado ---
  if (gesture) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await sleep(400);
    const kbPaused = !$('#btn-play').classList.contains('playing');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await sleep(400);
    check('teclado: espacio pausa/reanuda', kbPaused && $('#btn-play').classList.contains('playing'),
      kbPaused ? 'reanudó' : 'no pausó');
  }

  // --- menú contextual ---
  const lib = $('#library-list .track');
  lib.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
  await sleep(200);
  check('ctxmenu: se abre', $('#ctx-menu').hidden === false);
  check('ctxmenu: no ofrece borrar en biblioteca', $('#ctx-menu').querySelector('[data-action="remove"]').hidden === true);

  // info
  $('#ctx-menu').querySelector('[data-action="info"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check('ctxmenu -> info: modal abierto', $('#modal-backdrop').hidden === false && $('#modal-info').hidden === false);
  check('info: contiene filas', $('#info-list').children.length >= 8, $('#info-list').children.length + ' filas');
  $('#modal-info').querySelector('[data-close]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check('info: modal cerrado', $('#modal-backdrop').hidden === true);

  // cola: se vacía y se añade una pista encima de lo que hubiera
  fire($('[data-tab="queue"]'), 'click');
  const q0 = parseInt($('#queue-count').textContent, 10) || 0;
  fire($('#btn-clear-queue'), 'click');
  await sleep(300);
  const qClear = parseInt($('#queue-count').textContent, 10) || 0;
  check('cola: vaciada', qClear <= 1 && qClear <= q0, `${qClear} tras vaciar (había ${q0})`);

  // poner como siguiente (cola) — la fila se relee: el render la regenera
  const libRow = $('#library-list .track');
  libRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
  await sleep(150);
  check('cola: menú contextual abierto', $('#ctx-menu').hidden === false);
  $('#ctx-menu').querySelector('[data-action="add-queue"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(300);
  check('cola: añade 1 pista', (parseInt($('#queue-count').textContent, 10) || 0) === qClear + 1,
    $('#queue-count').textContent + ' (había ' + qClear + ')');

  // --- playlists ---
  fire($('[data-tab="playlists"]'), 'click');
  check('nav: playlists activa', $('.nav-item.active').dataset.tab === 'playlists');
  const pl0 = $$('.playlist').length;
  fire($('#btn-empty-new-playlist'), 'click');
  await sleep(250);
  check('playlist: modal de creación', $('#modal-new-playlist').hidden === false);
  $('#new-playlist-name').value = 'Mis Favoritas';
  fire($('#btn-create-playlist'), 'click');
  await waitFor(() => $$('.playlist').length === pl0 + 1, 4000);
  check('playlist: creada', $$('.playlist').length === pl0 + 1,
    $$('.playlist').length + ' playlists (había ' + pl0 + ')');
  const nuevaPl = findPlaylist('Mis Favoritas');
  check('playlist: nombre visible', !!nuevaPl, nuevaPl ? 'Mis Favoritas' : 'no encontrada');
  check('playlist: contador', $('#pl-count').textContent.includes('playlist'));

  // arrastrar biblioteca -> playlist
  fire($('[data-tab="library"]'), 'click');
  const srcLi = $('#library-list .track');
  const dt = new DataTransfer();
  dt.setData('text/plain', srcLi.dataset.id);
  srcLi.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  fire($('[data-tab="playlists"]'), 'click');
  await sleep(150);
  const plLi = findPlaylist('Mis Favoritas') || $('.playlist');
  plLi.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: 200 }));
  check('drag: playlist resalta', plLi.classList.contains('drag-over'));
  plLi.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: 200 }));
  const metaEl = () => {
    const pl = findPlaylist('Mis Favoritas') || $('.playlist');
    return pl ? pl.querySelector('.playlist-meta') : null;
  };
  await waitFor(() => metaEl()?.textContent?.includes('1'), 3000);
  check('drag: canción añadida a playlist', !!metaEl()?.textContent?.includes('1'),
    metaEl()?.textContent);

  // abrir playlist y añadir la segunda
  fire(findPlaylist('Mis Favoritas') || $('.playlist'), 'click');
  await sleep(300);
  check('playlist: vista detalle', !!$('#pl-name-input'));
  check('playlist: 1 pista en detalle', $$('#pl-track-list .track').length === 1,
    $$('#pl-track-list .track').length + ' pistas');
  fire($('#btn-pl-add'), 'click');
  await sleep(300);
  check('playlist: picker abierto', $('#modal-pick-playlist').hidden === false);
  const pickItem = $('#pick-list li[data-id]');
  check('playlist: hay canción disponible', !!pickItem);
  if (pickItem) fire(pickItem, 'click');
  await sleep(400);
  check('playlist: ahora 2 pistas', $$('#pl-track-list .track').length === 2,
    $$('#pl-track-list .track').length + ' pistas');
  // el selector se queda abierto para añadir varias: se cierra a mano
  $('#modal-pick-playlist').querySelector('[data-close]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check('playlist: picker cerrado', $('#modal-pick-playlist').hidden === true,
    'pila=[' + (window.__modalStack || []).join(',') + ']');

  // reordenar por drag & drop dentro de la playlist
  const items = $$('#pl-track-list .track');
  if (items.length === 2) {
    const before = items.map((el) => el.dataset.id);
    const dt2 = new DataTransfer();
    dt2.setData('text/plain', items[1].dataset.id);
    items[1].dispatchEvent(new DragEvent('dragstart', bubbles2({ dataTransfer: dt2 })));
    const rect0 = items[0].getBoundingClientRect();
    const rect1 = items[1].getBoundingClientRect();
    $('#pl-track-list').dispatchEvent(new DragEvent('dragover', bubbles2({ dataTransfer: dt2, clientY: rect0.top + 3 })));
    items[1].dispatchEvent(new DragEvent('dragend', bubbles2({ dataTransfer: dt2 })));
    await sleep(500);
    const after = $$('#pl-track-list .track').map((el) => el.dataset.id);
    check('reorder: el orden cambió', JSON.stringify(before) !== JSON.stringify(after),
      before.join(',') + ' -> ' + after.join(','));
  }

  // quitar pista con el botón ✕
  const removeBtn = $('#pl-track-list [data-act="remove-from-playlist"]');
  check('playlist: botón quitar presente', !!removeBtn);
  if (removeBtn) {
    fire(removeBtn, 'click');
    await waitFor(() => $$('#pl-track-list .track').length === 1, 3000);
    check('playlist: pista quitada', $$('#pl-track-list .track').length === 1,
      $$('#pl-track-list .track').length + ' pistas');
  }

  // borrar playlist
  fire($('#btn-pl-delete'), 'click');
  await sleep(250);
  check('playlist: confirmación visible', $('#modal-confirm').hidden === false);
  fire($('#btn-confirm-ok'), 'click');
  await waitFor(() => $('#pl-count').textContent.startsWith(pl0 + ' playlist'), 4000);
  check('playlist: eliminada', $('#pl-count').textContent.startsWith(pl0 + ' playlist'),
    $('#pl-count').textContent + ' (esperadas ' + pl0 + ')');
  // el cierre del confirm es asíncrono: hay que esperar a que ocurra
  await waitFor(() => $('#modal-backdrop').hidden === true, 3000);
  check('playlist: modal de confirmación cerrado', $('#modal-backdrop').hidden === true,
    'pila=[' + (window.__modalStack || []).join(',') + ']');

  // --- temporizador de sueño ---
  fire($('[data-tab="library"]'), 'click');
  const stackBefore = (window.__modalStack || []).join(',') || 'vacía';
  const handler = typeof $('#btn-sleep').onclick;
  fire($('#btn-sleep'), 'click');
  const stackSync = (window.__modalStack || []).join(',') || 'vacía';
  const visSync = visibleModals();
  await sleep(250);
  check('sleep: modal abierto', $('#modal-sleep').hidden === false,
    `handler=${handler} · pila antes=[${stackBefore}] tras clic=[${stackSync}] · ` +
    `visibles=${visSync} · a 250 ms=${visibleModals()} · backdrop=${$('#modal-backdrop').hidden ? 'oculto' : 'visible'}`);
  check('sleep: 6 opciones', $$('#modal-sleep [data-sleep]').length === 6);
  $('#modal-sleep').querySelector('[data-sleep="off"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check('sleep: modal cerrado', $('#modal-backdrop').hidden === true,
    `pila=[${(window.__modalStack || []).join(',')}] · visibles=${visibleModals()}`);

  // --- borrar canción de la biblioteca (siempre una pista de prueba) ---
  const beforeDel = $$('#library-list .track').length;
  const li = $('#library-list .track[data-id^="selftest-"]') || $('#library-list .track');
  li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
  await sleep(200);
  check('ctxmenu: sí ofrece borrar', $('#ctx-menu').querySelector('[data-action="delete"]').hidden === false);
  $('#ctx-menu').querySelector('[data-action="delete"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check('borrar: confirmación', $('#modal-confirm').hidden === false);
  fire($('#btn-confirm-ok'), 'click');
  await waitFor(() => $$('#library-list .track').length === beforeDel - 1, 4000);
  const afterDel = $$('#library-list .track').length;
  check('borrar: se elimina una pista', afterDel === beforeDel - 1,
    `${afterDel} canciones (había ${beforeDel})`);
  await waitFor(() => $('#modal-backdrop').hidden === true, 3000);
  check('borrar: modal de confirmación cerrado', $('#modal-backdrop').hidden === true,
    'pila=[' + (window.__modalStack || []).join(',') + ']');

  // --- modales y errores globales ---
  check('modales: no queda ninguno abierto',
    (window.__modalStack || []).length === 0 && $('#modal-backdrop').hidden === true,
    'pila=[' + (window.__modalStack || []).join(',') + '] · backdrop=' +
    ($('#modal-backdrop').hidden ? 'oculto' : 'visible') + ' · visibles=' + visibleModals());
  check('global: sin errores JS en toda la sesión', window.__errs.length === 0, window.__errs.join(' | '));
}

function bubbles2(extra) {
  return Object.assign({ bubbles: true, cancelable: true }, extra);
}

// ============================================================
// FASE 3: formatos de audio (?fmt=1)
// Descarga cada muestra de test-samples/ y la pasa por la
// cadena completa (nativo → ffmpeg.wasm).
// ============================================================
const SAMPLES = [
  's.mp3', 's.m4a', 's_alac.m4a', 's.flac', 's.wav', 's.ogg', 's.opus',
  's.wma', 's.aiff', 's.au', 's.caf', 's.w64', 's.voc', 's.ac3', 's.mp2',
  's.tta', 's.3gp', 's.mka',
];

async function runFormatTests() {
  step('inicio de prueba de formatos (' + SAMPLES.length + ' muestras)');
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let converted = 0;

  // matriz real del navegador
  const support = browserSupport();
  step('canPlayType: ' + JSON.stringify(support));
  check('accept: incluye formatos extendidos', acceptAttribute().includes('.wma') && acceptAttribute().includes('.ape'),
    acceptAttribute().slice(0, 120) + '…');

  for (const file of SAMPLES) {
    const t0 = performance.now();
    let nativeOk = false;
    try {
      const res = await fetch('test-samples/' + file);
      if (!res.ok) { check('fmt ' + file, false, 'HTTP ' + res.status); continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 100) { check('fmt ' + file, false, 'muestra vacía'); continue; }

      // ¿lo admite el navegador nativamente?
      try {
        const probe = await ctx.decodeAudioData(bytes.slice().buffer);
        nativeOk = !!(probe && probe.duration > 0);
      } catch { nativeOk = false; }

      // cadena completa de Free Player
      const buf = await decodeAudio(ctx, bytes, { name: file });
      const ok = !!(buf && buf.duration > 0.5);
      if (!nativeOk) converted++;
      check('fmt ' + file, ok,
        `${buf ? buf.duration.toFixed(2) : 0}s · tier=${tierOf(extOf(file))} · ` +
        `${nativeOk ? 'nativo' : 'CONVERTIDO'} · ${Math.round(performance.now() - t0)}ms`);
    } catch (e) {
      check('fmt ' + file, false, String((e && e.message) || e));
    }
    // el worker de ffmpeg necesita un respiro entre transcodificaciones
    await sleep(150);
  }

  check('global: sin errores JS en la fase de formatos', window.__errs.length === 0, window.__errs.join(' | '));
  step(`convertidos por ffmpeg.wasm: ${converted}/${SAMPLES.length}`);
  await finish();
}

// ============================================================
// FASE 4: carátulas incrustadas (?art=1)
// ============================================================
const COVER_SAMPLES = ['c.mp3', 'c.m4a', 'c.flac', 'c.mp4'];

async function runArtTests() {
  step('inicio de prueba de carátulas');

  // 1) muestras CON carátula → deben extraerse
  for (const f of COVER_SAMPLES) {
    try {
      const res = await fetch('test-samples/' + f);
      if (!res.ok) { check('art ' + f, false, 'HTTP ' + res.status); continue; }
      const blob = await extractArtwork(new Blob([await res.arrayBuffer()]));
      check('art ' + f, !!(blob && /^image\//.test(blob.type) && blob.size > 1000),
        blob ? `${blob.type} · ${blob.size} B` : 'sin carátula');
    } catch (e) {
      check('art ' + f, false, String((e && e.message) || e));
    }
  }

  // 2) muestras SIN carátula → null (que no invente imágenes)
  for (const f of ['s.mp3', 's.wma', 's.flac']) {
    try {
      const res = await fetch('test-samples/' + f);
      const blob = await extractArtwork(new Blob([await res.arrayBuffer()]));
      check('art sin carátula ' + f, blob === null, blob ? '¡inventó una imagen!' : 'null ✓');
    } catch (e) {
      check('art sin carátula ' + f, false, String((e && e.message) || e));
    }
  }

  // 3) biblioteca real: el backfill de arranque debe haber revisado todo
  await waitFor(async () => {
    const ts = await db.allTracks();
    return ts.length > 0 && ts.every((t) => t.artChecked);
  }, 20000, 300);

  const tracks = await db.allTracks();
  const checked = tracks.filter((t) => t.artChecked).length;
  const withArt = tracks.filter((t) => t.hasArt).length;
  check('backfill: archivos revisados', tracks.length === 0 || checked === tracks.length,
    `${checked}/${tracks.length}`);
  step(`carátulas incrustadas en la biblioteca: ${withArt}/${tracks.length}`);

  // 4) UI: si hay carátulas, la lista debe mostrar <img> con blob cargado
  if (withArt > 0) {
    await waitFor(
      () => [...document.querySelectorAll('#library-list img[data-art-id]')]
        .some((i) => i.src.startsWith('blob:')),
      8000, 200
    );
    const imgs = [...document.querySelectorAll('#library-list img[data-art-id]')];
    const visible = imgs.filter((i) => i.src.startsWith('blob:') && !i.hidden);
    check('ui: miniaturas en la biblioteca', visible.length > 0,
      `${visible.length}/${imgs.length} con imagen`);
  } else {
    step('ninguna canción trae carátula incrustada (típico en descargas de vídeo)');
  }

  check('global: sin errores JS en la fase de carátulas', window.__errs.length === 0, window.__errs.join(' | '));
  await finish();
}

// ============================================================
// Limpieza + informe
// ============================================================
async function cleanup() {
  try {
    const tracks = await db.allTracks();
    for (const t of tracks) if (String(t.id).startsWith('selftest-')) await db.deleteTrack(t.id);
    // solo la playlist creada por la prueba, jamás las tuyas
    const pls = await db.allPlaylists();
    for (const p of pls) if (p.name === 'Mis Favoritas') await db.deletePlaylist(p.id);
  } catch (e) {
    report({ t: Date.now(), kind: 'CLEANUP-ERR', msg: String(e), extra: '' });
  }
}

async function finish() {
  await cleanup();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  const summary =
    `RESULTADO ${passed}/${results.length} pruebas OK` +
    (failed.length ? ` | FALLOS: ${failed.map((f) => f.name + ' [' + f.extra + ']').join(' ;; ')}` : ' | SIN FALLOS');
  report({ t: Date.now(), kind: 'RESULT', msg: summary, extra: JSON.stringify(results) });
  console.log(summary);
  results.forEach((r) => console.log((r.pass ? '  OK   ' : '  FAIL ') + r.name + (r.extra ? '  << ' + r.extra : '')));
}

// ============================================================
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.has('seed')) {
    await seed();
    return;
  }
  if (q.has('fmt')) {
    try {
      await runFormatTests();
    } catch (e) {
      report({ t: Date.now(), kind: 'CRASH', msg: String(e && (e.stack || e.message)), extra: '' });
      results.push({ name: 'fase de formatos: excepción', pass: false, extra: String(e) });
      await finish();
    }
    return;
  }
  if (q.has('art')) {
    try {
      await runArtTests();
    } catch (e) {
      report({ t: Date.now(), kind: 'CRASH', msg: String(e && (e.stack || e.message)), extra: '' });
      results.push({ name: 'fase de carátulas: excepción', pass: false, extra: String(e) });
      await finish();
    }
    return;
  }
  if (!q.has('selftest')) return;
  // sin pistas de prueba (primera vez o limpieza anterior): se crean y
  // la página se recarga sola para ejecutar la prueba completa
  if (!(await db.hasFile('selftest-440'))) {
    step('faltan las pistas de prueba: creándolas');
    await seed();
    return;
  }
  try {
    await runTests();
  } catch (e) {
    report({ t: Date.now(), kind: 'CRASH', msg: String(e && (e.stack || e.message)), extra: '' });
    results.push({ name: 'excepción no controlada', pass: false, extra: String(e) });
  }
  await finish();
})();
