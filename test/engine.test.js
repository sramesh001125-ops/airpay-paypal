import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { clock } from '../src/util.js';
import * as engine from '../src/engine.js';
import * as rails from '../src/rails.js';
import * as audit from '../src/audit.js';
import * as qr from '../src/qr.js';
import * as pp from '../src/paypal.js';
import { get, run } from '../src/db.js';

let n = 0;
const uid = () => `c${++n}`;
const order = (over = {}) => ({
  clientId: uid(), createdOfflineAt: Date.now() + n,
  items: [{ id: 'sandwich', qty: 1 }], amount: 400, currency: 'INR',
  buyer: { name: 'Asha Rao', contact: `+91900000${String(n).padStart(4, '0')}`, country: 'IN' },
  ...over,
});
const sync = async (orders, deviceId = 'DEV-1') =>
  (await engine.syncOrders({ deviceId, flightNo: '6E-123', orders: Array.isArray(orders) ? orders : [orders] })).map((r) => r);
const hook = (type, o, amountUsd, id) => {
  const raw = JSON.stringify({
    id: id || `WH-${Math.random()}`, event_type: type,
    resource: { custom_id: o.id, amount: { currency_code: 'USD', value: amountUsd.toFixed(2) } },
  });
  return engine.processWebhook({ 'x-mock-signature': pp.mockSign(raw) }, raw);
};
const row = (id) => get('SELECT * FROM orders WHERE id=?', id);

test('rails: US buyer prefers cheaper bank rail; card is dearer', () => {
  const r = rails.rank({ amount: 10, currency: 'USD', buyerCountry: 'US' });
  assert.equal(r.cheapest, 'ach_pay_by_bank');
  const ach = r.ranked.find((x) => x.rail === 'ach_pay_by_bank');
  assert.ok(ach.savingsVsCardUsd > 0);
});

test('rails: Indian buyer in INR picks the UPI-style leg (zero fee) over PayPal card', () => {
  const r = rails.rank({ amount: 400, currency: 'INR', buyerCountry: 'IN' });
  assert.equal(r.cheapest, 'upi_sim');
  assert.equal(r.ranked[0].costUsd, 0);
});

test('rails: irreversible rails are blocked above the cap', () => {
  const r = rails.rank({ amount: 40, currency: 'USD', buyerCountry: 'US' });
  assert.equal(r.ranked.find((x) => x.rail === 'ach_pay_by_bank').blocked, true);
  assert.equal(r.cheapest === 'ach_pay_by_bank', false);
});

test('rails: guard accepts near-cheapest AI proposal, overrides costly or ineligible ones', () => {
  const r = rails.rank({ amount: 10, currency: 'USD', buyerCountry: 'US' });
  assert.equal(rails.decide(r, { rail: 'ach_pay_by_bank', source: 'x' }).guard.accepted, true);
  const costly = rails.decide(r, { rail: 'card', source: 'x' });
  assert.equal(costly.guard.accepted, false);
  assert.equal(costly.chosen, 'ach_pay_by_bank');
  const bad = rails.decide(r, { rail: 'ideal', source: 'x' });
  assert.equal(bad.guard.accepted, false);
  assert.equal(bad.chosen, 'ach_pay_by_bank');
});

test('sync is idempotent on clientId', async () => {
  const o = order();
  const [a] = await sync(o);
  const [b] = await sync(o);
  assert.equal(b.duplicate, true);
  assert.equal(a.orderId, b.orderId);
});

test('happy path: link sent, verified webhook marks paid and burns QR only then', async () => {
  const [r] = await sync(order());
  assert.equal(r.state, 'LINK_SENT');
  let o = row(r.orderId);
  assert.equal(o.rail, 'upi_sim');
  assert.equal(qr.check(r.payToken).ok, true);

  // a declined attempt must NOT burn the token
  await hook('SIM.UPI.DECLINED', o, o.amount_usd);
  assert.equal(row(r.orderId).state, 'LINK_SENT');
  assert.equal(qr.check(r.payToken).ok, true);

  await hook('SIM.UPI.PAID', o, o.amount_usd);
  assert.equal(row(r.orderId).state, 'PAID');
  assert.equal(qr.check(r.payToken).ok, false);
  assert.equal(qr.check(r.payToken).reason, 'ALREADY_USED');
});

