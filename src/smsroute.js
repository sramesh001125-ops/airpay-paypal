// SMS return-code route for payers on basic phones or weak data (MOCK gateway: no real SMS provider is integrated).
//
// Flow: the server issues a one-time code bound to the order; the payer's phone returns it by SMS (one tap on an
// sms: link, or a short reply); the sender number is taken from the messaging network, not from the message body;
// a deterministic audit runs BEFORE any payment request; a single-use payee identifier is issued for the order;
// the payer authorises with the UPI PIN on the payment network's own channel (the *99# session or their payment
// app). This code never receives, stores or displays a PIN. The order is paid only on a verified settlement
// event whose amount matches the order. Codes are stored only as hashes and never written to the audit log.
import crypto from 'node:crypto';
import { CFG, limitFor, defaultInstrument } from './config.js';
import { get, all, run } from './db.js';
import { clock, rid, sha256, contactKey, HttpError } from './util.js';
import * as audit from './audit.js';
import * as shield from './shield.js';
import * as engine from './engine.js';

export const ROUTES = ['app_link', 'light_page', 'sms_ussd'];
const CAPABILITY = { smartphone: 0, feature: 1, basic: 2 };

export const enabled = () => CFG.sms.mode !== 'off';
const need = () => { if (!enabled()) throw new HttpError(404, 'SMS route is off (set SMS_MODE=mock)'); };

const tail10 = (k) => String(k || '').replace(/\D/g, '').slice(-10);
const numHash = (k) => sha256(`sms-num|${tail10(k)}`);
const codeHash = (c) => sha256(`sms-code|${c}`);
const rand = (digits) => String(crypto.randomInt(10 ** (digits - 1), 10 ** digits));
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const mask = (k) => { const t = tail10(k); return t.length < 4 ? '****' : `******${t.slice(-4)}`; };
const short = (id) => String(id).slice(-6);

// ------------------------------------------------------------------ mock messaging gateway
const outbox = [];
function send(to, text, kind, demo = null) {
  outbox.push({ id: outbox.length + 1, ts: clock.iso(), to: mask(to), toKey: String(to), text, kind, demo });
  if (outbox.length > 300) outbox.shift();
  audit.log('server', 'SMS_SENT', null, { kind, to: mask(to) }); // never the text: it carries a code
}
export const getOutbox = (toKey) => (toKey ? outbox.filter((m) => tail10(m.toKey) === tail10(toKey)) : outbox).slice(-100);
export const clearOutbox = () => { outbox.length = 0; };

const guard = 'Never send your UPI PIN by message.';
const smsLink = (body) => `sms:${CFG.sms.inboundNumber}?body=${encodeURIComponent(body)}`;

function verifyMessage(route, o, ch, code, ref) {
  const amt = `INR ${o.amount_inr.toFixed(2)}`;
  if (route === 0) return { text: `AirPay: ${amt}, order ${short(o.id)}. Tap to confirm: ${smsLink(code)}  ${guard}`, demo: { replyBody: code } };
  if (route === 1) return { text: `AirPay: ${amt}, order ${short(o.id)}. Open: ${CFG.baseUrl}/s.html?c=${ch}&k=${code}&n=${encodeURIComponent(CFG.sms.inboundNumber)}  ${guard}`, demo: { replyBody: code } };
  return { text: `AirPay: ${amt}, order ${short(o.id)}. Reply AIRPAY ${ref} to ${CFG.sms.inboundNumber}.  ${guard}`, demo: { replyBody: `AIRPAY ${ref}` } };
}

function chooseRoute(claimedHash, capability) {
  const mem = get('SELECT route_idx FROM route_memory WHERE contact_hash=?', claimedHash);
  if (mem) return mem.route_idx;
  return CAPABILITY[capability] ?? 0;
}

