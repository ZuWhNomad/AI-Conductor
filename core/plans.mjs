// Deterministic multi-stage plans (fan-out, refuter votes, judge panels, until-dry loops, critic)
// executed on the task scheduler. Model-agnostic: every task carries whatever provider/model/effort
// the conductor chose (or nothing, for the auto-pick). Pure helpers are exported for tests.
import { createTask, awaitTask, getTask } from './tasks.mjs';
import { statePath, writeJson, nowIso, shortId } from './paths.mjs';
import { bus } from './bus.mjs';
import { accessProviders } from './capabilities.mjs';
import { existsSync } from 'node:fs';

const MAX_TASKS = 200;
const activePlans = new Set();

/** Validate and normalize a plan; throws on structural errors. */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.stages) || !plan.stages.length) throw new Error('plan needs a non-empty stages array');
  const ids = new Set();
  for (const [i, s] of plan.stages.entries()) {
    s.id = String(s.id || `stage${i + 1}`);
    if (ids.has(s.id)) throw new Error(`duplicate stage id ${s.id}`);
    ids.add(s.id);
    if (s.for_each && !ids.has(String(s.for_each).split('.')[0])) throw new Error(`stage ${s.id}: for_each refers to unknown earlier stage ${s.for_each}`);
    if (s.for_each && !s.task?.spec) throw new Error(`stage ${s.id}: for_each needs a task template with a spec`);
    if (!s.for_each && !(Array.isArray(s.tasks) && s.tasks.length)) throw new Error(`stage ${s.id}: needs tasks[] or for_each`);
    for (const t of s.tasks || []) if (!t.spec) throw new Error(`stage ${s.id}: every task needs a spec`);
    s.votes = Math.max(1, Math.min(7, Number(s.votes) || 1));
  }
  if (plan.until_dry && !ids.has(plan.until_dry.stage)) throw new Error('until_dry.stage must name a stage');
  return plan;
}

/** Last fenced ```json block (or a bare trailing object) in a worker report. */
export function extractJson(text) {
  if (!text) return null;
  const fences = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).reverse();
  for (const f of fences) { try { return JSON.parse(f); } catch {} }
  const i = text.lastIndexOf('{'); if (i >= 0) { try { return JSON.parse(text.slice(i)); } catch {} }
  return null;
}

/** Findings from a report: an explicit findings[] block, else the whole report as one item. */
export function findingsOf(report, taskId) {
  const j = extractJson(report);
  const arr = Array.isArray(j?.findings) ? j.findings : Array.isArray(j) ? j : null;
  if (arr) return arr.filter((f) => f && typeof f === 'object').map((f, i) => ({ ...f, id: f.id || `${taskId}-${i + 1}`, source: taskId }));
  return report?.trim() ? [{ id: `${taskId}-1`, title: report.trim().slice(0, 140), detail: report.trim(), source: taskId }] : [];
}

export const findingKey = (f) => `${String(f.file || f.location || '').toLowerCase().replace(/\\/g, '/')}|${String(f.title || f.detail || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60)}`;

/** Verdict from a refuter/judge report: {real:boolean} / {verdict:'real'|'refuted'} / {score}. */
export function parseVerdict(report) {
  const j = extractJson(report) || {};
  if (typeof j.real === 'boolean') return { real: j.real, reason: j.reason || '', score: j.score ?? null };
  if (typeof j.refuted === 'boolean') return { real: !j.refuted, reason: j.reason || '', score: j.score ?? null };
  if (typeof j.verdict === 'string') return { real: /^(real|confirmed|pass|accept)/i.test(j.verdict), reason: j.reason || '', score: j.score ?? null };
  if (typeof j.score === 'number') return { real: j.score >= (j.threshold ?? 5), reason: j.reason || '', score: j.score };
  const t = String(report || '');
  return { real: !/\b(refuted|not (?:real|a bug)|false positive|cannot reproduce)\b/i.test(t) && /\b(confirmed|real|reproduc)/i.test(t), reason: t.slice(0, 200), score: null };
}

