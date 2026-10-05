import { $, el, api, S, act, asBtn, showStatus, COMPOSER_PLACEHOLDER } from './core.js';
import { renderBudget } from './budget.js';
import { renderChip } from './chip.js';
import { refreshHeaderPicker, pickerValue } from './picker.js';
import { T, stopSpinners, addUser, addSys, clearTranscript, renderHistory, addPermission, dropQueueTag, removeQueuedBubble, addDelta, addAssistant, addToolResult, addResult, resolvePermission } from './transcript.js';
import { renderTasks, taskCard, renderFleetHead, terminalTask } from './fleet.js';

let newSessionPromise = null;

// ---------- sessions ----------
function renderSessions() {
  const box = $('#sessions'); box.innerHTML = '';
  const f = (S.chatFilter || '').toLowerCase();
  for (const s of S.sessions) {
    if (f && !`${s.title || 'New chat'} ${s.cwd || ''}`.toLowerCase().includes(f)) continue;
    const it = el('div', 'item' + (S.current?.id === s.id ? ' active' : ''));
    const t = el('span', 't', s.title || 'New chat'); t.title = `${s.cwd}\n${s.model || 'default model'}`;
    t.ondblclick = (e) => { e.stopPropagation(); renameSession(s); };
    const running = S.tasks.filter((t) => t.sessionId === s.id && t.status === 'running').length;
    const checked = s.status === 'running' && s.watchdog?.checkedAt;
    const verdict = checked ? s.watchdog.verdict : null;
    const st = el('span', 'pill' + (verdict ? ` ${verdict}` : running || s.status === 'running' ? ' running' : ''), running ? `● ${running}` : (verdict || (s.status === 'running' ? '●' : '')));
    if (checked) st.title = s.watchdog.summary;
    const appPill = (s.pendingCount > 0) ? el('span', 'pill warn', `approve ${s.pendingCount}`) : null;
    if (appPill) appPill.title = `${s.pendingCount} pending permission prompt(s)`;
    const ren = el('button', 'x', '✎'); ren.type = 'button'; ren.title = 'Rename chat'; ren.setAttribute('aria-label', 'Rename chat');
    ren.onclick = (e) => { e.stopPropagation(); renameSession(s); };
    ren.onkeydown = (e) => e.stopPropagation();
    const x = el('button', 'x', '✕'); x.type = 'button'; x.title = 'Delete chat'; x.setAttribute('aria-label', 'Delete chat');
    x.onclick = (e) => { e.stopPropagation(); if (confirm('Delete this chat?')) act(() => api.del(`/api/sessions/${s.id}`)); };
    x.onkeydown = (e) => e.stopPropagation();
    if (appPill) it.append(t, appPill, st, ren, x);
    else it.append(t, st, ren, x);
    asBtn(it, () => act(() => openSession(s.id), null, $('#sessions-status')));
    box.append(it);
  }
  if (!box.children.length) {
    const empty = el('div', 'empty', S.sessions.length ? 'No chats match.' : 'No chats yet.');
    if (S.sessions.length) {
      const clear = el('button', 'sm', 'Clear filter');
      clear.onclick = () => { S.chatFilter = ''; $('#chat-filter').value = ''; renderSessions(); };
      empty.append(clear);
    }
    box.append(empty);
  }
}

async function renameSession(s) {
  const name = prompt('Rename chat:', s.title || 'New chat');
  if (name == null) return; // cancelled
  const next = name.trim();
  if (!next || next === s.title) return;
  try { await api.post(`/api/sessions/${s.id}/title`, { title: next }); } catch (e) { alert(`Rename failed: ${e.message}`); }
}

function updateTask(t) {
  if (terminalTask(t)) S.workerLog.delete(t.id);
  const i = S.tasks.findIndex((x) => x.id === t.id);
  const previous = S.tasks[i];
  if (i >= 0) S.tasks[i] = t; else S.tasks.unshift(t);
  if (!previous || terminalTask(previous) !== terminalTask(t)) renderTasks();
  else {
    const existing = S.taskEls.get(t.id);
    if (existing) existing.replaceWith(taskCard(t));
    renderFleetHead();
  }
  renderSessions();
}