test('webhook: bad signature rejected, duplicate event ignored, wrong amount not accepted', async () => {
  const [r] = await sync(order());
  const o = row(r.orderId);
  const raw = JSON.stringify({ id: 'WH-X1', event_type: 'SIM.UPI.PAID', resource: { custom_id: o.id, amount: { value: '4.71' } } });
  await assert.rejects(() => engine.processWebhook({ 'x-mock-signature': 'deadbeef' }, raw), /signature/);

  const wrong = await hook('SIM.UPI.PAID', o, 99.0, 'WH-DUP');
  assert.equal(wrong.mismatch, true);
  assert.equal(row(o.id).state, 'LINK_SENT');
  const dup = await hook('SIM.UPI.PAID', o, 99.0, 'WH-DUP');
  assert.equal(dup.duplicate, true);
  assert.ok(audit.review(o.id).flags.some((f) => f.code === 'AMOUNT_MISMATCH'));
});

test('limits: per-transaction, menu-mismatch and per-device exposure', async () => {
  const [over] = await sync(order({ items: [{ id: 'sandwich', qty: 2 }], amount: 800 }));
  assert.equal(over.state, 'REJECTED_LIMIT');
  const [mis] = await sync(order({ amount: 100 }));
  assert.equal(mis.state, 'REJECTED_AMOUNT');

  const dev = 'DEV-EXPO';
  const states = [];
  for (let i = 0; i < 6; i++) states.push((await sync(order(), dev))[0].state);
  assert.deepEqual(states, ['LINK_SENT', 'LINK_SENT', 'LINK_SENT', 'LINK_SENT', 'LINK_SENT', 'REJECTED_LIMIT']);
});

test('pay-later fallback: hidden until lender confirms, 7-day term, auto-debit, block rule', async () => {
  const contact = '+919800011122';
  const [r] = await sync(order({ buyer: { name: 'Ravi Kumar', contact, country: 'IN' } }), 'DEV-TOD');
  const token = r.payToken;

  clock.advanceMinutes(CFG.linkTtlMin + 1);
  engine.sweep();
  assert.equal(row(r.orderId).state, 'DEFERRED_PENDING_BANK');
  assert.equal(qr.check(token).ok, false);

  let view = engine.publicView(token);
  assert.equal(view.status, 'PENDING');
  assert.doesNotMatch(JSON.stringify(view), /overdraft|credit|loan|pay later|savings/i);

  // blocked while unresolved
  const [blocked] = await sync(order({ buyer: { name: 'Ravi Kumar', contact, country: 'IN' } }), 'DEV-TOD2');
  assert.equal(blocked.state, 'BLOCKED_DUE');

  clock.advanceMinutes(10);
  const conf = engine.bankConfirm(r.orderId, true);
  assert.equal(conf.state, 'DEFERRED_ACTIVE');
  const o = row(r.orderId);
  const days = (new Date(o.due_at) - new Date(o.deferred_at)) / 86400000;
  assert.ok(days <= CFG.tod.maxDays + 0.01 && days > CFG.tod.maxDays - 0.1);
  assert.equal(o.lender_confirmed, 1);

  view = engine.publicView(token);
  assert.equal(view.status, 'PAY_LATER');
  assert.equal(view.totalDueInr, 410);

  // not enough balance: stays due
  let t = engine.topUp(contact, 100);
  assert.equal(t.repaid.length, 0);
  // enough: auto-debited
  t = engine.topUp(contact, 400);
  assert.deepEqual(t.repaid, [r.orderId]);
  assert.equal(row(r.orderId).state, 'REPAID');
  assert.equal(t.outstandingInr, 0);

  // block lifted
  const [again] = await sync(order({ buyer: { name: 'Ravi Kumar', contact, country: 'IN' } }), 'DEV-TOD3');
  assert.equal(again.state, 'LINK_SENT');
});

