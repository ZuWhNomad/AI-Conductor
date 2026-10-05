import { findModel } from '../../core/models.mjs';
import { bus } from '../../core/bus.mjs';
import * as conductor from '../../core/conductor.mjs';
import { EFFORTS, scorecardModelId, recordRun, rateTask } from '../../core/scorecard.mjs';
import { json, readBody } from './_http.mjs';

export async function handle(ctx) {
  const { req, res, m, seg } = ctx;
  if (seg[1] !== 'sessions') return false;
  if (m === 'GET' && !seg[2]) return json(res, 200, conductor.listSessions());
  if (m === 'POST' && !seg[2]) { const b = await readBody(req); return json(res, 200, conductor.createSession({ ...b, overflowApi: b.overflowApi == null ? null : !!b.overflowApi, parallelOverride: !!b.parallelOverride })); }
  const id = seg[2];
  if (m === 'GET' && !seg[3]) { const s = await conductor.getSession(id); return s ? json(res, 200, { ...s, seq: bus.seq }) : json(res, 404, { error: 'not found' }); }
  if (m === 'DELETE' && !seg[3]) return json(res, 200, { ok: conductor.deleteSession(id) });
  if (m === 'DELETE' && seg[3] === 'queue' && seg[4]) return json(res, 200, { ok: conductor.cancelQueuedMessage(id, seg[4]) });
  if (m === 'POST' && seg[3] === 'rate') {
    const session = conductor.listSessions().find((s) => s.id === id);
    if (!session) return json(res, 404, { error: 'not found' });
    const b = await readBody(req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json(res, 400, { error: 'body must be an object' });
    const verdicts = ['pass', 'close', 'fail', 'void'];
    const failKinds = ['timeout', 'limit', 'crash', 'lost', 'stuck'];
    const verdict = b.verdict;
    const level = b.level ?? 4;
    const rounds = b.rounds;
    const durationMs = b.durationMs;
    const provider = Object.hasOwn(b, 'provider') ? b.provider : session.provider;
    const model = Object.hasOwn(b, 'model') ? b.model : session.model;
    const effort = Object.hasOwn(b, 'effort') ? b.effort : session.effort;
    const notes = b.notes ?? '';
    if (!verdicts.includes(verdict)) return json(res, 400, { error: `verdict must be one of ${verdicts.join('|')}` });
    if (!Number.isInteger(level) || level < 1 || level > 5) return json(res, 400, { error: 'level must be 1-5' });
    if (!Number.isInteger(rounds) || rounds < 0) return json(res, 400, { error: 'rounds must be a nonnegative integer' });
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return json(res, 400, { error: 'durationMs must be a nonnegative number' });
    if (b.failKind !== undefined && !failKinds.includes(b.failKind)) return json(res, 400, { error: `failKind must be one of ${failKinds.join('|')}` });
    if (typeof notes !== 'string' || notes.length > 1000) return json(res, 400, { error: 'notes must be a string of at most 1000 characters' });
    const registeredModel = typeof provider === 'string' && typeof model === 'string' ? findModel(provider, scorecardModelId(model)) : null;
    if (!provider || !registeredModel || registeredModel.kind !== 'agent') {
      return json(res, 400, { error: 'provider/model must identify an agent model' });
    }
    if (effort != null && typeof effort !== 'string') return json(res, 400, { error: 'effort must be a string or null' });
    const taskId = `chat-${id}-${b.n ?? 1}`;
    const standIn = {
      id: taskId, provider, model, effort, category: 'conductor', difficulty: level, status: 'done', sessionId: id,
      source: 'live', title: null, rounds, result: { durationMs, usage: b.usage }, failKind: b.failKind,
    };
    const run = recordRun(standIn, { before: null });
    const rating = rateTask(taskId, verdict, notes);
    return json(res, 200, { ok: true, taskId, run, rating });
  }
  const b = m === 'POST' ? await readBody(req) : {};
  if (m === 'POST' && seg[3] === 'messages') return json(res, 200, await conductor.sendMessage(id, String(b.text || '')));
  if (m === 'POST' && seg[3] === 'interrupt') {
    return json(res, 200, await conductor.interrupt(id, undefined, { returnQueued: true }));
  }
  if (m === 'POST' && seg[3] === 'stop') return json(res, 200, { ok: conductor.stopSession(id) });
  if (m === 'POST' && seg[3] === 'permission') return json(res, 200, { ok: conductor.answerPermission(id, b.requestId, { allow: !!b.allow, message: b.message }) });
  if (m === 'POST' && seg[3] === 'title') return json(res, 200, conductor.setTitle(id, b.title));
  if (m === 'POST' && seg[3] === 'model') {
    if (b.model != null && typeof b.model !== 'string') return json(res, 400, { error: 'model must be a string' });
    await conductor.setModel(id, b.model || null); return json(res, 200, { ok: true });
  }
  if (m === 'POST' && seg[3] === 'effort') {
    const effort = b.effort || null;
    if (effort && !EFFORTS.includes(effort)) return json(res, 400, { error: `invalid effort (want ${EFFORTS.join('|')})` });
    conductor.setEffort(id, effort); return json(res, 200, { ok: true });
  }
  if (m === 'POST' && seg[3] === 'mode') {
    const MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
    if (!MODES.includes(b.permissionMode)) return json(res, 400, { error: `invalid permissionMode (want ${MODES.join('|')})` });
    await conductor.setPermissionMode(id, b.permissionMode); return json(res, 200, { ok: true });
  }
  if (m === 'POST' && seg[3] === 'overflow') { conductor.setOverflow(id, !!b.overflowApi); return json(res, 200, { ok: true }); }
  if (m === 'POST' && seg[3] === 'parallel') { conductor.setParallel(id, !!b.parallelOverride); return json(res, 200, { ok: true }); }
  return false;
}
