// Central configuration. All numbers marked ASSUMPTION are editable demo values,
// not contracted PayPal rates and not legal/regulatory advice.
// NOT IP-protected: commodity configuration.

const env = process.env;
const port = Number(env.PORT || 3000);

export const CFG = {
  port,
  baseUrl: env.BASE_URL || `http://localhost:${port}`,

  paypal: {
    // 'mock' = fully local simulation (no keys needed). 'live' = PayPal SANDBOX APIs.
    mode: env.PAYPAL_MODE || 'mock',
    clientId: env.PAYPAL_CLIENT_ID || '',
    secret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    settleCurrency: 'USD',
    invoicerEmail: env.PAYPAL_INVOICER_EMAIL || '',
  },
  mockWebhookSecret: env.MOCK_WEBHOOK_SECRET || 'dev-mock-secret-change-me',
  qrSecret: env.QR_SECRET || 'dev-qr-secret-change-me',
  adminKey: env.ADMIN_KEY || '', // if set, ledger/audit endpoints need header x-admin-key

  // AI (optional). Without a key the deterministic fallback is used.
  ai: {
    provider: env.AI_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : 'none'),
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-2.5-flash',
    timeoutMs: 25000, // newer Gemini models can take 6-10 s; fallback still applies on timeout
  },

  merchantCountry: 'IN', // the airline / seller country (ASSUMPTION)
  linkTtlMin: Number(env.LINK_TTL_MIN || 60), // pay-link life after landing sync

  // ASSUMPTION: illustrative FX. Replace with a live rate in production.
  fx: { INR_PER_USD: 85, EUR_PER_USD: 0.92 },

  // Payer instruments. The product is INTERNATIONAL-FIRST: most cross-border buyers pay by credit or debit
  // card (or PayPal wallet / local bank rail) and need no overdraft. India's UPI debit-from-savings leg is an
  // ADD-ON, and only that leg carries the small offline caps and the lender-backed pay-later fallback.
  instruments: {
    intl: { label: 'International (card, PayPal wallet, local bank rail)', lenderFallback: false },
    upi_debit: { label: 'India UPI debit (savings account)', lenderFallback: true },
  },

  // Limits per instrument.
  //  upi_debit: INR 500 per order / INR 2,000 open, from the RBI offline small-value framework and UPI Lite X
  //             (VERIFY with counsel/NPCI before relying on them; whether they bind an online settlement after
  //             landing is unconfirmed, so we apply them as our own risk caps on the lender-funded overdraft).
  //  intl:      NOT a regulatory limit. An airline risk cap on unpaid orders (ASSUMPTION, editable), because a
  //             card payer who never pays leaves the airline with a collection problem and no lender behind it.
  limits: {
    upi_debit: {
      perTxnInr: 500, perDeviceInr: 2000,
      basis: 'RBI offline small-value framework / UPI Lite X; applied as lender-overdraft risk caps (verify)',
    },
    intl: {
      perTxnUsd: Number(env.INTL_PER_TXN_USD || 100), perDeviceUsd: Number(env.INTL_PER_DEVICE_USD || 1000),
      basis: 'Airline risk cap on unpaid orders (ASSUMPTION). Not a regulatory limit.',
    },
    // A UPI-debit order backed by the passenger's confirmed credit-card consent. The risk sits on the card's own
    // credit line, so the small UPI-debit caps do not apply. ASSUMPTION: whether UPI rules are untouched is NOT
    // confirmed; the bank and counsel must confirm. Editable.
    card_backed: {
      perTxnUsd: Number(env.CARD_BACKED_PER_TXN_USD || 100), perDeviceUsd: Number(env.CARD_BACKED_PER_DEVICE_USD || 1000),
      basis: 'Backed by a confirmed card consent; cap is an airline risk cap (ASSUMPTION). UPI-rule fit unconfirmed.',
    },
  },

  // Card-guarantee consent: form generated per passenger, confirmed with a tick box and a one-time code.
  consent: {
    validHours: Number(env.CONSENT_VALID_HOURS || 48),
    otpMinutes: 5,
    maxOtpTries: 5,
    defaultCapInr: Number(env.CONSENT_DEFAULT_CAP_INR || 8500),
    // Demo only: show the one-time code on screen instead of sending an SMS. Set DEMO_OTP=0 when a real SMS provider exists.
    demoOtp: env.DEMO_OTP !== '0',
  },
  // International payers have no lender fallback, so their link stays open longer after landing (ASSUMPTION).
  intlLinkTtlMin: Number(env.INTL_LINK_TTL_MIN || 4320),

  // Backup-card authorisation (the auto-generated form). The card is the passenger's own credit line, so there
  // is no loan: a card-backed order is limited by the card's own limit plus the airline risk cap (limits.intl).
  cardConsent: {
    validDays: Number(env.CARD_CONSENT_DAYS || 30), // ASSUMPTION
    formTtlMin: 60,
    otpWindowMin: 5,
    maxAttempts: 5,
    demoOtp: env.DEMO_OTP !== 'false', // no SMS provider is integrated: in demo the OTP is shown on screen
  },

  // SHIELD adapter (pre-perimeter screening). 'stub' = small built-in rules; 'http' = call your own SHIELD
  // service at SHIELD_URL. The real SHIELD is separate IP and is NOT part of this repository.
  shield: {
    mode: env.SHIELD_URL ? 'http' : 'stub',
    url: env.SHIELD_URL || '',
    key: env.SHIELD_KEY || '',
    timeoutMs: 3000,
    maxOrdersPerContactDay: 5,
  },

  // Temporary overdraft (TOD) design (India UPI-debit add-on only): own savings account, flat charge, max 7 days.
  tod: { maxDays: 7, flatChargeInr: 10, lenderSettleMin: 30 },

  // FUNDING COST (what it costs PayPal, or the funding side, to pull the money from the payer's source).
  // This is NOT the merchant fee. The merchant pays the same fee for a given rail whichever source funds
  // the payment; the funding cost is borne upstream (by PayPal and its partners). ALL numbers below are
  // ILLUSTRATIVE placeholders chosen only to keep the order balance < bank < card. They are NOT PayPal's costs.
  funding: {
    sources: {
      balance: { label: 'PayPal balance', pct: 0, fixed: 0 },
      savings_account: { label: 'Savings account (UPI-style, simulated)', pct: 0.1, fixed: 0 },
      bank: { label: 'Linked bank account', pct: 0.5, fixed: 0.05 },
      card: { label: 'Card', pct: 2.2, fixed: 0.3 },
    },
    // Bank-type rails are funded by one source only.
    railSource: {
      ach_pay_by_bank: 'bank', ideal: 'bank', bancontact: 'bank', blik: 'bank', p24: 'bank', eps: 'bank', mybank: 'bank', trustly: 'bank',
      upi_sim: 'savings_account',
    },
    note: 'ILLUSTRATIVE funding costs per source (balance lowest, card highest). Not PayPal\'s real costs.',
  },

  // Irreversible account-to-account rails are capped (risk guard), USD.
  a2aIrreversibleCapUsd: 25,
  // The AI may propose a rail only if it costs no more than cheapest + this tolerance.
  aiGuardToleranceUsd: 0.25,

  menu: [
    { id: 'sandwich', name: 'Veg sandwich meal', priceInr: 400 },
    { id: 'combo', name: 'Hot snack combo', priceInr: 450 },
  ],

  currencies: ['INR', 'USD', 'EUR'],

  // ILLUSTRATIVE fee table. pct/fixed/cap in USD terms. NOT PayPal's contracted rates.
  // xbPct = cross-border surcharge when buyer country != merchant country.
  // fxPct = currency-conversion spread when order currency != USD (PayPal-settled rails only).
  rails: {
    card: {
      label: 'Card via PayPal',
      pct: 3.49, fixed: 0.49, xbPct: 1.5, fxPct: 3.0,
      reversible: true, simulated: false, settle: 'T+0', countries: '*',
    },
    paypal_wallet: {
      label: 'PayPal wallet',
      pct: 3.49, fixed: 0.49, xbPct: 1.5, fxPct: 3.0,
      reversible: true, simulated: false, settle: 'T+0', countries: '*',
    },
    ach_pay_by_bank: {
      label: 'Pay by Bank (ACH)',
      pct: 1.0, fixed: 0, cap: 5, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+1..3', countries: ['US'], viaInvoice: true,
    },
    ideal: {
      label: 'iDEAL', pct: 1.8, fixed: 0.3, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+0', countries: ['NL'], psKey: 'ideal',
    },
    bancontact: {
      label: 'Bancontact', pct: 2.0, fixed: 0.35, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+0', countries: ['BE'], psKey: 'bancontact',
    },
    blik: {
      label: 'BLIK', pct: 1.8, fixed: 0.3, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+0', countries: ['PL'], psKey: 'blik',
    },
    p24: {
      label: 'Przelewy24', pct: 1.8, fixed: 0.3, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+0', countries: ['PL'], psKey: 'p24',
    },
    eps: {
      label: 'EPS', pct: 1.8, fixed: 0.3, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+0', countries: ['AT'], psKey: 'eps',
    },
    mybank: {
      label: 'MyBank', pct: 1.8, fixed: 0.3, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+0', countries: ['IT'], psKey: 'mybank',
    },
    trustly: {
      label: 'Trustly', pct: 1.8, fixed: 0.3, xbPct: 0.5, fxPct: 3.0,
      reversible: false, simulated: false, settle: 'T+0', countries: ['DE', 'SE', 'FI', 'EE'], psKey: 'trustly',
    },
    // SIMULATED: PayPal's sandbox has no UPI. This stands for a UPI-style bank-account leg
    // reached through an interoperability partner (e.g. the announced PayPal World / NPCI International link).
    // India ADD-ON: only for upi_debit payers.
    upi_sim: {
      label: 'UPI-style bank leg (simulated)',
      pct: 0, fixed: 0, xbPct: 0, fxPct: 0,
      reversible: false, simulated: true, settle: 'T+0', countries: ['IN'], instruments: ['upi_debit'],
    },
  },
};