test('lender decline: airline bears loss and audit flags it; overdue after 7 days', async () => {
  const [a] = await sync(order(), 'DEV-DEC');
  clock.advanceMinutes(CFG.linkTtlMin + 1);
  engine.sweep();
  engine.bankConfirm(a.orderId, false);
  assert.equal(row(a.orderId).state, 'BANK_DECLINED');
  assert.ok(audit.review(a.orderId).flags.some((f) => f.code === 'BANK_DECLINED'));

  const [b] = await sync(order(), 'DEV-OD');
  clock.advanceMinutes(CFG.linkTtlMin + 1);
  engine.sweep();
  engine.bankConfirm(b.orderId, true);
  clock.advanceMinutes(8 * 24 * 60);
  engine.sweep();
  assert.equal(row(b.orderId).state, 'OVERDUE');
});

test('lender SLA breach is flagged', async () => {
  const [a] = await sync(order(), 'DEV-SLA');
  clock.advanceMinutes(CFG.linkTtlMin + 1);
  engine.sweep();
  clock.advanceMinutes(CFG.tod.lenderSettleMin + 20);
  engine.bankConfirm(a.orderId, true);
  assert.ok(audit.review(a.orderId).flags.some((f) => f.code === 'LENDER_SLA'));
});

test('QR token: tampering and unknown tokens fail', async () => {
  const [r] = await sync(order(), 'DEV-QR');
  const bad = r.payToken.slice(0, -2) + 'xx';
  assert.equal(qr.check(bad).ok, false);
  assert.equal(qr.check('garbage').ok, false);
});

test('audit chain verifies, and detects tampering', () => {
  assert.equal(audit.verifyChain().ok, true);
  run("UPDATE audit_log SET payload='{\"forged\":true}' WHERE seq=(SELECT MIN(seq) FROM audit_log)");
  const v = audit.verifyChain();
  assert.equal(v.ok, false);
  assert.ok(v.brokenAtSeq >= 1);
});

// ------------------------------------------------------------------ international-first model + SHIELD

const intlOrder = (over = {}) => ({
  clientId: uid(), createdOfflineAt: Date.now() + n,
  items: [{ id: 'sandwich', qty: 1 }], amount: 4.71, currency: 'USD',
  buyer: { name: 'John Miller', contact: `john${n}@example.com`, country: 'US' },
  ...over,
});

test('instruments: India UPI-debit caps do not bind international card payers', async () => {
  const items = [{ id: 'combo', qty: 8 }]; // INR 3,600 = about USD 42
  const [intl] = await sync(intlOrder({ items, amount: 42.35 }), 'DEV-INTL');
  assert.equal(intl.state, 'LINK_SENT');
  assert.equal(row(intl.orderId).instrument, 'intl');

  const [upi] = await sync(order({ items, amount: 3600 }), 'DEV-INTL2'); // India default = upi_debit
  assert.equal(upi.state, 'REJECTED_LIMIT');
  assert.equal(row(upi.orderId).instrument, 'upi_debit');
});

test('instruments: international payers still have an airline risk cap, per instrument and per device', async () => {
  const saved = CFG.limits.intl.perTxnUsd;
  CFG.limits.intl.perTxnUsd = 20;
  try {
    const [r] = await sync(intlOrder({ items: [{ id: 'combo', qty: 8 }], amount: 42.35 }), 'DEV-CAP');
    assert.equal(r.state, 'REJECTED_LIMIT');
  } finally { CFG.limits.intl.perTxnUsd = saved; }
  // UPI-debit exposure on the same device is counted separately from international exposure
  const dev = 'DEV-SEP';
  for (let i = 0; i < 5; i++) assert.equal((await sync(order(), dev))[0].state, 'LINK_SENT');
  assert.equal((await sync(order(), dev))[0].state, 'REJECTED_LIMIT');
  assert.equal((await sync(intlOrder(), dev))[0].state, 'LINK_SENT');
});

