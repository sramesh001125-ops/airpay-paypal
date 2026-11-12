// AirPay core engine.
// IP-CANDIDATE (the protected model):
//   1. Offline order capture on a crew device with device-side AND server-side exposure limits.
//   2. Deferred settlement: a payment link/QR issued only after landing sync; pay-before-leaving window.
//   3. Lender-backed fallback: unpaid orders move to a temporary overdraft on the passenger's own
//      savings account (flat charge, 7-day maximum, auto-debit on top-up), the airline is settled by the
//      lender within a target window, and nothing about credit is shown to the passenger until the
//      lender confirms.
//   4. Block rule: a passenger with an unresolved due cannot be extended further credit/orders.
//   5. QR/link burned only on verified settlement (see qr.js) and rail choice guarded by rules (rails.js).
import crypto from 'node:crypto';
import { CFG, toUsd, toInr, defaultInstrument, limitFor, limitsByInstrument } from './config.js';
import { get, all, run } from './db.js';
import { clock, rid, round2, contactKey, maskName, HttpError } from './util.js';
import * as audit from './audit.js';
import * as rails from './rails.js';
import * as ai from './ai.js';
import * as qr from './qr.js';
import * as pp from './paypal.js';
import * as rz from './razorpay.js';
import * as shield from './shield.js';
import * as consent from './consent.js';
import * as funding from './funding.js';

// EXPIRED_UNPAID: an international payer's link ran out with no payment. There is no lender behind them,
// so the airline carries it; it still counts as open exposure and blocks further orders by that buyer.
// CARD_FALLBACK_PENDING: a UPI-debit payer who opted in to a backup credit card; the card is the guarantee
// tried first when the savings-account payment is not made. The lender overdraft is for payers with no card.
const OPEN_STATES = ['SYNCED', 'LINK_SENT', 'DEFERRED_PENDING_BANK', 'CHECKOUT_FAILED', 'EXPIRED_UNPAID', 'CARD_FALLBACK_PENDING'];
const UNRESOLVED_DUE = ['DEFERRED_PENDING_BANK', 'DEFERRED_ACTIVE', 'OVERDUE', 'EXPIRED_UNPAID', 'CARD_FALLBACK_PENDING'];
const qs = (arr) => arr.map(() => '?').join(',');

/** Open exposure on a device for one limit bucket (each payer type has its own cap; card-backed orders their own). */
export function exposure(deviceId, limitKey) {
  return get(
    `SELECT COALESCE(SUM(amount_inr),0) AS s FROM orders WHERE device_id=? AND COALESCE(limit_key, instrument)=? AND state IN (${qs(OPEN_STATES)})`,
    deviceId, limitKey, ...OPEN_STATES,
  ).s;
}

export function buyerHasDue(key) {
  if (!key) return false;
  return !!get(
    `SELECT 1 AS x FROM orders WHERE contact_key=? AND state IN (${qs(UNRESOLVED_DUE)}) LIMIT 1`,
    key, ...UNRESOLVED_DUE,
  );
}

// ------------------------------------------------------------------ sync (offline -> server)

function validateOrder(o) {
  if (!o || typeof o.clientId !== 'string' || !o.clientId) return 'clientId required';
  if (!Number.isFinite(o.amount) || o.amount <= 0) return 'amount must be > 0';
  if (!CFG.currencies.includes(o.currency)) return 'unsupported currency';
  if (!o.buyer || !/^[A-Za-z]{2}$/.test(o.buyer.country || '')) return 'buyer.country (2 letters) required';
  if (!o.buyer.contact) return 'buyer.contact required';
  if (o.buyer.instrument !== undefined && !CFG.instruments[o.buyer.instrument]) return 'unknown buyer.instrument';
  if (o.buyer.instrument === 'upi_debit' && o.buyer.country.toUpperCase() !== 'IN') return 'upi_debit is for buyers in IN only';
  if (o.buyer.consentRef !== undefined && typeof o.buyer.consentRef !== 'string') return 'buyer.consentRef must be a string';
  if (o.buyer.simFunds !== undefined && !validFunds(o.buyer.simFunds)) return 'buyer.simFunds must be {balanceUsd, bankUsd} numbers >= 0';
  if (!Array.isArray(o.items) || !o.items.length) return 'items required';
  for (const it of o.items) {
    if (!CFG.menu.find((m) => m.id === it.id)) return `unknown item ${it.id}`;
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 10) return 'item qty must be 1..10';
  }
  return null;
}

const validFunds = (f) => f && typeof f === 'object'
  && [f.balanceUsd, f.bankUsd].every((x) => x === undefined || (Number.isFinite(x) && x >= 0));

/**
 * SIMULATED payer funds. In production these are PayPal's own funding choices (balance, bank, card), which this
 * app would not know in advance. Defaults: PayPal path = linked bank covers all; savings/guarantee path = nothing
 * available, so the consented card is charged in full.
 */
function fundsFor(o, path) {
  if (o.sim_funds_json) return JSON.parse(o.sim_funds_json);
  return path === 'paypal' ? { balanceUsd: 0, bankUsd: o.amount_usd } : { balanceUsd: 0, bankUsd: 0 };
}

