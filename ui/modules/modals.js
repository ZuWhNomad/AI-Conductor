import { $, el, api, S, act, asBtn, openModal, closeModal } from './core.js';
import { ALL, composite, resolveOther, pickerValue, fillPicker, refreshNewPicker } from './picker.js';
import { renderProviders } from './sidebar.js';
import { renderUpdate } from './update.js';
import { applyAutoRefresh, refreshImprovements } from './sse.js';
import { openSession, refreshSessions } from './sessions.js';
import { revealProviders } from './misc.js';

// ---------- modals ----------
async function browse(path) {
  const requested = path || localStorage.getItem('cwd') || '';
  let r;
  try { r = await api.get(`/api/browse?path=${encodeURIComponent(requested)}`); }
  catch (e) { r = { path: requested, error: e.message }; }
  const body = el('div', 'dirs');
  const head = el('div', 'row'); const inp = el('input'); inp.type = 'text'; inp.value = r.path || ''; inp.setAttribute('aria-label', 'Folder path');
  const go = el('button', 'sm', 'Go'); go.onclick = () => act(() => browse(inp.value)); inp.onkeydown = (e) => { if (e.key === 'Enter') act(() => browse(inp.value)); };
  const use = el('button', 'primary sm', 'Use this folder'); use.onclick = () => { $('#cwd').value = r.path; localStorage.setItem('cwd', r.path); closeModal(); };
  head.append(inp, go, use); body.append(head);
  if (r.error) {
    use.disabled = true;
    body.append(el('div', 'sysline err', `Cannot open folder: ${r.error}`));
  } else {
    body.append(el('div', 'tiny muted', `${r.hasGit ? 'git repo · ' : ''}${r.hasClaudeMd ? 'has CLAUDE.md' : 'no CLAUDE.md'}`));
  }
  if (!r.error && !r.dirs?.length) body.append(el('div', 'muted', 'No subfolders'));
  if (r.parent) { const up = el('div', 'd', '⬆ ..'); asBtn(up, () => act(() => browse(r.parent))); body.append(up); }
  for (const d of (r.dirs || [])) { const x = el('div', 'd', '📁 ' + d); asBtn(x, () => act(() => browse(r.path.replace(/[\\/]$/, '') + (r.path.includes('\\') ? '\\' : '/') + d))); body.append(x); }
  openModal('Choose project folder', body);
}
function openSettings() {
  const c = S.config; const body = el('div');
  const grokReset = () => (Number(c.scorecard?.usageResets?.grok?.periodHours) > 0 ? c.scorecard.usageResets.grok : null); // periodHours 0 / absent = not set
  const fields = el('div', 'settings-fields');
  const tabs = el('div', 'row settings-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Settings');
  const panels = {}, buttons = {};
  const selectTab = (id) => {
    for (const key of Object.keys(panels)) {
      panels[key].hidden = key !== id;
      buttons[key].setAttribute('aria-selected', String(key === id));
      buttons[key].tabIndex = key === id ? 0 : -1;
      buttons[key].className = key === id ? 'primary' : '';
    }
    try { localStorage.setItem('settingsTab', id); } catch {}
  };
  for (const [id, label] of [['general', 'General'], ['subscriptions', 'Subscriptions'], ['keys', 'API keys']]) {
    const panel = el('div', 'settings-panel'); panel.id = 'settings-' + id; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'settings-tab-' + id);
    const button = el('button', null, label); button.id = 'settings-tab-' + id; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    button.onclick = () => selectTab(id);
    button.onkeydown = (e) => {
      const keys = Object.keys(panels), index = keys.indexOf(id);
      const next = e.key === 'ArrowRight' ? keys[(index + 1) % keys.length] : e.key === 'ArrowLeft' ? keys[(index + keys.length - 1) % keys.length] : e.key === 'Home' ? keys[0] : e.key === 'End' ? keys.at(-1) : null;
      if (next) { e.preventDefault(); selectTab(next); buttons[next].focus(); }
    };
    panels[id] = panel; buttons[id] = button; tabs.append(button); fields.append(panel);
  }
  let activeTab = 'general';
  try { const saved = localStorage.getItem('settingsTab'); if (Object.hasOwn(panels, saved)) activeTab = saved; } catch {}
  selectTab(activeTab);
  body.append(tabs, fields);
  let grid;
  const section = (panel, label) => { if (label) panels[panel].append(el('h4', null, label)); grid = el('div', 'grid'); panels[panel].append(grid); };
  const field = (label, id, value, type = 'text', hint = '') => { const l = el('label', null, label); l.title = hint; l.htmlFor = 'cfg-' + id; const i = el('input'); i.type = type; i.id = 'cfg-' + id; i.value = value ?? ''; if (type === 'password') { i.placeholder = value ? '(saved)' : 'paste key'; if (!i.dataset) i.dataset = {}; i.dataset.initial = value ?? ''; } grid.append(l, i); return i; };
  const toggleField = (label, id, checked, hint = '') => { const l = el('label', null, label); l.title = hint; l.htmlFor = 'cfg-' + id; const i = el('input'); i.type = 'checkbox'; i.id = 'cfg-' + id; i.checked = !!checked; grid.append(l, i); return i; };
  const selectField = (label, id, value, opts, hint = '') => { grid.append(Object.assign(el('label', null, label), { htmlFor: 'cfg-' + id, title: hint })); const s = el('select'); s.id = 'cfg-' + id; for (const o of opts) s.append(new Option(o, o)); s.value = value; grid.append(s); };
  const pickerRow = (label, prefix, sel, opts) => {
    grid.append(Object.assign(el('label', null, label), { htmlFor: prefix + 'provider' }));
    const row = el('div', 'row picker');
    for (const part of ['provider', 'model', 'effort']) { const s = el('select'); s.id = `${prefix}${part}`; s.setAttribute('aria-label', `${label} ${part}`); row.append(s); }
    grid.append(row);
    setTimeout(() => {
      fillPicker(prefix, sel, opts);
      $(`#${prefix}provider`).onchange = (e) => { const v = e.target.value; fillPicker(prefix, v === ALL ? pickerValue(prefix) : { ...pickerValue(prefix), provider: v, model: '' }, { ...opts, forceProvider: true }); };
      $(`#${prefix}model`).onchange = () => { if (resolveOther(prefix, true) === false) return; fillPicker(prefix, pickerValue(prefix), { ...opts, forceProvider: true }); };
    }, 0);
  };
  section('general', 'Defaults');
  pickerRow('Worker', 'wk-', { provider: c.worker.provider, model: c.worker.model, effort: c.worker.effort }, { conductOnly: false, all: true });
  pickerRow('Conductor', 'cd-', { provider: c.conductor.provider || 'claude', model: c.conductor.model || '', effort: c.conductor.effort }, { conductOnly: true, all: true });
  selectField('New chats: permissions', 'conductor.permissionMode', c.conductor.permissionMode || 'acceptEdits', ['bypassPermissions', 'acceptEdits']);
  selectField('New chats: API overflow', 'conductor.overflowApi', String(!!c.conductor.overflowApi), ['false', 'true']);
  section('general', 'Application');
  selectField('GitHub updates', 'conductor.autoUpdate', c.conductor.autoUpdate, ['ask', 'auto', 'off']); // ask = notify + apply on click; auto = pull automatically; off = never check
  field('Poll models/limits every (min)', 'pollMinutes', c.pollMinutes, 'number');
  const upd = el('button', 'sm', 'Check for updates (GitHub)'); const updOut = el('div', 'muted tiny', '');
  upd.onclick = async () => { if (upd.disabled) return; upd.disabled = true; updOut.textContent = 'checking…'; try { const st = await api.get('/api/update?fetch=1'); S.update = st; renderUpdate(); updOut.textContent = st.git ? (st.error ? `${st.branch}@${st.head}: ${st.error}` : `${st.branch}@${st.head}: ${st.behind ? `${st.behind} update(s) available — use the ⬇ Update button in the header` : 'up to date'}${st.ahead ? `, ${st.ahead} local commit(s) not pushed` : ''}${st.dirty ? `, ${st.dirty} uncommitted change(s)` : ''}`) : st.error; } catch (e) { updOut.textContent = e.message; } finally { upd.disabled = false; } };
  panels.general.append(upd, updOut);
  const doc = el('button', 'sm', 'Run doctor (environment check)'); const docOut = el('pre', null, ''); docOut.hidden = true;
  doc.onclick = () => act(async () => { doc.disabled = true; try { const r = await api.get('/api/doctor'); docOut.hidden = false; docOut.textContent = r.rows.map((x) => `${x.name.padEnd(20)} ${String(x.value).padEnd(26)} ${x.status}${x.path ? `\n${''.padEnd(20)} ${x.path}` : ''}`).join('\n') + `\n\nPATH entries: ${r.path.length}`; } finally { doc.disabled = false; } });
  panels.general.append(doc, docOut);
  section('general', 'Benchmarking');
  selectField('Benchmark new models', 'bench.newModels', c.bench?.newModels || 'off', ['off', 'auto'], 'auto benchmarks newly discovered models during off-peak hours; off leaves benchmarking manual.');
  field('Auto-bench off-peak start (local)', 'bench.offPeak.start', c.bench?.offPeak?.start ?? '', 'time', 'Leave both off-peak times empty for no restriction.');
  field('Auto-bench off-peak end (local)', 'bench.offPeak.end', c.bench?.offPeak?.end ?? '', 'time', 'Windows may wrap past midnight, for example 22:00–06:00.');
  toggleField('Auto-bench all weekend', 'bench.offPeak.weekends', c.bench?.offPeak?.weekends ?? true, 'Saturday and Sunday are off-peak all day in local time.');
  selectField('Selection before measured scores', 'scorecard.coldStart', c.scorecard?.coldStart || 'off', ['off', 'priors'], 'priors uses hand-picked model tiers before measured scores exist; off requires an explicit model or measured scores.');
  section('general', 'Execution');
  toggleField('Efficiency mode', 'worker.efficiencyMode', c.worker.efficiencyMode, 'Wait for the same model when it reaches a usage limit. Off fails over to the next available model.');
  const sbxRow = el('div', 'row');
  const sbxSel = el('select'); sbxSel.id = 'cfg-worker.codexSandbox';
  for (const o of ['read-only', 'workspace-write', 'danger-full-access']) sbxSel.append(new Option(o, o));
  sbxSel.value = c.worker.codexSandbox;
  const sbxOverrides = [c.worker, c.conductor].filter((selection) => selection?.provider === 'codex' && c.worker?.codexSandboxByModel?.[selection.model])
    .map((selection) => `${selection.model}: ${c.worker.codexSandboxByModel[selection.model]}`);
  const sbxNote = el('span', 'tiny muted', 'Applies to Codex workers and conductors; per-model overrides take precedence.' + (sbxOverrides.length ? ` Defaults: ${[...new Set(sbxOverrides)].join('; ')}.` : ''));
  sbxRow.append(sbxSel, sbxNote);
  grid.append(Object.assign(el('label', null, 'Codex sandbox'), { htmlFor: sbxSel.id, title: 'worker.codexSandboxByModel overrides this per model for workers and conductors' }), sbxRow);
  field('Max parallel workers', 'conductor.maxWorkerConcurrency', c.conductor.maxWorkerConcurrency, 'number');
  field('Max tool turns per chat turn', 'conductor.maxTurns', c.conductor.maxTurns, 'number', 'Claude harness and API conductors; big projects need thousands.');
  field('Conductor turn timeout (min)', 'conductor.turnTimeoutMinutes', c.conductor.turnTimeoutMinutes, 'number', '0 = no limit. Stop remains immediate.');
  field('Max tool turns per Claude worker task', 'worker.maxTurns', c.worker.maxTurns, 'number');
  field('Worker timeout (min)', 'worker.timeoutMinutes', c.worker.timeoutMinutes, 'number', '0 = no limit. Stop remains immediate.');
  field('Worker timeout for modeling (min)', 'worker.timeoutByCategory.modeling', c.worker.timeoutByCategory?.modeling ?? '', 'number', '0 = no limit. Set only if this category needs a hard cap.');
  section('general', 'Monitoring / review');
  field('Watchdog check-in every (min)', 'watchdog.intervalMinutes', c.watchdog.intervalMinutes, 'number', '5–1440 minutes. One global liveness sample per interval.');
  field('Kill after stuck checks', 'watchdog.killAfterStuckChecks', c.watchdog.killAfterStuckChecks, 'number', '0 = flag only; otherwise at least 2. Default 3.');
  field('Loop repeat threshold', 'watchdog.loopRepeat', c.watchdog.loopRepeat, 'number', 'Repeated identical calls or tool-less progress turns before a runaway alert.');
  field('Log runs longer than (min)', 'worker.longRunMinutes', c.worker.longRunMinutes, 'number');
  field('Worker review rounds before escalation', 'worker.maxRounds', c.worker.maxRounds, 'number', 'Review and follow-up rounds on the same worker before escalating to a stronger model.');
  section('subscriptions');
  for (const id of ['codex', 'antigravity', 'grok', 'claude']) selectField(id === 'claude' ? 'Claude Agent SDK updates' : `${id} CLI updates`, `providers.${id}.cliUpdate`, c.providers[id]?.cliUpdate || 'notify', ['notify', 'auto', 'off']);
  const signIns = el('button', 'sm', 'Manage subscription sign-ins');
  signIns.onclick = () => { closeModal(); revealProviders(); }; panels.subscriptions.append(signIns);
  // Grok reset: "not set" is the default and means Conductor assumes NO reset (no "resets …" on the bar, no
  // use-it-or-lose-it discount) — a guessed reset time is worse than none. Set it once you know yours.
  { const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; grid.append(Object.assign(el('label', null, 'Grok weekly reset day'), { htmlFor: 'cfg-grok-reset-day' })); const s = el('select'); s.id = 'cfg-grok-reset-day'; s.title = 'Not set: no reset is assumed, so the bar shows no reset time and Grok gets no near-reset discount.'; s.append(new Option('not set (assume none)', '-1')); days.forEach((n, i) => s.append(new Option(n, i))); s.value = String(grokReset()?.resetDay ?? -1); grid.append(s); }
  const grokHour = field('Grok reset hour (0-23, local)', 'grok-reset-hour', c.scorecard?.usageResets?.grok?.resetHour, 'number'); grokHour.min = 0; grokHour.max = 23; grokHour.id = 'cfg-grok-reset-hour';
  section('keys');
  field('DeepSeek budget (USD, for the balance meter)', 'providers.deepseek.budgetUsd', c.providers.deepseek?.budgetUsd ?? '', 'number', 'What you topped up; the meter shows % of it consumed. Leave empty to use the highest balance seen.');
  for (const id of ['deepseek']) field(S.providers.find((p) => p.id === id)?.label || id, `providers.${id}.apiKey`, c.providers[id]?.apiKey === '••••' ? '••••' : '', 'password');
  const prevProviders = c.providers || {};
  const save = el('button', 'primary', 'Save'); save.onclick = () => act(async () => {
    const patch = {};
    for (const i of fields.querySelectorAll('input,select')) {
      if (!i.id.startsWith('cfg-')) continue;
      const emptyNumber = i.type === 'number' && i.value.trim() === '';
      if (emptyNumber && !['cfg-worker.timeoutByCategory.modeling', 'cfg-providers.deepseek.budgetUsd'].includes(i.id)) continue;
      const path = i.id.replace('cfg-', '').split('.'); let v = emptyNumber ? null : i.type === 'checkbox' ? !!i.checked : i.type === 'number' ? Number(i.value) : i.value;
      if (i.type === 'password') {
        if (v === '••••') continue;
        if (!v) {
          if (i.dataset.initial === '••••') v = '';
          else continue;
        }
      }
      if (i.id === 'cfg-conductor.overflowApi') v = v === 'true';
      if (i.id === 'cfg-grok-reset-day' || i.id === 'cfg-grok-reset-hour') continue; // handled below: "not set" must stay not set
      let o = patch; for (const k of path.slice(0, -1)) o = o[k] = o[k] || {}; o[path.at(-1)] = v;
    }
    // Grok reset: day -1 = not set -> periodHours 0, which every reader treats as "no schedule" (nothing is assumed).
    const rday = Number($('#cfg-grok-reset-day').value); const rawHour = grokHour.value.trim(); const rhour = Number(rawHour);
    grokHour.setCustomValidity(rday >= 0 && (rawHour === '' || !Number.isInteger(rhour) || rhour < 0 || rhour > 23) ? 'Enter your reset hour (0–23) or choose “not set”.' : '');
    if (rday >= 0 && !grokHour.reportValidity()) return;
    patch.scorecard = { ...(patch.scorecard || {}), usageResets: { grok: rday < 0 ? { periodHours: 0 } : { periodHours: 168, resetDay: rday, resetHour: rhour } } };
    const wk = pickerValue('wk-'); const cd = pickerValue('cd-');
    patch.worker = { ...(patch.worker || {}), provider: wk.provider, model: wk.model || null, effort: wk.effort };
    patch.conductor = { ...(patch.conductor || {}), provider: cd.provider, model: cd.model || null, effort: cd.effort };
    try { localStorage.setItem('conductorSel', JSON.stringify({ provider: cd.provider, model: cd.model || '', effort: cd.effort })); } catch {}
    const changedProviders = [];
    if (patch.providers) {
      for (const [id, prov] of Object.entries(patch.providers)) {
        if ('apiKey' in prov || ('baseUrl' in prov && prov.baseUrl !== prevProviders[id]?.baseUrl)) {
          changedProviders.push(id);
        }
      }
    }
    S.config = await api.post('/api/settings', patch); closeModal(); renderProviders(); applyAutoRefresh(); refreshNewPicker(false, true);
    if (changedProviders.length > 0) api.post('/api/models/refresh', { only: changedProviders }).catch(() => {});
  });
  body.append(save);
  openModal('Settings', body);
}
function openImprovements(showResolved = false) {
  const body = el('div');
  const view = { body, showResolved, request: 0, list: el('div'), tabs: [] };
  const tabs = el('div', 'row');
  for (const [label, value] of [['Open', false], ['Resolved', true]]) {
    const button = el('button', 'sm', label);
    button.onclick = () => { view.showResolved = value; act(() => refreshImprovements(view)); };
    view.tabs.push({ button, value }); tabs.append(button);
  }
  body.append(tabs);
  const form = el('form', 'row'); const inp = el('input'); inp.type = 'text'; inp.placeholder = 'Log an idea or annoyance…'; inp.setAttribute('aria-label', 'Log an idea or annoyance'); const add = el('button', 'sm', 'Add');
  add.type = 'submit';
  form.onsubmit = (e) => { e.preventDefault(); return act(async () => { if (inp.value.trim()) { await api.post('/api/improvements', { kind: 'idea', message: inp.value.trim() }); inp.value = ''; await refreshImprovements(view); } }); };
  form.append(inp, add); body.append(form);
  const run = el('button', 'primary sm', 'Run self-review now'); run.onclick = runReview; body.append(run, view.list);
  openModal('Improvement log', body);
  S.improvementView = view;
  return act(() => refreshImprovements(view));
}

async function runReview() {
  const model = composite(pickerValue('new-'));
  if (!confirm(`Start a paid self-review session with ${model} on the Conductor repo?`)) return;
  act(async () => {
    closeModal();
    const s = await api.post('/api/review', { model });
    await refreshSessions(); await openSession(s.id);
  });
}

export { browse, openSettings, openImprovements, runReview };
