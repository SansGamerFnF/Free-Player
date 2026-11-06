// ============================================================
// Free Player — puente con la notificación de reproducción
//
// El lado Android (plugin MediaBridge) mantiene:
//   • el servicio en primer plano con la notificación de control,
//   • la MediaSession (controles del lockscreen / coche / Bluetooth),
//   • el widget de la pantalla de inicio.
//
// Todo esto es inerte en el navegador (no existe window.Capacitor).
// ============================================================

const cap = (typeof window !== 'undefined' && window.Capacitor) || null;
const mb = cap && cap.Plugins ? cap.Plugins.MediaBridge : null;

/** ¿Hay lado nativo disponible? */
export function mediaAvailable() {
  return !!(mb && typeof mb.update === 'function');
}

/** Información del reproductor → notificación + widget + MediaSession. */
export function mediaUpdate(info) {
  if (!mediaAvailable()) return Promise.resolve();
  try {
    return Promise.resolve(mb.update(info)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Oculta la notificación y para el servicio (al parar la música). */
export function mediaHide() {
  if (!mediaAvailable()) return Promise.resolve();
  try {
    return Promise.resolve(mb.hide()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Android 13+: pide permiso de notificaciones. Devuelve true si está. */
export async function mediaRequestPermission() {
  if (!mediaAvailable()) return false;
  try {
    const res = await mb.requestPermission();
    return !!(res && res.granted);
  } catch {
    return false;
  }
}

/**
 * Botones de la notificación / lockscreen / widget → la app.
 * cb recibe ('play' | 'pause' | 'toggle' | 'next' | 'prev' | 'stop' | 'seek', evento).
 * En 'seek', evento.position trae la posición pedida en milisegundos.
 */
export function onMediaAction(cb) {
  if (!mediaAvailable() || typeof mb.addListener !== 'function') return () => {};
  try {
    const handler = mb.addListener('action', (e) => {
      try { cb((e && e.action) || '', e || {}); } catch { /* nada */ }
    });
    // Capacitor devuelve un objeto con .remove()
    return () => { try { handler && handler.remove && handler.remove(); } catch { /* nada */ } };
  } catch {
    return () => {};
  }
}
