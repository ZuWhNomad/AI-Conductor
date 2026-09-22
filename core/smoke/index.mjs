// Smoke runner: runs the battery against one or more provider:model:effort selections, one task at
// a time (so limit deltas are attributable), rates each run from its check, and returns the results.
// Rows land in the scorecard like any other task (source: 'smoke').
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BATTERY } from './battery.mjs';
import { createTask, awaitTask, cancelTask, getTask, flushRecords } from '../tasks.mjs';
import { rateTask, voidTask } from '../scorecard.mjs';
import { providerAvailable } from '../scorecard.mjs';
import { loadConfig } from '../config.mjs';
import { bus } from '../bus.mjs';

export const SMOKE_TASKS = BATTERY.map(({ id, category, difficulty, title }) => ({ id, category, difficulty, title }));

/**
 * @param {object} o { models: [{provider, model, effort}], tasks?: string[] (battery ids), timeoutMinutes?, sessionId?, keep?, execute?, onResult? }
 * `execute(spec, timeoutMinutes)` runs one task and returns the finished task; tests inject a stub.
 */
export async function runSmoke({ models, tasks = null, timeoutMinutes = loadConfig().smoke.timeoutMinutes, sessionId = 'smoke', keep = false, execute = executeTask, onResult = null, agentsMd = null, variant = null } = {}) {
  if (!Array.isArray(models) || !models.length) throw Object.assign(new Error('models must be a non-empty array of {provider, model, effort}'), { status: 400 });
  const battery = BATTERY.filter((b) => !tasks || tasks.includes(b.id));
  if (!battery.length) throw Object.assign(new Error(`no matching smoke tasks (have: ${BATTERY.map((b) => b.id).join(', ')})`), { status: 400 });
  const results = [];
  for (const sel of models) {
    for (const b of battery) {
      const base = { provider: sel.provider, model: sel.model || null, effort: sel.effort || null, task: b.id, category: b.category, difficulty: b.difficulty };
      if (!providerAvailable(sel.provider, { overflowApi: true, model: sel.model })) { push({ ...base, verdict: 'skipped', notes: 'provider at its usage limit' }); continue; }
      // Long path: Windows may hand out an 8.3 short TEMP (C:\Users\LONGNA~1\...), which the Codex sandbox denies.
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `conductor-smoke-${b.id}-`)));
      let res;
      try {
        b.setup(dir);
        if (agentsMd) writeFileSync(join(dir, 'AGENTS.md'), agentsMd); // A/B a policy file (Codex and Claude both read AGENTS.md in cwd)
        const t = await execute({ cwd: dir, title: `smoke ${b.id}`, spec: b.spec, provider: sel.provider, model: sel.model, effort: sel.effort, category: b.category, difficulty: b.difficulty, sessionId, source: 'smoke', variant }, timeoutMinutes);
        const check = t.status === 'done' ? await b.check(dir, t) : { pass: false, notes: t.timedOut ? 'timeout' : t.error || t.status };
        if (t.status !== 'done' && (t.limitHit || t.failedOverTo || /usage limit|rate limit|quota|limit reached|at its limit/i.test(t.error || ''))) {
          // Provider limit mid-battery: not the model's fault, and the rest of this selection would only time out.
          // Timeouts of this selection immediately before the limit surfaced were the same quota stall (seen with Kimi and
          // Claude on the Google plan): void them so they do not read as model failures.
          for (let i = results.length - 1; i >= 0 && results[i].provider === sel.provider && results[i].model === base.model && results[i].effort === base.effort && results[i].notes === 'timeout'; i--) {
            if (results[i].taskId) voidTask(results[i].taskId, 'environment: provider limit (timeout immediately before the limit was detected)');
            results[i] = { ...results[i], verdict: 'error', notes: 'environment: provider limit (timeout before the limit was detected)' };
          }
          push({ ...base, taskId: t.id || null, status: t.status, verdict: 'skipped', notes: `provider limit: ${String(t.error).slice(0, 120)}` });
          try { if (!keep) rmSync(dir, { recursive: true, force: true }); } catch {}
          break;
        }
        if (!check.pass && envFailure(t)) {
          // The harness, not the model, failed (sandbox denied the workspace, network down, loop cap): void it now, since a
          // failed status would otherwise read as a model failure in the ledger.
          if (t.id) voidTask(t.id, `environment: ${envFailure(t)}`);
          res = { ...base, taskId: t.id || null, status: t.status, verdict: 'error', notes: `environment: ${envFailure(t)}`, durationMs: t.result?.durationMs || 0 };
        } else {
          if (t.id) rateTask(t.id, check.pass ? 'pass' : 'fail', check.notes);
          res = { ...base, taskId: t.id || null, status: t.status, verdict: check.pass ? 'pass' : 'fail', notes: String(check.notes || '').slice(0, 400), durationMs: t.result?.durationMs || 0 };
        }
      } catch (e) {
        res = { ...base, verdict: 'error', notes: String(e?.message || e).slice(0, 400) };
      } finally {
        if (!keep) try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      push(res);
    }
  }
  return results;

  function push(r) { results.push(r); bus.publish('smoke', r); onResult?.(r); }
}

const ENV_FAIL = /max iterations reached|UnauthorizedAccessException|access (?:was |is )?denied|permission denied|EACCES|EPERM|waiting for network|Connection failed|ECONNRESET|ENOTFOUND|fetch failed/i;
/** A workspace-access denial or network drop in the worker's own words (or its error) — the harness failed, not the model. */
export function envFailure(t) {
  const texts = [t.result?.finalMessage || '', t.error || '', ...(t.result?.items || []).map((i) => i.text || i.output || '')];
  const hit = texts.find((x) => ENV_FAIL.test(x));
  return hit ? hit.match(ENV_FAIL)[0] : null;
}

async function executeTask(spec, timeoutMinutes) {
  const t = createTask(spec);
  const r = await awaitTask(t.id, timeoutMinutes * 60_000);
  if (r?.timedOut) {
    cancelTask(t.id, 'timeout'); // OB6: reason so run() still scores this cancellation
    // cancelTask already marked the task terminal, so awaitTask would return immediately;
    // wait for run() to set finishedAt (and register score()) before flushing the ledger.
    if (getTask(t.id)?.attempts) {
      const end = Date.now() + 10_000;
      while (!getTask(t.id)?.finishedAt && Date.now() < end) await new Promise((ok) => setTimeout(ok, 25));
    }
  }
  await flushRecords();
  return { ...getTask(t.id), timedOut: !!r?.timedOut };
}

/** One line per result, for the CLI and the conductor tool. */
export function formatSmoke(results) {
  const sel = (r) => `${r.provider}:${r.model || 'default'}:${r.effort || 'default'}`;
  const lines = results.map((r) => `${r.verdict.padEnd(7)} ${sel(r).padEnd(36)} ${r.task.padEnd(12)}${r.durationMs ? ` ${Math.round(r.durationMs / 1000)}s` : ''}${r.notes ? `  ${r.notes.split('\n')[0].slice(0, 120)}` : ''}`);
  const byModel = new Map();
  for (const r of results) { const k = sel(r); const m = byModel.get(k) || { pass: 0, total: 0 }; m.total++; if (r.verdict === 'pass') m.pass++; byModel.set(k, m); }
  for (const [k, m] of byModel) lines.push(`${k}: ${m.pass}/${m.total} passed`);
  return lines.join('\n');
}
