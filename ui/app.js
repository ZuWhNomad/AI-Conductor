// ---------- boot ----------
import { createSTT, insertAtCaret } from './stt.js';
import { $, api, S, act, closeModal } from './modules/core.js';
import { esc } from './modules/markdown.js';
import { renderProviders } from './modules/sidebar.js';
import { renderBudget } from './modules/budget.js';
import { renderChip } from './modules/chip.js';
import { ALL, resolveOther, pickerValue, fillPicker, savedSelection, refreshNewPicker, refreshHeaderPicker } from './modules/picker.js';
import { addSys } from './modules/transcript.js';
import { renderTasks, refreshRunningCards } from './modules/fleet.js';
import { renderSessions, openSession, newSession, toggleNewChat, send, cmdMenuOpen, closeCmdMenu, updateCmdMenu, moveCmd, pickCmd } from './modules/sessions.js';
import { renderUpdate, noteUpdate } from './modules/update.js';
import { applyState, applyAutoRefresh, seedNewChatDefaults, connect } from './modules/sse.js';
import { quitServer, revealProviders, openSystem, openScores, toggleModelPop } from './modules/misc.js';
import { browse, openSettings, openImprovements, runReview } from './modules/modals.js';

async function boot() {
  const st = await api.get('/api/state');
  applyState(st); // the transcript is rendered from state; only newer events stream in
  $('#cwd').value = localStorage.getItem('cwd') || '';
  S.chatFilter = $('#chat-filter').value;
  refreshNewPicker(false); renderSessions(); renderProviders(); renderBudget(); renderTasks(); renderUpdate(); applyAutoRefresh(); seedNewChatDefaults(); renderChip();
  connect();
  const last = localStorage.getItem('lastSession');
  if (last && S.sessions.some((s) => s.id === last)) openSession(last).catch(() => {});
  setInterval(refreshRunningCards, 15000);

  $('#btn-new').onclick = () => act(newSession, null, $('#new-status'));
  $('#btn-browse').onclick = () => act(() => browse($('#cwd').value));
  $('#btn-send').onclick = send;
  $('#btn-stop').onclick = () => S.current && act(async () => {
    const input = $('#input');
    const r = await api.post(`/api/sessions/${S.current.id}/interrupt`);
    if (r.returned?.length) {
      input.value = [input.value, ...r.returned].filter(Boolean).join('\n\n');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  $('#btn-refresh').onclick = (e) => act(async () => { e.target.disabled = true; try { await Promise.all([api.post('/api/models/refresh'), api.post('/api/limits/refresh')]); } finally { e.target.disabled = false; } });
  $('#auto-refresh').onchange = (e) => act(async () => { S.config = await api.post('/api/settings', { ui: { autoRefresh: e.target.checked } }); applyAutoRefresh(); }, e.target);
  $('#btn-settings').onclick = openSettings;
  $('#btn-quit').onclick = (e) => quitServer(e.currentTarget);
  $('#btn-budget-details').onclick = () => revealProviders();
  if (localStorage.getItem('fleetCollapsed') === '1') document.body.classList.add('fleet-collapsed');
  $('#fleet-collapse').onclick = () => { const c = document.body.classList.toggle('fleet-collapsed'); localStorage.setItem('fleetCollapsed', c ? '1' : '0'); };
  $('#fleet-scope').onclick = (e) => { const b = e.target.closest('button[data-scope]'); if (!b || b.disabled) return; localStorage.setItem('fleetScope', b.dataset.scope); renderTasks(); };
  // new-chat: one button reveals the inline form; SYSTEM drawer folds admin away.
  $('#btn-newchat-toggle').onclick = () => toggleNewChat();
  $('#system-toggle').onclick = () => openSystem();
  $('#btn-scores').onclick = openScores;
  $('#btn-settings2').onclick = openSettings;
  $('#chat-filter').oninput = (e) => { S.chatFilter = e.target.value; renderSessions(); };
  $('#btn-nav').onclick = () => document.body.classList.toggle('nav-open');
  $('#scrim').onclick = () => document.body.classList.remove('nav-open');
  try { if (localStorage.getItem('systemOpen') === '1') openSystem(true); } catch {}
  if (!S.sessions.length) toggleNewChat(true); // first run: no chats yet, show the form
  // model chip popover: toggle on click, close on outside-click / Escape.
  $('#model-chip').onclick = (e) => { e.stopPropagation(); toggleModelPop(); };
  $('#model-pop').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => toggleModelPop(false));
  $('#btn-improvements').onclick = () => openImprovements();
  $('#btn-update').onclick = async () => { const b = $('#btn-update'); b.disabled = true; b.classList.remove('flash'); try { const r = await api.post('/api/update'); if (!r.updated) { b.hidden = true; S.update = null; addSys('Already up to date.'); } else noteUpdate(r); } catch (e) { addSys(`Update failed: ${e.message}`); b.classList.add('flash'); } b.disabled = false; };
  $('#btn-review').onclick = runReview;
  $('#modal-close').onclick = closeModal;
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  // Switching back to "all providers" must keep the last real selection (the bare model id in the select no longer carries its provider).
  $('#new-provider').onchange = (e) => { const v = e.target.value; fillPicker('new-', v === ALL ? savedSelection() : { ...savedSelection(), provider: v, model: '' }, { forceProvider: v !== ALL }); refreshNewPicker(true, v !== ALL); };
  $('#new-model').onchange = () => { if (resolveOther('new-', true) === false) return; refreshNewPicker(true, true); };
  $('#new-effort').onchange = () => refreshNewPicker(true, true);
  $('#model').onchange = (e) => {
    if (!S.current) return;
    if (resolveOther('', true) === false) return;
    const v = pickerValue('');
    act(async () => {
      await api.post(`/api/sessions/${S.current.id}/model`, { model: v.model || null });
      S.current.model = v.model || null;
      renderChip();
      refreshHeaderPicker();
    }, () => {
      refreshHeaderPicker(true);
    });
  };
  $('#effort').onchange = (e) => {
    if (!S.current) return;
    const prev = S.current.effort || 'high';
    act(async () => {
      await api.post(`/api/sessions/${S.current.id}/effort`, { effort: e.target.value });
      S.current.effort = e.target.value;
      renderChip();
    }, () => {
      e.target.value = prev;
    });
  };
  $('#new-bypass').onchange = () => { S.bypassTouched = true; };
  $('#new-overflow').onchange = () => { S.overflowTouched = true; };
  $('#overflow').onchange = (e) => S.current && act(() => api.post(`/api/sessions/${S.current.id}/overflow`, { overflowApi: e.target.checked }), e.target);
  $('#parallel').onchange = (e) => S.current && act(() => api.post(`/api/sessions/${S.current.id}/parallel`, { parallelOverride: e.target.checked }), e.target);
  $('#bypass').onchange = (e) => S.current && act(() => api.post(`/api/sessions/${S.current.id}/mode`, { permissionMode: e.target.checked ? 'bypassPermissions' : 'acceptEdits' }), e.target);
  $('#cwd').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); act(newSession, null, $('#new-status')); } };
  $('#cwd').onchange = (e) => localStorage.setItem('cwd', e.target.value.trim());
  const ta = $('#input');
  ta.addEventListener('keydown', (e) => {
    if (cmdMenuOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveCmd(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveCmd(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickCmd(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeCmdMenu(); }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px'; updateCmdMenu(); });
  ta.addEventListener('blur', () => setTimeout(closeCmdMenu, 120)); // clicking outside closes it; item mousedown keeps focus so a pick still lands

  // speech to text
  const stt = createSTT({
    onFinal: (t) => insertAtCaret(ta, t),
    onInterim: (t) => { const i = $('#interim'); i.hidden = !t; i.textContent = t; },
    onState: ({ active, error }) => { $('#btn-mic').classList.toggle('on', !!active); $('#stt-hint').textContent = error ? `mic: ${error}${error === 'not-allowed' ? ' — allow microphone access for this site' : ''}` : active ? 'listening… click the mic button or Ctrl+M to stop' : ''; },
  });
  if (!stt.supported) { $('#btn-mic').disabled = true; $('#stt-hint').textContent = 'Speech to text needs Chrome or Edge (Web Speech API).'; }
  $('#btn-mic').onclick = () => stt.toggle();
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'm') { e.preventDefault(); stt.toggle(); ta.focus(); } if (e.key === 'Escape') { if (!$('#model-pop').hidden) toggleModelPop(false); else if (!$('#modal').hidden) closeModal(); else if (document.body.classList.contains('nav-open')) document.body.classList.remove('nav-open'); else if (stt.active) stt.stop(); } });
}
boot().catch((e) => { document.body.innerHTML = `<pre style="padding:20px">Failed to load: ${esc(e.message)}</pre>`; });
