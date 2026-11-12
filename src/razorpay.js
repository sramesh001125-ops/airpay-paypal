// Razorpay adapter: a UPI payment link per order for Indian passengers.
// Modes (CFG.razorpay.mode): 'off' | 'mock' (local simulation, no keys) | 'test' (Razorpay TEST-mode API).
// Same contract as paypal.js: createCheckout -> { kind, ref, approveUrl }; status; verifyWebhook.
// NOT IP-protected: thin provider wrapper. The 'test' path has not been run against Razorpay without keys.
import crypto from 'node:crypto';
import { CFG } from './config.js';

export const enabled = () => CFG.razorpay.mode !== 'off';
const testMode = () => CFG.razorpay.mode === 'test';
const secret = () => CFG.razorpay.webhookSecret || CFG.mockWebhookSecret;
const authHeader = () => 'Basic ' + Buffer.from(`${CFG.razorpay.keyId}:${CFG.razorpay.keySecret}`).toString('base64');

async function api(method, path, body) {
  if (!CFG.razorpay.keyId || !CFG.razorpay.keySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing for test mode');
  const res = await fetch(CFG.razorpay.apiBase + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Razorpay ${res.status}: ${json?.error?.description || 'request failed'}`);
  return json;
}

/** Amount in paise (integer), from the order's INR amount. */
export const paise = (order) => Math.round(Number(order.amount_inr) * 100);

/** Creates the UPI payment link the passenger is sent to. Sends no personal data: only order id and amount. */
export async function createCheckout(order) {
  if (!enabled()) throw new Error('Razorpay rail is off');
  if (!testMode()) {
    return { kind: 'rzp', ref: `plink_mock_${order.id}`, approveUrl: `${CFG.baseUrl}/mock/razorpay/${order.id}` };
  }
  const body = {
    upi_link: true,
    amount: paise(order),
    currency: 'INR',
    accept_partial: false,
    reference_id: order.id,
    description: `AirPay order ${order.id}`,
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { airpay_order: order.id },
  };
  if (CFG.baseUrl.startsWith('https://') && order.pay_token) {
    body.callback_url = `${CFG.baseUrl}/pay/${order.pay_token}`;
    body.callback_method = 'get';
  }
  const link = await api('POST', '/v1/payment_links', body);
  return { kind: 'rzp', ref: link.id, approveUrl: link.short_url };
}

/** Asks Razorpay whether a link is paid. Returns { status, amountPaidInr }. */
export async function status(ref) {
  if (!testMode()) return { status: 'unknown', amountPaidInr: null };
  const l = await api('GET', `/v1/payment_links/${encodeURIComponent(ref)}`);
  return { status: l.status, amountPaidInr: l.amount_paid != null ? l.amount_paid / 100 : null };
}

// ---------- Webhooks: X-Razorpay-Signature = HMAC-SHA256(rawBody, webhook secret), hex ----------
export const mockSign = (rawBody) => crypto.createHmac('sha256', secret()).update(rawBody).digest('hex');

export function verifyWebhook(headers, rawBody) {
  if (testMode() && !CFG.razorpay.webhookSecret) throw new Error('RAZORPAY_WEBHOOK_SECRET missing for test mode');
  const sig = Buffer.from(String(headers['x-razorpay-signature'] || ''));
  const exp = Buffer.from(mockSign(rawBody));
  return sig.length === exp.length && crypto.timingSafeEqual(sig, exp);
}
