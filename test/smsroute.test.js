import './setup_sms.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine.js';
import * as sms from '../src/smsroute.js';
import * as audit from '../src/audit.js';
import { get, all } from '../src/db.js';
import { clock, round2 } from '../src/util.js';
import { toUsd } from '../src/config.js';

let n = 0; let dv = 0;
const phone = () => `+91902222${String(++n).padStart(4, '0')}`;
const SELLER = '+919000000001';
async function syncOne(contact = phone(), amount = 400) {
  const r = (await engine.syncOrders({ deviceId: `DEV-S${++dv}`, flightNo: '6E-2', orders: [{
    clientId: `s${n}-${Math.random()}`, createdOfflineAt: Date.now() + n, items: [{ id: 'sandwich', qty: 1 }], amount, currency: 'INR',
    buyer: { name: 'Asha Rao', contact, country: 'IN' },
  }] }))[0];
  return { orderId: r.orderId, contact };
}
const order = (id) => get('SELECT * FROM orders WHERE id=?', id);
const lastTo = (contact, kind) => [...sms.getOutbox(contact)].reverse().find((m) => m.kind === kind);

test('sms: happy path. One tap returns the code, audit allows, payer settles, order is PAID and identifier burned', async () => {
  const { orderId, contact } = await syncOne();
  assert.equal(order(orderId).state, 'LINK_SENT');
  sms.issue(orderId, { capability: 'smartphone' });
  const v = lastTo(contact, 'verify');
  assert.match(v.text, /sms:\+?\d+\?body=\d{10}/);
  const r = await sms.inbound({ from: contact, body: v.demo.replyBody });
  assert.equal(r.verified, true);
  assert.equal(r.decision, 'ALLOWED');
  assert.match(r.payeeId, /^\d{10}$/);
  assert.match(r.upiLink, /^upi:\/\/pay\?pa=\d{10}@/);
  const pay = lastTo(contact, 'pay');
  assert.match(pay.text, /\*99#/);
  assert.match(pay.text, /Never send your UPI PIN/);
  const s = sms.settle({ ident: r.payeeId, amountInr: 400, eventId: 'e1' });
  assert.equal(s.state, 'PAID');
  assert.equal(order(orderId).state, 'PAID');
  assert.equal(get('SELECT status FROM payee_ids WHERE ident=?', r.payeeId).status, 'BURNED');
  assert.equal(audit.verifyChain().ok, true);
});

test('sms: the code is bound to the sender number; a different number is refused and counted', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, {});
  const code = lastTo(contact, 'verify').demo.replyBody;
  const r = await sms.inbound({ from: '+919333300000', body: code });
  assert.equal(r.reason, 'sender_mismatch');
  assert.equal(order(orderId).state, 'LINK_SENT');
  assert.equal(all('SELECT * FROM sms_challenges WHERE order_id=?', orderId)[0].tries, 1);
});

test('sms: a code works once only', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, {});
  const code = lastTo(contact, 'verify').demo.replyBody;
  assert.equal((await sms.inbound({ from: contact, body: code })).verified, true);
  assert.equal((await sms.inbound({ from: contact, body: code })).accepted, false);
});

test('sms: only the expected pattern is accepted; anything else is rejected and not stored', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, {});
  for (const body of ['1234', '123456 7890', 'my pin is 4821', 'AIRPAY 12']) {
    const r = await sms.inbound({ from: contact, body });
    assert.equal(r.reason, 'pattern');
  }
  const log = JSON.stringify(all('SELECT payload FROM audit_log'));
  assert.ok(!log.includes('4821'));
});

test('sms: the code is never written to the audit log or stored in clear', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, {});
  const code = lastTo(contact, 'verify').demo.replyBody;
  await sms.inbound({ from: contact, body: code });
  assert.ok(!JSON.stringify(all('SELECT * FROM audit_log')).includes(code));
  assert.ok(!JSON.stringify(all('SELECT * FROM sms_challenges')).includes(code));
});

test('sms: an expired code is refused', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, {});
  const code = lastTo(contact, 'verify').demo.replyBody;
  clock.advanceMinutes(20);
  assert.equal((await sms.inbound({ from: contact, body: code })).reason, 'expired');
  clock.advanceMinutes(-20);
});

test('sms: reply route (basic phone) uses a short reference; AIRPAY prefix accepted', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, { capability: 'basic' });
  const v = lastTo(contact, 'verify');
  assert.match(v.text, /Reply AIRPAY \d{6}/);
  const r = await sms.inbound({ from: contact, body: v.demo.replyBody });
  assert.equal(r.verified, true);
});