export function tally(votes, mode = 'majority') {
  const real = votes.filter((v) => v.real).length;
  const need = mode === 'any' ? 1 : mode === 'all' ? votes.length : Math.floor(votes.length / 2) + 1;
  return { real, total: votes.length, confirmed: votes.length > 0 && real >= need };
}

const fill = (tpl, vars) => String(tpl).replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));

/** Expand a stage into concrete task inputs given prior results (pure). */
export function expandStage(stage, ctx) {
  const vars = { goal: ctx.goal || '', seen: ctx.seen?.length ? ctx.seen.map((f) => `- ${f.title || f.detail || ''}${f.file ? ` (${f.file})` : ''}`).join('\n') : '(nothing yet)' };
  for (const [id, r] of Object.entries(ctx.results || {})) vars[`results:${id}`] = r.summary || '';
  const base = { ...(ctx.defaults || {}), ...(stage.defaults || {}) };
  if (!stage.for_each) return (stage.tasks || []).map((t, i) => ({ ...base, ...t, title: t.title || `${stage.id} #${i + 1}`, spec: fill(t.spec, vars) }));
  const [srcId, field] = String(stage.for_each).split('.');
  const src = ctx.results?.[srcId];
  const items = field === 'confirmed' ? src?.confirmed || [] : field === 'rejected' ? src?.rejected || [] : src?.findings || [];
  const out = [];
  for (const item of items) for (let v = 0; v < stage.votes; v++) {
    const lens = Array.isArray(stage.lenses) && stage.lenses.length ? stage.lenses[v % stage.lenses.length] : '';
    out.push({ ...base, ...stage.task, item, vote: v, title: `${stage.task.title || stage.id}: ${(item.title || item.detail || '').slice(0, 50)}${stage.votes > 1 ? ` [${v + 1}/${stage.votes}]` : ''}`, spec: fill(stage.task.spec, { ...vars, item: JSON.stringify(item, null, 1), lens }) });
  }
  return out;
}

async function runTasks(inputs, { sessionId, cwd, timeoutMs, recommend, taskRuntime, overflowApi, parallelOverride }) {
  const created = inputs.map((inp) => {
    let { provider, model, effort } = inp;
    if (!provider && !model && inp.category && recommend) {
      let pick, noWorker = 'No worker available for this input.';
      try {
        const gate = accessProviders(`${inp.title || ''}\n${inp.spec || ''}`); // OG4: honour the capability access gate
        const providers = gate?.providers || null;
        pick = recommend({ category: inp.category, difficulty: inp.difficulty || 2, exclude: inp.exclude || [], overflowApi, ...(providers ? { providers } : {}) });
      }
      catch { noWorker = 'Worker recommendation failed.'; }
      if (!pick) return { input: inp, id: null, noWorker };
      // Preserve the proven visual effort even when plan/stage defaults supply an effort-only override.
      provider = pick.provider; model = pick.model; effort = ['drafting', 'modeling'].includes(inp.category) ? pick.effort : effort || pick.effort;
    }
    const t = taskRuntime.createTask({ sessionId, cwd, title: inp.title, spec: inp.spec, provider, model, effort, sandbox: inp.sandbox, paths: inp.paths, category: inp.category, difficulty: inp.difficulty, overflowApi, parallelOverride });
    return { input: inp, id: t.id };
  });
  // One stage deadline: a failover continues the wait; it does not get a fresh timeout.
  const deadline = Date.now() + timeoutMs;
  return Promise.all(created.map(async (c) => {
    if (c.noWorker) return { ...c, taskIds: [], task: { status: 'no_worker' }, complete: false, report: '', ok: false };
    const taskIds = [c.id];
    let t;
    for (;;) {
      const taskId = taskIds.at(-1), remaining = deadline - Date.now();
      t = remaining > 0 ? await taskRuntime.awaitTask(taskId, remaining) : { ...taskRuntime.getTask(taskId), timedOut: true };
      if (t?.timedOut || !t?.failedOverTo) break;
      taskIds.push(t.failedOverTo);
    }
    const complete = !t?.timedOut && ['done', 'failed', 'canceled'].includes(t?.status);
    return { ...c, taskIds, task: t, complete, report: complete ? t?.result?.finalMessage || '' : '', ok: complete && t.status === 'done' };
  }));
}

