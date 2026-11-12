// Optional AI layer. Without a key everything falls back to deterministic text, so the demo always runs.
// Privacy rule: the model only ever sees country, amount band and rail names: never names or contacts.
// NOT IP-protected: thin provider wrapper.
import { CFG } from './config.js';

async function gemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.ai.geminiModel}:generateContent`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CFG.ai.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': CFG.ai.geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ai] Gemini HTTP ${res.status} (${CFG.ai.geminiModel}): ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    // Newer models may return "thought" parts first; keep only the answer text.
    const parts = (data?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && p.text);
    const text = parts.map((p) => p.text).join('').trim();
    if (!text) console.warn(`[ai] Gemini returned no text (${CFG.ai.geminiModel}): ${JSON.stringify(data).slice(0, 200)}`);
    return text || null;
  } catch (e) {
    console.warn(`[ai] Gemini call failed (${CFG.ai.geminiModel}): ${e?.name || ''} ${e?.message || e}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Ask the AI to choose a rail from the eligible list. Returns {rail, reason, source} or a heuristic. */
export async function proposeRail({ ranked, amountUsd, buyerCountry }) {
  const usable = ranked.filter((r) => !r.blocked);
  const heuristic = {
    rail: usable[0]?.rail,
    reason: 'Rule-based: lowest estimated cost among eligible rails.',
    source: 'heuristic',
  };
  if (CFG.ai.provider !== 'gemini' || !CFG.ai.geminiKey) return heuristic;

  const prompt = `You are a payments routing assistant. Choose ONE rail id from the list for a small in-flight purchase.
Prefer low cost, but consider that irreversible rails carry more dispute risk for the seller.
Return JSON only: {"rail":"<id>","reason":"<one sentence>"}.
Buyer country: ${buyerCountry}. Amount (USD): ${amountUsd}.
Rails: ${JSON.stringify(usable.map((r) => ({ id: r.rail, costUsd: r.costUsd, reversible: r.reversible, settle: r.settle })))}`;

  const text = await gemini(prompt);
  if (!text) return heuristic;
  try {
    const m = text.match(/\{[\s\S]*\}/); // tolerate code fences around the JSON
    const parsed = JSON.parse(m ? m[0] : text);
    if (parsed && typeof parsed.rail === 'string') {
      return { rail: parsed.rail, reason: String(parsed.reason || '').slice(0, 300), source: 'gemini' };
    }
    console.warn(`[ai] Gemini JSON had no "rail": ${text.slice(0, 200)}`);
  } catch {
    console.warn(`[ai] Gemini reply was not JSON: ${text.slice(0, 200)}`);
  }
  return heuristic;
}

/** Plain-language summary of an audit review. Deterministic flags are the source of truth. */
export async function narrateReview(review) {
  const base = review.flags.length
    ? `Order ${review.orderId} is ${review.risk} risk: ${review.flags.map((f) => f.code).join(', ')}.`
    : `Order ${review.orderId} passed all checks.`;
  if (CFG.ai.provider !== 'gemini' || !CFG.ai.geminiKey) return base;
  const text = await gemini(
    `Summarise this audit result in two plain sentences for an airline finance officer. Return JSON {"summary":"..."}.\n${JSON.stringify({
      state: review.state, risk: review.risk, flags: review.flags,
    })}`,
  );
  try {
    return JSON.parse(text).summary || base;
  } catch {
    return base;
  }
}