test('instruments: Indian credit-card payer is international (no UPI leg, no lender), and expiry is an airline loss', async () => {
  const contact = '+919811100099';
  const b = { name: 'Priya Nair', contact, country: 'IN', instrument: 'intl' };
  const [r] = await sync(order({ buyer: b, amount: 4.71, currency: 'USD' }), 'DEV-CC');
  assert.equal(r.state, 'LINK_SENT');
  const o = row(r.orderId);
  assert.notEqual(o.rail, 'upi_sim');
  assert.ok(['card', 'paypal_wallet'].includes(o.rail));

  // still open after the short India window: no lender, no deferral
  clock.advanceMinutes(CFG.linkTtlMin + 1);
  engine.sweep();
  assert.equal(row(r.orderId).state, 'LINK_SENT');

  // after the longer international window it just expires unpaid
  clock.advanceMinutes(CFG.intlLinkTtlMin);
  engine.sweep();
  assert.equal(row(r.orderId).state, 'EXPIRED_UNPAID');
  assert.equal(qr.check(r.payToken).ok, false);
  assert.ok(audit.review(r.orderId).flags.some((f) => f.code === 'EXPIRED_UNPAID'));
  assert.equal(engine.publicView(r.payToken).status, 'EXPIRED');
  assert.doesNotMatch(JSON.stringify(engine.publicView(r.payToken)), /overdraft|loan|savings/i);

  // the unresolved unpaid order blocks further orders by the same buyer
  const [again] = await sync(order({ buyer: b, amount: 4.71, currency: 'USD' }), 'DEV-CC2');
  assert.equal(again.state, 'BLOCKED_DUE');
});

test('instruments: rails differ by payer type for an Indian buyer; UPI-debit is rejected for non-India', async () => {
  const upi = rails.rank({ amount: 400, currency: 'INR', buyerCountry: 'IN', instrument: 'upi_debit' });
  assert.equal(upi.cheapest, 'upi_sim');
  const cc = rails.rank({ amount: 400, currency: 'INR', buyerCountry: 'IN', instrument: 'intl' });
  assert.equal(cc.ranked.some((x) => x.rail === 'upi_sim'), false);
  assert.equal(cc.cheapest, 'card');

  const [bad] = await sync(intlOrder({ buyer: { name: 'X Y', contact: 'xy@example.com', country: 'US', instrument: 'upi_debit' } }), 'DEV-BAD');
  assert.match(bad.error, /India|IN only/i);
});

test('SHIELD adapter: invalid contact and contact velocity are screened out before limits or rails', async () => {
  const [bad] = await sync(intlOrder({ buyer: { name: 'No Contact', contact: '123', country: 'US' } }), 'DEV-SH1');
  assert.equal(bad.state, 'BLOCKED_SHIELD');
  assert.ok(audit.review(bad.orderId).flags.some((f) => f.code === 'SHIELD_BLOCKED'));
  assert.equal(row(bad.orderId).pay_token, null);

  const b = { name: 'Fast Buyer', contact: 'fast.buyer@example.com', country: 'US' };
  const states = [];
  for (let i = 0; i < CFG.shield.maxOrdersPerContactDay + 1; i++) states.push((await sync(intlOrder({ buyer: b }), `DEV-V${i}`))[0].state);
  assert.equal(states.slice(0, -1).every((s) => s === 'LINK_SENT'), true);
  assert.equal(states.at(-1), 'BLOCKED_SHIELD');
});

// ------------------------------------------------------------------ consent form + card fallback (card credit line = the overdraft)

import * as consent from '../src/consent.js';

