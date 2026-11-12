import './setup_rzp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine.js';
import * as rails from '../src/rails.js';
import * as rz from '../src/razorpay.js';
import { get } from '../src/db.js';

let n = 0;
const order = () => ({
  clientId: `r${++n}`, createdOfflineAt: Date.now() + n,
  items: [{ id: 'sandwich', qty: 1 }], amount: 400, currency: 'INR',
  buyer: { name: 'Asha Rao', contact: `+91901111${String(n).padStart(4, '0')}`, country: 'IN' },
});
const hook = (o, { amountPaise, event = 'payment_link.paid', id = `evt_${Math.random()}`, sign = true } = {}) => {
  const raw = JSON.stringify({
    entity: 'event', event,
    payload: { payment_link: { entity: { id: o.paypal_ref, reference_id: o.id, status: 'paid', amount_paid: amountPaise ?? rz.paise(o), currency: 'INR' } } },
  });
  return engine.processRazorpayWebhook({ 'x-razorpay-signature': sign ? rz.mockSign(raw) : 'bad', 'x-razorpay-event-id': id }, raw);
};
const row = (id) => get('SELECT * FROM orders WHERE id=?', id);
const syncOne = async () => (await engine.syncOrders({ deviceId: 'DEV-R', flightNo: '6E-1', orders: [order()] }))[0];

test('razorpay: Indian UPI payer gets the Razorpay rail, not the simulated leg', () => {
  const r = rails.rank({ amount: 400, currency: 'INR', buyerCountry: 'IN' });
  const ids = r.ranked.map((x) => x.rail);
  assert.ok(ids.includes('razorpay_upi'));
  assert.ok(!ids.includes('upi_sim'));
  assert.equal(r.cheapest, 'razorpay_upi');
});

test('razorpay: international buyers never see the Razorpay rail', () => {
  const r = rails.rank({ amount: 10, currency: 'USD', buyerCountry: 'US' });
  assert.ok(!r.ranked.some((x) => x.rail === 'razorpay_upi'));
});

test('razorpay: sync creates a Razorpay link and a signed webhook settles it', async () => {
  const r = await syncOne();
  const o = row(r.orderId);
  assert.equal(o.rail, 'razorpay_upi');
  assert.equal(o.paypal_kind, 'rzp');
  assert.equal(o.state, 'LINK_SENT');
  const out = await hook(o);
  assert.equal(out.state, 'PAID');
  assert.equal(row(o.id).state, 'PAID');
});

test('razorpay: duplicate event is ignored', async () => {
  const o = row((await syncOne()).orderId);
  await hook(o, { id: 'evt_dup' });
  const again = await hook(o, { id: 'evt_dup' });
  assert.equal(again.duplicate, true);
});

test('razorpay: bad signature is rejected and the order stays unpaid', async () => {
  const o = row((await syncOne()).orderId);
  await assert.rejects(() => hook(o, { sign: false }), /invalid webhook signature/);
  assert.equal(row(o.id).state, 'LINK_SENT');
});

test('razorpay: wrong amount does not settle the order', async () => {
  const o = row((await syncOne()).orderId);
  const out = await hook(o, { amountPaise: 100 });
  assert.equal(out.mismatch, true);
  assert.equal(row(o.id).state, 'LINK_SENT');
});
