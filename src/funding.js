// Funding waterfall: the payer's own money first, then bank, then card for the SHORTFALL only.
// International: PayPal balance -> linked bank -> card.   India UPI debit: savings account -> confirmed card.
// NOT NOVEL ON ITS OWN: PayPal already funds in balance -> bank -> card order and supports split payments.
// What this module adds is the evidence layer: which sources paid how much, recorded on the order and in the
// hash-chained audit log, and the split between the MERCHANT FEE (unchanged by the source) and the
// FUNDING COST (borne upstream). Every cost figure is ILLUSTRATIVE (config.js) and is never PayPal's real cost.
import { CFG } from './config.js';
import { round2 } from './util.js';

const cents = (x) => Math.round(x * 100) / 100;

/** Illustrative funding cost of pulling `amountUsd` from one source. */
export function fundingCost(source, amountUsd) {
  const s = CFG.funding.sources[source];
  if (!s) throw new Error(`Unknown funding source ${source}`);
  if (!(amountUsd > 0)) return 0;
  return round2((amountUsd * s.pct) / 100 + s.fixed);
}

/**
 * Plan how an amount is funded.
 *  path 'paypal'  : PayPal-funded checkout (card / PayPal wallet rails): balance, then bank, then card.
 *  path 'savings' : India UPI-debit fallback charge: savings account, then the confirmed card.
 *  path 'rail'    : bank-type rail, funded by one source (see CFG.funding.railSource).
 * funds = simulated payer funds { balanceUsd, bankUsd } (balanceUsd is the savings-account balance on path 'savings').
 * The card covers only what the earlier sources cannot.
 */
export function plan({ path, rail, amountUsd, funds }) {
  const amt = cents(amountUsd);
  const f = { balanceUsd: Math.max(0, Number(funds?.balanceUsd) || 0), bankUsd: Math.max(0, Number(funds?.bankUsd) || 0) };
  let order;
  if (path === 'rail') order = [CFG.funding.railSource[rail] || 'bank'];
  else if (path === 'savings') order = ['savings_account', 'card'];
  else order = ['balance', 'bank', 'card'];

  const avail = { balance: f.balanceUsd, savings_account: f.balanceUsd, bank: f.bankUsd };
  let left = amt;
  const sources = [];
  for (const src of order) {
    if (left <= 0) break;
    const last = src === 'card' || order.length === 1;
    const take = last ? left : Math.min(left, avail[src] ?? 0);
    if (take > 0) {
      sources.push({ source: src, label: CFG.funding.sources[src].label, amountUsd: cents(take), fundingCostUsd: fundingCost(src, take) });
      left = cents(left - take);
    }
  }
  const total = round2(sources.reduce((s, x) => s + x.fundingCostUsd, 0));
  const allCard = fundingCost('card', amt);
  return {
    path, amountUsd: amt, sources, shortfallToCardUsd: round2(sources.find((x) => x.source === 'card')?.amountUsd || 0),
    fundingCostUsd: total, fundingCostAllCardUsd: allCard, fundingCostAvoidedUsd: round2(allCard - total),
    illustrative: true,
  };
}

/** Which plan applies when this rail settles via a link/webhook. */
export function planForRail({ rail, amountUsd, funds }) {
  if (CFG.funding.railSource[rail]) return plan({ path: 'rail', rail, amountUsd, funds });
  return plan({ path: 'paypal', amountUsd, funds });
}

/** Router illustration: the three headline cases for one amount (balance covers all / half / none). */
export function scenarios(rail, amountUsd) {
  const a = cents(amountUsd);
  const mk = (name, funds) => ({ name, ...planForRail({ rail, amountUsd: a, funds }) });
  return [
    mk('Balance covers all', { balanceUsd: a, bankUsd: a }),
    mk('Bank covers all', { balanceUsd: 0, bankUsd: a }),
    mk('Balance covers half, card the rest', { balanceUsd: cents(a / 2), bankUsd: 0 }),
    mk('Nothing available, card pays', { balanceUsd: 0, bankUsd: 0 }),
  ];
}