/** Runs the real consent flow: issue the form, send the code, tick, confirm. */
const confirmedConsent = (contact, country, instrument, cap = 1000) => {
  const c = consent.issue({ contact, country, instrument, maxAmountInr: cap });
  const { demoOtp } = consent.sendOtp(c.token);
  consent.confirm(c.token, { otp: demoOtp, tick: true });
  return c;
};
const expire = () => { clock.advanceMinutes(CFG.linkTtlMin + 1); engine.sweep(); };

test('consent form: generated per passenger, needs tick + correct one-time code, lockout, revoke', () => {
  const c = consent.issue({ contact: '+919876500001', country: 'IN', maxAmountInr: 1000 });
  const v = consent.view(c.token);
  assert.equal(v.status, 'ISSUED');
  assert.match(v.form.sections.map((s) => s.p).join(' '), /INR 1000/);
  assert.doesNotMatch(JSON.stringify(v.form), /overdraft|lender/i); // the form says nothing about any lender step
  assert.throws(() => consent.view('CN-FAKE.wrong'), /unknown consent link/);
  assert.throws(() => consent.view(`${c.id}.wrong`), /unknown consent link/);

  assert.throws(() => consent.confirm(c.token, { otp: '000000', tick: true }), /one-time code/);
  const { demoOtp } = consent.sendOtp(c.token);
  assert.throws(() => consent.confirm(c.token, { otp: demoOtp, tick: false }), /ticked/);
  const wrong = demoOtp === '111111' ? '222222' : '111111';
  for (let i = 0; i < CFG.consent.maxOtpTries; i++) assert.throws(() => consent.confirm(c.token, { otp: wrong, tick: true }), /wrong code/);
  assert.throws(() => consent.confirm(c.token, { otp: demoOtp, tick: true }), /too many/);
  const again = consent.sendOtp(c.token).demoOtp;
  assert.equal(consent.confirm(c.token, { otp: again, tick: true }).status, 'CONFIRMED');
  assert.equal(consent.revoke(c.token).status, 'REVOKED');

  assert.throws(() => consent.issue({ contact: '+919876500002', country: 'IN', maxAmountInr: 999999 }), /cannot exceed/);
  assert.throws(() => consent.issue({ contact: 'a@b.co', country: 'US', instrument: 'upi_debit' }), /IN only/);
});

test('consent gates the card: unconfirmed, wrong contact, over-cap, revoked and expired consents are not accepted', async () => {
  const contact = '+919876500010';
  const raw = consent.issue({ contact, country: 'IN', maxAmountInr: 1000 });          // never confirmed
  const [a] = await sync(order({ buyer: { name: 'A B', contact, country: 'IN', consentRef: raw.id } }), 'DEV-C1');
  assert.equal(row(a.orderId).backup_card, 0);
  assert.ok(audit.review(a.orderId).flags.some((f) => f.code === 'CONSENT_INVALID'));

  const ok = confirmedConsent('+919876500011', 'IN', 'upi_debit', 1000);
  const [b] = await sync(order({ buyer: { name: 'C D', contact: '+919876500099', country: 'IN', consentRef: ok.id } }), 'DEV-C2'); // wrong contact
  assert.equal(row(b.orderId).backup_card, 0);

  const small = confirmedConsent('+919876500012', 'IN', 'upi_debit', 300);             // cap below the order
  const [c2] = await sync(order({ buyer: { name: 'E F', contact: '+919876500012', country: 'IN', consentRef: small.id } }), 'DEV-C3');
  assert.equal(row(c2.orderId).backup_card, 0);

  const rev = confirmedConsent('+919876500013', 'IN', 'upi_debit', 1000);
  consent.revoke(rev.token);
  const [d] = await sync(order({ buyer: { name: 'G H', contact: '+919876500013', country: 'IN', consentRef: rev.id } }), 'DEV-C4');
  assert.equal(row(d.orderId).backup_card, 0);

  const exp = confirmedConsent('+919876500014', 'IN', 'upi_debit', 1000);
  clock.advanceMinutes(CFG.consent.validHours * 60 + 1);
  const [e] = await sync(order({ buyer: { name: 'I J', contact: '+919876500014', country: 'IN', consentRef: exp.id } }), 'DEV-C5');
  assert.equal(row(e.orderId).backup_card, 0);
});

