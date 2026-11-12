// SHIELD adapter: a pre-perimeter screen that every synced order passes BEFORE limits, rails or credit.
//
// IMPORTANT: this file is an ADAPTER, not the SHIELD invention. The real SHIELD (its own provisional, also
// the security layer of HAT) is separate IP and is NOT in this repository. Two modes:
//   stub  - a few transparent built-in rules, so the integration point can be shown and tested.
//   http  - forwards a minimal, privacy-reduced payload to YOUR SHIELD service (SHIELD_URL).
// The contract is deliberately small so the real SHIELD can be plugged in without opening its internals:
//   request : { deviceId, contactHash, country, instrument, amountUsd }
//   response: { action: 'allow' | 'review' | 'block', reasons: string[] }
// No names, raw contacts or items are ever sent. If the service is unreachable the order is sent to REVIEW
// (never silently allowed, never silently blocked).
import { CFG } from './config.js';
import { get } from './db.js';
import { clock, sha256 } from './util.js';

export const info = () => ({
  mode: CFG.shield.mode,
  note: CFG.shield.mode === 'stub'
    ? 'Built-in stub rules. The real SHIELD is separate IP and is plugged in through SHIELD_URL.'
    : 'Forwarding a minimal payload to the configured SHIELD service.',
});

function stub({ contactKey, deviceId }) {
  const reasons = [];
  const c = String(contactKey || '');
  const digits = c.replace(/\D/g, '');
  const looksValid = c.includes('@') ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c) : digits.length >= 8 && digits.length <= 15;
  if (!looksValid) reasons.push('contact_format_invalid');

  const since = new Date(clock.now() - 86400000).toISOString();
  const recent = get('SELECT COUNT(*) AS n FROM orders WHERE contact_key=? AND synced_at>=?', contactKey, since).n;
  if (recent >= CFG.shield.maxOrdersPerContactDay) reasons.push('contact_velocity_24h');

  const devices = get('SELECT COUNT(DISTINCT device_id) AS n FROM orders WHERE contact_key=? AND synced_at>=?', contactKey, since).n;
  if (devices >= 3 && !reasons.length) reasons.push('contact_many_devices');

  if (reasons.includes('contact_format_invalid') || reasons.includes('contact_velocity_24h')) {
    return { action: 'block', reasons, source: 'stub' };
  }
  return { action: reasons.length ? 'review' : 'allow', reasons, source: 'stub' };
}

export async function screen({ deviceId, contactKey, country, instrument, amountUsd }) {
  if (CFG.shield.mode === 'stub') return stub({ contactKey, deviceId });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), CFG.shield.timeoutMs);
    const res = await fetch(CFG.shield.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(CFG.shield.key ? { authorization: `Bearer ${CFG.shield.key}` } : {}) },
      body: JSON.stringify({ deviceId, contactHash: sha256(contactKey), country, instrument, amountUsd }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`SHIELD HTTP ${res.status}`);
    const out = await res.json();
    const action = ['allow', 'review', 'block'].includes(out.action) ? out.action : 'review';
    return { action, reasons: Array.isArray(out.reasons) ? out.reasons.slice(0, 8).map(String) : [], source: 'http' };
  } catch (e) {
    return { action: 'review', reasons: ['shield_unreachable'], source: 'http', error: String(e.message).slice(0, 120) };
  }
}
