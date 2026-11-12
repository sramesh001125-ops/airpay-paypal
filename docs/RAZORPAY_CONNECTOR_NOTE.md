# Next step: a Razorpay UPI rail for Indian passengers (planned, not built)

**Status:** design note. Nothing here is implemented in this prototype.

## Why
- PayPal reaches passengers in 140+ countries but does not support domestic payments inside India.
- India is the largest real-time payments market (UPI: about 241.6 billion transactions in FY2025-26; a record 25.47 billion in October 2026). Verify the latest figures on NPCI's UPI statistics page before quoting.
- Razorpay and PayPal have announced a partnership for Indian businesses to accept international payments. A tie-up with Razorpay, or another approved Indian platform, could let PayPal's network reach the Indian domestic market.

## Plan
1. Add a `razorpay_upi` rail to `src/rails.js` with its own cost row (to be confirmed from Razorpay's pricing; do not assume zero cost).
2. Create a Razorpay UPI QR or payment link per order, single-use, same burn-on-verified-payment rule as the PayPal link.
3. Confirm payment from Razorpay's own status or signed webhook, never from the browser.
4. Keep the rule: the AI proposes a rail, the rule guard decides. Indian passengers get the Razorpay UPI rail as an eligible option next to the PayPal rails.
5. Start with Razorpay test mode (verify availability on Razorpay's documentation), then partner agreements before any live use.

## Open questions
- Razorpay pricing for small UPI payments, and any settlement terms for the airline.
- Regulatory and partner approvals for any PayPal-Razorpay arrangement beyond the public announcement.
