import { homedir } from 'node:os';
import { REPO_ROOT } from '../../core/paths.ts';
import { publicConfig } from '../../core/config.mjs';
import { bus } from '../../core/bus.ts';
import { getModels } from '../../core/models.mjs';
import { limitsWithEstimates } from '../../core/usage-estimate.mjs';
import { providerSummaries } from '../../core/providers/index.mjs';
import { listTasks, openTasks, taskSummary } from '../../core/tasks.mjs';
import { listImprovements } from '../../core/improve.mjs';
import * as conductor from '../../core/conductor.mjs';
import { lastUpdateStatus } from '../../core/update.mjs';
import { cliUpdateStatus } from '../../core/cli-update.mjs';
import { resourceStatus } from '../../core/resources.mjs';
import { json } from './_http.mjs';

export async function handle(ctx) {
  const { res, m, p } = ctx;
  if (!(m === 'GET' && p === '/api/state')) return false;
  const resources = resourceStatus();
  const imps = listImprovements();
  const open = openTasks();
  const active = open.map(taskSummary);
  const activeIds = new Set(active.map((t) => t.id));
  const visible = new Map(active.map((t) => [t.id, t]));
  for (const t of listTasks({ limit: Infinity })) if (t.status === 'stale') visible.set(t.id, t);
  for (const t of listTasks({ limit: 50 })) if (!activeIds.has(t.id)) visible.set(t.id, t);
  const tasks = [...visible.values()];
  return json(res, 200, { version: ctx.version, boot: ctx.boot, pid: process.pid, seq: bus.seq, config: publicConfig(), providers: providerSummaries(), models: getModels(), limits: limitsWithEstimates(), resources, sessions: conductor.listSessions(), tasks, improvements: imps.slice(-50), improvementCount: imps.length, update: lastUpdateStatus(), cliUpdates: cliUpdateStatus(), home: homedir(), repoRoot: REPO_ROOT });
}
