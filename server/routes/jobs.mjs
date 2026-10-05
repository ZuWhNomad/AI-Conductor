import { jobStatus, startJob, cancelJob, listJobs } from '../../core/jobs.mjs';
import { json, readBody } from './_http.mjs';

// Unmatched jobs paths return false so index falls through to static files, same as the old route().
export async function handle(ctx) {
  const { req, res, url, m, seg } = ctx;
  if (seg[1] !== 'jobs') return false;
  if (m === 'GET' && !seg[2]) return json(res, 200, listJobs());
  if (m === 'POST' && !seg[2]) { const b = await readBody(req); return json(res, 200, startJob({ command: b.command, cwd: b.cwd, gpu: b.gpu })); }
  const j = m === 'POST' && seg[3] === 'cancel' ? cancelJob(seg[2]) : m === 'GET' && !seg[3] ? jobStatus(seg[2], { tailChars: Number(url.searchParams.get('tail')) || 4000 }) : undefined;
  if (j === undefined) return false;
  return j ? json(res, 200, j) : json(res, 404, { error: `unknown job ${seg[2]}` });
}