test('card-backed UPI-debit order: not held to the small UPI caps, because the card credit line stands behind it', async () => {
  const items = [{ id: 'combo', qty: 4 }]; // INR 1,800: far above the INR 500 UPI-debit cap
  const [plain] = await sync(order({ items, amount: 1800 }), 'DEV-CB0');
  assert.equal(plain.state, 'REJECTED_LIMIT');

  const contact = '+919876500020';
  const c = confirmedConsent(contact, 'IN', 'upi_debit', 2000);
  const [r] = await sync(order({ items, amount: 1800, buyer: { name: 'Vikram Shah', contact, country: 'IN', consentRef: c.id } }), 'DEV-CB1');
  assert.equal(r.state, 'LINK_SENT');
  assert.equal(row(r.orderId).limit_key, 'card_backed');
  assert.equal(row(r.orderId).consent_id, c.id);
});

test('India fallback order: savings account, then the consented card, then the lender only if the card fails', async () => {
  const contact = '+919876500021';
  const c = confirmedConsent(contact, 'IN', 'upi_debit');
  const buyer = { name: 'Vikram Shah', contact, country: 'IN', consentRef: c.id };
  const [r] = await sync(order({ buyer }), 'DEV-F1');
  expire();
  assert.equal(row(r.orderId).state, 'CARD_FALLBACK_PENDING');
  assert.equal(qr.check(r.payToken).ok, false);
  assert.doesNotMatch(JSON.stringify(engine.publicView(r.payToken)), /overdraft|loan|credit|savings/i);
  assert.equal((await sync(order({ buyer }), 'DEV-F1b'))[0].state, 'BLOCKED_DUE'); // unresolved: no new order

  assert.equal(engine.cardFallbackConfirm(r.orderId, true).state, 'PAID');
  const o = row(r.orderId);
  assert.equal(o.rail, 'card');
  assert.equal(o.deferred_at, null);
  assert.ok(audit.review(r.orderId).flags.some((f) => f.code === 'CARD_GUARANTEE_USED'));
  assert.match(engine.publicView(r.payToken).message, /backup card/i);

  // card declined (not enough credit limit): falls to the lender overdraft
  const c2 = confirmedConsent('+919876500022', 'IN', 'upi_debit');
  const [d] = await sync(order({ buyer: { name: 'Neha Jain', contact: '+919876500022', country: 'IN', consentRef: c2.id } }), 'DEV-F2');
  expire();
  assert.equal(engine.cardFallbackConfirm(d.orderId, false).state, 'DEFERRED_PENDING_BANK');
  assert.ok(audit.review(d.orderId).flags.some((f) => f.code === 'CARD_FALLBACK_DECLINED'));
  assert.equal(engine.bankConfirm(d.orderId, true).state, 'DEFERRED_ACTIVE');

  // no consent at all: straight to the lender, as before
  const [n] = await sync(order({ buyer: { name: 'No Card', contact: '+919876500023', country: 'IN' } }), 'DEV-F3');
  expire();
  assert.equal(row(n.orderId).state, 'DEFERRED_PENDING_BANK');
});

