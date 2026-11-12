// Card-guarantee consent: an auto-generated form per passenger, confirmed with a tick box and a one-time code.
// IP-CANDIDATE (claim family E): the consent record gates the card fallback; no confirmed consent, no card charge.
//
// The form text below is a DRAFT TEMPLATE for the airline's bank and counsel to review. It is not an approved
// regulatory form. It deliberately says nothing about any lender overdraft: per the founder's rule, nothing about
// credit is communicated until the lender confirms its own terms.
import crypto from 'node:crypto';
import { CFG, limitFor } from './config.js';
import { get, run } from './db.js';
import { clock, rid, sha256, contactKey, HttpError } from './util.js';
import * as audit from './audit.js';

const maskContact = (k) => (k.length <= 4 ? '****' : `${'*'.repeat(k.length - 4)}${k.slice(-4)}`);
const secretHash = (id, secret) => sha256(`${id}|${secret}`);
const otpHash = (id, otp) => sha256(`otp|${id}|${otp}`);

export function buildForm({ id, contactKey: key, country, instrument, maxAmountInr, validUntil }) {
  const upi = instrument === 'upi_debit';
  const mins = CFG.linkTtlMin;
  const trigger = upi
    ? `If the payment from your savings account (through the QR or link) is not completed within ${mins} minutes of the aircraft landing and the order syncing,`
    : `If the payment link for your on-board order is not paid within ${mins} minutes of the aircraft landing and the order syncing,`;
  const form = {
    version: 'DRAFT-1',
    notice: 'Draft template for review by the airline, its bank and counsel. Not an approved regulatory form.',
    title: 'Backup card payment authorisation',
    consentId: id,
    passenger: maskContact(key),
    country,
    payerType: CFG.instruments[instrument].label,
    sections: [
      { h: 'What you are authorising', p: `${trigger} the airline may charge the credit card you have chosen, once per order, for the exact amount of that order.` },
      { h: 'Limit', p: `Up to INR ${Math.round(maxAmountInr)} per order. Nothing above this can be charged under this authorisation.` },
      { h: 'How it works', p: 'This uses your own card and its own credit limit. No separate loan is created. If your card cannot be charged for any reason, the airline will contact you to settle the amount.' },
      { h: 'Cost to you', p: 'Your card issuer\'s normal card terms apply. No additional charge is added by this form.' },
      { h: 'How long it lasts', p: `This authorisation is valid until ${new Date(validUntil).toISOString().slice(0, 16).replace('T', ' ')} UTC and is used only for orders placed on your flight.` },
      { h: 'Your rights', p: 'You can withdraw this authorisation at any time before it is used, using the button on this page or by telling the crew. You will see each charge in your card statement.' },
      { h: 'Your data', p: 'Only the mobile number or email you give is kept, to match your orders. Card details are never stored by the airline system; the card is handled by the payment provider.' },
    ],
    declaration: 'I have read this authorisation, I am the holder of the card I will use, and I agree to it.',
  };
  return form;
}

