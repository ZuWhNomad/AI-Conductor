import { $, el, S } from './core.js';

// ---------- budget headline ----------
function meterClass(p) { return p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''; }
/** A window's scope: use the server tag, then infer for older persisted windows. */
function windowScope(w) {
  if (['session', 'weekly', 'other'].includes(w.scope)) return w.scope;
  if (typeof w.windowMinutes === 'number') return w.windowMinutes <= 600 ? 'session' : w.windowMinutes >= 10080 ? 'weekly' : null;
  const s = `${w.label || ''} ${w.id || ''}`;
  if (/weekly|seven[_ -]?day|7[_ -]?day/i.test(s)) return 'weekly';
  if (/5[_ -]?hour|\b5h\b|session|\bhour\b/i.test(s)) return 'session';
  return null;
}
/** The plan-level window for a provider+scope: skip per-model/sub-scoped windows, prefer the provider's own primary bucket. */
function planWindow(providerId, scope) {
  const ws = (S.limits.providers[providerId]?.windows || []).filter((w) => !w.models && w.scope !== 'model' && !w.estimated && !/^(five_hour|seven_day)_/.test(w.id || ''));
  const pool = ws.filter((w) => scope === 'session'
    ? w.windowMinutes === 300 || (w.windowMinutes == null && (/^(five_hour|5[_ -]?hour|5h)$/i.test(w.id || '') || /^(5[_ -]?hour|5h)$/i.test(w.label || '')))
    : windowScope(w) === scope);
  return pool.find((w) => /^(five_hour|seven_day)$/.test(w.id || '') || (w.id || '').startsWith(`${providerId}:`)) || pool[0];
}
function budgetBar(label, w) {
  const b = el('div', 'b');
  const pct = w ? Math.max(0, Math.min(100, Number(w.usedPercent) || 0)) : 0;
  const line = el('div', 'bl');
  line.append(el('span', 'k', label), el('span', 'v ' + meterClass(pct), w && w.usedPercent != null ? `${Math.round(pct)}%${w.estimated ? ' est' : ''}` : '—'));
  const m = el('div', 'meter'); const i = el('i', meterClass(pct)); i.style.width = pct + '%'; m.append(i);
  b.append(line, m);
  return b;
}
/** Compact budget: the selected conductor's actual five-hour window and high weekly usage. */
function renderBudget() {
  const box = $('#budget'); if (!box) return; box.innerHTML = '';
  const prov = S.current?.provider || S.config.conductor?.provider || 'claude';
  const pst = S.models.providers[prov] || {};
  if (pst.status && pst.status !== 'ok') box.append(el('div', 'empty', `${prov}: ${pst.loggedIn === false ? 'not signed in' : pst.configured === false ? 'no key' : pst.installed === false ? 'not installed' : pst.error ? 'error' : pst.status}`));
  // A different provider's refresh (or a failed poll) cannot make these cached windows current.
  const lim = S.limits.providers[prov] || {};
  const asOf = lim.updatedAt ? new Date(lim.updatedAt).getTime() : 0;
  box.classList.toggle('stale', !!lim.error || (!!S.boot && asOf < S.boot));
  const session = planWindow(prov, 'session');
  const weekly = planWindow(prov, 'weekly');
  if (session) box.append(budgetBar(`${prov} · 5-hour`, session));
  else if (lim.balance) box.append(el('div', 'tiny', `${prov} · balance ${lim.balance.amount} ${lim.balance.currency}${lim.balance.available === false ? ' · exhausted' : ''}`));
  else {
    const budget = (lim.windows || []).find((w) => !w.models && w.scope !== 'model' && !w.estimated && /budget/i.test(w.id || ''));
    if (budget) box.append(budgetBar(`${prov} · ${budget.label || 'budget'}`, budget));
    else box.append(el('div', 'empty', `${prov}: 5-hour usage unavailable`));
  }
  if (weekly && Number(weekly.usedPercent) > 90) box.append(budgetBar(`${prov} · weekly`, weekly));
  if (lim.error) box.append(el('div', 'empty', 'Refresh failed · cached limits'));
  else if (box.classList.contains('stale')) box.append(el('div', 'empty', `${asOf ? `as of ${new Date(asOf).toLocaleTimeString()}` : 'Age unknown'} · refresh limits`));
  if (!box.childElementCount) box.append(el('div', 'empty', 'Refresh to load limits'));
}

export { meterClass, windowScope, renderBudget };
