import { $, el, api, S, authTimers, saveProviderView, showStatus } from './core.js';
import { meterClass, windowScope } from './budget.js';

// ---------- rendering: sidebar ----------
function renderProviders() {
  const box = $('#providers'); box.innerHTML = '';
  const groups = {};
  const groupFor = (p) => p.auth?.type === 'local' || ['local', 'ollama'].includes(p.kind) ? 'local' : p.auth?.type === 'subscription' ? 'subscriptions' : 'keys';
  const filter = $('#providers-signed-in');
  filter.checked = S.providerView.signedInOnly;
  filter.onchange = () => { S.providerView.signedInOnly = filter.checked; saveProviderView(); renderProviders(); };
  for (const [id, label] of [['subscriptions', 'Subscriptions'], ['keys', 'API keys'], ['local', 'Local models']]) {
    const members = S.providers.filter((p) => groupFor(p) === id);
    if (id === 'local' && !members.length) continue;
    const group = el('details', 'provider-group'); group.id = 'providers-' + id;
    const initialOpen = id === 'subscriptions' && S.revealSubscriptions || S.providerView.groups[id];
    group.open = initialOpen;
    group.append(el('summary', null, `${label} · ${members.filter((p) => S.models.providers[p.id]?.status === 'ok').length}/${members.length}`));
    // Initial and detached queued toggle events must not overwrite the remembered preference.
    let lastOpen = initialOpen;
    group.ontoggle = () => {
      if (!group.isConnected || group.open === lastOpen) return;
      lastOpen = group.open;
      if (id === 'subscriptions') S.revealSubscriptions = false;
      S.providerView.groups[id] = group.open; saveProviderView();
    };
    groups[id] = group; box.append(group);
    if (S.providerView.signedInOnly && !members.some((p) => S.models.providers[p.id]?.status === 'ok' || S.awaitingAuth.has(p.id))) group.append(el('div', 'tiny muted', 'No signed-in providers.'));
  }
  for (const p of S.providers) {
    const st = S.models.providers[p.id] || {}; const lim = S.limits.providers[p.id] || {};
    const usable = st.status === 'ok';
    if (S.providerView.signedInOnly && !usable && !S.awaitingAuth.has(p.id)) continue;
    const d = el('div', 'prov');
    const status = el('div', 'tiny action-status'); status.setAttribute('role', 'status');
    const name = el('div', 'name');
    const left = el('span'); const nameEl = p.url ? Object.assign(el('a', null, p.id), { href: p.url, target: '_blank', rel: 'noopener', title: p.url }) : document.createTextNode(p.id);
    left.append(el('i', 'dot ' + (usable ? (lim.blocked ? 'bad' : 'ok') : st.status === 'error' ? 'bad' : '')), nameEl);
    const right = el('span', 'muted', usable ? `${st.count || 0} models${lim.plan ? ` · ${lim.plan}` : ''}` : (st.loggedIn === false ? 'not logged in' : st.configured === false ? 'no key' : st.installed === false ? 'not installed' : st.error ? 'error' : st.status || '…'));
    right.title = st.error || p.auth?.setup || '';
    // One-click install / sign-in: opens a real terminal (browser logins need one). The server then re-probes until
    // the provider comes back ok, so nobody has to press Refresh; we just show that we are waiting.
    const action = st.installed === false && p.canInstall ? 'install' : st.installed !== false && st.loggedIn === false && p.canLogin ? 'login' : null;
    const controls = el('span', 'row');
    const runAction = (act) => async (e) => {
      e.stopPropagation();
      if (act === 'relogin' && (['claude', 'grok'].includes(p.id) || p.auth?.logout)) {
        if (!confirm(`Re-authenticating ${p.id} will log out of the current account first. Continue?`)) return;
      }
      const b = e.target; b.disabled = true;
      try {
        const r = await api.post(`/api/providers/${p.id}/${act}`); showStatus(r.note || r.command);
        if (r.ok) { S.awaitingAuth.add(p.id); renderProviders(); clearTimeout(authTimers.get(p.id)); authTimers.set(p.id, setTimeout(() => { S.awaitingAuth.delete(p.id); authTimers.delete(p.id); renderProviders(); }, 5 * 60_000)); }
      } catch (err) { showStatus(err.message, status); } finally { b.disabled = false; }
    };
    if (action) {
      const btn = el('button', 'sm', action === 'install' ? 'Install' : 'Sign in'); btn.title = `${p.auth?.setup || ''}`.trim();
      btn.onclick = runAction(action); controls.append(btn);
    } else controls.append(right);
    // Re-auth is available for any provider that can log in, even when already signed in (e.g. to pick up a new
    // subscription tier). It logs out then signs in where the CLI supports logout.
    if (p.canRelogin && st.installed !== false) {
      const re = el('button', 'sm ghost', '↻ Re-auth'); re.title = 'Log out and sign in again (refresh the token / subscription)';
      re.onclick = runAction('relogin'); controls.append(re);
    }
    name.append(left, controls); d.append(name);
    // "Not logged in" is a CACHED answer that a re-probe can overturn (the user may have signed in elsewhere), so say
    // when it was taken and offer a targeted one. A missing API key is not that case — probing it changes nothing —
    // so those rows stay quiet. (The server's timed sweep is the signed-out half of this; an error is shown here too
    // because a human looking at the panel can act on it.)
    if (!usable && (st.status === 'error' || (st.installed !== false && st.loggedIn === false))) {
      const line = el('div', 'wl tiny');
      if (S.awaitingAuth.has(p.id)) line.append(el('span', 'muted', 'waiting for sign-in…'));
      else {
        line.append(el('span', 'muted', st.updatedAt ? `checked ${new Date(st.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'never checked'));
        const rc = el('button', 'sm ghost', 'Recheck'); rc.title = `Re-probe ${p.id} now`;
        rc.onclick = async (e) => { e.stopPropagation(); rc.disabled = true; try { await api.post('/api/models/refresh', { only: [p.id] }); } catch (err) { showStatus(err.message, status); } finally { rc.disabled = false; } };
        line.append(rc);
      }
      d.append(line);
    }
    // Worker CLI update (core/cli-update.mjs): "update available X → Y"; the button installs it through the server.
    const cu = S.cliUpdates?.providers?.[p.id];
    if (cu?.available || cu?.applying || cu?.last?.error) {
      const line = el('div', 'wl tiny');
      const msg = cu.applying ? `updating ${cu.current} → ${cu.latest}…` : cu.available ? `update available ${cu.current} → ${cu.latest}${cu.note ? ` — ${cu.note}` : ''}` : `CLI update ${cu.last.to} failed: ${cu.last.error}`;
      const txt = el('span', 'muted', msg); if (!cu.available && !cu.applying) txt.style.color = 'var(--bad)'; txt.title = `cliUpdate: ${cu.mode}${cu.last ? ` · last: ${cu.last.applied ? `updated ${cu.last.from} → ${cu.last.to}` : cu.last.error || cu.last.reason}` : ''}`;
      line.append(txt);
      if (cu.available && !cu.note && !cu.applying) {
        const b = el('button', 'sm ghost', 'Update'); b.title = 'Install it now if the provider is idle; verified with a test call, rolled back on failure';
        b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; try { await api.post('/api/cli-update', { provider: p.id }); } catch (err) { showStatus(err.message, status); } finally { b.disabled = false; } };
        line.append(b);
      }
      d.append(line);
    }
    if (lim.balance) d.append(el('div', 'wl tiny', `balance ${lim.balance.amount} ${lim.balance.currency}${lim.balance.granted > 0 ? ` · ${lim.balance.granted} granted (free)` : ''}${lim.balance.available ? '' : ' · exhausted'}`));
    // Fixed order: session → per-model → weekly → other. Prefer an explicit w.scope (windowScope already does), else infer.
    const wrank = (w) => { const s = w.scope || windowScope(w); return s === 'session' ? 0 : (s === 'model' || w.models) ? 1 : s === 'weekly' ? 2 : 3; };
    for (const w of [...(lim.windows || [])].sort((a, b) => wrank(a) - wrank(b))) {
      const pct = Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
      const m = el('div', 'meter'); const i = el('i', meterClass(pct)); i.style.width = pct + '%'; m.append(i);
      const wl = el('div', 'wl'); wl.append(el('span', null, w.label + (w.estimated ? ' ~est' : '')), el('span', null, `${w.usedPercent ?? '?'}%${w.remaining ? ' · ' + w.remaining : ''}${w.resetsAt ? (w.resetsAt > Date.now() ? ' · resets ' : ' · reset passed ') + new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`));
      d.append(m, wl);
      if (w.estimated) { // let the user record an actual reading to re-calibrate the estimate
        const row = el('div', 'wl tiny'); const inp = el('input'); inp.type = 'number'; inp.min = 0; inp.max = 100; inp.placeholder = 'actual %'; inp.style.width = '5em';
        const set = el('button', 'sm', 'Calibrate'); set.title = w.note || 'record the real % from the provider site to refine the estimate';
        set.onclick = async () => { const raw = inp.value.trim(); const v = Number(raw); if (raw === '' || !(v >= 0 && v <= 100)) { inp.focus(); return; } set.disabled = true; try { await api.post(`/api/providers/${p.id}/usage`, { pct: v }); inp.value = ''; } catch (e) { showStatus(e.message, status); } finally { set.disabled = false; } };
        row.append(inp, set); d.append(row);
      }
    }
    if (lim.blocked) { const blocked = el('div', 'tiny', `blocked until ${lim.blockedUntil ? new Date(lim.blockedUntil).toLocaleString() : '?'}`); blocked.style.color = 'var(--bad)'; d.append(blocked); }
    d.append(status); groups[groupFor(p)].append(d);
  }
  $('#refresh-meta').textContent = `models ${S.models.updatedAt ? new Date(S.models.updatedAt).toLocaleTimeString() : '—'} · limits ${S.limits.updatedAt ? new Date(S.limits.updatedAt).toLocaleTimeString() : '—'} · server poll ${S.config.pollMinutes}m · panel auto ${S.config?.ui?.autoRefresh ? 'on' : 'off'}`;
}

export { renderProviders };