// ------------------------------------------------------------------ issue
export function issue(orderId, { twoSided = false, payeeNumber, capability } = {}) {
  need();
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'unknown order');
  if (o.state !== 'LINK_SENT') throw new HttpError(409, `order is ${o.state}; the SMS route needs a synced, unpaid order`);
  if (o.buyer_country !== 'IN') throw new HttpError(400, 'the SMS and *99# route is for payers in India');
  if (!o.contact_key || tail10(o.contact_key).length < 10) throw new HttpError(400, 'the order needs a mobile number');
  if (twoSided && tail10(payeeNumber).length < 10) throw new HttpError(400, 'two-sided match needs the payee mobile number');

  const claimed = numHash(o.contact_key);
  const since = new Date(clock.now() - 86400000).toISOString();
  const recent = get('SELECT COUNT(*) AS n FROM sms_challenges WHERE claimed_hash=? AND created_at>=?', claimed, since).n;
  if (recent >= CFG.sms.maxPerContactDay) {
    audit.log('server', 'SMS_VELOCITY_BLOCK', o.id, { contact: mask(o.contact_key), recent });
    throw new HttpError(429, 'too many requests for this number today');
  }
  run("UPDATE sms_challenges SET status='SUPERSEDED' WHERE order_id=? AND status IN ('ISSUED','PARTIAL')", o.id);

  let code; let ref; let payeeCode = null;
  do { code = rand(10); ref = rand(6); } while (get('SELECT 1 AS x FROM sms_challenges WHERE code_hash=? OR ref_hash=?', codeHash(code), codeHash(ref)));
  if (twoSided) do { payeeCode = rand(10); } while (payeeCode === code || get('SELECT 1 AS x FROM sms_challenges WHERE payee_code_hash=?', codeHash(payeeCode)));

  const id = rid('SC');
  const route = chooseRoute(claimed, capability);
  const exp = clock.now() + CFG.sms.codeMinutes * 60000;
  run(
    `INSERT INTO sms_challenges (id, order_id, claimed_hash, payee_hash, code_hash, ref_hash, payee_code_hash, two_sided, status, route_idx, route_sent_at, amount_inr, exp, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, o.id, claimed, twoSided ? numHash(payeeNumber) : null, codeHash(code), codeHash(ref), payeeCode ? codeHash(payeeCode) : null,
    twoSided ? 1 : 0, 'ISSUED', route, clock.now(), o.amount_inr, exp, clock.iso(),
  );
  audit.log('server', 'SMS_CHALLENGE_ISSUED', o.id, { challengeId: id, route: ROUTES[route], twoSided: !!twoSided, contact: mask(o.contact_key) });
  const m = verifyMessage(route, o, id, code, ref);
  send(o.contact_key, m.text, 'verify', CFG.sms.mode === 'mock' ? m.demo : null);
  if (twoSided) {
    send(payeeNumber, `AirPay seller: confirm order ${short(o.id)}, INR ${o.amount_inr.toFixed(2)}. Tap: ${smsLink(payeeCode)}`, 'verify-payee', CFG.sms.mode === 'mock' ? { replyBody: payeeCode } : null);
  }
  return { challengeId: id, route: ROUTES[route], twoSided: !!twoSided, expiresAt: new Date(exp).toISOString() };
}

// ------------------------------------------------------------------ capability ladder
export function escalate(challengeId) {
  need();
  const ch = get('SELECT * FROM sms_challenges WHERE id=?', challengeId);
  if (!ch) throw new HttpError(404, 'unknown challenge');
  if (!['ISSUED', 'PARTIAL'].includes(ch.status)) return { status: ch.status, note: 'nothing to escalate' };
  if (clock.now() > ch.exp) { run("UPDATE sms_challenges SET status='EXPIRED' WHERE id=?", ch.id); return { status: 'EXPIRED' }; }
  if (ch.route_idx >= ROUTES.length - 1) return { status: ch.status, exhausted: true };
  const o = get('SELECT * FROM orders WHERE id=?', ch.order_id);
  // The code is not stored in clear, so a new message needs a fresh code: replace the hashes and keep the same challenge.
  const code = rand(10); const ref = rand(6);
  const idx = ch.route_idx + 1;
  run('UPDATE sms_challenges SET code_hash=?, ref_hash=?, route_idx=?, route_sent_at=? WHERE id=?', codeHash(code), codeHash(ref), idx, clock.now(), ch.id);
  audit.log('server', 'SMS_ROUTE_ESCALATED', o.id, { challengeId: ch.id, route: ROUTES[idx] });
  const m = verifyMessage(idx, o, ch.id, code, ref);
  send(o.contact_key, m.text, 'verify', CFG.sms.mode === 'mock' ? m.demo : null);
  return { status: ch.status, route: ROUTES[idx] };
}

/** Escalate every challenge whose route window has passed without a return. */
export function tick() {
  need();
  const out = [];
  for (const ch of all("SELECT * FROM sms_challenges WHERE status IN ('ISSUED','PARTIAL')")) {
    const win = (CFG.sms.routeWindowSec[ch.route_idx] || 300) * 1000;
    if (clock.now() - ch.route_sent_at >= win) out.push({ challengeId: ch.id, ...escalate(ch.id) });
  }
  return out;
}

// ------------------------------------------------------------------ inbound return message
const PATTERN = /^\s*(?:AIRPAY\s+)?(\d{6}|\d{10})\s*$/i;

/** The gateway calls this with the sender number supplied by the network. In mock mode the demo supplies it. */
export async function inbound({ from, body }) {
  need();
  const m = PATTERN.exec(String(body || ''));
  if (!m) {
    audit.log('server', 'SMS_REJECTED', null, { reason: 'pattern', from: mask(from) }); // the body is not stored
    return { accepted: false, reason: 'pattern' };
  }
  const h = codeHash(m[1]);
  const ch = get("SELECT * FROM sms_challenges WHERE (code_hash=? OR ref_hash=? OR payee_code_hash=?) AND status IN ('ISSUED','PARTIAL')", h, h, h);
  if (!ch) {
    audit.log('server', 'SMS_UNKNOWN_CODE', null, { from: mask(from) });
    return { accepted: false, reason: 'unknown' };
  }
  const side = ch.payee_code_hash === h ? 'payee' : 'payer';
  const o = get('SELECT * FROM orders WHERE id=?', ch.order_id);
  if (clock.now() > ch.exp) {
    run("UPDATE sms_challenges SET status='EXPIRED' WHERE id=?", ch.id);
    audit.log('server', 'SMS_EXPIRED', o.id, { challengeId: ch.id });
    return { accepted: false, reason: 'expired' };
  }
  if (ch.tries >= CFG.sms.maxTries) {
    run("UPDATE sms_challenges SET status='HELD' WHERE id=?", ch.id);
    audit.log('server', 'SMS_HELD_TRIES', o.id, { challengeId: ch.id });
    return { accepted: false, reason: 'too_many_tries' };
  }
  const expected = side === 'payee' ? ch.payee_hash : ch.claimed_hash;
  if (!eq(numHash(from), expected)) {
    run('UPDATE sms_challenges SET tries=tries+1 WHERE id=?', ch.id);
    audit.log('server', 'SMS_SENDER_MISMATCH', o.id, { challengeId: ch.id, side, from: mask(from) });
    return { accepted: false, reason: 'sender_mismatch' };
  }
  if ((side === 'payer' && ch.payer_ok) || (side === 'payee' && ch.payee_ok)) {
    audit.log('server', 'SMS_ALREADY_USED', o.id, { challengeId: ch.id, side });
    return { accepted: false, reason: 'already_used' };
  }
  run(`UPDATE sms_challenges SET ${side === 'payer' ? 'payer_ok' : 'payee_ok'}=1 WHERE id=?`, ch.id);
  const now = get('SELECT * FROM sms_challenges WHERE id=?', ch.id);
  const done = now.payer_ok && (!now.two_sided || now.payee_ok);
  audit.log('server', 'SMS_RETURN_ACCEPTED', o.id, { challengeId: ch.id, side });
  if (!done) {
    run("UPDATE sms_challenges SET status='PARTIAL' WHERE id=?", ch.id);
    return { accepted: true, verified: false, waitingFor: now.payer_ok ? 'payee' : 'payer' };
  }
  run("UPDATE sms_challenges SET status='VERIFIED', verified_at=? WHERE id=?", clock.iso(), ch.id);
  run('INSERT INTO route_memory (contact_hash, route_idx, updated_at) VALUES (?,?,?) ON CONFLICT(contact_hash) DO UPDATE SET route_idx=excluded.route_idx, updated_at=excluded.updated_at', ch.claimed_hash, ch.route_idx, clock.iso());
  audit.log('server', 'SMS_VERIFIED', o.id, { challengeId: ch.id, route: ROUTES[ch.route_idx] });
  return { accepted: true, verified: true, ...(await proceed(ch.id)) };
}

// ------------------------------------------------------------------ audit before the request
export async function proceed(challengeId) {
  const ch = get('SELECT * FROM sms_challenges WHERE id=?', challengeId);
  const o = get('SELECT * FROM orders WHERE id=?', ch.order_id);
  const since = new Date(clock.now() - 86400000).toISOString();
  const instrument = o.instrument || defaultInstrument(o.buyer_country);
  const rules = {
    amount_equals_captured: Math.abs(ch.amount_inr - o.amount_inr) < 0.011,
    seller_device_registered: !!get('SELECT 1 AS x FROM devices WHERE id=?', o.device_id),
    no_request_already_issued: !get("SELECT 1 AS x FROM payee_ids WHERE order_id=? AND status IN ('ISSUED','BURNED')", o.id),
    limits_met: o.amount_inr <= limitFor(instrument).perTxnInr + 0.01,
    number_verified: ch.status === 'VERIFIED',
    order_payable: o.state === 'LINK_SENT',
    velocity_ok: get('SELECT COUNT(*) AS n FROM sms_challenges WHERE claimed_hash=? AND created_at>=?', ch.claimed_hash, since).n <= CFG.sms.maxPerContactDay,
  };
  const failed = Object.entries(rules).filter(([, ok]) => !ok).map(([k]) => k);
  // The advisory agent (the SHIELD adapter) is given no name or contact in clear; it can only add a flag, which holds the order.
  const adv = await shield.screen({ deviceId: o.device_id, contactKey: o.contact_key, country: o.buyer_country, instrument, amountUsd: o.amount_usd });
  const flagged = adv.action !== 'allow';
  const decision = failed.length ? 'DENIED' : flagged ? 'HELD' : 'ALLOWED';
  audit.log('audit-agent', 'SMS_AUDIT_DECISION', o.id, { challengeId: ch.id, decision, failed, advisory: adv.action, reasons: adv.reasons });
  if (decision !== 'ALLOWED') {
    run('UPDATE sms_challenges SET status=? WHERE id=?', decision, ch.id);
    return { decision, failed, advisory: adv.action };
  }
  const p = issuePayeeId(o);
  send(o.contact_key,
    `AirPay: approve INR ${o.amount_inr.toFixed(2)} to ${p.ident}. Dial *99#, choose Send Money, enter ${p.ident}, then your UPI PIN. Smartphone: ${p.upiLink}  ${guard}`,
    'pay', CFG.sms.mode === 'mock' ? { ident: p.ident, amountInr: o.amount_inr } : null);
  return { decision, payeeId: p.ident, upiLink: p.upiLink, expiresAt: p.expiresAt };
}