async function openSession(id) {
  const tok = {};
  const same = S.opening?.id === id;
  S.opening = { id, tok };
  if (!same || !S.bufferedEvents) S.bufferedEvents = [];
  let s;
  try {
    s = await api.get(`/api/sessions/${id}`);
  } catch (e) {
    if (S.opening?.tok === tok) {
      const replay = S.current?.id === id ? S.bufferedEvents : null;
      S.opening = null;
      S.bufferedEvents = null;
      if (replay) for (const ev of replay) onSessionEvent(ev);
    }
    throw e;
  }
  if (S.opening?.tok !== tok) return;
  S.opening = null;
  const buffered = S.bufferedEvents || [];
  S.bufferedEvents = null;
  S.current = s; localStorage.setItem('lastSession', id);
  $('#chat-title').textContent = s.title || 'New chat'; $('#chat-cwd').textContent = s.cwd;
  refreshHeaderPicker(); renderChip(); renderBudget(); $('#bypass').checked = s.permissionMode === 'bypassPermissions'; if ($('#overflow')) $('#overflow').checked = !!s.overflowApi; if ($('#parallel')) $('#parallel').checked = !!s.parallelOverride;
  setStatus(s.status);
  renderHistory(s.messages || []);
  for (const p of s.pending || []) addPermission(p);
  renderSessions(); renderTasks();
  document.body.classList.remove('nav-open'); // close the mobile drawer after picking a chat
  $('#input').focus();
  for (const ev of buffered) {
    if (s.seq && ev.seq && ev.seq <= s.seq) continue;
    onSessionEvent(ev);
  }
}
function clearCurrent() {
  S.current = null;
  try { localStorage.removeItem('lastSession'); } catch {}
  $('#chat-title').textContent = 'No chat selected';
  $('#chat-cwd').textContent = '';
  renderChip();
  renderBudget();
  setStatus('idle');
  clearTranscript();
  const em = el('div', 'empty');
  em.append(document.createTextNode('Pick a project folder, choose the conductor model, and start a chat.'), el('br'), el('span', 'muted', 'The conductor plans and reviews; workers (Astra via Codex and API models) do the typing.'));
  T().append(em);
  renderTasks();
  renderSessions();
}
function setStatus(st) {
  const p = $('#status'); p.textContent = st; p.className = 'pill' + (st === 'running' ? ' running' : st === 'error' ? ' error' : '');
  $('#input').placeholder = st === 'running' && ['codex', 'loop'].includes(S.current?.runtime) ? 'Queue a follow-up…' : COMPOSER_PLACEHOLDER;
  $('#btn-stop').disabled = st !== 'running';
  if (st === 'idle' || st === 'error') stopSpinners();
}
async function newSession() {
  if (newSessionPromise) return newSessionPromise;
  const button = $('#btn-new'); button.disabled = true; button.textContent = 'Starting…';
  return (newSessionPromise = (async () => {
    const cwd = $('#cwd').value.trim();
    if (!cwd) { showStatus('Pick a project folder first.', $('#new-status')); $('#cwd').focus(); return; }
    localStorage.setItem('cwd', cwd);
    const sel = pickerValue('new-');
    localStorage.setItem('conductorSel', JSON.stringify(sel));
    let s;
    try { s = await api.post('/api/sessions', { cwd, provider: sel.provider, model: sel.model || 'default', effort: sel.effort, permissionMode: $('#new-bypass').checked ? 'bypassPermissions' : 'acceptEdits', overflowApi: $('#new-overflow').checked, parallelOverride: !!$('#new-parallel')?.checked }); }
    catch (e) { showStatus(e.message, $('#new-status')); return; }
    const curCd = S.config?.conductor || {};
    const modelOrNull = sel.model || null;
    if (sel.provider !== curCd.provider || modelOrNull !== (curCd.model || null) || sel.effort !== (curCd.effort || 'high')) {
      api.post('/api/settings', { conductor: { provider: sel.provider, model: modelOrNull, effort: sel.effort } }).catch(() => {});
    }
    toggleNewChat(false); // collapse the inline form once the chat is created
    upsertSession(s); renderSessions(); await openSession(s.id);
  })().finally(() => { newSessionPromise = null; button.disabled = false; button.textContent = 'Start chat'; }));
}
function toggleNewChat(show = $('#newchat-form').hidden) {
  $('#newchat-form').hidden = !show;
  $('#btn-newchat-toggle').ariaExpanded = String(show);
  $('#btn-newchat-toggle').textContent = show ? '− New chat' : '+ New chat';
  if (show) $('#cwd').focus();
}
function upsertSession(s) {
  S.sessions = [...S.sessions.filter((x) => x.id !== s.id), s].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
async function refreshSessions() { S.sessions = await api.get('/api/sessions'); renderSessions(); }
// Slash commands that send straight to a worker (zero conductor tokens). The send() matcher is built from this table (one source of truth).
const COMMANDS = [
  { cmd: 'worker', args: '<spec>', help: 'Default worker (no conductor tokens)' },
  { cmd: 'astra', args: '<spec>', help: 'Astra — Codex worker' },
  { cmd: 'codex', args: '<spec>', help: 'Codex worker' },
  { cmd: 'claude', args: '<model> <spec>', help: 'Claude worker' },
];
const DIRECT_RE = new RegExp(`^\\/(${COMMANDS.map((c) => c.cmd).join('|')})(?:\\s+(\\S+))?\\s+([\\s\\S]+)$`);
async function send() {
  const ta = $('#input'); const text = ta.value.trim(); if (!text) return;
  ta.value = ''; ta.style.height = '';
  if (!S.current) {
    try { await newSession(); } catch {}
    if (!S.current) { if (!ta.value) ta.value = text; return; }
  }
  // "/worker <spec>" (or "/astra") sends straight to a worker: zero conductor tokens.
  const direct = text.match(DIRECT_RE);
  if (direct) {
    const [, kind, arg, spec] = direct;
    let provider = kind === 'worker' ? undefined : kind === 'astra' ? 'codex' : kind;
    let model = kind === 'claude' && (['default', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'sonnetplan'].includes(arg) || S.models.models.some((m) => m.provider === 'claude' && (m.id === arg || m.resolved === arg || m.aliasOf?.includes(arg)))) ? arg : undefined;
    if (kind === 'worker' && arg) { const m = S.models.models.find((x) => x.id === arg || x.resolved === arg); if (m) { provider = m.provider; model = m.id; } } // /worker <model> targets it; otherwise arg is prepended to the spec (below)
    const body = { sessionId: S.current.id, cwd: S.current.cwd, spec: model ? spec : (arg ? `${arg} ${spec}` : spec), provider, model };
    try { const t = await api.post('/api/tasks', body); addUser(text); addSys(`worker task ${t.id} queued (${t.provider}${t.model ? '/' + t.model : ''})`); }
    catch (e) { if (!ta.value) ta.value = text; addSys(`task failed: ${e.message}`, 'err'); }
    return;
  }
  try { await api.post(`/api/sessions/${S.current.id}/messages`, { text }); }
  catch (e) { if (!ta.value) ta.value = text; addSys(`send failed: ${e.message}`, 'err'); }
}
function cmdMenuOpen() { return !$('#cmd-menu').hidden; }
function closeCmdMenu() { const m = $('#cmd-menu'); if (!m) return; m.hidden = true; m.innerHTML = ''; S.cmdItems = []; S.cmdSel = 0; }
/** Items for the current query: matching COMMANDS, then matching registry agent models as `/worker <id>`. */
function cmdItemsFor(query) {
  const q = query.toLowerCase(); const items = [];
  for (const c of COMMANDS) if (!q || c.cmd.startsWith(q)) items.push({ label: `/${c.cmd} ${c.args}`, help: c.help, insert: `/${c.cmd} ` });
  if (q) for (const m of S.models.models) if (m.kind === 'agent' && (m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q))) items.push({ label: `/worker ${m.id}`, help: m.provider, insert: `/worker ${m.id} ` });
  return items;
}
/** Open only when the whole composer is a single leading `/token` (no space yet); otherwise close. */
function updateCmdMenu() {
  const ta = $('#input'); const v = ta.value;
  if (!/^\/[^\s]*$/.test(v)) return closeCmdMenu();
  const items = cmdItemsFor(v.slice(1));
  if (!items.length) return closeCmdMenu();
  S.cmdItems = items; S.cmdSel = Math.min(S.cmdSel || 0, items.length - 1);
  const box = $('#cmd-menu'); box.innerHTML = '';
  items.forEach((it, i) => {
    const row = el('div', 'cmd-item' + (i === S.cmdSel ? ' on' : ''));
    row.append(el('span', 'c', it.label)); if (it.help) row.append(el('span', 'h', it.help));
    row.onmousedown = (e) => { e.preventDefault(); S.cmdSel = i; pickCmd(); }; // mousedown fires before the textarea blur, so focus is kept
    box.append(row);
  });
  box.hidden = false;
}
function moveCmd(d) { const n = S.cmdItems.length; if (!n) return; S.cmdSel = (S.cmdSel + d + n) % n; const box = $('#cmd-menu'); [...box.children].forEach((c, i) => c.classList.toggle('on', i === S.cmdSel)); box.children[S.cmdSel]?.scrollIntoView({ block: 'nearest' }); }
function pickCmd() { const it = S.cmdItems[S.cmdSel]; if (!it) return; const ta = $('#input'); ta.value = it.insert; closeCmdMenu(); ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }

