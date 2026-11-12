// Shared UI helpers. NOT IP-protected.
export const LOGO = `<svg width="38" height="38" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" fill="#0b5fff"/><path d="M8 24l24-12-6 18-6-6-4 6-2-8z" fill="#fff"/><circle cx="31" cy="11" r="3" fill="#00d0b0"/></svg>`;
export const TAGLINE = 'Order on board. Pay on landing.';

export const adminKey = () => { try { return localStorage.getItem('airpayAdminKey') || ''; } catch { return ''; } };
export const role = () => { try { return localStorage.getItem('airpayRole') || ''; } catch { return ''; } };

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  const k = adminKey();
  if (k) headers['x-admin-key'] = k;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const usd = (n) => (n === null || n === undefined ? '-' : `$${Number(n).toFixed(2)}`);
export const inr = (n) => (n === null || n === undefined ? '-' : `₹${Number(n).toFixed(2)}`);

export function stateBadge(s) {
  const good = ['PAID', 'REPAID'];
  const warn = ['LINK_SENT', 'SYNCED', 'DEFERRED_PENDING_BANK', 'DEFERRED_ACTIVE', 'CARD_FALLBACK_PENDING'];
  const cls = good.includes(s) ? 'ok' : warn.includes(s) ? 'warn' : 'bad';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

export function topbar(active) {
  const links = [
    ['/', 'Home', 'home'], ['/crew.html', 'Crew', 'crew'], ['/router.html', 'Rail router', 'router'],
    ['/ledger.html', 'Ledger', 'ledger'], ['/audit.html', 'Audit', 'audit'],
  ];
  const el = document.createElement('div');
  el.className = 'topbar';
  el.innerHTML = `<div class="in"><a class="brand" href="/">${LOGO}<span>RaMYOS AirPay<small>${TAGLINE}</small></span></a>
    <nav class="nav">${links.map(([h, t, k]) => `<a href="${h}" class="${k === active ? 'on' : ''}">${t}</a>`).join('')}</nav>
    <span id="modeBadge" class="badge">…</span></div>`;
  document.body.prepend(el);
  fetch('/api/config').then((r) => r.json()).then((c) => {
    const b = document.getElementById('modeBadge');
    b.textContent = c.mode === 'live' ? 'PayPal sandbox: live' : 'Simulated payments';
    b.className = `badge ${c.mode === 'live' ? 'ok' : 'warn'}`;
  }).catch(() => {});
}
