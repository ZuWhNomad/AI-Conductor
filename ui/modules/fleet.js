import { $, el, api, S, act, asBtn, openModal, closeModal } from './core.js';
import { md } from './markdown.js';

// ---------- fleet dock ----------
const FLEET_CAP = 30;
// scope: 'all' when no chat is open, else the remembered choice (default 'mine' = this chat only). sessionless tasks (CLI/API) always show.
function fleetScope() { return S.current ? (localStorage.getItem('fleetScope') || 'mine') : 'all'; }
function inFleet(t) { return fleetScope() === 'all' || t.sessionId === S.current?.id || t.sessionId == null; }
function terminalTask(t) { return ['done', 'failed', 'canceled'].includes(t?.status); }
function myTasks() { return S.tasks.filter(inFleet).sort((a, b) => Number(terminalTask(a)) - Number(terminalTask(b))); }
function renderTasks() {
  const box = $('#tasks'); box.innerHTML = ''; S.taskEls.clear();
  for (const t of myTasks().slice(0, FLEET_CAP)) box.append(taskCard(t));
  renderFleetHead();
}
function since(iso) { if (!iso) return ''; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; }
function isToday(iso) { if (!iso) return false; return new Date(iso).toDateString() === new Date().toDateString(); }
function statusPhrase(t) {
  if (t.status === 'running') return `running ${since(t.startedAt)}`;
  if (t.status === 'parked') return `parked until ${t.resumeAt ? new Date(t.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?'}`;
  return t.status;
}
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
function refreshRunningCards() {
  for (const t of S.tasks) {
    if (t.status !== 'running') continue;
    const card = S.taskEls.get(t.id);
    if (!card) continue;
    const sub = card.querySelector('.sub');
    if (sub) sub.textContent = `${t.provider}${t.model ? '/' + t.model : ''} · ${t.category || '?'}${t.difficulty ? '@' + t.difficulty : ''} · ${statusPhrase(t)}`;
  }
}
function taskCard(t) {
  const c = el('div', 'task ' + t.status); c.dataset.id = t.id;
  const h = el('div', 'h');
  const right = t.status === 'running' ? (t.watchdog?.checkedAt ? el('span', `pill ${t.watchdog.verdict || 'running'}`, t.watchdog.verdict || 'running') : el('span', 'dot')) : el('span', 'pill', t.status);
  if (t.watchdog?.summary) right.title = t.watchdog.summary;
  h.append(el('span', 't', t.title), right);
  const sub = el('div', 'sub', `${t.provider}${t.model ? '/' + t.model : ''} · ${t.category || '?'}${t.difficulty ? '@' + t.difficulty : ''} · ${statusPhrase(t)}`);
  c.append(h, sub);
  const la = lastAction(t);
  if (la) c.append(el('div', 'last', la));
  if (t.status === 'running') { const p = el('div', 'prog indet'); p.append(el('i')); c.append(p); }
  const foot = cardFoot(t);
  if (foot) c.append(el('div', 'sub', foot));
  if (t.status === 'stale') {
    const actions = el('div', 'row');
    const rerun = el('button', 'sm', 'Re-run');
    rerun.onclick = (e) => { e.stopPropagation(); act(() => api.post(`/api/tasks/${t.id}/rerun`)); };
    rerun.onkeydown = (e) => e.stopPropagation();
    const discard = el('button', 'sm danger', 'Discard');
    discard.onclick = (e) => { e.stopPropagation(); act(() => api.post(`/api/tasks/${t.id}/cancel`)); };
    discard.onkeydown = (e) => e.stopPropagation();
    actions.append(rerun, discard); c.append(actions);
  }
  asBtn(c, () => act(() => openTask(t.id)));
  S.taskEls.set(t.id, c);
  return c;
}
function renderFleetHead() {
  const mine = myTasks();
  const running = mine.filter((t) => t.status === 'running').length;
  const queued = mine.filter((t) => t.status === 'queued').length;
  const parked = mine.filter((t) => t.status === 'parked').length;
  const stale = mine.filter((t) => t.status === 'stale').length;
  const doneToday = mine.filter((t) => t.status === 'done' && isToday(t.finishedAt || t.updatedAt)).length;
  $('#fleet-counts').textContent = mine.length ? `${running} running · ${queued} queued · ${parked} parked · ${stale} stale · ${doneToday} done today` : 'no workers yet';
  const scope = fleetScope();
  for (const b of $('#fleet-scope').querySelectorAll('button')) {
    b.disabled = b.dataset.scope === 'mine' && !S.current;
    b.title = b.disabled ? 'Select a chat to show its workers' : '';
    const on = b.dataset.scope === scope;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
function lastAction(t) {
  const log = S.workerLog.get(t.id);
  if (log?.length) {
    const i = log[log.length - 1];
    const inp = i.input != null ? (typeof i.input === 'string' ? i.input : JSON.stringify(i.input)) : '';
    return i.command ? `$ ${i.command}` : i.name ? `${i.name} ${inp}` : i.text ? i.text : i.type;
  }
  if (t.error) return t.error;
  return t.result?.finalMessage ? t.result.finalMessage.slice(0, 120) : t.specPreview || '';
}
async function openTask(id) {
  const t = await api.get(`/api/tasks/${id}`);
  const log = S.workerLog.get(id) || [];
  const body = el('div');
  body.append(el('div', 'muted', `${t.provider}${t.model ? '/' + t.model : ''} · ${t.status}${t.threadId ? ' · thread ' + t.threadId : ''}${t.error ? ' · ' + t.error : ''}`));
  body.append(el('h4', null, 'Spec')); body.append(el('pre', null, t.spec || ''));
  if (t.changedFiles?.length) { body.append(el('h4', null, 'Changed files')); body.append(el('pre', null, t.changedFiles.join('\n') + (t.diffStat ? '\n\n' + t.diffStat : ''))); }
  body.append(el('h4', null, 'Actions'));
  const items = t.result?.items?.length ? t.result.items : log;
  body.append(el('pre', null, items.map((i) => {
    if (i.command) return `$ ${i.command}\n${(i.output || '').slice(0, 400)}`;
    if (i.name) {
      const inp = i.input != null ? (typeof i.input === 'string' ? i.input : JSON.stringify(i.input)) : '';
      return `→ ${i.name} ${inp.slice(0, 400)}`;
    }
    return i.text ? i.text : i.type;
  }).join('\n') || '(none yet)'));
  if (t.result?.finalMessage) { body.append(el('h4', null, 'Worker report')); const r = el('div', 'msg assistant'); r.innerHTML = md(t.result.finalMessage); body.append(r); }
  const row = el('div', 'row');
  const refresh = el('button', 'sm', 'Refresh'); refresh.onclick = () => act(() => openTask(id));
  row.append(el('span', 'tiny muted', 'Snapshot · refresh for latest status and actions'), refresh);
  if (!['done', 'failed', 'canceled'].includes(t.status)) { const b = el('button', 'sm danger', 'Cancel task'); b.onclick = () => act(async () => { await api.post(`/api/tasks/${id}/cancel`); closeModal(); }); row.append(b); }
  body.append(row);
  openModal(`Task ${t.id}: ${t.title}`, body);
}

export { renderTasks, taskCard, renderFleetHead, terminalTask, refreshRunningCards, lastAction };
