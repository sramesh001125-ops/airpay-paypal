// Small shared helpers. NOT IP-protected: commodity code.
import crypto from 'node:crypto';

let offsetMs = 0;

/** Demo clock: lets the demo "fast-forward" so 7-day terms can be shown in a minute. */
export const clock = {
  now: () => Date.now() + offsetMs,
  iso: () => new Date(Date.now() + offsetMs).toISOString(),
  advanceMinutes(min) {
    offsetMs += min * 60000;
    return offsetMs;
  },
  reset() {
    offsetMs = 0;
  },
  offsetMinutes: () => Math.round(offsetMs / 60000),
};

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const rid = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
export const round2 = (n) => Math.round(n * 100) / 100;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Normalise a buyer contact (phone or email) into a stable key. */
export function contactKey(contact) {
  const c = String(contact || '').trim().toLowerCase();
  if (c.includes('@')) return c;
  return c.replace(/[^\d+]/g, '');
}

export function maskName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Passenger';
  const parts = n.split(/\s+/);
  return parts.map((p, i) => (i === 0 ? p : p[0] + '.')).join(' ');
}
