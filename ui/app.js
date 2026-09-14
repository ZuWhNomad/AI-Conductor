import { createSTT, insertAtCaret } from './stt.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const api = {
  get: (p) => fetch(p).then(ok),
  post: (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(ok),
  del: (p) => fetch(p, { method: 'DELETE' }).then(ok),
};
async function ok(r) { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; }

const S = { sessions: [], current: null, models: { models: [], providers: {} }, limits: { providers: {} }, tasks: [], improvements: [], config: {}, providers: [], lastSeq: 0, stream: null, tools: new Map(), pending: new Map(), taskEls: new Map(), workerLog: new Map(), scoreInfo: new Map() };

// ---------- markdown-lite ----------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function md(src) {
  const parts = String(src).split(/```/);
  return parts.map((p, i) => {
    if (i % 2 === 1) { const nl = p.indexOf('\n'); const body = nl >= 0 ? p.slice(nl + 1) : p; return `<pre>${esc(body.replace(/\n$/, ''))}</pre>`; }
    return esc(p)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }).join('');
}

// ---------- rendering: sidebar ----------
function renderSessions() {
  const box = $('#sessions'); box.innerHTML = '';
  const f = (S.chatFilter || '').toLowerCase();
  for (const s of S.sessions) {
    if (f && !`${s.title || 'New chat'} ${s.cwd || ''}`.toLowerCase().includes(f)) continue;
    const it = el('div', 'item' + (S.current?.id === s.id ? ' active' : ''));
    const t = el('span', 't', s.title || 'New chat'); t.title = `${s.cwd}\n${s.model || 'default model'}`;
    t.ondblclick = (e) => { e.stopPropagation(); renameSession(s); };
    const st = el('span', 'pill' + (s.status === 'running' ? ' running' : ''), s.status === 'running' ? '●' : '');
    const ren = el('span', 'x', '✎'); ren.title = 'Rename chat';
    ren.onclick = (e) => { e.stopPropagation(); renameSession(s); };
    const x = el('span', 'x', '✕'); x.title = 'Delete chat';
    x.onclick = async (e) => { e.stopPropagation(); if (confirm('Delete this chat?')) { await api.del(`/api/sessions/${s.id}`); } };
    it.append(t, st, ren, x); it.onclick = () => openSession(s.id);
    box.append(it);
  }
}

async function renameSession(s) {
  const name = prompt('Rename chat:', s.title || 'New chat');
  if (name == null) return; // cancelled
  const next = name.trim();
  if (!next || next === s.title) return;
  try { await api.post(`/api/sessions/${s.id}/title`, { title: next }); } catch (e) { alert(`Rename failed: ${e.message}`); }
}

function meterClass(p) { return p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''; }
function renderProviders() {
  const box = $('#providers'); box.innerHTML = '';
  for (const p of S.providers) {
    const st = S.models.providers[p.id] || {}; const lim = S.limits.providers[p.id] || {};
    const usable = st.status === 'ok';
    const d = el('div', 'prov');
    const name = el('div', 'name');
    const left = el('span'); const nameEl = p.url ? Object.assign(el('a', null, p.id), { href: p.url, target: '_blank', rel: 'noopener', title: p.url }) : document.createTextNode(p.id);
    left.append(el('i', 'dot ' + (usable ? (lim.blocked ? 'bad' : 'ok') : st.status === 'error' ? 'bad' : '')), nameEl);
    const right = el('span', 'muted', usable ? `${st.count || 0} models${lim.plan ? ` · ${lim.plan}` : ''}` : (st.loggedIn === false ? 'not logged in' : st.configured === false ? 'no key' : st.installed === false ? 'not installed' : st.error ? 'error' : st.status || '…'));
    right.title = st.error || p.auth?.setup || '';
    // One-click install / sign-in: opens a real terminal (browser logins need one), then Refresh.
    const action = st.installed === false && p.canInstall ? 'install' : st.installed !== false && st.loggedIn === false && p.canLogin ? 'login' : null;
    const controls = el('span', 'row');
    const runAction = (act) => async (e) => { e.stopPropagation(); const b = e.target; b.disabled = true; try { const r = await api.post(`/api/providers/${p.id}/${act}`); $('#stt-hint').textContent = r.note || r.command; } catch (err) { $('#stt-hint').textContent = err.message; } finally { b.disabled = false; } };
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
    if (lim.balance) d.append(el('div', 'wl tiny', `balance ${lim.balance.amount} ${lim.balance.currency}${lim.balance.granted > 0 ? ` · ${lim.balance.granted} granted (free)` : ''}${lim.balance.available ? '' : ' · exhausted'}`));
    for (const w of lim.windows || []) {
      const pct = Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
      const m = el('div', 'meter'); const i = el('i', meterClass(pct)); i.style.width = pct + '%'; m.append(i);
      const wl = el('div', 'wl'); wl.append(el('span', null, w.label + (w.estimated ? ' ~est' : '')), el('span', null, `${w.usedPercent ?? '?'}%${w.remaining ? ' · ' + w.remaining : ''}${w.resetsAt ? ' · resets ' + new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`));
      d.append(m, wl);
      if (w.estimated) { // let the user record an actual reading to re-calibrate the estimate
        const row = el('div', 'wl tiny'); const inp = el('input'); inp.type = 'number'; inp.min = 0; inp.max = 100; inp.placeholder = 'actual %'; inp.style.width = '5em';
        const set = el('button', 'sm', 'Calibrate'); set.title = w.note || 'record the real % from the provider site to refine the estimate';
        set.onclick = async () => { const raw = inp.value.trim(); const v = Number(raw); if (raw === '' || !(v >= 0 && v <= 100)) { inp.focus(); return; } set.disabled = true; try { await api.post(`/api/providers/${p.id}/usage`, { pct: v }); S.limits = await api.get('/api/limits'); inp.value = ''; renderProviders(); } catch (e) { $('#stt-hint').textContent = e.message; } finally { set.disabled = false; } };
        row.append(inp, set); d.append(row);
      }
    }
    if (lim.blocked) { const blocked = el('div', 'tiny', `blocked until ${lim.blockedUntil ? new Date(lim.blockedUntil).toLocaleString() : '?'}`); blocked.style.color = 'var(--bad)'; d.append(blocked); }
    box.append(d);
  }
  $('#refresh-meta').textContent = `models ${S.models.updatedAt ? new Date(S.models.updatedAt).toLocaleTimeString() : '—'} · limits ${S.limits.updatedAt ? new Date(S.limits.updatedAt).toLocaleTimeString() : '—'} · server poll ${S.config.pollMinutes || 15}m · panel auto ${S.config?.ui?.autoRefresh ? (S.config.ui.autoRefreshMinutes || 15) + 'm' : 'off'}`;
}

// ---------- budget headline ----------
function pickWindow(providerId, rx) {
  const ws = S.limits.providers[providerId]?.windows || [];
  return ws.find((w) => rx.test(w.label || '') || rx.test(w.id || '')) || ws[0] || null;
}
function budgetBar(label, w) {
  const b = el('div', 'b');
  const pct = w ? Math.max(0, Math.min(100, Number(w.usedPercent) || 0)) : 0;
  const line = el('div', 'bl');
  line.append(el('span', 'k', label), el('span', 'v', w && w.usedPercent != null ? `${Math.round(pct)}%${w.estimated ? ' est' : ''}` : '—'));
  const m = el('div', 'meter'); const i = el('i', meterClass(pct)); i.style.width = pct + '%'; m.append(i);
  b.append(line, m);
  return b;
}
/** Compact always-visible budget: the two classes you actually spend (Claude session, Codex weekly) + a one-line rest. */
function renderBudget() {
  const box = $('#budget'); if (!box) return; box.innerHTML = '';
  const claude = pickWindow('claude', /5-hour|session|hour/i);
  const codex = pickWindow('codex', /weekly/i);
  if (claude) box.append(budgetBar('claude · session', claude));
  if (codex) box.append(budgetBar('codex · weekly', codex));
  const parts = [];
  for (const p of S.providers || []) {
    if (p.id === 'claude' || p.id === 'codex') continue;
    if ((S.models.providers[p.id] || {}).status !== 'ok') continue;
    const w = (S.limits.providers[p.id]?.windows || [])[0];
    if (w && w.usedPercent != null) parts.push(`${p.id} ${Math.round(w.usedPercent)}%${w.estimated ? ' est' : ''}`);
    else if (p.kind === 'ollama') parts.push(`${p.id} local`);
  }
  if (parts.length) box.append(el('div', 'others', parts.slice(0, 4).join(' · ') + (parts.length > 4 ? ` · +${parts.length - 4}` : '')));
  if (!claude && !codex && !parts.length) box.append(el('div', 'empty', 'Refresh to load limits'));
}

// ---------- model chip (header) ----------
function renderChip() {
  const t = $('#chip-text'); const chip = $('#model-chip'); if (!t) return;
  if (!S.current) { t.textContent = 'No chat selected'; chip.classList.remove('live'); return; }
  const model = S.current.model && S.current.model !== 'default' ? S.current.model : 'default';
  t.textContent = `${S.current.provider || 'claude'} · ${model} · ${S.current.effort || 'high'}`;
  chip.classList.add('live');
}

// ---------- conductor picker: provider : model : effort ----------
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const composite = (v) => `${v.provider}:${v.model || 'default'}:${v.effort || 'default'}`;
const CONDUCT_KINDS = new Set(['claude', 'codex', 'ollama', 'openai-compat']);
const ALL = '*';
/** Providers that can conduct (agent harnesses) or, for the worker picker, anything with agent models. */
function agentProviders({ conductOnly }) {
  const ps = S.providers.filter((p) => (conductOnly ? CONDUCT_KINDS.has(p.kind) : p.kind !== 'image'));
  return ps.length ? ps : [{ id: 'claude' }];
}
function modelsFor(provider) { return S.models.models.filter((m) => (provider === ALL || m.provider === provider) && m.kind === 'agent'); }
const modelLabel = (m, withProvider) => `${withProvider ? m.provider + ' · ' : ''}${m.label}${m.resolved && m.resolved !== m.id ? ` (${m.resolved})` : ''}`;
/** "Other…" asks for a model id and adds it to the select so it round-trips like any listed model. Only prompts on a user pick. */
function resolveOther(prefix, interactive = false) {
  const P = $(`#${prefix}provider`), M = $(`#${prefix}model`);
  if (M.value !== '__other__') return;
  if (!interactive) { M.selectedIndex = 0; return; }
  const all = P.value === ALL;
  const typed = (window.prompt(all ? 'Model id (provider:model, e.g. claude:claude-opus-4-8 or codex:gpt-5.6-sol):' : `Model id for ${P.value}:`) || '').trim();
  if (!typed) { M.selectedIndex = 0; return; }
  const value = all ? (typed.includes(':') ? typed : `claude:${typed}`) : typed;
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
  for (const p of agentProviders({ conductOnly: opts.conductOnly !== false })) P.append(new Option(p.id, p.id));
  P.value = keepAll ? ALL : (sel.provider || (wantAll ? ALL : 'claude'));
  if (!P.value) P.selectedIndex = 0;
  P.dataset.filled = '1';
  const all = P.value === ALL;
  const ms = modelsFor(P.value);
  M.innerHTML = '';
  if (!all && P.value === 'claude') M.append(new Option('Claude Code default', ''));
  if (all) M.append(new Option('claude · Claude Code default', 'claude:'));
  if (!all && P.value !== 'claude' && !ms.length) M.append(new Option('(no models listed — refresh, log in or add a key)', ''));
  for (const m of ms) M.append(new Option(modelLabel(m, all), all ? `${m.provider}:${m.id}` : m.id));
  const match = ms.find((m) => (all ? m.provider === (sel.provider || 'claude') : true) && (m.id === sel.model || m.resolved === sel.model));
  M.value = match ? (all ? `${match.provider}:${match.id}` : match.id) : (all ? 'claude:' : '');
  if (!match && sel.model && sel.model !== 'default') { const v = all ? `${sel.provider || 'claude'}:${sel.model}` : sel.model; M.append(new Option(`${all ? (sel.provider || 'claude') + ' · ' : ''}${sel.model}`, v)); M.value = v; } // keep an explicit id even if not listed yet
  M.append(new Option('Other… (type a model id)', '__other__'));
  const cur = ms.find((m) => (all ? `${m.provider}:${m.id}` : m.id) === M.value);
  const efforts = cur?.efforts?.length ? cur.efforts : EFFORTS;
  E.innerHTML = ''; for (const e of efforts) E.append(new Option(e, e));
  E.value = efforts.includes(sel.effort) ? sel.effort : (efforts.includes('high') ? 'high' : efforts[0]);
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
function refreshHeaderPicker(forceProvider = false) {
  if (!S.current) return;
  fillPicker('', { provider: S.current.provider || 'claude', model: S.current.model || '', effort: S.current.effort || 'high' }, { forceProvider });
}

// ---------- rendering: transcript ----------
const T = () => $('#transcript');
function scrollBottom() { const t = T(); if (t.scrollHeight - t.scrollTop - t.clientHeight < 240) t.scrollTop = t.scrollHeight; }
function clearTranscript() { T().innerHTML = ''; S.stream = null; S.streams = new Map(); S.tools.clear(); S.pending.clear(); }
/** Streaming bubbles are tracked per parent (main thread = null, else the subagent's tool_use id) so interleaved subagent text never orphans a bubble. */
function streamFor(parent) { S.streams = S.streams || new Map(); return S.streams.get(parent || null) || null; }
function endStream(parent) { const st = streamFor(parent); if (st) { st.el.classList.remove('streaming'); S.streams.delete(parent || null); } }
function endAllStreams() { for (const st of (S.streams || new Map()).values()) st.el.classList.remove('streaming'); S.streams = new Map(); }

function addUser(text) { const m = el('div', 'msg user'); m.textContent = text; T().append(m); scrollBottom(); }
function addSys(text, cls = '') { const m = el('div', 'sysline ' + cls, text); T().append(m); scrollBottom(); return m; }
function ensureStream(parent) {
  const have = streamFor(parent);
  if (have) return have;
  const m = el('div', 'msg assistant streaming' + (parent ? ' sub' : '')); T().append(m);
  const st = { el: m, text: '', parent: parent || null };
  S.streams.set(parent || null, st);
  return st;
}
function addDelta(block, text, parent) {
  if (block !== 'text') { if (!S.thinkingLine || S.thinkingLine.parent !== parent) { S.thinkingLine = { el: addSys('thinking…'), parent }; } return; }
  const st = ensureStream(parent); st.text += text; st.el.textContent = st.text; scrollBottom();
}
function addAssistant(msg) {
  if (S.thinkingLine) { S.thinkingLine.el.remove(); S.thinkingLine = null; }
  for (const b of msg.blocks || []) {
    if (b.type === 'text') {
      const st = ensureStream(msg.parent || null);
      st.el.innerHTML = md(b.text); endStream(msg.parent || null);
    } else if (b.type === 'tool_use') {
      endStream(msg.parent || null);
      const d = el('details', 'tool' + (msg.parent ? ' sub' : ''));
      const sum = el('summary'); sum.append(el('span', null, '🔧'), el('span', 'n', b.name.replace('mcp__conductor__', 'conductor:')), el('span', 'muted', summarize(b.input)), el('span', 'st spin'));
      const body = el('div', 'body'); const pin = el('pre', null, JSON.stringify(b.input, null, 2)); body.append(pin);
      d.append(sum, body); T().append(d); S.tools.set(b.id, d);
    }
  }
  scrollBottom();
}
function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.title || input.command || input.description || input.file_path || input.path || input.pattern || input.query || input.prompt || input.task_id || '';
  return String(v).slice(0, 90);
}
function addToolResult(msg) {
  const d = S.tools.get(msg.toolUseId);
  if (!d) return;
  d.querySelector('.st')?.replaceWith(el('span', 'st', msg.isError ? '✗' : '✓'));
  if (msg.isError) d.classList.add('err');
  const pre = el('pre', null, msg.text || '(no output)'); d.querySelector('.body').append(pre);
}
function addResult(msg) {
  endAllStreams();
  if (S.thinkingLine) { S.thinkingLine.el.remove(); S.thinkingLine = null; }
  const cost = msg.costUsd ? ` · $${msg.costUsd.toFixed(3)}` : '';
  addSys(`${msg.isError ? 'error: ' + (msg.text || msg.subtype) : 'done'} · ${msg.numTurns ?? '?'} turns · ${Math.round((msg.durationMs || 0) / 1000)}s${cost}`, msg.isError ? 'err' : '');
}
function addPermission(req) {
  const card = el('div', 'perm'); card.dataset.id = req.id;
  card.append(el('div', 'h', `Permission: ${req.toolName}${req.agentID ? ' (subagent)' : ''}`));
  if (req.description) card.append(el('div', 'muted', req.description));
  card.append(el('pre', null, JSON.stringify(req.input, null, 2).slice(0, 3000)));
  if (req.decisionReason) card.append(el('div', 'tiny muted', req.decisionReason));
  const row = el('div', 'row');
  const allow = el('button', 'primary sm', 'Allow'); const deny = el('button', 'sm danger', 'Deny');
  allow.onclick = () => answer(true); deny.onclick = () => answer(false);
  row.append(allow, deny); card.append(row);
  const answer = async (a) => { await api.post(`/api/sessions/${S.current.id}/permission`, { requestId: req.id, allow: a }); };
  T().append(card); S.pending.set(req.id, card); scrollBottom();
}
function resolvePermission(id, allow) {
  const c = S.pending.get(id); if (!c) return; S.pending.delete(id);
  c.querySelector('.row')?.replaceWith(el('div', 'tiny muted', allow === false ? 'denied' : allow ? 'allowed' : 'resolved'));
}

function renderHistory(messages) {
  clearTranscript();
  for (const m of messages) {
    if (m.role === 'user') addUser(m.text);
    else if (m.role === 'assistant') addAssistant(m);
    else if (m.role === 'tool_result') addToolResult(m);
    else if (m.role === 'result') addResult(m);
  }
  if (!messages.length) T().append(el('div', 'empty', 'Say what you want done. The conductor will plan, delegate, and review.'));
}

// ---------- fleet dock ----------
function myTasks() { return S.tasks.filter((t) => t.sessionId === S.current?.id || t.sessionId == null); } // sessionless = launched from the CLI/API; shown in every chat
function renderTasks() {
  const box = $('#tasks'); box.innerHTML = ''; S.taskEls.clear();
  for (const t of myTasks().slice(0, 30)) box.append(taskCard(t));
  renderFleetHead();
}
function since(iso) { if (!iso) return ''; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; }
function isToday(iso) { if (!iso) return false; return new Date(iso).toDateString() === new Date().toDateString(); }
function statusPhrase(t) { return t.status === 'running' ? `running ${since(t.startedAt)}` : t.status; }
function cardFoot(t) {
  const info = S.scoreInfo.get(t.id) || {};
  const pct = t.pctWindow != null ? t.pctWindow : info.pct;
  const parts = [];
  if (pct != null) parts.push(`${pct}% window`);
  if ((t.rounds || 0) > 0) parts.push(`round ${t.rounds + 1}`);
  if (t.changedFiles?.length) parts.push(`${t.changedFiles.length} file${t.changedFiles.length > 1 ? 's' : ''}`);
  if (t.result?.durationMs) parts.push(`${Math.round(t.result.durationMs / 1000)}s`);
  if (info.verdict) parts.push(`rated ${info.verdict}`);
  return parts.join(' · ');
}
function taskCard(t) {
  const c = el('div', 'task ' + t.status); c.dataset.id = t.id;
  const h = el('div', 'h');
  const right = t.status === 'running' ? el('span', 'dot') : el('span', 'pill', t.status);
  h.append(el('span', 't', t.title), right);
  const sub = el('div', 'sub', `${t.provider}${t.model ? '/' + t.model : ''} · ${t.category || '?'}${t.difficulty ? '@' + t.difficulty : ''} · ${statusPhrase(t)}`);
  c.append(h, sub);
  const la = lastAction(t);
  if (la) c.append(el('div', 'last', la));
  if (t.status === 'running') { const p = el('div', 'prog indet'); p.append(el('i')); c.append(p); }
  const foot = cardFoot(t);
  if (foot) c.append(el('div', 'sub', foot));
  c.onclick = () => openTask(t.id);
  S.taskEls.set(t.id, c);
  return c;
}
function renderFleetHead() {
  const mine = myTasks();
  const running = mine.filter((t) => t.status === 'running').length;
  const queued = mine.filter((t) => t.status === 'queued').length;
  const doneToday = mine.filter((t) => t.status === 'done' && isToday(t.finishedAt || t.updatedAt)).length;
  $('#fleet-counts').textContent = mine.length ? `${running} running · ${queued} queued · ${doneToday} done today` : 'no workers yet';
  const todays = mine.filter((t) => (t.status === 'done' || t.status === 'failed') && isToday(t.finishedAt || t.updatedAt));
  const usd = todays.reduce((a, t) => a + (t.result?.costUsd || 0), 0);
  const wk = todays.reduce((a, t) => a + (t.pctWindow || 0), 0);
  const box = $('#fleet-budget'); box.innerHTML = '';
  const bl = el('div', 'bl'); bl.append(el('span', null, 'spent today'), el('span', null, `${wk ? wk.toFixed(1) + '% · ' : ''}$${usd.toFixed(2)}`));
  const m = el('div', 'meter'); const i = el('i'); i.style.width = Math.min(100, wk) + '%'; m.append(i);
  box.append(bl, m);
}
function lastAction(t) {
  const log = S.workerLog.get(t.id);
  if (log?.length) { const i = log[log.length - 1]; return i.command ? `$ ${i.command}` : i.name ? `${i.name} ${i.input || ''}` : i.text ? i.text : i.type; }
  if (t.error) return t.error;
  return t.result?.finalMessage ? t.result.finalMessage.slice(0, 120) : t.specPreview || '';
}
function updateTask(t) {
  const i = S.tasks.findIndex((x) => x.id === t.id);
  if (i >= 0) S.tasks[i] = t; else S.tasks.unshift(t);
  if (t.sessionId === S.current?.id || t.sessionId == null) {
    const existing = S.taskEls.get(t.id);
    const fresh = taskCard(t);
    if (existing) existing.replaceWith(fresh); else $('#tasks').prepend(fresh);
  }
  renderFleetHead();
}
async function openTask(id) {
  const t = await api.get(`/api/tasks/${id}`);
  const log = S.workerLog.get(id) || [];
  const body = el('div');
  body.append(el('div', 'muted', `${t.provider}${t.model ? '/' + t.model : ''} · ${t.status}${t.threadId ? ' · thread ' + t.threadId : ''}${t.error ? ' · ' + t.error : ''}`));
  body.append(el('h4', null, 'Spec')); body.append(el('pre', null, t.spec || ''));
  if (t.changedFiles?.length) { body.append(el('h4', null, 'Changed files')); body.append(el('pre', null, t.changedFiles.join('\n') + (t.diffStat ? '\n\n' + t.diffStat : ''))); }
  body.append(el('h4', null, 'Actions')); body.append(el('pre', null, (t.result?.items?.length ? t.result.items : log).map((i) => i.command ? `$ ${i.command}\n${(i.output || '').slice(0, 400)}` : i.name ? `→ ${i.name} ${i.input || ''}` : i.text ? i.text : i.type).join('\n') || '(none yet)'));
  if (t.result?.finalMessage) { body.append(el('h4', null, 'Worker report')); const r = el('div', 'msg assistant'); r.innerHTML = md(t.result.finalMessage); body.append(r); }
  const row = el('div', 'row');
  if (!['done', 'failed', 'canceled'].includes(t.status)) { const b = el('button', 'sm danger', 'Cancel task'); b.onclick = async () => { await api.post(`/api/tasks/${id}/cancel`); closeModal(); }; row.append(b); }
  body.append(row);
  openModal(`Task ${t.id}: ${t.title}`, body);
}

// ---------- sessions ----------
async function openSession(id) {
  const s = await api.get(`/api/sessions/${id}`);
  S.current = s; localStorage.setItem('lastSession', id);
  $('#chat-title').textContent = s.title || 'New chat'; $('#chat-cwd').textContent = `${s.cwd} · ${s.selection || ''}`;
  refreshHeaderPicker(); renderChip(); $('#bypass').checked = s.permissionMode === 'bypassPermissions'; if ($('#overflow')) $('#overflow').checked = !!s.overflowApi;
  setStatus(s.status);
  renderHistory(s.messages || []);
  for (const p of s.pending || []) addPermission(p);
  renderSessions(); renderTasks();
  document.body.classList.remove('nav-open'); // close the mobile drawer after picking a chat
  $('#input').focus();
}
function setStatus(st) {
  const p = $('#status'); p.textContent = st; p.className = 'pill' + (st === 'running' ? ' running' : st === 'error' ? ' error' : '');
  $('#btn-stop').disabled = st !== 'running';
}
async function newSession() {
  const cwd = $('#cwd').value.trim();
  if (!cwd) { $('#stt-hint').textContent = 'Pick a project folder first (left panel).'; $('#cwd').focus(); return; }
  localStorage.setItem('cwd', cwd);
  const sel = pickerValue('new-');
  localStorage.setItem('conductorSel', JSON.stringify(sel));
  api.post('/api/settings', { conductor: { provider: sel.provider, model: sel.model || null, effort: sel.effort } }).catch(() => {}); // remember as default
  let s;
  try { s = await api.post('/api/sessions', { cwd, provider: sel.provider, model: sel.model || 'default', effort: sel.effort, permissionMode: $('#new-bypass').checked ? 'bypassPermissions' : 'acceptEdits', overflowApi: $('#new-overflow').checked }); }
  catch (e) { $('#stt-hint').textContent = e.message; return; }
  $('#newchat-form').hidden = true; // collapse the inline form once the chat is created
  await refreshSessions(); await openSession(s.id);
}
async function refreshSessions() { S.sessions = await api.get('/api/sessions'); renderSessions(); }
async function send() {
  const ta = $('#input'); const text = ta.value.trim(); if (!text) return;
  if (!S.current) { await newSession(); if (!S.current) return; }
  ta.value = ''; ta.style.height = '';
  // "/worker <spec>" (or "/astra", "/ollama <model> <spec>") sends straight to a worker: zero conductor tokens.
  const direct = text.match(/^\/(worker|astra|codex|ollama|claude)(?:\s+(\S+))?\s+([\s\S]+)$/);
  if (direct) {
    const [, kind, arg, spec] = direct;
    const provider = kind === 'worker' ? undefined : kind === 'astra' ? 'codex' : kind;
    const model = kind === 'ollama' || kind === 'claude' ? arg : undefined;
    const body = { sessionId: S.current.id, cwd: S.current.cwd, spec: model ? spec : (arg ? `${arg} ${spec}` : spec), provider, model };
    addUser(text);
    try { const t = await api.post('/api/tasks', body); addSys(`worker task ${t.id} queued (${t.provider}${t.model ? '/' + t.model : ''})`); } catch (e) { addSys(`task failed: ${e.message}`, 'err'); }
    return;
  }
  try { await api.post(`/api/sessions/${S.current.id}/messages`, { text }); } catch (e) { addSys(`send failed: ${e.message}`, 'err'); }
}

// ---------- SSE ----------
async function resync() {
  const st = await api.get('/api/state');
  S.lastSeq = st.seq || 0; // state is fresh: do not replay events that predate it on top of it
  Object.assign(S, { sessions: st.sessions, models: st.models, limits: st.limits, tasks: st.tasks, improvements: st.improvements, config: st.config, providers: st.providers });
  renderSessions(); renderProviders(); renderBudget(); renderTasks(); applyAutoRefresh();
  if (!S.bypassTouched) $('#new-bypass').checked = S.config?.conductor?.permissionMode === 'bypassPermissions'; // settings default; a manual toggle sticks
  if (!S.overflowTouched) $('#new-overflow').checked = !!S.config?.conductor?.overflowApi;
  if (S.current) await openSession(S.current.id);
}
/** Coalesce bursts (e.g. replayed events) into one refetch per key. */
const pendingRefetch = new Map();
function coalesce(key, fn, ms = 250) { clearTimeout(pendingRefetch.get(key)); pendingRefetch.set(key, setTimeout(() => { pendingRefetch.delete(key); fn().catch(() => {}); }, ms)); }
let autoRefreshTimer = null;
function applyAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const on = !!S.config?.ui?.autoRefresh;
  const min = Math.max(1, Number(S.config?.ui?.autoRefreshMinutes) || 15);
  const cb = $('#auto-refresh'); if (cb) cb.checked = on;
  if (on) autoRefreshTimer = setInterval(() => { api.post('/api/models/refresh').catch(() => {}); api.post('/api/limits/refresh').catch(() => {}); }, min * 60_000);
}
function connect() {
  const es = new EventSource(`/api/events?since=${S.lastSeq}`);
  // A different boot id means the server restarted: refetch state (which carries the new seq) and reconnect. Never leave the page without a stream.
  es.addEventListener('hello', (e) => { const boot = JSON.parse(e.data).boot; if (S.boot && boot !== S.boot) { S.boot = boot; es.close(); resync().catch(() => {}).then(() => setTimeout(connect, 500)); } else S.boot = boot; });
  const on = (type, fn) => es.addEventListener(type, (e) => { const ev = JSON.parse(e.data); S.lastSeq = Math.max(S.lastSeq, ev.seq); fn(ev); });
  on('session', onSessionEvent);
  on('task', (ev) => updateTask(ev.task));
  on('worker', (ev) => { const log = S.workerLog.get(ev.taskId) || []; if (ev.item) { log.push(ev.item); if (log.length > 200) log.shift(); S.workerLog.set(ev.taskId, log); } if (ev.error) { log.push({ type: 'error', text: ev.error }); S.workerLog.set(ev.taskId, log); } const c = S.taskEls.get(ev.taskId); if (c) { const l = c.querySelector('.last'); if (l) l.textContent = lastAction({ id: ev.taskId }); } });
  on('score', (ev) => { const s = S.scoreInfo.get(ev.taskId) || {}; if (ev.verdict) s.verdict = ev.verdict; if (ev.pct && typeof ev.pct === 'object') { const vals = Object.values(ev.pct); if (vals.length) s.pct = Math.round(Math.max(...vals) * 10) / 10; } S.scoreInfo.set(ev.taskId, s); const t = S.tasks.find((x) => x.id === ev.taskId); if (t) updateTask(t); });
  on('models', () => coalesce('models', async () => { S.models = await api.get('/api/models'); refreshNewPicker(true); refreshHeaderPicker(); renderProviders(); renderBudget(); }));
  on('limits', () => coalesce('limits', async () => { S.limits = await api.get('/api/limits'); renderProviders(); renderBudget(); }));
  on('improvement', () => coalesce('improvements', async () => { S.improvements = await api.get('/api/improvements'); $('#improve-count').textContent = S.improvements.length; }));
  on('model_pull', (ev) => { $('#stt-hint').textContent = ev.status === 'done' ? `pulled ${ev.model}` : `pulling ${ev.model}: ${ev.status} ${ev.completed && ev.total ? Math.round(100 * ev.completed / ev.total) + '%' : ''}`; });
  on('settings', () => coalesce('settings', async () => { S.config = await api.get('/api/settings'); renderProviders(); renderBudget(); applyAutoRefresh(); }));
  on('update', (ev) => { const b = $('#btn-update'); if (ev.behind) { b.hidden = false; b.textContent = `⬇ Update (${ev.behind})`; } if (ev.updated) { b.hidden = true; addSys(`Updated ${ev.from} → ${ev.to}${ev.npmInstalled ? ' (dependencies installed)' : ''}. Restart Conductor to run the new version.`); } });
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}
function onSessionEvent(ev) {
  if (ev.kind === 'created' || ev.kind === 'deleted' || ev.kind === 'updated') { refreshSessions(); if (ev.kind === 'deleted' && S.current?.id === ev.sessionId) { S.current = null; clearTranscript(); $('#chat-title').textContent = 'No chat selected'; } if (ev.kind === 'updated' && S.current?.id === ev.sessionId) { S.current = { ...S.current, ...ev.session }; refreshHeaderPicker(); renderChip(); $('#chat-title').textContent = S.current.title || 'New chat'; $('#chat-cwd').textContent = `${S.current.cwd} · ${S.current.selection || ''}`; } return; }
  if (ev.kind === 'status') { const s = S.sessions.find((x) => x.id === ev.sessionId); if (s) { s.status = ev.status; renderSessions(); } }
  if (ev.sessionId !== S.current?.id) return;
  switch (ev.kind) {
    case 'user': addUser(ev.text); $('#chat-title').textContent = S.current.title = (S.current.title === 'New chat' ? ev.text.slice(0, 60) : S.current.title); break;
    case 'delta': addDelta(ev.block, ev.text, ev.parent || null); break;
    case 'assistant': addAssistant(ev); break;
    case 'tool_result': addToolResult(ev); break;
    case 'result': addResult(ev); break;
    case 'status': setStatus(ev.status); break;
    case 'init': addSys(`session ${String(ev.sdkSessionId || '').slice(0, 8)} · ${ev.model} · ${ev.permissionMode}`); break;
    case 'permission': addPermission(ev.request); break;
    case 'permission_resolved': resolvePermission(ev.id, ev.allow); break;
    case 'subagent': addSys(`subagent ${ev.subtype.replace('task_', '')}: ${ev.description || ''}`); break;
    case 'compact': addSys(`context compacted (${ev.pre} → ${ev.post ?? '?'} tokens)`); break;
    case 'rate_limit': addSys(`rate limit ${ev.info?.status}: ${ev.info?.rateLimitType || ''} ${ev.info?.utilization != null ? Math.round(ev.info.utilization <= 1 ? ev.info.utilization * 100 : ev.info.utilization) + '%' : ''}`, 'warn'); break;
    case 'error': addSys(ev.message, 'err'); break;
  }
}

