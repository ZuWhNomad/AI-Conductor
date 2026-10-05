// Shared by every conductor tool group: selection identity, the task-wait registry, escalation math,
// and the model / limit formatters. Imports nothing else in this folder.
import { getModels } from '../models.mjs';
import { getLimits } from '../limits.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { DEFAULTS } from '../config.mjs';
import { selOf } from '../scorecard.mjs';
import { resourceStatus, resourceLine } from '../resources.mjs';

export { selOf };

export const taskWaits = new Map(); // sessionId -> task ids currently blocking a conductor tool call

export function waitingTasks(sessionId) { return [...(taskWaits.get(sessionId) || [])]; }

const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString() : '?');

export const resumeAt = (t) => t?.resumeAt ? new Date(t.resumeAt).toISOString() : '?';

/**
 * Where a retry_of sits on the review→escalation ladder (pure, so it is unit-tested). `depth` is the number of
 * attempts already in the retry chain (the chain root — the original worker — is #1, not a retry). Escalation begins
 * once the reviewed worker's rounds are spent, or after a prior model switch (depth ≥ 2). `escalationsUsed` counts
 * only prior BEST-AVAILABLE attempts: when the root was not reviewed to exhaustion the first retry was a value
 * fallback and is not counted, so `escalationRounds` grants that many genuine escalations (not one fewer).
 */
export function escalationState({ hasFailed = false, depth = 0, rootRounds = 0, failedRounds = 0, maxRounds = DEFAULTS.worker.maxRounds, escRounds = DEFAULTS.worker.escalationRounds } = {}) {
  const reviewExhausted = hasFailed && failedRounds >= maxRounds;
  const escalate = hasFailed && (reviewExhausted || depth >= 2);
  const rootReviewed = rootRounds >= maxRounds;
  const retries = hasFailed ? Math.max(0, depth - 1) : 0;
  const escalationsUsed = rootReviewed ? retries : Math.max(0, retries - 1);
  return { escalate, escalationsUsed, blocked: escalate && escalationsUsed >= escRounds, remaining: escRounds - (escalationsUsed + 1) };
}

/**
 * "Escalate, or stay at the ceiling." A retry_of excludes every selection already tried, so when the failed worker
 * IS the best available for this category@difficulty the auto-pick can only route DOWNWARD — which is a demotion
 * wearing an escalation's clothes. Detect that and keep iterating on the ceiling model instead. Effort is part of
 * the selection, so moving the same model to a higher effort still counts as a real escalation. Pure, so it is
 * unit-tested; `top` is recommend()'s best-available pick with nothing excluded.
 */
export function atCeiling(top, failed) {
  return !!(top && failed && selOf(top) === selOf(failed));
}

export function formatModels(reg = getModels()) {
  const byProv = new Map();
  for (const m of reg.models) { if (!byProv.has(m.provider)) byProv.set(m.provider, []); byProv.get(m.provider).push(m); }
  const lines = [`Model registry (updated ${reg.updatedAt || 'never'}):`];
  for (const p of Object.values(PROVIDERS)) {
    const st = reg.providers[p.id] || {};
    const ms = byProv.get(p.id) || [];
    const why = st.status === 'ok' ? '' : ` — ${st.error || (st.loggedIn === false ? 'not logged in' : st.configured === false ? 'no API key' : st.installed === false ? 'not installed' : st.status || 'unknown')}`;
    lines.push(`- ${p.id} (${p.auth.type}${st.plan ? `, plan ${st.plan}` : ''}, ${st.status || 'unpolled'}${why}): ${ms.length ? ms.map((m) => `${m.id}${m.resolved && m.resolved !== m.id ? `→${m.resolved}` : ''}${m.isDefault ? '*' : ''}${m.efforts?.length ? ` [${m.efforts.join('/')}]` : ''}`).join('; ') : '(no models)'}`);
  }
  return lines.join('\n');
}

export function formatLimits(reg = getLimits()) {
  const lines = [`Limits (updated ${reg.updatedAt || 'never'}):`];
  for (const [id, p] of Object.entries(reg.providers)) {
    const w = (p.windows || []).map((x) => `${x.label} ${x.usedPercent ?? '?'}%${x.remaining ? ` (${x.remaining})` : ''}${x.resetsAt ? (x.resetsAt > Date.now() ? ` (resets ${fmtWhen(x.resetsAt)})` : ` (reset ${fmtWhen(x.resetsAt)} has passed; not re-polled yet)`) : ''}`).join(', ');
    const bal = p.balance ? `balance ${p.balance.amount} ${p.balance.currency}${p.balance.granted > 0 ? ` (${p.balance.granted} granted/free)` : ''}${p.balance.available ? '' : ' (exhausted)'}` : '';
    lines.push(`- ${id}${p.plan ? ` (plan ${p.plan})` : ''}${p.blocked ? ` BLOCKED until ${fmtWhen(p.blockedUntil)} (${p.blockedReason || 'limit'})` : ''}: ${[bal, w].filter(Boolean).join(', ') || (p.available === false ? 'no plan limits available (not logged in?)' : p.error ? `error: ${p.error}` : 'no windows reported')}${w && p.error ? ` (stale: ${p.error.slice(0, 80)})` : ''}`);
  }
  lines.push(resourceLine(resourceStatus()));
  return lines.join('\n');
}
