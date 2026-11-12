// Audit agent: tamper-evident (hash-chained) decision log + deterministic order review.
// IP-CANDIDATE: the review rules that tie rail choice, QR state, limits and lender timing together.
import { CFG, defaultInstrument, limitFor } from './config.js';
import { get, all, run } from './db.js';
import { clock, sha256 } from './util.js';
import * as rails from './rails.js';

const GENESIS = 'GENESIS';

export function log(actor, type, orderId, payload = {}) {
  const last = get('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const prev = last ? last.hash : GENESIS;
  const ts = clock.iso();
  const body = JSON.stringify(payload);
  const hash = sha256(`${prev}|${ts}|${actor}|${type}|${orderId || ''}|${body}`);
  run(
    'INSERT INTO audit_log (ts, actor, type, order_id, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?)',
    ts, actor, type, orderId || null, body, prev, hash,
  );
  return hash;
}

export function entries(limit = 200, orderId = null) {
  const rows = orderId
    ? all('SELECT * FROM audit_log WHERE order_id=? ORDER BY seq DESC LIMIT ?', orderId, limit)
    : all('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?', limit);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || '{}') }));
}

/** Re-computes every hash; returns the first broken link, if any. */
export function verifyChain() {
  const rows = all('SELECT * FROM audit_log ORDER BY seq ASC');
  let prev = GENESIS;
  for (const r of rows) {
    const expect = sha256(`${prev}|${r.ts}|${r.actor}|${r.type}|${r.order_id || ''}|${r.payload}`);
    if (r.prev_hash !== prev || r.hash !== expect) {
      return { ok: false, brokenAtSeq: r.seq, checked: rows.length };
    }
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}

const sev = (code, severity, msg) => ({ code, severity, msg });

/** Deterministic review of one order. The AI may narrate, but these rules decide. */
export function review(orderId) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) return null;
  const flags = [];
  const instrument = o.instrument || defaultInstrument(o.buyer_country);
  const limitKey = o.limit_key || instrument;
  const L = limitFor(limitKey);

  if (instrument === 'upi_debit' && o.buyer_country !== 'IN') {
    flags.push(sev('INSTRUMENT_MISMATCH', 'high', 'UPI-debit instrument recorded for a buyer outside India.'));
  }
  if (o.amount_inr > L.perTxnInr + 0.01) {
    flags.push(sev('LIMIT_TXN', 'high', `Amount INR ${o.amount_inr.toFixed(2)} exceeds the ${limitKey} per-transaction limit ${Math.round(L.perTxnInr)}.`));
  }

  const exposure = get(
    `SELECT COALESCE(SUM(amount_inr),0) AS s FROM orders
     WHERE device_id=? AND COALESCE(limit_key, instrument)=? AND state IN ('LINK_SENT','DEFERRED_PENDING_BANK','EXPIRED_UNPAID','CARD_FALLBACK_PENDING')`,
    o.device_id, limitKey,
  ).s;
  if (exposure > L.perDeviceInr + 0.01) {
    flags.push(sev('DEVICE_EXPOSURE', 'high', `Open ${limitKey} exposure on device ${o.device_id} is INR ${exposure.toFixed(2)} (limit ${Math.round(L.perDeviceInr)}).`));
  }

  const shieldEv = get("SELECT payload FROM audit_log WHERE order_id=? AND type='SHIELD_SCREENED' ORDER BY seq DESC LIMIT 1", o.id);
  if (shieldEv) {
    const p = JSON.parse(shieldEv.payload || '{}');
    if (p.action === 'block') flags.push(sev('SHIELD_BLOCKED', 'high', `SHIELD screened this order out: ${(p.reasons || []).join(', ')}.`));
    else if (p.action === 'review') flags.push(sev('SHIELD_REVIEW', 'medium', `SHIELD asked for review: ${(p.reasons || []).join(', ')}.`));
  }

  if (o.rail_decision_json) {
    const d = JSON.parse(o.rail_decision_json);
    const chosenCost = d.ranked.find((r) => r.rail === d.chosen)?.costUsd;
    const cheapest = d.ranked[0]?.costUsd;
    if (chosenCost !== undefined && chosenCost > cheapest + CFG.aiGuardToleranceUsd + 1e-9) {
      flags.push(sev('RAIL_NOT_CHEAPEST', 'medium', `Chosen rail ${d.chosen} costs ${chosenCost} vs cheapest ${cheapest} USD.`));
    }
    if (d.guard && d.guard.aiProposed && !d.guard.accepted) {
      flags.push(sev('AI_PROPOSAL_OVERRIDDEN', 'info', `AI proposed ${d.guard.aiProposed}; rule guard overrode it: ${d.guard.note}`));
    }
  }

  const tok = o.pay_token ? get('SELECT status FROM qr_tokens WHERE order_id=? ORDER BY created_at DESC LIMIT 1', o.id) : null;
  if (tok) {
    if (['PAID', 'REPAID'].includes(o.state) && o.paypal_kind !== 'sim' && tok.status === 'ACTIVE') {
      flags.push(sev('QR_STILL_ACTIVE', 'high', 'Order is paid but its QR token is still active.'));
    }
    if (tok.status === 'USED' && !['PAID', 'REPAID'].includes(o.state)) {
      flags.push(sev('QR_USED_UNPAID', 'high', 'QR token is burned but the order is not settled.'));
    }
  }

  if (o.due_at && o.deferred_at) {
    const days = (new Date(o.due_at) - new Date(o.deferred_at)) / 86400000;
    if (days > CFG.tod.maxDays + 0.001) {
      flags.push(sev('TOD_TERM', 'high', `Pay-later term ${days.toFixed(1)} days exceeds maximum ${CFG.tod.maxDays}.`));
    }
  }
  if (o.airline_settled_at && o.deferred_at) {
    const mins = (new Date(o.airline_settled_at) - new Date(o.deferred_at)) / 60000;
    if (mins > CFG.tod.lenderSettleMin + 0.001) {
      flags.push(sev('LENDER_SLA', 'medium', `Airline settled after ${Math.round(mins)} min (target ${CFG.tod.lenderSettleMin}).`));
    }
  }
  if (o.state === 'OVERDUE') flags.push(sev('OVERDUE', 'medium', 'Pay-later amount is past its due date.'));
  if (o.state === 'CARD_FALLBACK_PENDING') flags.push(sev('CARD_FALLBACK_PENDING', 'medium', 'Savings-account payment not made; backup card charge is pending.'));
  const cardEv = get("SELECT type FROM audit_log WHERE order_id=? AND type IN ('CARD_GUARANTEE_CHARGED','CARD_FALLBACK_DECLINED') ORDER BY seq DESC LIMIT 1", o.id);
  if (cardEv?.type === 'CARD_GUARANTEE_CHARGED') flags.push(sev('CARD_GUARANTEE_USED', 'info', 'Paid by the backup card under the passenger\'s advance consent (higher cost than the savings-account route).'));
  if (cardEv?.type === 'CARD_FALLBACK_DECLINED') flags.push(sev('CARD_FALLBACK_DECLINED', 'medium', 'Backup card was declined (for example not enough credit limit).'));
  if (o.backup_card && !o.consent_id) flags.push(sev('CARD_WITHOUT_CONSENT', 'high', 'Card fallback recorded without a confirmed consent.'));
  const badConsent = get("SELECT payload FROM audit_log WHERE order_id=? AND type='CONSENT_INVALID' ORDER BY seq DESC LIMIT 1", o.id);
  if (badConsent) flags.push(sev('CONSENT_INVALID', 'medium', `Consent reference was not accepted (${JSON.parse(badConsent.payload).reason}); order is not card-backed.`));
  if (o.state === 'EXPIRED_UNPAID') flags.push(sev('EXPIRED_UNPAID', 'high', 'International payer never paid and has no lender fallback: the airline carries this loss.'));
  if (o.state === 'BANK_DECLINED') flags.push(sev('BANK_DECLINED', 'high', 'Lender declined: the airline carries this loss.'));
  if (o.state === 'REJECTED_LIMIT') flags.push(sev('REJECTED_LIMIT', 'high', 'Order served offline but over limit: airline carries this loss.'));
  if (o.state === 'BLOCKED_DUE') flags.push(sev('BLOCKED_DUE', 'medium', 'Buyer had an unresolved pay-later due; order not extended.'));

  const dup = get(
    `SELECT COUNT(*) AS c FROM orders WHERE contact_key=? AND amount=? AND currency=? AND id<>?
     AND ABS(COALESCE(created_offline_at,0) - ?) < 300000`,
    o.contact_key, o.amount, o.currency, o.id, o.created_offline_at || 0,
  ).c;
  if (dup > 0) flags.push(sev('POSSIBLE_DUPLICATE', 'medium', 'Same buyer and amount within 5 minutes on another order.'));

  const mismatch = get(
    "SELECT COUNT(*) AS c FROM audit_log WHERE order_id=? AND type='AMOUNT_MISMATCH'", o.id,
  ).c;
  if (mismatch > 0) flags.push(sev('AMOUNT_MISMATCH', 'high', 'A payment event reported a different amount than the order.'));

  const chain = verifyChain();
  if (!chain.ok) flags.push(sev('AUDIT_CHAIN_BROKEN', 'high', `Audit chain broken at seq ${chain.brokenAtSeq}.`));

  const risk = flags.some((f) => f.severity === 'high') ? 'high' : flags.some((f) => f.severity === 'medium') ? 'medium' : 'low';
  return { orderId: o.id, state: o.state, risk, flags };
}

export function reviewAll() {
  const ids = all('SELECT id FROM orders ORDER BY synced_at DESC').map((r) => r.id);
  const results = ids.map(review);
  log('audit-agent', 'REVIEW_ALL', null, {
    orders: results.length,
    high: results.filter((r) => r.risk === 'high').length,
    medium: results.filter((r) => r.risk === 'medium').length,
  });
  return results;
}

export { rails };