// ---------- modals ----------
function openModal(title, body) { document.body.classList.remove('nav-open'); $('#modal-title').textContent = title; const b = $('#modal-body'); b.innerHTML = ''; b.append(body); $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
async function browse(path) {
  const r = await api.get(`/api/browse?path=${encodeURIComponent(path || localStorage.getItem('cwd') || '')}`);
  const body = el('div', 'dirs');
  const head = el('div', 'row'); const inp = el('input'); inp.type = 'text'; inp.value = r.path; const go = el('button', 'sm', 'Go'); go.onclick = () => browse(inp.value); inp.onkeydown = (e) => { if (e.key === 'Enter') browse(inp.value); };
  const use = el('button', 'primary sm', 'Use this folder'); use.onclick = () => { $('#cwd').value = r.path; localStorage.setItem('cwd', r.path); closeModal(); };
  head.append(inp, go, use); body.append(head);
  body.append(el('div', 'tiny muted', `${r.hasGit ? 'git repo · ' : ''}${r.hasClaudeMd ? 'has CLAUDE.md' : 'no CLAUDE.md'}`));
  if (r.parent) { const up = el('div', 'd', '⬆ ..'); up.onclick = () => browse(r.parent); body.append(up); }
  for (const d of r.dirs) { const x = el('div', 'd', '📁 ' + d); x.onclick = () => browse(r.path.replace(/[\\/]$/, '') + (r.path.includes('\\') ? '\\' : '/') + d); body.append(x); }
  openModal('Choose project folder', body);
}
function openSettings() {
  const c = S.config; const body = el('div');
  const grid = el('div', 'grid');
  const field = (label, id, value, type = 'text', hint = '') => { const l = el('label', null, label); l.title = hint; const i = el('input'); i.type = type; i.id = 'cfg-' + id; i.value = value ?? ''; if (type === 'password') i.placeholder = value ? '(saved)' : 'paste key'; grid.append(l, i); return i; };
  const selectField = (label, id, value, opts) => { grid.append(el('label', null, label)); const s = el('select'); s.id = 'cfg-' + id; for (const o of opts) s.append(new Option(o, o)); s.value = value; grid.append(s); };
  const pickerRow = (label, prefix, sel, opts) => {
    grid.append(el('label', null, label));
    const row = el('div', 'row picker');
    for (const part of ['provider', 'model', 'effort']) { const s = el('select'); s.id = `${prefix}${part}`; row.append(s); }
    grid.append(row);
    setTimeout(() => {
      fillPicker(prefix, sel, opts);
      $(`#${prefix}provider`).onchange = (e) => { const v = e.target.value; fillPicker(prefix, v === ALL ? pickerValue(prefix) : { ...pickerValue(prefix), provider: v, model: '' }, { ...opts, forceProvider: true }); };
      $(`#${prefix}model`).onchange = () => fillPicker(prefix, pickerValue(prefix), { ...opts, forceProvider: true });
    }, 0);
  };
  body.append(el('h4', null, 'Default worker (the grunt coder) — provider : model : effort'));
  pickerRow('Worker', 'wk-', { provider: c.worker.provider, model: c.worker.model, effort: c.worker.effort }, { conductOnly: false, all: true });
  body.append(el('h4', null, 'Conductor default — provider : model : effort'));
  pickerRow('Conductor', 'cd-', { provider: c.conductor.provider || 'claude', model: c.conductor.model || '', effort: c.conductor.effort }, { conductOnly: true, all: true });
  selectField('GitHub updates', 'conductor.autoUpdate', c.conductor.autoUpdate || 'ask', ['ask', 'auto', 'off']); // ask = notify + apply on click; auto = pull automatically; off = never check
  selectField('New chats: permissions', 'conductor.permissionMode', c.conductor.permissionMode || 'acceptEdits', ['bypassPermissions', 'acceptEdits']);
  selectField('New chats: API overflow', 'conductor.overflowApi', String(!!c.conductor.overflowApi), ['false', 'true']);
  body.append(el('h4', null, 'Worker behaviour'));
  selectField('Codex sandbox', 'worker.codexSandbox', c.worker.codexSandbox, ['read-only', 'workspace-write', 'danger-full-access']);
  field('Max parallel workers', 'conductor.maxWorkerConcurrency', c.conductor.maxWorkerConcurrency, 'number');
  field('Max tool turns per chat turn', 'conductor.maxTurns', c.conductor.maxTurns, 'number', 'Claude harness and API/Ollama conductors; big projects need thousands.');
  field('Max tool turns per Claude worker task', 'worker.maxTurns', c.worker.maxTurns, 'number');
  field('Worker timeout (min)', 'worker.timeoutMinutes', c.worker.timeoutMinutes, 'number');
  field('Worker timeout for modeling (min)', 'worker.timeoutByCategory.modeling', c.worker.timeoutByCategory?.modeling ?? '', 'number', 'Image->3D runs iterate for a long time; runs past "long run" minutes are logged so you can watch them.');
  field('Log runs longer than (min)', 'worker.longRunMinutes', c.worker.longRunMinutes, 'number');
  field('Review rounds max', 'worker.maxRounds', c.worker.maxRounds, 'number');
  field('Poll models/limits every (min)', 'pollMinutes', c.pollMinutes, 'number');
  field('Providers panel auto-refresh every (min)', 'ui.autoRefreshMinutes', c.ui?.autoRefreshMinutes ?? 15, 'number', 'When the "auto" box next to ↻ Refresh is checked, the browser panel re-fetches models+limits this often. Separate from the server registry poll above. Minimum 1 minute.');
  { const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; grid.append(el('label', null, 'Grok reset day')); const s = el('select'); s.id = 'cfg-scorecard.usageResets.grok.resetDay'; days.forEach((n, i) => s.append(new Option(n, i))); s.value = String(c.scorecard?.usageResets?.grok?.resetDay ?? 1); grid.append(s); }
  const grokHour = field('Grok reset hour (0-23, local)', 'scorecard.usageResets.grok.resetHour', c.scorecard?.usageResets?.grok?.resetHour ?? 18, 'number'); grokHour.min = 0; grokHour.max = 23;
  body.append(el('h4', null, 'API keys (optional; subscriptions need none)'));
  field('DeepSeek budget (USD, for the balance meter)', 'providers.deepseek.budgetUsd', c.providers.deepseek?.budgetUsd ?? '', 'number', 'What you topped up; the meter shows % of it consumed. Leave empty to use the highest balance seen.');
  for (const id of ['deepseek', 'moonshot', 'xai', 'qwen', 'gemini', 'openai', 'stability']) field(S.providers.find((p) => p.id === id)?.label || id, `providers.${id}.apiKey`, c.providers[id]?.apiKey === '••••' ? '••••' : '', 'password');
  field('Ollama URL', 'providers.ollama.baseUrl', c.providers.ollama.baseUrl);
  field('Local SD URL', 'providers.sd.baseUrl', c.providers.sd.baseUrl);
  body.append(grid);
  body.append(el('div', 'tiny muted', 'Login for subscriptions happens in a terminal:  claude auth login   ·   codex login'));
  const upd = el('button', 'sm', 'Check for updates (GitHub)'); const updOut = el('div', 'muted tiny', '');
  upd.onclick = async () => { updOut.textContent = 'checking…'; try { const st = await api.get('/api/update?fetch=1'); updOut.textContent = st.git ? (st.error ? `${st.branch}@${st.head}: ${st.error}` : `${st.branch}@${st.head}: ${st.behind ? `${st.behind} update(s) available — use the ⬇ Update button in the header` : 'up to date'}${st.ahead ? `, ${st.ahead} local commit(s) not pushed` : ''}${st.dirty ? `, ${st.dirty} uncommitted change(s)` : ''}`) : st.error; if (st.behind) { $('#btn-update').hidden = false; $('#btn-update').textContent = `⬇ Update (${st.behind})`; } } catch (e) { updOut.textContent = e.message; } };
  body.append(upd, updOut);
  const doc = el('button', 'sm', 'Run doctor (environment check)'); const docOut = el('pre', null, ''); docOut.hidden = true;
  doc.onclick = async () => { doc.disabled = true; try { const r = await api.get('/api/doctor'); docOut.hidden = false; docOut.textContent = r.rows.map((x) => `${x.name.padEnd(20)} ${String(x.value).padEnd(26)} ${x.status}${x.path ? `\n${''.padEnd(20)} ${x.path}` : ''}`).join('\n') + `\n\nPATH entries: ${r.path.length}`; } finally { doc.disabled = false; } };
  body.append(doc, docOut);
  const save = el('button', 'primary', 'Save'); save.onclick = async () => {
    const patch = {};
    for (const i of grid.querySelectorAll('input,select')) {
      if (!i.id.startsWith('cfg-')) continue;
      const path = i.id.replace('cfg-', '').split('.'); let v = i.type === 'number' ? Number(i.value) : i.value;
      if (i.type === 'password') { if (!v || v === '••••') continue; }
      if (i.id === 'cfg-conductor.overflowApi') v = v === 'true';
      if (i.id === 'cfg-conductor.overflowApi') v = v === 'true';
      if (i.id.startsWith('cfg-scorecard.usageResets.')) v = Number(i.value);
      let o = patch; for (const k of path.slice(0, -1)) o = o[k] = o[k] || {}; o[path.at(-1)] = v;
    }
    const wk = pickerValue('wk-'); const cd = pickerValue('cd-');
    patch.worker = { ...(patch.worker || {}), provider: wk.provider, model: wk.model || null, effort: wk.effort };
    patch.conductor = { ...(patch.conductor || {}), provider: cd.provider, model: cd.model || null, effort: cd.effort };
    S.config = await api.post('/api/settings', patch); closeModal(); renderProviders(); applyAutoRefresh(); refreshNewPicker(false, true); api.post('/api/models/refresh').catch(() => {});
  };
  body.append(save);
  // Quit: stop the server process from the browser (also available top-left in the brand row).
  const quit = el('button', 'sm danger', 'Quit conductor (stop the server)');
  quit.style.marginLeft = '8px';
  quit.onclick = () => quitServer(quit);
  body.append(quit);
  openModal('Settings', body);
}
async function openImprovements(showResolved = false) {
  S.improvements = await api.get('/api/improvements');
  const all = showResolved ? await api.get('/api/improvements?all=1') : S.improvements;
  const body = el('div');
  const tabs = el('div', 'row');
  for (const [label, v] of [['Open', false], ['Resolved', true]]) { const b = el('button', v === showResolved ? 'primary sm' : 'sm', label); b.onclick = () => openImprovements(v); tabs.append(b); }
  body.append(tabs);
  const form = el('div', 'row'); const inp = el('input'); inp.type = 'text'; inp.placeholder = 'Log an idea or annoyance…'; const add = el('button', 'sm', 'Add');
  add.onclick = async () => { if (inp.value.trim()) { await api.post('/api/improvements', { kind: 'idea', message: inp.value.trim() }); inp.value = ''; openImprovements(); } };
  form.append(inp, add); body.append(form);
  const run = el('button', 'primary sm', 'Run self-review now'); run.onclick = runReview; body.append(run);
  const shown = showResolved ? all.filter((e) => e.resolved) : S.improvements;
  for (const e of [...shown].reverse()) {
    const d = el('div', 'imp'); d.append(el('div', 'k', `${e.kind} · ${e.source} · ${new Date(e.ts).toLocaleString()}${e.resolved ? ' · resolved' : ''}`), el('div', 'm', e.message));
    if (!e.resolved) { const r = el('button', 'sm', 'Resolve'); r.onclick = async () => { await api.post(`/api/improvements/${e.id}/resolve`); openImprovements(showResolved); }; d.append(r); }
    body.append(d);
  }
  if (!shown.length) body.append(el('div', 'muted', showResolved ? 'Nothing resolved yet.' : 'Nothing logged. Errors are captured automatically; the conductor and you can add ideas.'));
  openModal('Improvement log', body);
}
async function runReview() {
  closeModal();
  const s = await api.post('/api/review', { model: composite(pickerValue('new-')) });
  await refreshSessions(); await openSession(s.id);
}

// ---------- quit / misc ----------
/** Stop the server process (destructive: gated behind a confirm). Used by the top-left Quit and the Settings Quit. */
async function quitServer(btn) {
  if (!confirm('Stop the Conductor server? In-flight tasks resume next time you start it. This tab stops working until you restart it.')) return false;
  if (btn) btn.disabled = true;
  try { await api.post('/api/shutdown', {}); } catch {}
  document.body.innerHTML = '<div style="padding:2rem;font:14px system-ui">Conductor stopped. Restart it with <code>conductor start</code>, then reload this page.</div>';
  return true;
}
function toggleModelPop(force) { const pop = $('#model-pop'); if (!pop) return; pop.hidden = force != null ? !force : !pop.hidden; }
/** SYSTEM drawer: providers, self-improvement, benchmarks, settings out of the primary flow. */
function openSystem(open) {
  const b = $('#system-body'); if (!b) return;
  const isOpen = open != null ? open : b.hidden;
  b.hidden = !isOpen;
  localStorage.setItem('systemOpen', isOpen ? '1' : '0');
  const car = $('#system-toggle .caret'); if (car) car.textContent = isOpen ? '▾' : '▸';
}
/** "details ▸" on the budget headline opens the SYSTEM drawer at Providers & limits. */
function revealProviders() { openSystem(true); $('.providers-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
async function openScores() {
  const body = el('div'); body.append(el('div', 'muted tiny', 'Loading…'));
  openModal('Benchmarks & scores', body);
  try {
    const [sc, bn] = await Promise.all([api.get('/api/scores'), api.get('/api/bench').catch(() => null)]);
    body.innerHTML = '';
    body.append(el('h4', null, 'Scores (measured worker selection)'));
    body.append(el('pre', null, sc.text || '(no rated runs yet)'));
    if (bn?.text) { body.append(el('h4', null, 'Due for benchmark')); body.append(el('pre', null, bn.text)); }
  } catch (e) { body.innerHTML = ''; body.append(el('div', 'sysline err', e.message)); }
}

// ---------- boot ----------
async function boot() {
  const st = await api.get('/api/state');
  S.boot = st.boot; S.lastSeq = st.seq || 0; // the transcript is rendered from state; only newer events stream in
  Object.assign(S, { sessions: st.sessions, models: st.models, limits: st.limits, tasks: st.tasks, improvements: st.improvements, config: st.config, providers: st.providers });
  $('#cwd').value = localStorage.getItem('cwd') || '';
  $('#improve-count').textContent = S.improvements.length;
  refreshNewPicker(false); renderSessions(); renderProviders(); renderBudget(); renderTasks(); applyAutoRefresh();
  connect();
  const last = localStorage.getItem('lastSession');
  if (last && S.sessions.some((s) => s.id === last)) openSession(last).catch(() => {});

  $('#btn-new').onclick = newSession;
  $('#btn-browse').onclick = () => browse($('#cwd').value);
  $('#btn-send').onclick = send;
  $('#btn-stop').onclick = () => S.current && api.post(`/api/sessions/${S.current.id}/interrupt`);
  $('#btn-refresh').onclick = async (e) => { e.target.disabled = true; try { await Promise.all([api.post('/api/models/refresh'), api.post('/api/limits/refresh')]); } finally { e.target.disabled = false; } };
  $('#auto-refresh').onchange = async (e) => { const v = e.target.checked; try { S.config = await api.post('/api/settings', { ui: { autoRefresh: v } }); } catch {} applyAutoRefresh(); };
  $('#btn-settings').onclick = openSettings;
  $('#btn-quit').onclick = (e) => quitServer(e.currentTarget);
  $('#btn-budget-details').onclick = () => revealProviders();
  if (localStorage.getItem('fleetCollapsed') === '1') { document.body.classList.add('fleet-collapsed'); $('#fleet-collapse').textContent = '⟩'; }
  $('#fleet-collapse').onclick = () => { const c = document.body.classList.toggle('fleet-collapsed'); localStorage.setItem('fleetCollapsed', c ? '1' : '0'); $('#fleet-collapse').textContent = c ? '⟩' : '⟨'; };
  // new-chat: one button reveals the inline form; SYSTEM drawer folds admin away.
  $('#btn-newchat-toggle').onclick = () => { const f = $('#newchat-form'); f.hidden = !f.hidden; if (!f.hidden) $('#cwd').focus(); };
  $('#system-toggle').onclick = () => openSystem();
  $('#btn-scores').onclick = openScores;
  $('#btn-settings2').onclick = openSettings;
  $('#chat-filter').oninput = (e) => { S.chatFilter = e.target.value; renderSessions(); };
  $('#btn-nav').onclick = () => document.body.classList.toggle('nav-open');
  $('#scrim').onclick = () => document.body.classList.remove('nav-open');
  if (localStorage.getItem('systemOpen') === '1') openSystem(true);
  if (!S.sessions.length) $('#newchat-form').hidden = false; // first run: no chats yet, show the form
  // model chip popover: toggle on click, close on outside-click / Escape.
  $('#model-chip').onclick = (e) => { e.stopPropagation(); toggleModelPop(); };
  $('#model-pop').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => toggleModelPop(false));
  $('#btn-improvements').onclick = () => openImprovements();
  $('#btn-update').onclick = async () => { const b = $('#btn-update'); b.disabled = true; try { const r = await api.post('/api/update'); if (!r.updated) { b.hidden = true; addSys('Already up to date.'); } } catch (e) { addSys(`Update failed: ${e.message}`); } b.disabled = false; };
  $('#btn-review').onclick = runReview;
  $('#modal-close').onclick = closeModal;
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  // Switching back to "all providers" must keep the last real selection (the bare model id in the select no longer carries its provider).
  $('#new-provider').onchange = (e) => { const v = e.target.value; fillPicker('new-', v === ALL ? savedSelection() : { ...savedSelection(), provider: v, model: '' }, { forceProvider: v !== ALL }); refreshNewPicker(true, v !== ALL); };
  $('#new-model').onchange = () => { resolveOther('new-', true); refreshNewPicker(true, true); };
  $('#new-effort').onchange = () => refreshNewPicker(true, true);
  $('#provider').onchange = (e) => { const v = e.target.value; const cur = { provider: S.current?.provider || 'claude', model: S.current?.model || '', effort: S.current?.effort || 'high' }; fillPicker('', v === ALL ? cur : { ...cur, provider: v, model: v === cur.provider ? cur.model : '' }, { forceProvider: v !== ALL }); };
  $('#model').onchange = () => { if (!S.current) return; resolveOther('', true); const v = pickerValue(''); if (v.provider !== S.current.provider) { $('#stt-hint').textContent = 'Provider can only be chosen for a new chat; the model switched within ' + S.current.provider + ' only if it belongs to it.'; refreshHeaderPicker(true); return; } api.post(`/api/sessions/${S.current.id}/model`, { model: v.model || null }); fillPicker('', v, { forceProvider: true }); };
  $('#effort').onchange = () => S.current && api.post(`/api/sessions/${S.current.id}/effort`, { effort: pickerValue('').effort });
  $('#new-bypass').onchange = () => { S.bypassTouched = true; };
  $('#new-overflow').onchange = () => { S.overflowTouched = true; };
  $('#overflow').onchange = (e) => S.current && api.post(`/api/sessions/${S.current.id}/overflow`, { overflowApi: e.target.checked });
  $('#bypass').onchange = (e) => S.current && api.post(`/api/sessions/${S.current.id}/mode`, { permissionMode: e.target.checked ? 'bypassPermissions' : 'acceptEdits' });
  $('#cwd').onchange = (e) => localStorage.setItem('cwd', e.target.value.trim());
  const ta = $('#input');
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px'; });

  // speech to text
  const stt = createSTT({
    onFinal: (t) => insertAtCaret(ta, t),
    onInterim: (t) => { const i = $('#interim'); i.hidden = !t; i.textContent = t; },
    onState: ({ active, error }) => { $('#btn-mic').classList.toggle('on', !!active); $('#stt-hint').textContent = error ? `mic: ${error}${error === 'not-allowed' ? ' — allow microphone access for this site' : ''}` : active ? 'listening… click 🎤 or Ctrl+M to stop' : ''; },
  });
  if (!stt.supported) { $('#btn-mic').disabled = true; $('#stt-hint').textContent = 'Speech to text needs Chrome or Edge (Web Speech API).'; }
  $('#btn-mic').onclick = () => stt.toggle();
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'm') { e.preventDefault(); stt.toggle(); ta.focus(); } if (e.key === 'Escape') { if (!$('#model-pop').hidden) toggleModelPop(false); else if (!$('#modal').hidden) closeModal(); else if (document.body.classList.contains('nav-open')) document.body.classList.remove('nav-open'); else if (stt.active) stt.stop(); } });
}
boot().catch((e) => { document.body.innerHTML = `<pre style="padding:20px">Failed to load: ${esc(e.message)}</pre>`; });
