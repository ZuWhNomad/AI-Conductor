import { REPO_ROOT } from '../../core/paths.ts';
import { listImprovements, logImprovement, resolveImprovement, buildReviewPrompt } from '../../core/improve.mjs';
import * as conductor from '../../core/conductor.mjs';
import { json, readBody } from './_http.mjs';

export async function handle(ctx) {
  const { req, res, url, m, p, seg } = ctx;
  if (seg[1] === 'improvements') {
    if (m === 'GET') return json(res, 200, listImprovements({ includeResolved: url.searchParams.get('all') === '1' }));
    if (m === 'POST' && !seg[2]) { const b = await readBody(req); return json(res, 200, logImprovement(b.kind || 'idea', 'ui', b.message || '', b.context || {})); }
    if (m === 'POST' && seg[3] === 'resolve') { resolveImprovement(seg[2]); return json(res, 200, { ok: true }); }
    return false;
  }
  if (p === '/api/review' && m === 'POST') {
    const b = await readBody(req);
    const s = conductor.createSession({ cwd: REPO_ROOT, model: b.model || null, title: 'Self-review' });
    await conductor.sendMessage(s.id, buildReviewPrompt());
    return json(res, 200, s);
  }
  return false;
}
