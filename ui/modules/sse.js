import { $, el, api, S, showStatus, act } from './core.js';
import { renderProviders } from './sidebar.js';
import { renderBudget } from './budget.js';
import { refreshNewPicker, refreshHeaderPicker } from './picker.js';
import { addSys } from './transcript.js';
import { renderTasks, lastAction } from './fleet.js';
import { renderUpdate, noteUpdate } from './update.js';
import { renderSessions, openSession, updateTask, onSessionEvent } from './sessions.js';

// ---------- SSE ----------
function applyState(st) {
  S.boot = st.boot; S.lastSeq = st.seq || 0;
  Object.assign(S, { sessions: st.sessions, models: st.models, limits: st.limits, tasks: st.tasks, improvements: st.improvements.filter((entry) => !entry.resolved), config: st.config, providers: st.providers, update: st.update, cliUpdates: st.cliUpdates });
  $('#improve-count').textContent = st.improvementCount ?? S.improvements.length;
}
async function resync() {
  const st = await api.get('/api/state');
  applyState(st); // state is fresh: do not replay events that predate it on top of it
  renderSessions(); renderProviders(); renderBudget(); renderTasks(); renderUpdate(); applyAutoRefresh();
  seedNewChatDefaults();
  if (S.current) await openSession(S.current.id);
}
/** Coalesce bursts (e.g. replayed events) into one refetch per key. */
const pendingRefetch = new Map();
function coalesce(key, fn, ms = 250) { clearTimeout(pendingRefetch.get(key)); pendingRefetch.set(key, setTimeout(() => { pendingRefetch.delete(key); fn().catch(() => resync().catch(() => {})); }, ms)); }
function applyAutoRefresh() {
  const on = !!S.config?.ui?.autoRefresh;
  const cb = $('#auto-refresh'); if (cb) cb.checked = on;
}
function seedNewChatDefaults() {
  if (!S.bypassTouched) { const cb = $('#new-bypass'); if (cb) cb.checked = S.config?.conductor?.permissionMode === 'bypassPermissions'; }
  if (!S.overflowTouched) { const cb = $('#new-overflow'); if (cb) cb.checked = !!S.config?.conductor?.overflowApi; }
}
function connect() {
  if (S.stopped) return;
  const es = new EventSource(`/api/events?since=${S.lastSeq}`);
  S.eventSource = es;
  // A restart or an evicted replay range requires fresh state (and its seq) before reconnecting.
  es.addEventListener('hello', (e) => {
    if (S.stopped) { es.close(); return; }
    const { boot, oldest } = JSON.parse(e.data);
    if (S.boot && boot !== S.boot) { S.updateState = null; S.updateLine = null; }
    if ((S.boot && boot !== S.boot) || (S.lastSeq && oldest > S.lastSeq + 1)) {
      S.boot = boot; es.close(); resync().catch(() => {}).then(() => setTimeout(connect, 500));
    } else S.boot = boot;
  });
  const on = (type, fn) => es.addEventListener(type, (e) => {
    if (S.stopped) return;
    const ev = JSON.parse(e.data);
    S.lastSeq = Math.max(S.lastSeq, ev.seq);
    fn(ev);
  });
  on('session', onSessionEvent);
  on('task', (ev) => updateTask(ev.task));
  on('worker', (ev) => {
    if (String(ev.taskId || '').startsWith('conductor:')) return;
    const log = S.workerLog.get(ev.taskId) || [];
    if (ev.item) { log.push(ev.item); if (log.length > 200) log.shift(); S.workerLog.set(ev.taskId, log); }
    if (ev.error) { log.push({ type: 'error', text: ev.error }); S.workerLog.set(ev.taskId, log); }
    const c = S.taskEls.get(ev.taskId);
    if (c) { const l = c.querySelector('.last'); if (l) l.textContent = lastAction({ id: ev.taskId }); }
  });
  on('watchdog', (ev) => {
    if (ev.itemKind === 'task') {
      const t = S.tasks.find((x) => x.id === ev.taskId);
      if (t) updateTask({ ...t, aliveAt: ev.aliveAt, watchdog: { verdict: ev.verdict, checkedAt: ev.checkedAt, lastEventAt: ev.lastEventAt, late: ev.late, summary: ev.summary } });
    } else if (ev.itemKind === 'session') {
      const s = S.sessions.find((x) => x.id === ev.sessionId);
      if (s) { s.watchdog = { verdict: ev.verdict, checkedAt: ev.checkedAt, lastEventAt: ev.lastEventAt, late: ev.late, summary: ev.summary }; renderSessions(); }
    }
    if (ev.sessionId === S.current?.id) addSys(`[watchdog] ${ev.itemKind === 'task' ? `Task ${ev.taskId}: ` : ''}${ev.summary}`, 'watchdog');
  });
  on('score', (ev) => { const s = S.scoreInfo.get(ev.taskId) || {}; if (ev.verdict) s.verdict = ev.verdict; if (ev.pct && typeof ev.pct === 'object') { const vals = Object.values(ev.pct); if (vals.length) s.pct = Math.round(Math.max(...vals) * 10) / 10; } S.scoreInfo.set(ev.taskId, s); const t = S.tasks.find((x) => x.id === ev.taskId); if (t) updateTask(t); });
  on('models', () => coalesce('models', async () => { S.models = await api.get('/api/models'); refreshNewPicker(true); refreshHeaderPicker(); renderProviders(); renderBudget(); }));
  on('limits', () => coalesce('limits', async () => { S.limits = await api.get('/api/limits'); renderProviders(); renderBudget(); }));
  on('cli-update', () => coalesce('cli-update', async () => { S.cliUpdates = await api.get('/api/cli-update'); renderProviders(); }));
  on('improvement', (ev) => {
    if (ev?.count != null) $('#improve-count').textContent = ev.count;
    coalesce('improvements', () => refreshImprovements());
  });
  on('model_pull', (ev) => {
    if (ev.error) showStatus(`pull ${ev.model}: ${ev.error}`);
    else showStatus(ev.status === 'done' ? `pulled ${ev.model}` : `pulling ${ev.model}: ${ev.status} ${ev.completed && ev.total ? Math.round(100 * ev.completed / ev.total) + '%' : ''}`);
  });
  on('plan', (ev) => {
    if (!S.current || ev.sessionId !== S.current.id) return;
    if (ev.kind === 'stage') addSys(`plan stage ${ev.stage}: starting ${ev.tasks} task${ev.tasks === 1 ? '' : 's'}${ev.round ? ` (round ${ev.round + 1})` : ''}`);
    else if (ev.kind === 'stage_done') addSys(`plan stage ${ev.stage}: finished (${ev.findings ?? 0} findings)`);
    else if (ev.kind === 'stage_incomplete') addSys(`plan stage ${ev.stage}: incomplete`, 'warn');
    else if (ev.kind === 'done' || ev.kind === 'incomplete') addSys(`plan ${ev.kind}`);
  });
  on('settings', () => coalesce('settings', async () => { S.config = await api.get('/api/settings'); renderProviders(); renderBudget(); applyAutoRefresh(); seedNewChatDefaults(); }));
  on('update', (ev) => { // remote ahead, an update was applied, a relaunch started, or a relaunch failed
    if (ev.behind) { S.update = { git: true, behind: ev.behind, head: ev.head }; renderUpdate(); return; }
    noteUpdate(ev); // updated / relaunching / relaunchFailed — merged into one line
  });
  es.onerror = () => { es.close(); if (!S.stopped) setTimeout(connect, 2000); };
}

