import { sessionFlags } from '../../core/session-flags.mjs';
import { listTasks, getTask, publicTask, createTask, cancelChain, rerunTask, schedule } from '../../core/tasks.mjs';
import { json, readBody } from './_http.mjs';

export async function handle(ctx) {
  const { req, res, url, m, seg } = ctx;
  if (seg[1] !== 'tasks') return false;
  if (m === 'GET' && !seg[2]) return json(res, 200, listTasks({ sessionId: url.searchParams.get('session') || null }));
  if (m === 'POST' && !seg[2]) { // direct-to-worker (no conductor tokens): the UI's "/worker …" shortcut
    const b = await readBody(req);
    if ((!b.followUpOf && (typeof b.cwd !== 'string' || !b.cwd)) || typeof b.spec !== 'string' || !b.spec) return json(res, 400, { error: 'spec must be a nonempty string; cwd is required for new tasks' });
    const flags = sessionFlags(b.sessionId || null);
    return json(res, 200, publicTask(createTask({ sessionId: b.sessionId || null, cwd: b.cwd, title: b.title || String(b.spec).slice(0, 50), spec: b.spec, provider: b.provider, model: b.model, effort: b.effort, paths: b.paths, followUpOf: b.followUpOf, sandbox: b.sandbox, isolate: b.isolate, category: b.category, difficulty: b.difficulty, variant: b.variant, noFailover: b.noFailover, avoidFamilies: b.avoidFamilies, parallelOverride: b.parallelOverride == null ? !!flags.parallelOverride : !!b.parallelOverride, overflowApi: b.overflowApi == null ? !!flags.overflowApi : !!b.overflowApi })));
  }
  if (m === 'GET' && seg[2] && !seg[3]) { const t = getTask(seg[2]); return t ? json(res, 200, { ...publicTask(t), spec: t.spec }) : json(res, 404, { error: 'not found' }); }
  if (m === 'POST' && seg[3] === 'rerun') {
    const t = getTask(seg[2]);
    if (!t) return json(res, 404, { error: 'unknown task' });
    if (t.status !== 'stale') return json(res, 409, { error: 'task is not stale' });
    const rerun = rerunTask(t.id);
    if (!rerun) return json(res, 409, { error: 'task is not stale' });
    schedule();
    return json(res, 200, { ok: true, task: publicTask(rerun) });
  }
  if (m === 'POST' && seg[3] === 'cancel') { const r = cancelChain(seg[2]); return r ? json(res, 200, { ok: r.canceled.length > 0, canceled: r.canceled, already: r.already }) : json(res, 404, { error: 'unknown task' }); }
  return false;
}