test('international payer with card consent: card charged after landing, no loan; a declined card is an airline loss', async () => {
  const contact = 'maria.silva@example.com';
  const c = confirmedConsent(contact, 'BR', 'intl', 1000);
  const buyer = { name: 'Maria Silva', contact, country: 'BR', consentRef: c.id };
  const [r] = await sync(intlOrder({ buyer }), 'DEV-I1');
  assert.equal(r.state, 'LINK_SENT');
  expire(); // short window applies because a confirmed card consent exists
  assert.equal(row(r.orderId).state, 'CARD_FALLBACK_PENDING');
  assert.equal(engine.cardFallbackConfirm(r.orderId, true).state, 'PAID');

  const c2 = confirmedConsent('lee.wong@example.com', 'SG', 'intl', 1000);
  const [d] = await sync(intlOrder({ buyer: { name: 'Lee Wong', contact: 'lee.wong@example.com', country: 'SG', consentRef: c2.id } }), 'DEV-I2');
  expire();
  const out = engine.cardFallbackConfirm(d.orderId, false);
  assert.equal(out.state, 'EXPIRED_UNPAID'); // no lender for international payers: no loan is created
  assert.ok(audit.review(d.orderId).flags.some((f) => f.code === 'EXPIRED_UNPAID'));
  assert.equal(row(d.orderId).deferred_at, null);

  // an international payer with no consent keeps the long window and no card step
  const [p] = await sync(intlOrder(), 'DEV-I3');
  expire();
  assert.equal(row(p.orderId).state, 'LINK_SENT');
});

// ------------------------------------------------------------------ funding waterfall and cost split
import * as funding from '../src/funding.js';

test('funding plan: own money first, then bank, card only for the shortfall; cost order balance < bank < card', () => {
  const f = (balanceUsd, bankUsd) => funding.plan({ path: 'paypal', amountUsd: 10, funds: { balanceUsd, bankUsd } });
  const all = f(10, 10);
  assert.deepEqual(all.sources.map((s) => s.source), ['balance']);
  assert.equal(all.fundingCostUsd, 0);
  assert.equal(all.shortfallToCardUsd, 0);

  const part = f(4, 3); // 4 balance + 3 bank + 3 card
  assert.deepEqual(part.sources.map((s) => [s.source, s.amountUsd]), [['balance', 4], ['bank', 3], ['card', 3]]);
  assert.equal(part.shortfallToCardUsd, 3);
  assert.equal(part.sources.reduce((s, x) => s + x.amountUsd, 0), 10);

  const none = f(0, 0);
  assert.deepEqual(none.sources.map((s) => s.source), ['card']);
  assert.equal(none.fundingCostAvoidedUsd, 0);

  const bank = f(0, 10);
  assert.ok(all.fundingCostUsd < bank.fundingCostUsd && bank.fundingCostUsd < none.fundingCostUsd);
  assert.ok(part.fundingCostUsd < none.fundingCostUsd && part.fundingCostAvoidedUsd > 0);

  // India fallback: savings account first, then the consented card
  const inr = funding.plan({ path: 'savings', amountUsd: 10, funds: { balanceUsd: 6 } });
  assert.deepEqual(inr.sources.map((s) => [s.source, s.amountUsd]), [['savings_account', 6], ['card', 4]]);
  // bank-type rails are funded by one source
  assert.deepEqual(funding.planForRail({ rail: 'ach_pay_by_bank', amountUsd: 10 }).sources.map((s) => s.source), ['bank']);
  assert.ok(inr.illustrative && /ILLUSTRATIVE/.test(CFG.funding.note));
});

test('settlement records which sources paid and how much, on the order and in the audit log', async () => {
  const [r] = await sync(intlOrder({ buyer: { name: 'Ana Luz', contact: 'ana.luz@example.com', country: 'BR', simFunds: { balanceUsd: 1.5, bankUsd: 1 } } }), 'DEV-W1');
  assert.equal(r.state, 'LINK_SENT');
  const o = row(r.orderId);
  assert.ok(['card', 'paypal_wallet'].includes(o.rail));
  await hook('PAYMENT.CAPTURE.COMPLETED', { id: r.orderId }, o.amount_usd);
  const p = JSON.parse(row(r.orderId).funding_json);
  assert.deepEqual(p.sources.map((s) => s.source), ['balance', 'bank', 'card']);
  assert.equal(p.sources[0].amountUsd, 1.5);
  assert.equal(p.sources[1].amountUsd, 1);
  assert.equal(Math.round(p.sources.reduce((s, x) => s + x.amountUsd, 0) * 100) / 100, o.amount_usd);
  const ev = audit.entries(50, r.orderId).find((e) => e.type === 'FUNDING_RECORDED');
  assert.ok(ev && ev.payload.illustrative === true && ev.payload.sources.length === 3);
  assert.ok(ev.payload.shortfallToCardUsd > 0);
});

