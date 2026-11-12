// HTTP server (no framework). NOT IP-protected: plumbing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { CFG, limitsByInstrument } from './config.js';
import * as shield from './shield.js';
import * as consent from './consent.js';
import * as funding from './funding.js';
import { get } from './db.js';
import { HttpError, clock, round2 } from './util.js';
import * as engine from './engine.js';
import * as audit from './audit.js';
import * as rails from './rails.js';
import * as ai from './ai.js';
import * as qr from './qr.js';
import * as pp from './paypal.js';
import * as rz from './razorpay.js';
import * as sms from './smsroute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler, admin: !!opts.admin, raw: !!opts.raw });
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const json = (res, body, status = 200) => send(res, status, body);

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ public config
route('GET', '/api/config', (req, res) => {
  json(res, {
    mode: CFG.paypal.mode, aiProvider: CFG.ai.provider, baseUrl: CFG.baseUrl,
    limits: limitsByInstrument(), instruments: CFG.instruments, shield: shield.info(),
    tod: CFG.tod, menu: CFG.menu, fx: CFG.fx, currencies: CFG.currencies,
    linkTtlMin: CFG.linkTtlMin, intlLinkTtlMin: CFG.intlLinkTtlMin, a2aIrreversibleCapUsd: CFG.a2aIrreversibleCapUsd,
    rails: Object.fromEntries(Object.entries(CFG.rails).map(([k, v]) => [k, {
      label: v.label, pct: v.pct, fixed: v.fixed, cap: v.cap ?? null, xbPct: v.xbPct, fxPct: v.fxPct,
      reversible: v.reversible, simulated: v.simulated, settle: v.settle, countries: v.countries,
      instruments: v.instruments || null,
    }])),
    feeNote: 'Fee table is ILLUSTRATIVE (editable in src/config.js), not PayPal contracted rates.',
    fundingSources: CFG.funding.sources,
    fundingNote: CFG.funding.note,
    clockOffsetMin: clock.offsetMinutes(),
  });
});

// ------------------------------------------------------------------ crew sync
route('POST', '/api/crew/sync', async (req, res, ctx) => {
  const body = JSON.parse(ctx.body || '{}');
  const results = await engine.syncOrders(body);
  json(res, { results });
});

// ------------------------------------------------------------------ rail simulator
route('POST', '/api/rails/simulate', async (req, res, ctx) => {
  const b = JSON.parse(ctx.body || '{}');
  if (!(b.amount > 0) || !CFG.currencies.includes(b.currency) || !/^[A-Za-z]{2}$/.test(b.country || '')) {
    throw new HttpError(400, 'amount>0, currency in INR/USD/EUR, country (2 letters) required');
  }
  if (b.instrument && !CFG.instruments[b.instrument]) throw new HttpError(400, 'unknown instrument');
  const rr = rails.rank({ amount: Number(b.amount), currency: b.currency, buyerCountry: b.country, instrument: b.instrument || undefined });
  const proposal = await ai.proposeRail({ ranked: rr.ranked, amountUsd: rr.amountUsd, buyerCountry: b.country.toUpperCase() });
  const decision = rails.decide(rr, b.aiOverride ? { rail: b.aiOverride, reason: 'manual test', source: 'manual' } : proposal);
  // Funding view (ILLUSTRATIVE): the merchant fee above is fixed by the rail; this shows who funds it and what that costs upstream.
  const funds = b.funds && typeof b.funds === 'object' ? b.funds : null;
  const chosenFunding = funds
    ? funding.planForRail({ rail: decision.chosen, amountUsd: decision.amountUsd, funds })
    : null;
  json(res, { ...decision, funding: { chosen: chosenFunding, scenarios: funding.scenarios(decision.chosen, decision.amountUsd), note: CFG.funding.note } });
});
route('POST', '/api/orders/:id/check-payment', async (req, res, ctx) => json(res, await engine.checkPayment(ctx.params.id)), { admin: true });
route('POST', '/api/orders/:id/test-payment', async (req, res, ctx) => json(res, await engine.recordTestPayment(ctx.params.id)), { admin: true });
route('POST', '/api/orders/:id/sim-funds', (req, res, ctx) => json(res, engine.setSimFunds(ctx.params.id, JSON.parse(ctx.body || '{}'))), { admin: true });

