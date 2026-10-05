import { $, S } from './core.js';

// ---------- conductor picker: provider : model : effort ----------
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const composite = (v) => `${v.provider}:${v.model || 'default'}:${v.effort || 'default'}`;
const CONDUCT_KINDS = new Set(['claude', 'codex', 'openai-compat']);
const ALL = '*';
/** Providers that can conduct (agent harnesses) or, for the worker picker, anything with agent models. */
function agentProviders({ conductOnly }) {
  const ps = S.providers.filter((p) => (conductOnly ? CONDUCT_KINDS.has(p.kind) : true));
  return ps.length ? ps : [{ id: 'claude' }];
}
function modelsFor(provider, opts = {}) {
  const allowed = provider === ALL && opts.conductOnly !== false ? new Set(agentProviders({ conductOnly: true }).map((p) => p.id)) : null;
  return S.models.models.filter((m) => (provider === ALL ? (!allowed || allowed.has(m.provider)) : m.provider === provider) && m.kind === 'agent');
}
// Labels already name the model an alias resolves to, and the selection line under the pickers spells the id out.
const modelLabel = (m, withProvider) => `${withProvider ? m.provider + ' · ' : ''}${m.label}`;
/** "Other…" asks for a model id and adds it to the select so it round-trips like any listed model. Only prompts on a user pick. */
function resolveOther(prefix, interactive = false) {
  const P = $(`#${prefix}provider`), M = $(`#${prefix}model`);
  if (M.value !== '__other__') return;
  if (!interactive) { M.value = M.dataset.selection; return false; }
  const all = P.value === ALL;
  const typed = (window.prompt(all ? 'Model id (provider:model, e.g. claude:claude-opus-4-8 or codex:gpt-5.6-sol):' : `Model id for ${P.value}:`) || '').trim();
  if (!typed || (all && !/^[^:]+:.+$/.test(typed))) {
    M.value = M.dataset.selection;
    if (typed) alert('Enter a model id as provider:model.');
    return false;
  }
  const value = typed;
  M.add(new Option(value.replace(':', ' · '), value), M.options[M.options.length - 1]);
  M.value = value;
}
/** Read a picker. With provider "*" the model option value carries "provider:model". Never prompts. */
function pickerValue(prefix) {
  const P = $(`#${prefix}provider`), M = $(`#${prefix}model`), E = $(`#${prefix}effort`);
  resolveOther(prefix, false);
  let provider = P.value, model = M.value;
  if (provider === ALL) { const i = model.indexOf(':'); if (i > 0) { provider = model.slice(0, i); model = model.slice(i + 1); } else provider = 'claude'; }
  return { provider, model, effort: E.value };
}
/** Fill the three linked selects; `sel` = desired {provider, model, effort}. opts.conductOnly limits providers to harnesses; opts.all offers an "all providers" entry. */
function fillPicker(prefix, sel, opts = {}) {
  const P = $(`#${prefix}provider`), M = $(`#${prefix}model`), E = $(`#${prefix}effort`);
  const wantAll = opts.all !== false;
  // "all providers" is the default view (every model in one list); narrowing to a provider is explicit.
  const keepAll = wantAll && !opts.forceProvider && (!P.dataset.filled || P.value === ALL);
  P.innerHTML = '';
  if (wantAll) P.append(new Option('all providers', ALL));
  for (const p of (opts.fixedProvider ? [{ id: sel.provider }] : agentProviders({ conductOnly: opts.conductOnly !== false }))) P.append(new Option(p.id, p.id));
  P.value = keepAll ? ALL : (sel.provider || (wantAll ? ALL : 'claude'));
  if (!P.value) P.selectedIndex = 0;
  P.dataset.filled = '1';
  const all = P.value === ALL;
  const ms = modelsFor(P.value, opts);
  M.innerHTML = '';
  if (!all && P.value === 'claude') M.append(new Option('Claude Code default', ''));
  if (all) M.append(new Option('claude · Claude Code default', 'claude:'));
  if (!all && P.value !== 'claude' && !ms.length) M.append(new Option('(no models listed — refresh, log in or add a key)', ''));
  for (const m of ms) M.append(new Option(modelLabel(m, all), all ? `${m.provider}:${m.id}` : m.id));
  const match = ms.find((m) => (all ? m.provider === (sel.provider || 'claude') : true) && (m.id === sel.model || m.resolved === sel.model));
  M.value = match ? (all ? `${match.provider}:${match.id}` : match.id) : (all ? 'claude:' : '');
  if (!match && sel.model && sel.model !== 'default') { const v = all ? `${sel.provider || 'claude'}:${sel.model}` : sel.model; M.append(new Option(`${all ? (sel.provider || 'claude') + ' · ' : ''}${sel.model}`, v)); M.value = v; } // keep an explicit id even if not listed yet
  M.append(new Option('Other… (type a model id)', '__other__'));
  M.dataset.selection = M.value;
  const cur = ms.find((m) => (all ? `${m.provider}:${m.id}` : m.id) === M.value);
  const prov = cur?.provider || (all ? (M.value.includes(':') ? M.value.split(':')[0] : 'claude') : P.value);
  const fallbackEfforts = prov === 'claude' ? CLAUDE_EFFORTS : EFFORTS;
  const hasEffortList = cur && Array.isArray(cur.efforts);
  const efforts = hasEffortList ? cur.efforts : (!cur ? fallbackEfforts : []);
  E.innerHTML = '';
  if (!efforts.length) {
    const opt = new Option('default', 'default');
    opt.disabled = true;
    E.append(opt);
    E.value = 'default';
    E.disabled = true;
  } else {
    E.disabled = false;
    for (const e of efforts) E.append(new Option(e, e));
    E.value = efforts.includes(sel.effort) ? sel.effort : (efforts.includes('high') ? 'high' : efforts[0]);
  }
}
function savedSelection() {
  try { const s = JSON.parse(localStorage.getItem('conductorSel') || 'null'); if (s?.model !== undefined) return s; } catch {}
  return { provider: S.config.conductor?.provider || 'claude', model: S.config.conductor?.model || '', effort: S.config.conductor?.effort || 'high' };
}
function refreshNewPicker(keep = true, forceProvider = false) {
  fillPicker('new-', keep ? pickerValue('new-') : savedSelection(), { forceProvider });
  $('#new-selection').textContent = composite(pickerValue('new-'));
  localStorage.setItem('conductorSel', JSON.stringify(pickerValue('new-')));
}
function refreshHeaderPicker() {
  if (!S.current) return;
  fillPicker('', { provider: S.current.provider || 'claude', model: S.current.model || '', effort: S.current.effort || 'high' }, { all: false, fixedProvider: true });
  $('#provider').disabled = true;
}

export { ALL, composite, resolveOther, pickerValue, fillPicker, savedSelection, refreshNewPicker, refreshHeaderPicker };