test('merchant fee does not change with the funding source; only the funding cost does', async () => {
  const mk = async (simFunds, i) => {
    const [r] = await sync(intlOrder({ buyer: { name: 'Pat Doe', contact: `pat${i}@example.com`, country: 'GB', simFunds } }), `DEV-M${i}`);
    const o = row(r.orderId);
    await hook('PAYMENT.CAPTURE.COMPLETED', { id: r.orderId }, o.amount_usd);
    const d = JSON.parse(row(r.orderId).rail_decision_json);
    return { fee: d.ranked.find((x) => x.rail === d.chosen).merchantFeeUsd, plan: JSON.parse(row(r.orderId).funding_json) };
  };
  const a = await mk({ balanceUsd: 99, bankUsd: 99 }, 1);
  const b = await mk({ balanceUsd: 0, bankUsd: 0 }, 2);
  assert.equal(a.fee, b.fee);
  assert.ok(a.plan.fundingCostUsd < b.plan.fundingCostUsd);
  assert.equal(a.plan.fundingCostAllCardUsd, b.plan.fundingCostAllCardUsd);
});

test('India fallback charges the card for the shortfall only (savings balance used first)', async () => {
  const contact = '+919876500031';
  const c = confirmedConsent(contact, 'IN', 'upi_debit');
  const buyer = { name: 'Kiran Rao', contact, country: 'IN', consentRef: c.id, simFunds: { balanceUsd: 2.0 } };
  const [r] = await sync(order({ buyer }), 'DEV-FW1');
  expire();
  assert.equal(engine.cardFallbackConfirm(r.orderId, true).state, 'PAID');
  const p = JSON.parse(row(r.orderId).funding_json);
  assert.deepEqual(p.sources.map((s) => s.source), ['savings_account', 'card']);
  assert.equal(p.sources[0].amountUsd, 2);
  assert.equal(p.shortfallToCardUsd, Math.round((row(r.orderId).amount_usd - 2) * 100) / 100);
});

test('savings report separates merchant fee from funding cost and labels both illustrative', () => {
  const s = engine.savingsReport();
  assert.ok(s.funding.settledOrders >= 3);
  assert.ok(s.funding.fundingCostAvoidedUsd > 0);
  assert.ok(s.funding.fundingCostUsd + s.funding.fundingCostAvoidedUsd - s.funding.fundingCostIfAllCardUsd < 0.011);
  assert.ok('merchantFeeUsd' in s && 'merchantFeeSavedUsd' in s);
  assert.match(s.note, /ILLUSTRATIVE/);
  assert.match(s.note, /not PayPal/i);
});

test('simulated funds are validated and can be set on an unsettled order', async () => {
  const [bad] = await sync(intlOrder({ buyer: { name: 'X Y', contact: 'xy@example.com', country: 'FR', simFunds: { balanceUsd: -5 } } }), 'DEV-V1');
  assert.match(bad.error, /simFunds/);
  const [r] = await sync(intlOrder({ buyer: { name: 'Zed Q', contact: 'zq@example.com', country: 'FR' } }), 'DEV-V2');
  assert.deepEqual(engine.setSimFunds(r.orderId, { balanceUsd: 3 }), { balanceUsd: 3, bankUsd: 0 });
  assert.throws(() => engine.setSimFunds(r.orderId, { balanceUsd: 'a' }));
});