function onSessionEvent(ev) {
  if (ev.kind === 'created' || ev.kind === 'deleted' || ev.kind === 'updated') {
    if (ev.kind === 'deleted') S.sessions = S.sessions.filter((s) => s.id !== ev.sessionId);
    else upsertSession(ev.session);
    renderSessions();
    if (ev.kind === 'deleted' && S.current?.id === ev.sessionId) clearCurrent();
    if (ev.kind === 'updated' && S.current?.id === ev.sessionId) {
      S.current = { ...S.current, ...ev.session };
      refreshHeaderPicker();
      renderChip();
      renderBudget();
      $('#chat-title').textContent = S.current.title || 'New chat';
      $('#chat-cwd').textContent = S.current.cwd;
      if ($('#bypass')) $('#bypass').checked = S.current.permissionMode === 'bypassPermissions';
      if ($('#overflow')) $('#overflow').checked = !!S.current.overflowApi;
      if ($('#parallel')) $('#parallel').checked = !!S.current.parallelOverride;
    }
    return;
  }
  if (ev.kind === 'status') { const s = S.sessions.find((x) => x.id === ev.sessionId); if (s) { s.status = ev.status; renderSessions(); } }
  if (S.opening && ev.sessionId === S.opening.id) { S.bufferedEvents?.push(ev); return; }
  if (ev.sessionId !== S.current?.id) return;
  switch (ev.kind) {
    case 'user': addUser(ev.text); $('#chat-title').textContent = S.current.title = (S.current.title === 'New chat' ? ev.text.slice(0, 60) : S.current.title); break;
    case 'queued':
      S.current.queue = [...(S.current.queue || []), { id: ev.id, text: ev.text }];
      addUser(ev.text, null, { id: ev.id });
      break;
    case 'dequeued':
      S.current.queue = (S.current.queue || []).filter((q) => !ev.ids.includes(q.id));
      for (const id of ev.ids) dropQueueTag(id);
      break;
    case 'queue_removed':
      S.current.queue = (S.current.queue || []).filter((q) => !ev.ids.includes(q.id));
      for (const id of ev.ids) removeQueuedBubble(id);
      break;
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

export { renderSessions, openSession, clearCurrent, setStatus, newSession, toggleNewChat, refreshSessions, send, cmdMenuOpen, closeCmdMenu, updateCmdMenu, moveCmd, pickCmd, onSessionEvent, updateTask };