/** Default payer instrument by country: India defaults to UPI debit (the add-on); everyone else is international. */
export const defaultInstrument = (country) => (String(country || '').toUpperCase() === 'IN' ? 'upi_debit' : 'intl');

/** Limits for an instrument, always expressed in INR-equivalent for storage and comparison. */
export function limitFor(instrument) {
  const l = CFG.limits[instrument];
  if (!l) throw new Error(`Unknown instrument ${instrument}`);
  if (l.perTxnInr !== undefined) return { perTxnInr: l.perTxnInr, perDeviceInr: l.perDeviceInr, basis: l.basis };
  return {
    perTxnInr: l.perTxnUsd * CFG.fx.INR_PER_USD,
    perDeviceInr: l.perDeviceUsd * CFG.fx.INR_PER_USD,
    basis: l.basis,
  };
}
/** Which limit pool an order sits in: a card-backed order is capped by the card, not by the UPI-debit caps. */
export const limitClass = (instrument, backupCard) => (backupCard ? 'intl' : instrument);
export const limitsByInstrument = () => Object.fromEntries(Object.keys(CFG.limits).map((k) => [k, limitFor(k)]));

export const toUsd = (amount, currency) => {
  if (currency === 'USD') return amount;
  if (currency === 'INR') return amount / CFG.fx.INR_PER_USD;
  if (currency === 'EUR') return amount / CFG.fx.EUR_PER_USD;
  throw new Error(`Unsupported currency ${currency}`);
};
export const toInr = (amount, currency) => toUsd(amount, currency) * CFG.fx.INR_PER_USD;