/** Create a consent and its form. The secret is returned once and is the only way to open or confirm the form. */
export function issue({ contact, country, instrument, maxAmountInr }) {
  const key = contactKey(contact);
  if (!key) throw new HttpError(400, 'contact required');
  if (!/^[A-Za-z]{2}$/.test(country || '')) throw new HttpError(400, 'country (2 letters) required');
  const inst = instrument || (String(country).toUpperCase() === 'IN' ? 'upi_debit' : 'intl');
  if (!CFG.instruments[inst]) throw new HttpError(400, 'unknown instrument');
  if (inst === 'upi_debit' && country.toUpperCase() !== 'IN') throw new HttpError(400, 'upi_debit is for IN only');
  const cap = Number.isFinite(Number(maxAmountInr)) && Number(maxAmountInr) > 0 ? Number(maxAmountInr) : CFG.consent.defaultCapInr;
  const ceiling = limitFor('card_backed').perTxnInr;
  if (cap > ceiling + 0.01) throw new HttpError(400, `cap cannot exceed the card-backed per-order limit INR ${Math.round(ceiling)}`);
  const id = rid('CN');
  const secret = crypto.randomBytes(18).toString('hex');
  const validUntil = clock.now() + CFG.consent.validHours * 3600000;
  const form = buildForm({ id, contactKey: key, country: country.toUpperCase(), instrument: inst, maxAmountInr: cap, validUntil });
  run(
    `INSERT INTO consents (id, secret_hash, contact_key, country, instrument, max_amount_inr, status, valid_until, form_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, secretHash(id, secret), key, country.toUpperCase(), inst, cap, 'ISSUED', validUntil, sha256(JSON.stringify(form)), clock.iso(),
  );
  audit.log('server', 'CONSENT_ISSUED', null, { consentId: id, contact: maskContact(key), instrument: inst, capInr: cap, formHash: sha256(JSON.stringify(form)).slice(0, 16) });
  return { id, secret, token: `${id}.${secret}`, validUntil };
}

function load(token) {
  const [id, secret] = String(token || '').split('.');
  const c = id ? get('SELECT * FROM consents WHERE id=?', id) : null;
  const a = Buffer.from(secretHash(id || '', secret || ''));
  const b = Buffer.from(c ? c.secret_hash : secretHash('x', 'y'));
  if (!c || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(404, 'unknown consent link');
  return c;
}

export function view(token) {
  const c = load(token);
  const expired = clock.now() > c.valid_until;
  const form = buildForm({ id: c.id, contactKey: c.contact_key, country: c.country, instrument: c.instrument, maxAmountInr: c.max_amount_inr, validUntil: c.valid_until });
  return { form, status: expired && c.status !== 'REVOKED' ? 'EXPIRED' : c.status, validUntil: new Date(c.valid_until).toISOString() };
}

/** Send a one-time code. In demo mode the code is returned for display; otherwise it must go by SMS (not built). */
export function sendOtp(token) {
  const c = load(token);
  if (c.status !== 'ISSUED') throw new HttpError(409, `consent is ${c.status}`);
  if (clock.now() > c.valid_until) throw new HttpError(410, 'consent expired');
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  run('UPDATE consents SET otp_hash=?, otp_exp=?, otp_tries=0 WHERE id=?', otpHash(c.id, otp), clock.now() + CFG.consent.otpMinutes * 60000, c.id);
  audit.log('server', 'CONSENT_OTP_SENT', null, { consentId: c.id, demo: CFG.consent.demoOtp });
  return CFG.consent.demoOtp ? { sent: true, demoOtp: otp } : { sent: true };
}

export function confirm(token, { otp, tick }) {
  const c = load(token);
  if (c.status !== 'ISSUED') throw new HttpError(409, `consent is ${c.status}`);
  if (clock.now() > c.valid_until) throw new HttpError(410, 'consent expired');
  if (tick !== true) throw new HttpError(400, 'the declaration must be ticked');
  if (!c.otp_hash || clock.now() > c.otp_exp) throw new HttpError(400, 'request a new one-time code');
  if (c.otp_tries >= CFG.consent.maxOtpTries) throw new HttpError(429, 'too many wrong codes; request a new one');
  const ok = Buffer.from(otpHash(c.id, String(otp || ''))).equals(Buffer.from(c.otp_hash));
  if (!ok) {
    run('UPDATE consents SET otp_tries=otp_tries+1 WHERE id=?', c.id);
    audit.log('passenger', 'CONSENT_BAD_OTP', null, { consentId: c.id });
    throw new HttpError(400, 'wrong code');
  }
  run("UPDATE consents SET status='CONFIRMED', confirmed_at=?, otp_hash=NULL WHERE id=?", clock.iso(), c.id);
  audit.log('passenger', 'CONSENT_CONFIRMED', null, { consentId: c.id, contact: maskContact(c.contact_key), capInr: c.max_amount_inr, formHash: c.form_hash.slice(0, 16) });
  return { status: 'CONFIRMED', consentId: c.id };
}

export function revoke(token) {
  const c = load(token);
  if (!['ISSUED', 'CONFIRMED'].includes(c.status)) throw new HttpError(409, `consent is ${c.status}`);
  run("UPDATE consents SET status='REVOKED', revoked_at=? WHERE id=?", clock.iso(), c.id);
  audit.log('passenger', 'CONSENT_REVOKED', null, { consentId: c.id });
  return { status: 'REVOKED' };
}

/** Called at order sync: may this confirmed consent back this order? Returns { ok, id } or { ok:false, reason }. */
export function validateForOrder({ id, contactKey: key, amountInr, country, instrument }) {
  const c = get('SELECT * FROM consents WHERE id=?', String(id || ''));
  if (!c) return { ok: false, reason: 'consent_unknown' };
  if (c.status !== 'CONFIRMED') return { ok: false, reason: `consent_${c.status.toLowerCase()}` };
  if (clock.now() > c.valid_until) return { ok: false, reason: 'consent_expired' };
  if (c.contact_key !== key) return { ok: false, reason: 'consent_contact_mismatch' };
  if (c.country !== country) return { ok: false, reason: 'consent_country_mismatch' };
  if (c.instrument !== instrument) return { ok: false, reason: 'consent_instrument_mismatch' };
  if (amountInr > c.max_amount_inr + 0.01) return { ok: false, reason: 'consent_cap_exceeded' };
  return { ok: true, id: c.id };
}