async function refreshImprovements(view = S.improvementView) {
  const request = view ? ++view.request : 0;
  const showResolved = !!view?.showResolved;
  const open = (await api.get('/api/improvements')).filter((entry) => !entry.resolved);
  S.improvements = open;
  $('#improve-count').textContent = open.length;
  const all = showResolved ? await api.get('/api/improvements?all=1') : open;
  if (!view || S.improvementView !== view || request !== view.request || $('#modal').hidden || !view.body.isConnected) return;
  for (const { button, value } of view.tabs) button.className = value === showResolved ? 'primary sm' : 'sm';
  const shown = all.filter((entry) => showResolved ? entry.resolved : !entry.resolved);
  view.list.innerHTML = '';
  for (const e of [...shown].reverse()) {
    const d = el('div', 'imp'); d.append(el('div', 'k', `${e.kind} · ${e.source} · ${new Date(e.ts).toLocaleString()}${e.resolved ? ' · resolved' : ''}`), el('div', 'm', e.message));
    if (!e.resolved) { const r = el('button', 'sm', 'Resolve'); r.onclick = () => act(async () => { await api.post(`/api/improvements/${e.id}/resolve`); await refreshImprovements(view); }); d.append(r); }
    view.list.append(d);
  }
  if (!shown.length) view.list.append(el('div', 'muted', showResolved ? 'Nothing resolved yet.' : 'Nothing logged. Errors are captured automatically; the conductor and you can add ideas.'));
}

export { applyState, applyAutoRefresh, seedNewChatDefaults, connect, refreshImprovements };