// ------------------------------------------------------------------ card-guarantee consent (auto-generated form)
route('POST', '/api/consent', async (req, res, ctx) => {
  const b = JSON.parse(ctx.body || '{}');
  const c = consent.issue({ contact: b.contact, country: b.country, instrument: b.instrument, maxAmountInr: b.maxAmountInr });
  json(res, { consentId: c.id, formUrl: `${CFG.baseUrl}/consent/${c.token}`, token: c.token, validUntil: new Date(c.validUntil).toISOString() }, 201);
});
route('GET', '/consent/:token', (req, res) => serveFile(res, 'consent.html'));
route('GET', '/api/consent/:token', (req, res, ctx) => json(res, consent.view(ctx.params.token)));
route('POST', '/api/consent/:token/otp', (req, res, ctx) => json(res, consent.sendOtp(ctx.params.token)));
route('POST', '/api/consent/:token/confirm', (req, res, ctx) => json(res, consent.confirm(ctx.params.token, JSON.parse(ctx.body || '{}'))));
route('POST', '/api/consent/:token/revoke', (req, res, ctx) => json(res, consent.revoke(ctx.params.token)));

// ------------------------------------------------------------------ passenger pay
route('GET', '/api/pay/:token', (req, res, ctx) => json(res, engine.publicView(ctx.params.token)));
route('POST', '/api/pay/:token/start', (req, res, ctx) => json(res, engine.startPay(ctx.params.token)));
route('GET', '/qr/:token', async (req, res, ctx) => {
  const t = ctx.params.token.replace(/\.png$/, '');
  if (!qr.peek(t)) throw new HttpError(404, 'unknown token');
  const png = await QRCode.toBuffer(`${CFG.baseUrl}/pay/${t}`, { width: 320, margin: 1 });
  send(res, 200, png, 'image/png');
});
route('GET', '/pay/:token', (req, res) => serveFile(res, 'pay.html'));

// ------------------------------------------------------------------ webhooks
route('POST', '/api/paypal/webhook', async (req, res, ctx) => {
  const out = await engine.processWebhook(req.headers, ctx.body);
  json(res, { ok: true, ...out });
}, { raw: true });

route('POST', '/api/razorpay/webhook', async (req, res, ctx) => {
  const out = await engine.processRazorpayWebhook(req.headers, ctx.body);
  json(res, { ok: true, ...out });
}, { raw: true });

// ------------------------------------------------------------------ mock PayPal + simulated UPI pages
async function fireMock(eventType, order, amountUsd) {
  const ev = {
    id: `WH-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`,
    event_type: eventType,
    resource: { custom_id: order.id, status: 'COMPLETED', amount: { currency_code: 'USD', value: amountUsd.toFixed(2) }, id: order.paypal_ref },
  };
  const raw = JSON.stringify(ev);
  return engine.processWebhook({ 'x-mock-signature': pp.mockSign(raw) }, raw);
}

