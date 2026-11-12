# RaMYOS AirPay on PayPal rails

Take orders with no network, get paid when you land. Crew record purchases offline; after landing each order is settled over the cheapest PayPal-connected rail; unpaid orders fall back to a lender-backed pay-later on the passenger's own savings account; every step lands in a hash-chained audit log.

## For judges: test it in 3 minutes
1. `npm install` then `npm start` (Node 22.13 or newer), open http://localhost:3000. It runs in **mock mode with no keys**: simulated PayPal, real engine.
2. **Crew** → untick "Airplane mode" → add an order (or **Load 5 demo orders**) → **Sync after landing**.
3. **Ledger** → **Show QR** → pay on the pay page. In mock mode checkout is simulated.
4. **Audit** → **Verify log integrity**. The hash chain should read intact.
5. Live PayPal sandbox (optional, needs your own sandbox keys): see "Live PayPal sandbox" below. Then on **Ledger** use **Check payment status** after paying the invoice. It asks PayPal directly, so no public webhook is needed.

**PayPal:** Invoicing v2 (payment link and QR), Orders v2 (checkout and capture), webhook signature verification, and invoice-status lookup.
**AI:** an AI agent (Gemini) proposes the payment rail from non-identifying features; deterministic rules accept or reject it. Set `GEMINI_API_KEY` to enable. Without it a rule-based fallback runs.

## Run it (no keys needed)
```bash
npm install
npm start            # http://localhost:3000   (Node 22.13 or newer)
npm test             # 29 tests
```
Open `/`, then **Crew**: untick "Airplane mode", press **Load 5 demo orders** (a US card payer with card consent, Netherlands, an Indian credit-card payer, an Indian UPI-debit payer with no card, and an Indian UPI-debit payer with card consent; the demo runs the real consent form flow using an on-screen one-time code), **Sync after landing**, open a pay page, pay in the simulated checkout. Use **Ledger** to fast-forward the demo clock, let a link expire, approve or decline as the lender, top up the savings account, and see the 7-day rules. **Audit** verifies the log chain and reviews every order.

