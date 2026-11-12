// Rail router: ranks every eligible payment rail by estimated cost, then lets an AI agent PROPOSE a
// choice that a deterministic guard accepts or overrides. The AI never sets amounts or states.
// IP-CANDIDATE: guarded rail selection with irreversibility cap and cost-vs-card savings evidence.
import { CFG, toUsd, defaultInstrument } from './config.js';
import { round2 } from './util.js';

/** Rails open to this buyer: by country AND by payer instrument (UPI leg is for India UPI-debit payers only). */
export function eligibleRails(buyerCountry, instrument) {
  const cc = String(buyerCountry || '').toUpperCase();
  const inst = instrument || defaultInstrument(cc);
  return Object.entries(CFG.rails)
    .filter(([, r]) => r.countries === '*' || r.countries.includes(cc))
    .filter(([, r]) => !r.instruments || r.instruments.includes(inst))
    .map(([id]) => id);
}

/** Estimated merchant cost in USD for one rail. Illustrative fee table (see config.js). */
export function costFor(railId, { amountUsd, currency, buyerCountry }) {
  const r = CFG.rails[railId];
  const cross = String(buyerCountry).toUpperCase() !== CFG.merchantCountry;
  let pct = r.pct;
  if (cross) pct += r.xbPct || 0;
  if (currency !== 'USD') pct += r.fxPct || 0;
  let cost = (amountUsd * pct) / 100 + (r.fixed || 0);
  if (r.cap !== undefined) cost = Math.min(cost, r.cap + (r.fixed || 0));
  return { costUsd: round2(cost), effectivePct: amountUsd ? round2((cost / amountUsd) * 100) : 0 };
}

export function rank({ amount, currency, buyerCountry, instrument }) {
  const amountUsd = toUsd(amount, currency);
  const ids = eligibleRails(buyerCountry, instrument);
  const ctx = { amountUsd, currency, buyerCountry };

  const rows = ids.map((id) => {
    const r = CFG.rails[id];
    const c = costFor(id, ctx);
    const blocked = !r.reversible && amountUsd > CFG.a2aIrreversibleCapUsd;
    return {
      rail: id,
      label: r.label,
      costUsd: c.costUsd,
      merchantFeeUsd: c.costUsd, // what the merchant pays; the funding source does not change it
      effectivePct: c.effectivePct,
      reversible: r.reversible,
      simulated: r.simulated,
      settle: r.settle,
      blocked,
      blockReason: blocked ? `Irreversible rail above USD ${CFG.a2aIrreversibleCapUsd} cap` : null,
    };
  });

  const usable = rows.filter((x) => !x.blocked).sort((a, b) => a.costUsd - b.costUsd);
  const blockedRows = rows.filter((x) => x.blocked);
  const card = rows.find((x) => x.rail === 'card');
  const withSavings = [...usable, ...blockedRows].map((x) => ({
    ...x,
    savingsVsCardUsd: card ? round2(card.costUsd - x.costUsd) : 0,
  }));
  return { amountUsd: round2(amountUsd), ranked: withSavings, cheapest: usable[0]?.rail || null };
}

/**
 * Deterministic guard around an optional AI proposal.
 * accepted = proposal is usable AND within tolerance of the cheapest usable rail.
 */
export function decide(rankResult, aiProposal) {
  const usable = rankResult.ranked.filter((x) => !x.blocked);
  if (!usable.length) throw new Error('No usable rail for this buyer');
  const cheapest = usable[0];
  let chosen = cheapest.rail;
  const guard = { aiProposed: null, accepted: null, note: null, source: null };

  if (aiProposal && aiProposal.rail) {
    guard.aiProposed = aiProposal.rail;
    guard.source = aiProposal.source || 'ai';
    const hit = usable.find((x) => x.rail === aiProposal.rail);
    if (!hit) {
      guard.accepted = false;
      guard.note = 'Proposed rail is not eligible or is blocked by the irreversibility cap.';
    } else if (hit.costUsd > cheapest.costUsd + CFG.aiGuardToleranceUsd) {
      guard.accepted = false;
      guard.note = `Proposed rail costs USD ${hit.costUsd}, above cheapest ${cheapest.costUsd} plus tolerance ${CFG.aiGuardToleranceUsd}.`;
    } else {
      guard.accepted = true;
      guard.note = 'Within tolerance of the cheapest usable rail.';
      chosen = hit.rail;
    }
  }
  return {
    chosen,
    ranked: rankResult.ranked,
    amountUsd: rankResult.amountUsd,
    guard,
    aiReason: aiProposal?.reason || null,
  };
}