const checkoutPage = (title, order, action, extra = '') => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/app.css">
<main class="wrap narrow"><div class="card"><p class="badge warn">SIMULATION: not a real payment page</p>
<h1>${esc(title)}</h1><p>Order <b>${esc(order.id)}</b> · ${esc(order.currency)} ${esc(order.amount)} (USD ${esc(order.amount_usd)})</p>
${extra}
<form method="post" action="${action}" class="row"><button class="btn primary" name="d" value="approve">Approve and pay</button>
<button class="btn" name="d" value="decline">Decline</button></form>
<p class="muted">After you choose, a signed webhook is sent to the server exactly as PayPal would send it.</p>
<p><a href="/pay/${esc(order.pay_token || '')}">Back to payment status</a></p></div></main>`;

route('GET', '/mock/paypal/:ref', (req, res, ctx) => {
  const o = get('SELECT * FROM orders WHERE paypal_ref=?', ctx.params.ref);
  if (!o) throw new HttpError(404, 'unknown mock checkout');
  send(res, 200, checkoutPage('Simulated PayPal sandbox checkout', o, `/mock/paypal/${esc(o.paypal_ref)}/decision`,
    `<p>Rail: <b>${esc(o.rail)}</b> (${esc(o.paypal_kind)})</p>`), 'text/html; charset=utf-8');
});
route('POST', '/mock/paypal/:ref/decision', async (req, res, ctx) => {
  const o = get('SELECT * FROM orders WHERE paypal_ref=?', ctx.params.ref);
  if (!o) throw new HttpError(404, 'unknown mock checkout');
  const approve = new URLSearchParams(ctx.body).get('d') === 'approve';
  const type = approve ? (o.paypal_kind === 'invoice' ? 'INVOICING.INVOICE.PAID' : 'PAYMENT.CAPTURE.COMPLETED') : 'PAYMENT.CAPTURE.DENIED';
  await fireMock(type, o, o.amount_usd);
  res.writeHead(303, { location: `/pay/${o.pay_token}` });
  res.end();
});
// Mock Razorpay UPI page (RAZORPAY_MODE=mock): fires a signed payment_link.paid webhook, as Razorpay would.
route('GET', '/mock/razorpay/:orderId', (req, res, ctx) => {
  const o = get('SELECT * FROM orders WHERE id=?', ctx.params.orderId);
  if (!o || o.paypal_kind !== 'rzp') throw new HttpError(404, 'unknown mock Razorpay payment');
  send(res, 200, checkoutPage('Simulated Razorpay UPI payment', o, `/mock/razorpay/${esc(o.id)}/decision`,
    '<p>Stands in for a Razorpay UPI payment link. Razorpay test mode is used when RAZORPAY_MODE=test.</p>'), 'text/html; charset=utf-8');
});
route('POST', '/mock/razorpay/:orderId/decision', async (req, res, ctx) => {
  const o = get('SELECT * FROM orders WHERE id=?', ctx.params.orderId);
  if (!o || o.paypal_kind !== 'rzp') throw new HttpError(404, 'unknown mock Razorpay payment');
  const approve = new URLSearchParams(ctx.body).get('d') === 'approve';
  const raw = JSON.stringify({
    entity: 'event', event: approve ? 'payment_link.paid' : 'payment_link.cancelled',
    payload: { payment_link: { entity: { id: o.paypal_ref, reference_id: o.id, status: approve ? 'paid' : 'cancelled', amount_paid: approve ? rz.paise(o) : 0, currency: 'INR' } } },
  });
  await engine.processRazorpayWebhook({ 'x-razorpay-signature': rz.mockSign(raw), 'x-razorpay-event-id': `evt_${Math.random().toString(16).slice(2)}` }, raw);
  res.writeHead(303, { location: `/pay/${o.pay_token}` });
  res.end();
});
route('GET', '/sim/upi/:orderId', (req, res, ctx) => {
  const o = get('SELECT * FROM orders WHERE id=?', ctx.params.orderId);
  if (!o || o.paypal_kind !== 'sim') throw new HttpError(404, 'unknown simulated UPI payment');
  send(res, 200, checkoutPage('Simulated UPI-style bank payment', o, `/sim/upi/${esc(o.id)}/decision`,
    '<p>Stands in for a UPI collect via an interoperability partner. PayPal\'s sandbox has no UPI.</p>'), 'text/html; charset=utf-8');
});
route('POST', '/sim/upi/:orderId/decision', async (req, res, ctx) => {
  const o = get('SELECT * FROM orders WHERE id=?', ctx.params.orderId);
  if (!o || o.paypal_kind !== 'sim') throw new HttpError(404, 'unknown simulated UPI payment');
  const approve = new URLSearchParams(ctx.body).get('d') === 'approve';
  await fireMock(approve ? 'SIM.UPI.PAID' : 'SIM.UPI.DECLINED', o, o.amount_usd);
  res.writeHead(303, { location: `/pay/${o.pay_token}` });
  res.end();
});

// ------------------------------------------------------------------ airline / lender / auditor
route('GET', '/api/orders', (req, res) => json(res, engine.listOrders()), { admin: true });
route('GET', '/api/orders/:id', (req, res, ctx) => {
  const o = engine.getOrder(ctx.params.id);
  if (!o) throw new HttpError(404, 'order not found');
  json(res, o);
}, { admin: true });
route('GET', '/api/orders/:id/qr-link', (req, res, ctx) => {
  const o = get('SELECT pay_token FROM orders WHERE id=?', ctx.params.id);
  if (!o?.pay_token) throw new HttpError(404, 'no link for this order');
  json(res, { payUrl: `${CFG.baseUrl}/pay/${o.pay_token}`, qrPng: `/qr/${o.pay_token}.png`, token: o.pay_token });
}, { admin: true });

route('GET', '/api/ledger', (req, res) => json(res, engine.ledgerSummary()), { admin: true });
route('POST', '/api/ledger/sweep', (req, res) => json(res, engine.sweep()), { admin: true });
route('POST', '/api/ledger/bank-confirm/:id', (req, res, ctx) => {
  const b = JSON.parse(ctx.body || '{}');
  json(res, engine.bankConfirm(ctx.params.id, b.approve !== false));
}, { admin: true });
route('POST', '/api/ledger/card-fallback/:id', (req, res, ctx) => {
  const b = JSON.parse(ctx.body || '{}');
  json(res, engine.cardFallbackConfirm(ctx.params.id, b.approve !== false));
}, { admin: true });
route('POST', '/api/ledger/topup', (req, res, ctx) => {
  const b = JSON.parse(ctx.body || '{}');
  json(res, engine.topUp(b.contact, Number(b.amountInr)));
}, { admin: true });
route('POST', '/api/demo/advance', (req, res, ctx) => {
  const b = JSON.parse(ctx.body || '{}');
  const m = Number(b.minutes);
  if (!Number.isFinite(m) || m <= 0 || m > 60 * 24 * 30) throw new HttpError(400, 'minutes must be 1..43200');
  clock.advanceMinutes(m);
  audit.log('demo', 'CLOCK_ADVANCED', null, { minutes: m });
  json(res, { ...engine.sweep() });
}, { admin: true });

route('GET', '/api/audit', (req, res, ctx) => {
  const url = new URL(req.url, 'http://x');
  json(res, audit.entries(Math.min(Number(url.searchParams.get('limit')) || 200, 1000), url.searchParams.get('order')));
}, { admin: true });
route('GET', '/api/audit/verify', (req, res) => json(res, audit.verifyChain()), { admin: true });
route('GET', '/api/audit/review/:id', async (req, res, ctx) => {
  const r = audit.review(ctx.params.id);
  if (!r) throw new HttpError(404, 'order not found');
  json(res, { ...r, summary: await ai.narrateReview(r) });
}, { admin: true });
route('POST', '/api/audit/review-all', (req, res) => json(res, audit.reviewAll()), { admin: true });
route('GET', '/api/report/savings', (req, res) => json(res, engine.savingsReport()), { admin: true });

// ------------------------------------------------------------------ SMS return-code route (mock gateway)
route('POST', '/api/sms/issue', (req, res, ctx) => { const b = JSON.parse(ctx.body || '{}'); json(res, sms.issue(b.orderId, b), 201); }, { admin: true });
route('POST', '/api/sms/escalate', (req, res, ctx) => json(res, sms.escalate(JSON.parse(ctx.body || '{}').challengeId)), { admin: true });
route('POST', '/api/sms/tick', (req, res) => json(res, { escalated: sms.tick() }), { admin: true });
route('GET', '/api/sms/status/:orderId', (req, res, ctx) => json(res, sms.status(ctx.params.orderId)), { admin: true });
// Mock gateway: inbound messages and the outbox exist only in mock mode. A real gateway adapter (signed webhook) is not built.
route('POST', '/api/sms/inbound', async (req, res, ctx) => {
  if (CFG.sms.mode !== 'mock') throw new HttpError(501, 'real gateway adapter is not built');
  json(res, await sms.inbound(JSON.parse(ctx.body || '{}')));
});
route('GET', '/api/sms/outbox', (req, res) => {
  if (CFG.sms.mode !== 'mock') throw new HttpError(501, 'mock mode only');
  json(res, { messages: sms.getOutbox(new URL(req.url, 'http://x').searchParams.get('to')) });
});
route('POST', '/api/sms/mock-settlement', (req, res, ctx) => {
  if (CFG.sms.mode !== 'mock') throw new HttpError(501, 'mock mode only');
  json(res, sms.settle(JSON.parse(ctx.body || '{}')));
});

// ------------------------------------------------------------------ static files
function serveFile(res, name) {
  const file = path.join(PUBLIC, name);
  const rel = path.relative(PUBLIC, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    throw new HttpError(404, 'not found');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'bad path'); }
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (r) {
      if (r.admin && CFG.adminKey && req.headers['x-admin-key'] !== CFG.adminKey) throw new HttpError(401, 'admin key required');
      const m = pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = req.method === 'POST' ? await readBody(req) : '';
      return await r.handler(req, res, { params, body });
    }
    if (req.method === 'GET') {
      const name = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
      return serveFile(res, name.includes('.') ? name : `${name}.html`);
    }
    throw new HttpError(404, 'not found');
  } catch (e) {
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'internal error' : e.message });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(CFG.port, () => {
    console.log(`AirPay on PayPal rails listening on ${CFG.baseUrl}  (paypal=${CFG.paypal.mode}, ai=${CFG.ai.provider})`);
    if (CFG.paypal.mode === 'mock') console.log('Mock mode: no PayPal keys needed. Set PAYPAL_MODE=live to use the sandbox.');
  });
}

export { round2 };
