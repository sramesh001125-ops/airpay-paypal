// PayPal adapter. Two modes:
//   mock - fully local; no keys needed; webhooks signed with an HMAC secret so the verification path runs.
//   live - PayPal SANDBOX REST APIs (Orders v2, Invoicing v2, Webhooks verify). Needs your sandbox keys.
// NOT IP-protected: standard integration code.
//
// HONESTY NOTE: live mode was written from PayPal's documentation but could not be run from the build
// environment (no access to api-m.sandbox.paypal.com). Test it with your own sandbox credentials.
import crypto from 'node:crypto';
import { CFG } from './config.js';

const live = () => CFG.paypal.mode === 'live';

// ---------- OAuth (live) ----------
let tokenCache = { value: null, exp: 0 };
async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp - 30000) return tokenCache.value;
  if (!CFG.paypal.clientId || !CFG.paypal.secret) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing for live mode');
  }
  const basic = Buffer.from(`${CFG.paypal.clientId}:${CFG.paypal.secret}`).toString('base64');
  const res = await fetch(`${CFG.paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  tokenCache = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return tokenCache.value;
}

async function api(method, path, body, extraHeaders = {}) {
  const token = await accessToken();
  const res = await fetch(`${CFG.paypal.apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json };
}

// ---------- Checkout creation ----------
function experience(order) {
  return {
    return_url: `${CFG.baseUrl}/pay/${order.pay_token || ''}`,
    cancel_url: `${CFG.baseUrl}/pay/${order.pay_token || ''}`,
  };
}