test('sms: two-sided match needs both the payer and the seller before the audit runs', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, { twoSided: true, payeeNumber: SELLER });
  const payerCode = lastTo(contact, 'verify').demo.replyBody;
  const sellerCode = lastTo(SELLER, 'verify-payee').demo.replyBody;
  const a = await sms.inbound({ from: contact, body: payerCode });
  assert.equal(a.verified, false);
  assert.equal(a.waitingFor, 'payee');
  assert.equal(all('SELECT * FROM payee_ids WHERE order_id=?', orderId).length, 0);
  assert.equal((await sms.inbound({ from: contact, body: sellerCode })).reason, 'sender_mismatch'); // seller code from payer's phone
  const b = await sms.inbound({ from: SELLER, body: sellerCode });
  assert.equal(b.verified, true);
  assert.equal(b.decision, 'ALLOWED');
});

test('sms: audit denies when the amount changed after the code was issued; nothing is requested', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, {});
  const code = lastTo(contact, 'verify').demo.replyBody;
  const { run } = await import('../src/db.js');
  run('UPDATE orders SET amount_inr=amount_inr+50 WHERE id=?', orderId);
  const r = await sms.inbound({ from: contact, body: code });
  assert.equal(r.decision, 'DENIED');
  assert.ok(r.failed.includes('amount_equals_captured'));
  assert.equal(all('SELECT * FROM payee_ids WHERE order_id=?', orderId).length, 0);
});

test('sms: the identifier is not burned by a mismatching amount, a started attempt or a failed attempt; a matching amount burns it', async () => {
  const { orderId, contact } = await syncOne();
  sms.issue(orderId, {});
  const r = await sms.inbound({ from: contact, body: lastTo(contact, 'verify').demo.replyBody });
  sms.attempt(r.payeeId); sms.attempt(r.payeeId, { failed: true });
  assert.equal(sms.settle({ ident: r.payeeId, amountInr: 100, eventId: 'm1' }).mismatch, true);
  assert.equal(get('SELECT status FROM payee_ids WHERE ident=?', r.payeeId).status, 'ISSUED');
  assert.equal(order(orderId).state, 'LINK_SENT');
  assert.equal(sms.settle({ ident: r.payeeId, amountInr: 400, eventId: 'm2' }).state, 'PAID');
  assert.equal(sms.settle({ ident: r.payeeId, amountInr: 400, eventId: 'm2' }).duplicate, true);
});

test('sms: capability ladder escalates app link, light page, then SMS and *99# only; the winning route is remembered', async () => {
  const { orderId, contact } = await syncOne();
  const i = sms.issue(orderId, { capability: 'smartphone' });
  assert.equal(i.route, 'app_link');
  assert.equal(sms.escalate(i.challengeId).route, 'light_page');
  assert.match(lastTo(contact, 'verify').text, /\/s\.html\?c=/);
  assert.equal(sms.escalate(i.challengeId).route, 'sms_ussd');
  assert.equal(sms.escalate(i.challengeId).exhausted, true);
  const r = await sms.inbound({ from: contact, body: lastTo(contact, 'verify').demo.replyBody });
  assert.equal(r.verified, true);
  // next order for the same number starts on the route that worked
  const next = await syncOne(contact);
  assert.equal(sms.issue(next.orderId, { capability: 'smartphone' }).route, 'sms_ussd');
});

test('sms: window timer escalates a silent challenge', async () => {
  const { orderId } = await syncOne();
  const i = sms.issue(orderId, { capability: 'smartphone' });
  assert.equal(sms.tick().length, 0);
  clock.advanceMinutes(3);
  const t = sms.tick();
  assert.equal(t.find((x) => x.challengeId === i.challengeId).route, 'light_page');
  clock.advanceMinutes(-3);
});

test('sms: too many requests for one number in a day are blocked', async () => {
  const { orderId } = await syncOne();
  for (let k = 0; k < 5; k++) sms.issue(orderId, {}); // each re-issue supersedes the last
  assert.throws(() => sms.issue(orderId, {}), /too many requests/);
});

test('sms: the route is for Indian payers and for synced, unpaid orders only', async () => {
  const r = (await engine.syncOrders({ deviceId: `DEV-S${++dv}`, flightNo: '6E-2', orders: [{
    clientId: `us${Math.random()}`, createdOfflineAt: Date.now(), items: [{ id: 'sandwich', qty: 1 }], amount: round2(toUsd(400, 'INR')), currency: 'USD',
    buyer: { name: 'John', contact: '+14155550100', country: 'US' },
  }] }))[0];
  assert.throws(() => sms.issue(r.orderId, {}), /India/);
});
