// ============================================================
// Free Player — utilidades
// ============================================================

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Color determinista (hash) a partir de un string. */
export function hashColor(str, sat = 62, light = 52) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, ${sat}%, ${light}%)`;
}

export function escapeHtml(s = '') {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- Toast ----
let toastTimer;
export function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---- Arte de portada generado (canvas) ----
export function artworkDataUrl(seed, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const base = hashColor(seed, 68, 55);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, base);
  g.addColorStop(1, shade(base, -22));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(size * 0.78, size * 0.24, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.font = `700 ${size * 0.42}px -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const letter = (seed || '♪').trim().charAt(0).toUpperCase() || '♪';
  ctx.fillText(letter, size / 2, size / 2 + size * 0.02);
  return c.toDataURL('image/png');
}

function shade(hsl, amt) {
  const m = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!m) return hsl;
  const l = Math.min(100, Math.max(0, +m[3] + amt));
  return `hsl(${m[1]}, ${m[2]}%, ${l}%)`;
}