// ------------------------------------------------------------------ single-use payee identifier (mock registry)
function issuePayeeId(o) {
  let ident;
  do { ident = rand(10); } while (get('SELECT 1 AS x FROM payee_ids WHERE ident=?', ident));
  const exp = clock.now() + CFG.sms.payeeIdMinutes * 60000;
  run('INSERT INTO payee_ids (ident, order_id, amount_inr, status, exp, created_at) VALUES (?,?,?,?,?,?)', ident, o.id, o.amount_inr, 'ISSUED', exp, clock.iso());
  audit.log('server', 'PAYEE_ID_ISSUED', o.id, { ident: `******${ident.slice(-4)}`, amountInr: o.amount_inr, expiresInMin: CFG.sms.payeeIdMinutes });
  const upiLink = `upi://pay?pa=${ident}@airpay-mock&am=${o.amount_inr.toFixed(2)}&cu=INR&tr=${encodeURIComponent(o.id)}&tn=AirPay`;
  return { ident, upiLink, expiresAt: new Date(exp).toISOString() };
}

/** A payment attempt was shown, started or failed: the identifier stays valid. */
export function attempt(ident, { failed = false } = {}) {
  need();
  const p = get('SELECT * FROM payee_ids WHERE ident=?', String(ident));
  if (!p) throw new HttpError(404, 'unknown identifier');
  audit.log('server', failed ? 'PAYEE_ID_ATTEMPT_FAILED' : 'PAYEE_ID_ATTEMPT_STARTED', p.order_id, {});
  return { status: p.status };
}