/**
 * Execute a plan. Stages run in order; tasks within a stage run in parallel on the scheduler.
 * Returns { id, status, stages: {id: {tasks, findings, confirmed, rejected, summary}}, report }.
 * An incomplete stage stops the plan; its active tasks remain on the scheduler.
 * taskRuntime is injectable so stage ordering can be tested without launching workers.
 */
export async function runPlan(plan, options = {}) {
  validatePlan(plan);
  const id = shortId((id) => activePlans.has(id) || existsSync(statePath('plans', `${id}.json`)));
  activePlans.add(id);
  try { return await executePlan(id, plan, options); }
  finally { activePlans.delete(id); }
}

async function executePlan(id, plan, { sessionId, cwd, recommend = null, taskRuntime = { createTask, awaitTask, getTask }, overflowApi = false, parallelOverride = false }) {
  const timeoutMs = Math.max(1, Number(plan.timeout_minutes) || 45) * 60_000;
  const ctx = { goal: plan.goal, defaults: plan.defaults || {}, results: {}, seen: [] };
  const seenKeys = new Set();
  let total = 0;
  const publish = (kind, data) => bus.publish('plan', { planId: id, sessionId, kind, ...data });
  publish('started', { goal: plan.goal, stages: plan.stages.map((s) => s.id) });

  const runStage = async (stage, outputKeys, round = 0) => {
    const inputs = expandStage(stage, ctx);
    if (!inputs.length) return { tasks: [], findings: [], confirmed: [], rejected: [], summary: '(no inputs)' };
    if (total + inputs.length > MAX_TASKS) return { tasks: [], findings: [], confirmed: [], rejected: [], incomplete: true, summary: `Incomplete: plan exceeds ${MAX_TASKS} tasks` };
    total += inputs.length;
    publish('stage', { stage: stage.id, round, tasks: inputs.length });
    const done = await runTasks(inputs, { sessionId, cwd, timeoutMs, recommend, taskRuntime, overflowApi, parallelOverride });
    const result = { tasks: done.map((d) => ({ id: d.id, ...(d.taskIds.length > 1 ? { taskId: d.taskIds.at(-1), taskIds: d.taskIds } : {}), ...(d.task?.timedOut ? { timedOut: true } : {}), ...(d.noWorker ? { error: d.noWorker } : {}), title: d.input.title, status: d.task?.status, model: d.noWorker ? 'none' : `${d.task?.provider}:${d.task?.model || 'default'}:${d.task?.effort || 'default'}`, changedFiles: d.task?.changedFiles || [] })), findings: [], confirmed: [], rejected: [] };
    if (done.some((d) => !d.complete)) {
      result.incomplete = true;
      result.summary = done.some((d) => d.noWorker) ? 'Incomplete: no worker available for one or more inputs.' : 'Incomplete: tasks have not reached a terminal status.';
      if (done.some((d) => d.task?.timedOut)) result.summary = `${done.some((d) => d.noWorker) ? result.summary + '\n' : ''}Incomplete: stage deadline reached; tasks may still be active.`;
      return result;
    }
    if (stage.for_each && done.some((d) => !d.ok)) {
      result.incomplete = true;
      result.summary = 'Incomplete: one or more voters failed or were canceled; no verdict was reached.';
      return result;
    }
    if (stage.for_each) {
      const groups = new Map();
      for (const d of done) { const k = d.input.item.id || findingKey(d.input.item); if (!groups.has(k)) groups.set(k, { item: d.input.item, votes: [] }); groups.get(k).votes.push({ ...parseVerdict(d.report), taskId: d.id, ok: d.ok }); }
      for (const g of groups.values()) { const t = tally(g.votes, stage.pass || 'majority'); const entry = { ...g.item, votes: g.votes.map((v) => `${v.real ? 'real' : 'refuted'}: ${v.reason}`.slice(0, 200)), tally: `${t.real}/${t.total}` }; (t.confirmed ? result.confirmed : result.rejected).push(entry); }
      result.findings = result.confirmed;
      result.summary = `${result.confirmed.length} confirmed, ${result.rejected.length} rejected\n` + result.confirmed.map((f) => `- [${f.severity || '?'}] ${f.file ? f.file + ': ' : ''}${f.title || f.detail || ''} (${f.tally})`).join('\n');
    } else {
      let fresh = 0;
      for (const d of done) for (const f of findingsOf(d.report, d.id)) {
        const k = findingKey(f);
        // Stage outputs survive handoffs; global novelty only feeds context and dry convergence.
        if (!seenKeys.has(k)) { seenKeys.add(k); ctx.seen.push(f); fresh++; }
        if (!outputKeys.has(k)) { outputKeys.add(k); result.findings.push(f); }
      }
      result.fresh = fresh;
      result.summary = `${result.findings.length} findings (${fresh} new)\n` + result.findings.map((f) => `- [${f.severity || '?'}] ${f.file ? f.file + ': ' : ''}${f.title || f.detail || ''}`).join('\n') + '\n' + done.filter((d) => !d.ok).map((d) => `! task ${d.id} ${d.task?.status}: ${d.task?.error || ''}`).join('\n');
      if (done.length === 1 && !extractJson(done[0].report)) result.summary = done[0].report.slice(0, 4000); // single free-text task (planner, critic)
    }
    return result;
  };

  for (const stage of plan.stages) {
    const outputKeys = new Set();
    let res = await runStage(stage, outputKeys);
    if (!res.incomplete && plan.until_dry?.stage === stage.id) {
      let dry = res.fresh ? 0 : 1; const max = Math.max(1, Number(plan.until_dry.max_rounds) || 3); const k = Math.max(1, Number(plan.until_dry.dry_rounds) || 1);
      for (let round = 1; round < max && dry < k; round++) {
        const again = await runStage(stage, outputKeys, round);
        res.tasks.push(...again.tasks);
        if (again.incomplete) { res.incomplete = true; res.summary += `\n${again.summary}`; break; }
        res.findings.push(...again.findings);
        res.summary = `${res.findings.length} findings after ${round + 1} rounds\n` + res.findings.map((f) => `- [${f.severity || '?'}] ${f.file ? f.file + ': ' : ''}${f.title || f.detail || ''}`).join('\n');
        dry = again.fresh ? 0 : dry + 1;
      }
    }
    ctx.results[stage.id] = res;
    if (res.incomplete) { publish('stage_incomplete', { stage: stage.id, tasks: res.tasks.length }); break; }
    publish('stage_done', { stage: stage.id, tasks: res.tasks.length, findings: res.findings.length });
  }

  const report = plan.stages.filter((s) => ctx.results[s.id]).map((s) => `## ${s.title || s.id}\ntasks: ${ctx.results[s.id].tasks.map((t) => `${t.taskIds?.join(' -> ') || t.id}[${t.status}]${t.timedOut ? ' (timed out)' : ''} ${t.model}`).join(', ')}\n${ctx.results[s.id].summary}`).join('\n\n');
  const status = Object.values(ctx.results).some((r) => r.incomplete) ? 'incomplete' : 'done';
  const out = { id, status, goal: plan.goal, startedAt: nowIso(), stages: ctx.results, report };
  writeJson(statePath('plans', `${id}.json`), { ...out, plan });
  publish(status, { report: report.slice(0, 2000) });
  return out;
}