## What is real and what is simulated (read this)
| Part | Status |
|---|---|
| Offline queue, limits, sync, state machine, QR burn-on-settlement, audit chain, rail ranking and AI guard | Real code, covered by tests |
| PayPal calls in `mock` mode | Simulated locally; webhooks are HMAC-signed and verified like real ones |
| PayPal `live` mode (sandbox) | **Tested live in the PayPal sandbox:** an invoice was created, a sandbox buyer paid on PayPal's own page (bank and Visa card), and the app confirmed it with the invoice status check. The webhook handler is built but was not exercised live from localhost. A labelled sandbox-only helper ("Record test payment") exists and is recorded in the audit log |
| UPI-style bank leg (India add-on) | **Simulated.** PayPal's sandbox has no UPI |
| SHIELD adapter | **Stub rules only.** The real SHIELD is separate IP and is not in this repo; plug it in with `SHIELD_URL` (see below) |
| Lender, savings account, temporary overdraft | **Simulated** |
| Funding order (payer's own money, then bank, then card for the shortfall only) | Real code (`src/funding.js`), tested. **The payer's balances are a simulated input** (`buyer.simFunds`, or the Router page); in production PayPal decides the funding. Not new by itself: PayPal already funds balance, then bank, then card, with split payments. Here it is recorded per order (sources and amounts) in the order row and the audit log |
| Merchant fee table | **Illustrative**, editable in `src/config.js`; not PayPal's contracted rates. The merchant pays the same fee whichever source funds the payment |
| PayPal funding cost per source (balance < bank < card) | **Illustrative placeholders**, editable in `src/config.js`. Not PayPal's real costs. The card cost avoided is PayPal's saving, not the merchant's |
| FX (INR to USD) | Fixed demo rate; INR orders are converted to USD for PayPal |
| Sign-in | Demo role label only; no real authentication. Set `ADMIN_KEY` to protect ledger/audit endpoints |
| AI | Optional (`GEMINI_API_KEY`). Without it a rule-based fallback runs. The model never sees names or contacts, and never sets amounts or states |

## Live PayPal sandbox
1. Create a sandbox REST app at developer.paypal.com; copy client id and secret.
2. Create a webhook pointing to `<BASE_URL>/api/paypal/webhook` with events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `INVOICING.INVOICE.PAID`; copy the webhook id.
3. `PAYPAL_MODE=live PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYPAL_WEBHOOK_ID=... BASE_URL=https://your-host npm start`
The webhook URL must be reachable from the internet (deploy, or use a tunnel).

## Design rules built in
- AI proposes, rules decide: a rail proposal is accepted only if eligible, not blocked, and within `aiGuardToleranceUsd` of the cheapest usable rail.
- Irreversible bank rails are blocked above `a2aIrreversibleCapUsd`.
- International first: card, PayPal wallet and local bank rails for buyers in PayPal's markets. India's UPI debit (savings account) is an add-on.
- Limits are per payer type, device-side and server-side. UPI debit: INR 500 per order and INR 2,000 open per device (RBI offline small-value framework / UPI Lite X; to be verified with counsel). International: an airline risk cap (default USD 100 per order, USD 1,000 open per device, editable) because there is no regulatory cap on foreign cards.
- An Indian buyer paying by credit card is an international payer: no UPI leg, no overdraft.
- SHIELD pre-screen: every synced order is screened before limits, rails or credit. Only a hashed contact, country, instrument and amount ever leave the server; an unreachable service sends the order to review, never silently allows or blocks it.
- Card consent form (auto-generated): for each passenger the system generates a form (limit, trigger, rights), confirmed with a tick box and a one-time code at `/consent/<token>`. No confirmed consent matching the order's contact, country, payer type and amount means no card step. The text is a DRAFT for the bank and counsel; it says nothing about any lender step.
- Fallback order with a confirmed consent, for ANY payer (India or international): the card is charged after the short window (card simulated; its own credit line is the overdraft, so no loan). India UPI-debit orders with consent use the card-backed caps, not the small UPI caps (UPI-rule fit unconfirmed). If the card is declined: India UPI-debit payers fall to the lender overdraft; international payers have no lender and the order is an airline loss. India UPI-debit payers with no consent go straight to the lender overdraft: the lender is asked to settle the airline; the passenger sees nothing about credit until the lender confirms; flat charge; 7 days maximum; auto-debit on top-up; a passenger with an unresolved due cannot place new orders. International payers have a longer link window and no lender; an expired unpaid order is flagged as an airline loss and blocks that buyer's next order.
- The QR/link is burned only by a verified settlement event, never by a scan or a failed attempt.
- Webhooks are signature-checked, de-duplicated, and amount-checked.

## Files
`src/engine.js` (core), `src/rails.js`, `src/qr.js`, `src/audit.js`, `src/paypal.js`, `src/ai.js`, `src/server.js`, `src/config.js`, `public/*` (landing page follows the RaMYOS pattern), `test/engine.test.js`.

## Licence
AGPL-3.0 (`LICENSE`). Judges, reviewers and developers are welcome to run, test and study this code under the AGPL-3.0. Commercial licences are available by separate agreement.

**Patent pending.** Indian provisional patent application no. 202641135327, filed 12 November 2026. Judges, organisers and sponsors of the PayPal AI Hackathon are expressly welcome to view, run, test and evaluate all code. Commercial use in closed products requires a separate licence. Contact: [ADD CONTACT EMAIL].

## SHIELD adapter
`src/shield.js` is only the integration point. Request: `{ deviceId, contactHash, country, instrument, amountUsd }`. Response: `{ action: 'allow'|'review'|'block', reasons: [] }`. Set `SHIELD_URL` (and optionally `SHIELD_KEY`) to call your own SHIELD service; otherwise built-in stub rules run (contact format, 24-hour velocity). Keep the real SHIELD outside this open repository.

## Card consent form
`src/consent.js` builds the form from the order terms (cap per order, trigger window, validity, rights). Set `DEMO_OTP=0` once a real SMS provider is connected; until then the demo shows the one-time code on screen. Caps for card-backed orders are `CARD_BACKED_PER_TXN_USD` and `CARD_BACKED_PER_DEVICE_USD` (editable assumptions).
