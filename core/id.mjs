// Small shared helpers. No dependencies, no state.

export function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

export function num(v, fallback) {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function bad(status, message) {
  throw new HttpError(status, message);
}

export function newId(prefix = 'id') {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