/** Admin/demo: set the simulated funds of an order that is not yet settled. */
export function setSimFunds(orderId, f) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'order not found');
  if (!validFunds(f)) throw new HttpError(400, 'balanceUsd and bankUsd must be numbers >= 0');
  if (['PAID', 'REPAID'].includes(o.state)) throw new HttpError(409, 'order already settled');
  const clean = { balanceUsd: round2(f.balanceUsd || 0), bankUsd: round2(f.bankUsd || 0) };
  run('UPDATE orders SET sim_funds_json=? WHERE id=?', JSON.stringify(clean), orderId);
  audit.log('server', 'SIM_FUNDS_SET', orderId, clean);
  return clean;
}

function recordFunding(o, p, source) {
  run('UPDATE orders SET funding_json=? WHERE id=?', JSON.stringify(p), o.id);
  audit.log('funding', 'FUNDING_RECORDED', o.id, {
    source, path: p.path, sources: p.sources.map((x) => ({ source: x.source, amountUsd: x.amountUsd })),
    shortfallToCardUsd: p.shortfallToCardUsd, illustrative: true,
  });
}

function expectedInr(items) {
  return items.reduce((s, it) => s + CFG.menu.find((m) => m.id === it.id).priceInr * it.qty, 0);
}

export async function syncOrders({ deviceId, flightNo, orders }) {
  if (!deviceId || !Array.isArray(orders)) throw new HttpError(400, 'deviceId and orders[] required');
  if (!get('SELECT 1 AS x FROM devices WHERE id=?', deviceId)) {
    run('INSERT INTO devices (id, flight_no, created_at) VALUES (?,?,?)', deviceId, flightNo || null, clock.iso());
  }
  const results = [];
  const sorted = [...orders].sort((a, b) => (a.createdOfflineAt || 0) - (b.createdOfflineAt || 0));

  for (const o of sorted) {
    const existing = o && o.clientId ? get('SELECT * FROM orders WHERE device_id=? AND client_id=?', deviceId, o.clientId) : null;
    if (existing) {
      results.push({ clientId: o.clientId, orderId: existing.id, state: existing.state, duplicate: true, payToken: existing.pay_token });
      continue;
    }
    const bad = validateOrder(o);
    if (bad) {
      results.push({ clientId: o?.clientId || null, error: bad });
      continue;
    }

    const amountUsd = round2(toUsd(o.amount, o.currency));
    const amountInr = round2(toInr(o.amount, o.currency));
    const key = contactKey(o.buyer.contact);
    const expInr = expectedInr(o.items);

    const country = o.buyer.country.toUpperCase();
    const instrument = o.buyer.instrument || defaultInstrument(country);
    // A backup-card fallback exists only if the passenger CONFIRMED a consent form (tick box + one-time code)
    // that matches this order's contact, country, payer type and amount. Otherwise the order is simply not card-backed.
    let consentId = null;
    let consentNote = null;
    if (o.buyer.consentRef) {
      const v = consent.validateForOrder({ id: o.buyer.consentRef, contactKey: key, amountInr, country, instrument });
      if (v.ok) consentId = v.id; else consentNote = v.reason;
    }
    const backupCard = consentId ? 1 : 0;
    // A card-backed UPI-debit order rests on the card's own credit line, so it uses the card-backed caps.
    const limitKey = backupCard && instrument === 'upi_debit' ? 'card_backed' : instrument;
    const L = limitFor(limitKey);

    // SHIELD runs first: a pre-perimeter screen before limits, rails or any credit logic.
    const sh = await shield.screen({ deviceId, contactKey: key, country, instrument, amountUsd });

    let state = 'SYNCED';
    let reason = null;
    if (sh.action === 'block') {
      state = 'BLOCKED_SHIELD';
      reason = `Screened out before processing (${sh.reasons.join(', ') || 'policy'}).`;
    } else if (Math.abs(amountInr - expInr) / expInr > 0.015) {
      state = 'REJECTED_AMOUNT';
      reason = `Amount INR ${amountInr} does not match menu total INR ${expInr}.`;
    } else if (amountInr > L.perTxnInr + 0.01) {
      state = 'REJECTED_LIMIT';
      reason = `Over the per-transaction limit for this payer type (INR ${Math.round(L.perTxnInr)}).`;
    } else if (exposure(deviceId, limitKey) + amountInr > L.perDeviceInr + 0.01) {
      state = 'REJECTED_LIMIT';
      reason = `Would exceed the open exposure limit for this payer type on this device (INR ${Math.round(L.perDeviceInr)}).`;
    } else if (buyerHasDue(key)) {
      state = 'BLOCKED_DUE';
      reason = 'Buyer has an unresolved due.';
    }

    const id = rid('AP');
    run(
      `INSERT INTO orders (id, client_id, device_id, flight_no, items_json, amount, currency, amount_usd, amount_inr,
        buyer_name, buyer_contact, contact_key, buyer_country, instrument, backup_card, consent_id, limit_key, state, created_offline_at, synced_at, sim_funds_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, o.clientId, deviceId, flightNo || null, JSON.stringify(o.items), o.amount, o.currency, amountUsd, amountInr,
      o.buyer.name || null, o.buyer.contact, key, country, instrument, backupCard, consentId, limitKey, state, o.createdOfflineAt || null, clock.iso(),
      o.buyer.simFunds ? JSON.stringify({ balanceUsd: o.buyer.simFunds.balanceUsd || 0, bankUsd: o.buyer.simFunds.bankUsd || 0 }) : null,
    );
    audit.log('shield', 'SHIELD_SCREENED', id, { action: sh.action, reasons: sh.reasons, source: sh.source });
    audit.log('server', 'ORDER_SYNCED', id, { deviceId, instrument, limitKey, backupCard, state, reason, amountInr, amountUsd });
    if (consentId) audit.log('server', 'CONSENT_APPLIED', id, { consentId });
    if (consentNote) audit.log('server', 'CONSENT_INVALID', id, { consentRef: String(o.buyer.consentRef).slice(0, 20), reason: consentNote });

    let payToken = null;
    if (state === 'SYNCED') {
      try {
        payToken = (await startPayment(id)).payToken;
      } catch (e) {
        run("UPDATE orders SET state='CHECKOUT_FAILED' WHERE id=?", id);
        audit.log('server', 'CHECKOUT_FAILED', id, { error: String(e.message).slice(0, 200) });
      }
    }
    const fresh = get('SELECT state FROM orders WHERE id=?', id);
    results.push({ clientId: o.clientId, orderId: id, state: fresh.state, reason, payToken });
  }
  return results;
}

// ------------------------------------------------------------------ payment start

export async function startPayment(orderId) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'order not found');

  const rr = rails.rank({ amount: o.amount, currency: o.currency, buyerCountry: o.buyer_country, instrument: o.instrument });
  const proposal = await ai.proposeRail({ ranked: rr.ranked, amountUsd: rr.amountUsd, buyerCountry: o.buyer_country });
  const decision = rails.decide(rr, proposal);
  audit.log('rail-agent', 'RAIL_DECIDED', o.id, {
    chosen: decision.chosen, guard: decision.guard, cheapest: rr.cheapest, amountUsd: rr.amountUsd,
  });

  // Short window when a fallback exists (confirmed card consent, or the India lender); the longer window otherwise.
  const ttlMin = o.backup_card || CFG.instruments[o.instrument]?.lenderFallback ? CFG.linkTtlMin : CFG.intlLinkTtlMin;
  const expMs = clock.now() + ttlMin * 60000;
  const payToken = qr.issue(o.id, expMs);
  run('UPDATE orders SET pay_token=?, link_expires_at=? WHERE id=?', payToken, expMs, o.id);
  const withToken = { ...o, pay_token: payToken };

  // Try the chosen rail first, then the other usable rails in cost order.
  const order = [decision.chosen, ...rr.ranked.filter((r) => !r.blocked && r.rail !== decision.chosen).map((r) => r.rail)];
  let checkout = null;
  let usedRail = null;
  let lastErr = null;
  for (const railId of order) {
    try {
      checkout = railId === 'razorpay_upi' ? await rz.createCheckout(withToken) : await pp.createCheckout(withToken, railId);
      usedRail = railId;
      break;
    } catch (e) {
      lastErr = e;
      audit.log('server', 'RAIL_FAILED', o.id, { rail: railId, error: String(e.message).slice(0, 200) });
    }
  }
  if (!checkout) throw lastErr || new Error('no rail could create a checkout');

  const finalDecision = { ...decision, chosen: usedRail };
  run(
    `UPDATE orders SET state='LINK_SENT', rail=?, rail_decision_json=?, paypal_ref=?, paypal_kind=?, approve_url=? WHERE id=?`,
    usedRail, JSON.stringify(finalDecision), checkout.ref, checkout.kind, checkout.approveUrl, o.id,
  );
  audit.log('server', 'LINK_CREATED', o.id, {
    rail: usedRail, kind: checkout.kind, ref: checkout.ref, expiresInMin: ttlMin,
  });
  return { payToken, rail: usedRail };
}

// ------------------------------------------------------------------ settlement

const PAYABLE = ['LINK_SENT', 'DEFERRED_PENDING_BANK', 'DEFERRED_ACTIVE', 'OVERDUE'];

function markPaid(o, { amountUsd, source }) {
  if (!PAYABLE.includes(o.state)) {
    audit.log('server', 'PAYMENT_IGNORED', o.id, { state: o.state, source });
    return { ignored: true, state: o.state };
  }
  if (amountUsd !== null && amountUsd !== undefined && Math.abs(amountUsd - o.amount_usd) > 0.011) {
    audit.log('server', 'AMOUNT_MISMATCH', o.id, { expected: o.amount_usd, got: amountUsd, source });
    return { mismatch: true, state: o.state };
  }
  const repay = o.state === 'DEFERRED_ACTIVE' || o.state === 'OVERDUE';
  const now = clock.iso();
  run(
    'UPDATE orders SET state=?, paid_at=?, repaid_at=? WHERE id=?',
    repay ? 'REPAID' : 'PAID', now, repay ? now : null, o.id,
  );
  qr.burn(o.id); // burned only now, on verified settlement
  if (!repay) {
    const p = funding.planForRail({ rail: o.rail, amountUsd: o.amount_usd, funds: fundsFor(o, 'paypal') });
    recordFunding(o, p, source);
  }
  if (repay) {
    const owed = o.amount_inr + (o.flat_charge_inr || 0);
    run('UPDATE sb_accounts SET outstanding_inr = MAX(0, outstanding_inr - ?) WHERE contact_key=?', owed, o.contact_key);
  }
  audit.log('server', repay ? 'REPAID_VIA_LINK' : 'PAYMENT_CONFIRMED', o.id, { source, amountUsd: amountUsd ?? null });
  return { state: repay ? 'REPAID' : 'PAID' };
}

/**
 * Ask PayPal directly whether this order is paid, and settle it if so. Works without a webhook,
 * so it is the way to confirm a sandbox payment when the app runs on localhost.
 */
export async function checkPayment(orderId) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'unknown order');
  if (o.paypal_kind === 'rzp') {
    if (CFG.razorpay.mode !== 'test') return { state: o.state, note: 'Razorpay mock mode: use the simulated checkout page.' };
    if (!PAYABLE.includes(o.state)) return { state: o.state, note: `Order is already ${o.state}.` };
    const s = await rz.status(o.paypal_ref);
    audit.log('server', 'RAZORPAY_STATUS_CHECKED', o.id, { status: s.status });
    if (s.status === 'paid') {
      return { razorpayStatus: s.status, ...markPaid(o, { amountUsd: s.amountPaidInr == null ? null : toUsd(s.amountPaidInr, 'INR'), source: 'razorpay-status-check' }) };
    }
    return { state: o.state, razorpayStatus: s.status, note: 'Razorpay does not show this as paid yet.' };
  }
  if (CFG.paypal.mode !== 'live') return { state: o.state, note: 'Mock mode: use the simulated checkout page.' };
  if (!['order', 'invoice'].includes(o.paypal_kind)) return { state: o.state, note: 'Not a PayPal payment.' };
  if (!PAYABLE.includes(o.state)) return { state: o.state, note: `Order is already ${o.state}.` };
  let paypalStatus;
  if (o.paypal_kind === 'invoice') {
    const s = await pp.invoiceStatus(o.paypal_ref);
    paypalStatus = s.status;
    audit.log('server', 'PAYPAL_STATUS_CHECKED', o.id, { kind: 'invoice', paypalStatus });
    if (['PAID', 'MARKED_AS_PAID'].includes(paypalStatus)) {
      return { paypalStatus, ...markPaid(o, { amountUsd: s.paidAmountUsd, source: 'invoice-status-check' }) };
    }
  } else {
    const s = await pp.orderStatus(o.paypal_ref);
    paypalStatus = s.status;
    audit.log('server', 'PAYPAL_STATUS_CHECKED', o.id, { kind: 'order', paypalStatus });
    if (paypalStatus === 'APPROVED') {
      const cap = await pp.captureOrder(o.paypal_ref);
      const amt = num(cap.raw?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value);
      if (cap.status === 'COMPLETED') return { paypalStatus: 'COMPLETED', ...markPaid(get('SELECT * FROM orders WHERE id=?', o.id), { amountUsd: amt, source: 'order-status-check' }) };
    } else if (paypalStatus === 'COMPLETED') {
      const amt = num(s.raw?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value);
      return { paypalStatus, ...markPaid(o, { amountUsd: amt, source: 'order-status-check' }) };
    }
  }
  return { state: o.state, paypalStatus, note: 'PayPal does not show this as paid yet.' };
}

/** SANDBOX ONLY: record a test payment on the PayPal invoice, then settle through the normal path. */
export async function recordTestPayment(orderId) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'unknown order');
  if (CFG.paypal.mode !== 'live') throw new HttpError(400, 'Needs PAYPAL_MODE=live (PayPal sandbox)');
  if (o.paypal_kind !== 'invoice') throw new HttpError(400, 'Only PayPal-hosted invoices can take a recorded test payment');
  if (!PAYABLE.includes(o.state)) throw new HttpError(409, `Order is ${o.state}`);
  await pp.recordInvoicePayment(o.paypal_ref, o.amount_usd);
  audit.log('admin', 'TEST_PAYMENT_RECORDED', o.id, { amountUsd: o.amount_usd, note: 'recorded through Invoicing API, not via checkout' });
  const s = await pp.invoiceStatus(o.paypal_ref);
  return { paypalStatus: s.status, ...markPaid(get('SELECT * FROM orders WHERE id=?', o.id), { amountUsd: o.amount_usd, source: 'invoice-test-recorded' }) };
}

function findOrderForEvent(res) {
  const cid = res.custom_id || res.purchase_units?.[0]?.custom_id;
  let o = cid ? get('SELECT * FROM orders WHERE id=?', cid) : null;
  if (!o) {
    const ref = res.supplementary_data?.related_ids?.order_id || res.invoice?.id || res.id;
    if (ref) o = get('SELECT * FROM orders WHERE paypal_ref=?', ref);
  }
  return o;
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

export async function processWebhook(headers, rawBody) {
  const ok = await pp.verifyWebhook(headers, rawBody);
  if (!ok) {
    audit.log('server', 'WEBHOOK_REJECTED', null, { reason: 'bad signature' });
    throw new HttpError(401, 'invalid webhook signature');
  }
  const ev = JSON.parse(rawBody);
  if (!ev.id || !ev.event_type) throw new HttpError(400, 'malformed event');
  if (get('SELECT 1 AS x FROM webhook_events WHERE id=?', ev.id)) return { duplicate: true };
  run('INSERT INTO webhook_events (id, type, received_at) VALUES (?,?,?)', ev.id, ev.event_type, clock.iso());

  const res = ev.resource || {};
  const o = findOrderForEvent(res);
  if (!o) {
    audit.log('server', 'WEBHOOK_NO_ORDER', null, { type: ev.event_type, id: ev.id });
    return { ignored: true };
  }

  switch (ev.event_type) {
    case 'CHECKOUT.ORDER.APPROVED': {
      const cap = await pp.captureOrder(res.id);
      if (cap.status === 'COMPLETED') {
        const amt = num(cap.raw?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value);
        return markPaid(get('SELECT * FROM orders WHERE id=?', o.id), { amountUsd: amt, source: 'order-capture' });
      }
      audit.log('server', 'CAPTURE_NOT_COMPLETED', o.id, { status: cap.status });
      return { state: o.state };
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
      return markPaid(o, { amountUsd: num(res.amount?.value), source: 'capture-webhook' });
    case 'INVOICING.INVOICE.PAID':
      return markPaid(o, { amountUsd: num(res.invoice?.amount?.value ?? res.amount?.value), source: 'invoice-webhook' });
    case 'SIM.UPI.PAID':
      return markPaid(o, { amountUsd: num(res.amount?.value), source: 'simulated-upi' });
    case 'PAYMENT.CAPTURE.DENIED':
    case 'SIM.UPI.DECLINED':
      audit.log('server', 'PAYMENT_DENIED', o.id, { type: ev.event_type });
      return { denied: true, state: o.state }; // order stays LINK_SENT so the buyer can retry
    default:
      audit.log('server', 'WEBHOOK_UNHANDLED', o.id, { type: ev.event_type });
      return { unhandled: true };
  }
}

/** Razorpay webhook (payment_link.paid etc.). Signature checked, de-duplicated, amount-checked. */
export async function processRazorpayWebhook(headers, rawBody) {
  if (!rz.enabled()) throw new HttpError(404, 'Razorpay rail is off');
  if (!rz.verifyWebhook(headers, rawBody)) {
    audit.log('server', 'WEBHOOK_REJECTED', null, { reason: 'bad razorpay signature' });
    throw new HttpError(401, 'invalid webhook signature');
  }
  const ev = JSON.parse(rawBody);
  const evId = `rzp-${headers['x-razorpay-event-id'] || crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;
  if (!ev.event) throw new HttpError(400, 'malformed event');
  if (get('SELECT 1 AS x FROM webhook_events WHERE id=?', evId)) return { duplicate: true };
  run('INSERT INTO webhook_events (id, type, received_at) VALUES (?,?,?)', evId, ev.event, clock.iso());

  const ent = ev.payload?.payment_link?.entity || {};
  const o = (ent.reference_id && get('SELECT * FROM orders WHERE id=?', ent.reference_id))
    || (ent.id && get('SELECT * FROM orders WHERE paypal_ref=?', ent.id));
  if (!o) {
    audit.log('server', 'WEBHOOK_NO_ORDER', null, { type: ev.event, id: evId });
    return { ignored: true };
  }
  switch (ev.event) {
    case 'payment_link.paid': {
      const inr = ent.currency === 'INR' && ent.amount_paid != null ? ent.amount_paid / 100 : null;
      return markPaid(o, { amountUsd: inr == null ? null : toUsd(inr, 'INR'), source: 'razorpay-webhook' });
    }
    case 'payment_link.expired':
    case 'payment_link.cancelled':
      audit.log('server', 'PAYMENT_DENIED', o.id, { type: ev.event });
      return { denied: true, state: o.state };
    default:
      audit.log('server', 'WEBHOOK_UNHANDLED', o.id, { type: ev.event });
      return { unhandled: true };
  }
}

// ------------------------------------------------------------------ deferral / lender fallback

function defer(o) {
  run("UPDATE orders SET state='DEFERRED_PENDING_BANK', deferred_at=? WHERE id=?", clock.iso(), o.id);
  qr.expire(o.id);
  audit.log('server', 'DEFERRED_TO_LENDER', o.id, {
    note: 'Unpaid after link window. Lender asked to settle the airline. Passenger not told about credit yet.',
    amountInr: o.amount_inr,
  });
}

/** Savings-account payment not made in the window: try the passenger's pre-agreed backup credit card first. */
function startCardFallback(o) {
  run("UPDATE orders SET state='CARD_FALLBACK_PENDING' WHERE id=?", o.id);
  qr.expire(o.id);
  audit.log('server', 'CARD_FALLBACK_STARTED', o.id, {
    note: 'Savings-account payment not completed in the window. Charging the backup card the passenger opted in to (simulated).',
    amountInr: o.amount_inr,
  });
}

/**
 * Outcome of the backup-card charge (a simulation desk stands in for the card network).
 * Charged => PAID, no loan involved (the card's own credit line is the overdraft).
 * Declined (e.g. not enough credit limit) => India UPI-debit payers fall through to the lender overdraft;
 * international payers have no lender, so the order expires unpaid and the airline carries it.
 */
export function cardFallbackConfirm(orderId, approve) {
  sweep();
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'order not found');
  if (o.state !== 'CARD_FALLBACK_PENDING') throw new HttpError(409, `order is ${o.state}, not awaiting a card charge`);
  if (approve) {
    run("UPDATE orders SET state='PAID', paid_at=?, rail='card' WHERE id=?", clock.iso(), orderId);
    // Card only for the shortfall: any savings balance (UPI-debit) or PayPal balance/bank (international) is used first.
    const path = o.instrument === 'upi_debit' ? 'savings' : 'paypal';
    recordFunding(o, funding.plan({ path, amountUsd: o.amount_usd, funds: fundsFor(o, 'guarantee') }), 'card-guarantee');
    audit.log('card-network', 'CARD_GUARANTEE_CHARGED', orderId, { amountUsd: o.amount_usd, note: 'Backup card charged under the passenger\'s advance consent.' });
    return { state: 'PAID' };
  }
  const lender = !!CFG.instruments[o.instrument]?.lenderFallback;
  audit.log('card-network', 'CARD_FALLBACK_DECLINED', orderId, { note: lender ? 'Backup card declined; moving to the lender overdraft.' : 'Backup card declined; no lender for this payer type.' });
  if (lender) { defer(o); return { state: 'DEFERRED_PENDING_BANK' }; }
  expireUnpaid(o);
  return { state: 'EXPIRED_UNPAID' };
}

/** International payer who never paid: no lender, no overdraft. The airline carries it; flagged by the audit agent. */
function expireUnpaid(o) {
  run("UPDATE orders SET state='EXPIRED_UNPAID' WHERE id=?", o.id);
  qr.expire(o.id);
  audit.log('server', 'EXPIRED_UNPAID', o.id, {
    note: 'Link expired unpaid. International payers have no lender fallback; the airline pursues collection.',
    amountInr: o.amount_inr,
  });
}

export function sweep() {
  const nowMs = clock.now();
  const nowIso = clock.iso();
  let deferred = 0;
  let overdue = 0;
  for (const o of all("SELECT * FROM orders WHERE state='LINK_SENT' AND link_expires_at<=?", nowMs)) {
    if (o.backup_card) {
      startCardFallback(o);
    } else if (CFG.instruments[o.instrument]?.lenderFallback) {
      defer(o);
      deferred += 1;
    } else {
      expireUnpaid(o);
    }
  }
  for (const o of all("SELECT * FROM orders WHERE state='DEFERRED_ACTIVE' AND due_at<=?", nowIso)) {
    run("UPDATE orders SET state='OVERDUE' WHERE id=?", o.id);
    audit.log('server', 'MARKED_OVERDUE', o.id, { dueAt: o.due_at });
    overdue += 1;
  }
  return { deferred, overdue, clockOffsetMin: clock.offsetMinutes() };
}

/** Lender decision. Approve => airline settled, TOD booked on the passenger's savings account. */
export function bankConfirm(orderId, approve) {
  sweep();
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw new HttpError(404, 'order not found');
  if (o.state !== 'DEFERRED_PENDING_BANK') throw new HttpError(409, `order is ${o.state}, not awaiting the lender`);
  if (!approve) {
    run("UPDATE orders SET state='BANK_DECLINED' WHERE id=?", orderId);
    audit.log('lender', 'BANK_DECLINED', orderId, { airlineBearsLossInr: o.amount_inr });
    return { state: 'BANK_DECLINED' };
  }
  const now = clock.now();
  const nowIso = clock.iso();
  const dueIso = new Date(now + CFG.tod.maxDays * 86400000).toISOString();
  const flat = CFG.tod.flatChargeInr;
  run(
    `UPDATE orders SET state='DEFERRED_ACTIVE', lender_confirmed=1, airline_settled_at=?, due_at=?, flat_charge_inr=? WHERE id=?`,
    nowIso, dueIso, flat, orderId,
  );
  run(
    `INSERT INTO sb_accounts (contact_key, balance_inr, outstanding_inr) VALUES (?,0,?)
     ON CONFLICT(contact_key) DO UPDATE SET outstanding_inr = outstanding_inr + excluded.outstanding_inr`,
    o.contact_key, o.amount_inr + flat,
  );
  const minutes = Math.round((now - new Date(o.deferred_at).getTime()) / 60000);
  audit.log('lender', 'LENDER_SETTLED_AIRLINE', orderId, {
    airlineSettledAfterMin: minutes, targetMin: CFG.tod.lenderSettleMin, dueAt: dueIso, flatChargeInr: flat,
  });
  return { state: 'DEFERRED_ACTIVE', dueAt: dueIso, flatChargeInr: flat, airlineSettledAfterMin: minutes };
}

/** Passenger adds money to the savings account; dues are auto-debited oldest first. */
export function topUp(contact, amountInr) {
  const key = contactKey(contact);
  if (!key) throw new HttpError(400, 'contact required');
  if (!Number.isFinite(amountInr) || amountInr <= 0) throw new HttpError(400, 'amountInr must be > 0');
  sweep();
  run(
    `INSERT INTO sb_accounts (contact_key, balance_inr, outstanding_inr) VALUES (?,?,0)
     ON CONFLICT(contact_key) DO UPDATE SET balance_inr = balance_inr + excluded.balance_inr`,
    key, amountInr,
  );
  audit.log('passenger', 'SB_TOPUP', null, { contactKey: maskContact(key), amountInr });
  const repaid = [];
  const dues = all(
    "SELECT * FROM orders WHERE contact_key=? AND state IN ('DEFERRED_ACTIVE','OVERDUE') ORDER BY deferred_at ASC", key,
  );
  for (const o of dues) {
    const acct = get('SELECT * FROM sb_accounts WHERE contact_key=?', key);
    const owed = o.amount_inr + (o.flat_charge_inr || 0);
    if (acct.balance_inr + 1e-9 < owed) break;
    run('UPDATE sb_accounts SET balance_inr = balance_inr - ?, outstanding_inr = MAX(0, outstanding_inr - ?) WHERE contact_key=?', owed, owed, key);
    run("UPDATE orders SET state='REPAID', repaid_at=? WHERE id=?", clock.iso(), o.id);
    audit.log('server', 'AUTO_DEBIT_REPAID', o.id, { owedInr: owed });
    repaid.push(o.id);
  }
  const acct = get('SELECT * FROM sb_accounts WHERE contact_key=?', key);
  return { repaid, balanceInr: round2(acct.balance_inr), outstandingInr: round2(acct.outstanding_inr) };
}

const maskContact = (k) => (k.length <= 4 ? '****' : `${'*'.repeat(k.length - 4)}${k.slice(-4)}`);

// ------------------------------------------------------------------ passenger-facing view

export function publicView(token) {
  sweep();
  const t = qr.peek(token);
  if (!t) throw new HttpError(404, 'unknown or invalid link');
  const o = get('SELECT * FROM orders WHERE id=?', t.order_id);
  const items = JSON.parse(o.items_json || '[]').map((it) => ({
    name: CFG.menu.find((m) => m.id === it.id)?.name || it.id, qty: it.qty,
  }));
  const decision = o.rail_decision_json ? JSON.parse(o.rail_decision_json) : null;
  const base = {
    orderId: o.id, flight: o.flight_no, items, buyer: maskName(o.buyer_name),
    amount: o.amount, currency: o.currency, state: o.state,
    rail: o.rail ? CFG.rails[o.rail]?.label : null,
    railCostUsd: decision?.ranked?.find((r) => r.rail === o.rail)?.costUsd ?? null,
  };
  switch (o.state) {
    case 'LINK_SENT':
      return { ...base, status: 'AWAITING_PAYMENT', canPay: qr.check(token).ok, expiresAt: new Date(o.link_expires_at).toISOString() };
    case 'PAID':
      return { ...base, status: 'PAID', message: get("SELECT 1 AS x FROM audit_log WHERE order_id=? AND type='CARD_GUARANTEE_CHARGED'", o.id) ? 'Payment received on the backup card you agreed to. Thank you.' : 'Payment received. Thank you.' };
    case 'CARD_FALLBACK_PENDING':
    case 'DEFERRED_PENDING_BANK':
    case 'BANK_DECLINED':
      // Rule: nothing about credit is shown until the lender confirms.
      return { ...base, status: 'PENDING', message: 'Your payment is still being processed. We will update this page shortly.' };
    case 'DEFERRED_ACTIVE':
    case 'OVERDUE':
      return {
        ...base, status: o.state === 'OVERDUE' ? 'OVERDUE' : 'PAY_LATER',
        dueAt: o.due_at, flatChargeInr: o.flat_charge_inr, totalDueInr: round2(o.amount_inr + o.flat_charge_inr),
        message: 'Your bank has temporarily covered this purchase on your savings account. Add money to your savings account by the due date; the amount is then debited automatically.',
      };
    case 'REPAID':
      return { ...base, status: 'REPAID', message: 'Settled. Thank you.' };
    case 'EXPIRED_UNPAID':
      return { ...base, status: 'EXPIRED', message: 'This payment link has expired. Please contact the airline to settle your purchase.' };
    default:
      return { ...base, status: o.state, message: 'This order could not be completed. Please speak to the crew.' };
  }
}

export function startPay(token) {
  sweep();
  const c = qr.check(token);
  if (!c.ok) throw new HttpError(410, `link not usable: ${c.reason}`);
  const o = get('SELECT * FROM orders WHERE id=?', c.orderId);
  if (o.state !== 'LINK_SENT') throw new HttpError(409, `order is ${o.state}`);
  audit.log('passenger', 'PAY_STARTED', o.id, { rail: o.rail });
  return { url: o.approve_url, rail: o.rail, kind: o.paypal_kind };
}

// ------------------------------------------------------------------ read models

const hydrate = (o) => ({
  ...o,
  items: JSON.parse(o.items_json || '[]'),
  railDecision: o.rail_decision_json ? JSON.parse(o.rail_decision_json) : null,
  approve_url: undefined, // never list bearer links in admin tables
  pay_token: o.pay_token ? `${o.pay_token.slice(0, 10)}…` : null,
  items_json: undefined,
  rail_decision_json: undefined,
});

export function listOrders() {
  sweep();
  return all('SELECT * FROM orders ORDER BY synced_at DESC, rowid DESC').map(hydrate);
}
export function getOrder(id) {
  sweep();
  const o = get('SELECT * FROM orders WHERE id=?', id);
  return o ? hydrate(o) : null;
}
export function ledgerSummary() {
  sweep();
  const states = all('SELECT state, COUNT(*) AS n, ROUND(SUM(amount_inr),2) AS inr FROM orders GROUP BY state');
  const accounts = all('SELECT * FROM sb_accounts ORDER BY outstanding_inr DESC').map((a) => ({
    contact: maskContact(a.contact_key), balance_inr: round2(a.balance_inr), outstanding_inr: round2(a.outstanding_inr), key: a.contact_key,
  }));
  const savings = all(`SELECT rail, COUNT(*) AS n FROM orders WHERE rail IS NOT NULL GROUP BY rail`);
  return { states, accounts, railMix: savings, clockOffsetMin: clock.offsetMinutes(), limits: limitsByInstrument(), tod: CFG.tod };
}

/**
 * Cost evidence, split in two so they are never mixed up:
 *  - MERCHANT FEE: what the merchant (airline) pays PayPal. Depends on the rail, NOT on which source funds it.
 *  - FUNDING COST: what it costs upstream to pull the money from the payer's source (balance < bank < card).
 *    The card cost avoided by funding from balance or bank is PayPal's saving, not the merchant's.
 * Every figure comes from the editable ILLUSTRATIVE tables in config.js; none is a PayPal cost or rate.
 */
export function savingsReport() {
  const rows = all("SELECT * FROM orders WHERE rail_decision_json IS NOT NULL");
  let chosen = 0;
  let card = 0;
  let volume = 0;
  for (const o of rows) {
    const d = JSON.parse(o.rail_decision_json);
    const c = d.ranked.find((r) => r.rail === d.chosen)?.costUsd;
    const k = d.ranked.find((r) => r.rail === 'card')?.costUsd;
    if (c === undefined || k === undefined) continue;
    chosen += c; card += k; volume += o.amount_usd;
  }
  let fundOrders = 0; let fundCost = 0; let fundAllCard = 0; let fundVolume = 0; let shortfall = 0;
  const bySource = {};
  for (const o of all("SELECT funding_json FROM orders WHERE funding_json IS NOT NULL")) {
    const p = JSON.parse(o.funding_json);
    fundOrders += 1; fundCost += p.fundingCostUsd; fundAllCard += p.fundingCostAllCardUsd; fundVolume += p.amountUsd;
    shortfall += p.shortfallToCardUsd;
    for (const x of p.sources) bySource[x.source] = round2((bySource[x.source] || 0) + x.amountUsd);
  }
  return {
    orders: rows.length, volumeUsd: round2(volume),
    // merchant fee (unchanged by the funding source)
    merchantFeeUsd: round2(chosen), merchantFeeIfCardUsd: round2(card),
    merchantFeeSavedUsd: round2(card - chosen), merchantFeeSavedPct: card ? round2(((card - chosen) / card) * 100) : 0,
    // funding cost (borne upstream)
    funding: {
      settledOrders: fundOrders, volumeUsd: round2(fundVolume), byFundingSourceUsd: bySource, shortfallChargedToCardUsd: round2(shortfall),
      fundingCostUsd: round2(fundCost), fundingCostIfAllCardUsd: round2(fundAllCard),
      fundingCostAvoidedUsd: round2(fundAllCard - fundCost),
      fundingCostAvoidedPct: fundAllCard ? round2(((fundAllCard - fundCost) / fundAllCard) * 100) : 0,
    },
    // legacy field names kept for older clients
    costChosenUsd: round2(chosen), costIfCardUsd: round2(card), savedUsd: round2(card - chosen), savedPct: card ? round2(((card - chosen) / card) * 100) : 0,
    note: 'ILLUSTRATIVE. Merchant fee and funding cost come from editable tables in config.js, not PayPal contract rates or costs. The merchant pays the same fee whichever source funds a payment; funding cost avoided accrues upstream (PayPal), not to the merchant.',
  };
}