function paymentSource(railId, order) {
  const r = CFG.rails[railId];
  const ctx = experience(order);
  if (railId === 'card' || railId === 'paypal_wallet') {
    return { paypal: { experience_context: { ...ctx, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } };
  }
  if (r.psKey) {
    return {
      [r.psKey]: {
        name: order.buyer_name || 'Passenger',
        country_code: order.buyer_country,
        experience_context: ctx,
      },
    };
  }
  return undefined;
}

/**
 * Creates the hosted payment the buyer will be sent to.
 * Returns { kind: 'order'|'invoice'|'sim', ref, approveUrl }.
 */
export async function createCheckout(order, railId) {
  if (railId === 'upi_sim') {
    return { kind: 'sim', ref: `SIM-${order.id}`, approveUrl: `${CFG.baseUrl}/sim/upi/${order.id}` };
  }
  const isInvoice = !!CFG.rails[railId].viaInvoice;

  if (!live()) {
    return {
      kind: isInvoice ? 'invoice' : 'order',
      ref: `MOCK-${order.id}`,
      approveUrl: `${CFG.baseUrl}/mock/paypal/MOCK-${order.id}`,
    };
  }

  const value = order.amount_usd.toFixed(2);
  if (!isInvoice) {
    const body = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order.id,
        custom_id: order.id,
        description: `AirPay ${order.flight_no || ''}`.trim(),
        amount: { currency_code: CFG.paypal.settleCurrency, value },
      }],
      payment_source: paymentSource(railId, order),
    };
    const r = await api('POST', '/v2/checkout/orders', body, { 'PayPal-Request-Id': `${order.id}:${railId}` });
    if (!r.ok) throw new Error(`PayPal create order failed ${r.status}: ${JSON.stringify(r.json)?.slice(0, 300)}`);
    const link = r.json.links?.find((l) => l.rel === 'payer-action') || r.json.links?.find((l) => l.rel === 'approve');
    return { kind: 'order', ref: r.json.id, approveUrl: link?.href };
  }

  // Invoice path (Pay by Bank / ACH is offered on PayPal-hosted invoices)
  const inv = await api('POST', '/v2/invoicing/invoices', {
    detail: { currency_code: CFG.paypal.settleCurrency, reference: order.id, note: `AirPay ${order.flight_no || ''}` },
    invoicer: CFG.paypal.invoicerEmail ? { email_address: CFG.paypal.invoicerEmail } : undefined,
    primary_recipients: [{
      billing_info: {
        name: { given_name: order.buyer_name || 'Passenger' },
        email_address: String(order.buyer_contact || '').includes('@') ? order.buyer_contact : undefined,
      },
    }],
    items: [{ name: 'AirPay on-board purchase', quantity: '1', unit_amount: { currency_code: CFG.paypal.settleCurrency, value } }],
    configuration: { allow_tip: false },
  });
  if (!inv.ok) throw new Error(`PayPal create invoice failed ${inv.status}: ${JSON.stringify(inv.json)?.slice(0, 300)}`);
  const href = inv.json.href || '';
  const invoiceId = href.split('/').pop();
  const sent = await api('POST', `/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: false, send_to_invoicer: false });
  if (!sent.ok) throw new Error(`PayPal send invoice failed ${sent.status}`);
  const view = sent.json?.href ? await api('GET', `/v2/invoicing/invoices/${invoiceId}`) : null;
  const approveUrl = view?.json?.detail?.metadata?.recipient_view_url || sent.json?.href;
  return { kind: 'invoice', ref: invoiceId, approveUrl };
}

export async function captureOrder(ref) {
  if (!live()) return { status: 'COMPLETED' };
  const r = await api('POST', `/v2/checkout/orders/${ref}/capture`, undefined, { 'PayPal-Request-Id': `cap:${ref}` });
  return { status: r.json?.status, raw: r.json, ok: r.ok };
}

/** Ask PayPal directly whether a hosted invoice is paid (no webhook needed). */
export async function invoiceStatus(invoiceId) {
  if (!live()) return null;
  const r = await api('GET', `/v2/invoicing/invoices/${invoiceId}`);
  if (!r.ok) throw new Error(`PayPal invoice lookup failed ${r.status}: ${JSON.stringify(r.json)?.slice(0, 200)}`);
  const paid = r.json?.payments?.paid_amount?.value ?? r.json?.amount?.value;
  return { status: r.json?.status, paidAmountUsd: paid === undefined ? null : Number(paid), raw: r.json };
}

/** Ask PayPal for an Orders v2 order's status. */
export async function orderStatus(orderId) {
  if (!live()) return null;
  const r = await api('GET', `/v2/checkout/orders/${orderId}`);
  if (!r.ok) throw new Error(`PayPal order lookup failed ${r.status}`);
  return { status: r.json?.status, raw: r.json };
}

/**
 * SANDBOX TEST HELPER. Records an external payment against a hosted invoice through the Invoicing API
 * (the same call a merchant uses for a cheque or cash payment). Used only when PayPal's sandbox
 * checkout page itself fails; the app labels the settlement source 'test-recorded'.
 */
export async function recordInvoicePayment(invoiceId, amountUsd) {
  if (!live()) throw new Error('Record test payment needs PAYPAL_MODE=live');
  const r = await api('POST', `/v2/invoicing/invoices/${invoiceId}/payments`, {
    method: 'OTHER',
    note: 'AirPay sandbox test payment',
    amount: { currency_code: CFG.paypal.settleCurrency, value: Number(amountUsd).toFixed(2) },
  });
  if (!r.ok) throw new Error(`PayPal record payment failed ${r.status}: ${JSON.stringify(r.json)?.slice(0, 300)}`);
  return r.json;
}

/** PayPal-hosted invoice QR (Base64 PNG). Path differs between doc versions, so try both. */
export async function invoiceQr(invoiceId) {
  if (!live()) return null;
  for (const p of ['generate-qr-code', 'qr-code']) {
    const r = await api('POST', `/v2/invoicing/invoices/${invoiceId}/${p}`, { width: 300, height: 300 });
    if (r.ok && r.json?.qr_code) return r.json.qr_code;
    if (r.status !== 404) break;
  }
  return null;
}

// ---------- Webhooks ----------
export function mockSign(rawBody) {
  return crypto.createHmac('sha256', CFG.mockWebhookSecret).update(rawBody).digest('hex');
}

/** Returns true if the webhook signature is valid. */
export async function verifyWebhook(headers, rawBody) {
  if (!live()) {
    const sig = String(headers['x-mock-signature'] || '');
    const exp = mockSign(rawBody);
    const a = Buffer.from(sig);
    const b = Buffer.from(exp);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!CFG.paypal.webhookId) throw new Error('PAYPAL_WEBHOOK_ID missing for live mode');
  const r = await api('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: CFG.paypal.webhookId,
    webhook_event: JSON.parse(rawBody),
  });
  return r.ok && r.json?.verification_status === 'SUCCESS';
}
