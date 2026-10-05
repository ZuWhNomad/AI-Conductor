import { $, el, S } from './core.js';
import { addSys } from './transcript.js';

// ---------- update affordance ----------
/** Show + flash the header Update button when this checkout is behind its GitHub remote (from S.update / an 'update' event). */
function renderUpdate(st = S.update) {
  const b = $('#btn-update'); if (!b) return;
  const behind = st && st.git && !st.error ? (st.behind || 0) : 0;
  if (behind > 0) { b.hidden = false; b.classList.add('flash'); b.innerHTML = ''; b.append(el('span', null, '⬇'), el('span', 'update-label', ` Update (${behind})`)); b.setAttribute('aria-label', `Update (${behind})`); b.title = `${behind} newer commit(s) on GitHub — click to pull and then restart`; }
  else { b.hidden = true; b.classList.remove('flash'); }
}
/** One source of truth for the four post-update states, from merged flags (updated/npmInstalled/npmError/relaunching/relaunchFailed). */
function updateMessage(o) {
  const v = `${o.from} → ${o.to}${o.npmInstalled ? ' (dependencies installed)' : ''}`;
  if (o.relaunchFailed) return { text: `Update applied, but the new version failed to start (${o.why}); still running the previous version. Fix it, then restart by hand.`, cls: 'err' };
  if (o.relaunching === 'when idle') return { text: `Updated ${v}. Conductor restarts to apply it as soon as the current work finishes.`, cls: '' };
  if (o.relaunching) return { text: `Updated ${v}. Restarting Conductor to apply — this tab reconnects automatically…`, cls: '' };
  if (o.npmError) return { text: `Updated ${o.from} → ${o.to}, but npm install failed (${o.npmError}): run "npm install" in the Conductor folder, then restart.`, cls: 'warn' };
  if (o.updated) return { text: `Updated ${v}. Restart Conductor to run the new version.`, cls: '' };
  return null;
}
/** Merge each update signal (they arrive as up to two separate events/responses) and render into ONE reused line, so the
 *  applied→relaunching sequence never leaves a contradictory message and arrival order does not matter. */
function noteUpdate(o) {
  if (o.to && S.updateState?.to && o.to !== S.updateState.to) S.updateState = null;
  S.updateState = { ...(S.updateState || {}), ...o };
  if (S.updateState.updated || S.updateState.relaunching) { S.update = null; const b = $('#btn-update'); if (b) { b.hidden = true; b.classList.remove('flash'); } }
  const m = updateMessage(S.updateState); if (!m) return;
  if (S.updateLine && S.updateLine.isConnected) { S.updateLine.className = 'sysline ' + m.cls; S.updateLine.textContent = m.text; }
  else S.updateLine = addSys(m.text, m.cls);
}

export { renderUpdate, noteUpdate };