/** Verified settlement event from the (mock) payment provider. Invalidates the identifier only on a matching amount. */
export function settle({ ident, amountInr, eventId }) {
  need();
  const evId = `sms-${eventId || crypto.randomBytes(8).toString('hex')}`;
  if (get('SELECT 1 AS x FROM webhook_events WHERE id=?', evId)) return { duplicate: true };
  run('INSERT INTO webhook_events (id, type, received_at) VALUES (?,?,?)', evId, 'sms.settlement', clock.iso());
  const p = get('SELECT * FROM payee_ids WHERE ident=?', String(ident));
  if (!p) { audit.log('server', 'WEBHOOK_NO_ORDER', null, { type: 'sms.settlement' }); return { ignored: true }; }
  if (p.status !== 'ISSUED') return { ignored: true, status: p.status };
  if (clock.now() > p.exp) {
    run("UPDATE payee_ids SET status='EXPIRED' WHERE ident=?", p.ident);
    return { ignored: true, status: 'EXPIRED' };
  }
  if (Math.abs(Number(amountInr) - p.amount_inr) > 0.01) {
    audit.log('server', 'AMOUNT_MISMATCH', p.order_id, { expected: p.amount_inr, got: Number(amountInr), source: 'sms-route' });
    return { mismatch: true, status: p.status };
  }
  const r = engine.settleExternal(p.order_id, { amountInr: Number(amountInr), source: 'sms-route-settlement' });
  if (r.state === 'PAID') {
    run("UPDATE payee_ids SET status='BURNED', burned_at=? WHERE ident=?", clock.iso(), p.ident);
    audit.log('server', 'PAYEE_ID_BURNED', p.order_id, { ident: `******${p.ident.slice(-4)}` });
  }
  return r;
}

export function status(orderId) {
  return {
    challenges: all('SELECT id, status, route_idx, two_sided, payer_ok, payee_ok, amount_inr, exp FROM sms_challenges WHERE order_id=? ORDER BY created_at', orderId)
      .map((c) => ({ ...c, route: ROUTES[c.route_idx] })),
    payeeIds: all('SELECT status, amount_inr, exp, burned_at FROM payee_ids WHERE order_id=?', orderId),
  };
}
