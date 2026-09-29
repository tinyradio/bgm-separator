/** 75.25 → "1:15.25" */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${m}:${Number(s) < 10 ? '0' : ''}${s || '0'}`;
}

/** Accepts "65.5" or "1:05.5". */
export function parseTime(text) {
  const t = String(text).trim();
  if (/^\d+(?:\.\d{1,3})?$/.test(t)) return Number(t);
  const m = t.match(/^(\d+):([0-5]?\d(?:\.\d{1,3})?)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const formatSize = (bytes) => `${(bytes / 1048576).toFixed(+(bytes < 10485760))} MB`;

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
