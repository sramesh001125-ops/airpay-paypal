// Single-use pay token (the content of the QR / link).
// IP-CANDIDATE: the token is burned only when SETTLEMENT is confirmed by a verified payment event,
// not when it is scanned. A failed or abandoned payment therefore does not destroy the QR.
import crypto from 'node:crypto';
import { CFG } from './config.js';
import { get, run } from './db.js';
import { clock, sha256 } from './util.js';

const hmac = (s) => crypto.createHmac('sha256', CFG.qrSecret).update(s).digest('base64url');

export function issue(orderId, expMs) {
  const nonce = crypto.randomBytes(9).toString('base64url');
  const body = Buffer.from(`${orderId}|${expMs}|${nonce}`).toString('base64url');
  const token = `${body}.${hmac(body)}`;
  run(
    'INSERT INTO qr_tokens (token_hash, order_id, status, exp, created_at) VALUES (?,?,?,?,?)',
    sha256(token), orderId, 'ACTIVE', expMs, clock.iso(),
  );
  return token;
}

/** Verifies signature and state. Returns {ok, orderId, status, reason}. */
export function check(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return { ok: false, reason: 'MALFORMED' };
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  const row = get('SELECT * FROM qr_tokens WHERE token_hash=?', sha256(token));
  if (!row) return { ok: false, reason: 'UNKNOWN' };
  if (row.status === 'USED') return { ok: false, reason: 'ALREADY_USED', orderId: row.order_id, status: 'USED' };
  if (row.status === 'EXPIRED') return { ok: false, reason: 'EXPIRED', orderId: row.order_id, status: 'EXPIRED' };
  if (clock.now() > row.exp) {
    run("UPDATE qr_tokens SET status='EXPIRED' WHERE token_hash=?", row.token_hash);
    return { ok: false, reason: 'EXPIRED', orderId: row.order_id, status: 'EXPIRED' };
  }
  return { ok: true, orderId: row.order_id, status: row.status };
}

/** Read-only lookup that ignores state (for showing a status page after payment). */
export function peek(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return get('SELECT * FROM qr_tokens WHERE token_hash=?', sha256(token));
}

export const burn = (orderId) =>
  run("UPDATE qr_tokens SET status='USED', used_at=? WHERE order_id=? AND status='ACTIVE'", clock.iso(), orderId);
export const expire = (orderId) =>
  run("UPDATE qr_tokens SET status='EXPIRED' WHERE order_id=? AND status='ACTIVE'", orderId);
