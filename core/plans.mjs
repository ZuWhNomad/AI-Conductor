// Deterministic multi-stage plans (fan-out, refuter votes, judge panels, until-dry loops, critic)
// executed on the task scheduler. Model-agnostic: every task carries whatever provider/model/effort
// the conductor chose (or nothing, for the auto-pick). Pure helpers are exported for tests.
import { createTask, awaitTask, getTask, cancelTask, cancelChain } from './tasks.mjs';
import { statePath, writeJson, readJson, nowIso, shortId } from './paths.mjs';
import { bus } from './bus.mjs';
import { accessProviders } from './capabilities.mjs';
import { normFamilies, selsInFamilies } from './models.mjs';
import { existsSync } from 'node:fs';

/** Shared enum for sandbox values (used in run_plan and delegate schemas). */
export const SANDBOX_VALUES = /** @type {const} */ (['read-only', 'workspace-write', 'danger-full-access']);

const MAX_TASKS = 200;
const activePlans = new Set();
const livePlans = new Map(); // id -> in-flight record (plan_status + abortPlans)

/** Validate and normalize a plan; throws on structural errors. */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.stages) || !plan.stages.length) throw new Error('plan needs a non-empty stages array');
  const ids = new Set();
  for (const [i, s] of plan.stages.entries()) {
    s.id = String(s.id || `stage${i + 1}`);
    // L48: check for_each before ids.add so a stage cannot target itself.
    if (s.for_each && !ids.has(String(s.for_each).split('.')[0])) throw new Error(`stage ${s.id}: for_each refers to unknown earlier stage ${s.for_each}`);
    if (ids.has(s.id)) throw new Error(`duplicate stage id ${s.id}`);
    ids.add(s.id);
    if (s.for_each && !s.task?.spec) throw new Error(`stage ${s.id}: for_each needs a task template with a spec`);
    if (!s.for_each && !(Array.isArray(s.tasks) && s.tasks.length)) throw new Error(`stage ${s.id}: needs tasks[] or for_each`);
    for (const t of s.tasks || []) if (!t.spec) throw new Error(`stage ${s.id}: every task needs a spec`);
    s.votes = Math.max(1, Math.min(7, Number(s.votes) || 1));
  }
  if (plan.until_dry) {
    if (!ids.has(plan.until_dry.stage)) throw new Error('until_dry.stage must name a stage');
    const target = plan.stages.find((s) => s.id === plan.until_dry.stage);
    if (target?.for_each) throw new Error('until_dry cannot target a for_each stage');
  }
  return plan;
}

// Spec: bound the unfenced `{` scan so a brace bomb cannot monopolize the server thread.
const SCAN_STEPS = 2_000_000;

/** Last parseable `{...}` that satisfies `want`, ending last (outermost on a tie). Each `{` is its own candidate —
 *  string state does not carry across prose, so a 12" quote cannot hide a later object. */
function lastBalancedObject(text, want = () => true) {
  let best = null, bestEnd = -1, bestStart = Infinity, steps = SCAN_STEPS;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '{') continue;
    let depth = 0, s = false, e = false;
    for (let j = i; j < text.length; j++) {
      if (steps-- <= 0) return best;
      const c = text[j];
      if (e) { e = false; continue; }
      if (s) { if (c === '\\') e = true; else if (c === '"') s = false; continue; }
      if (c === '"') { s = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const end = j + 1;
          if (end > bestEnd || (end === bestEnd && i < bestStart)) {
            try {
              const obj = JSON.parse(text.slice(i, end));
              if (want(obj)) { best = obj; bestEnd = end; bestStart = i; }
            } catch {}
          }
          break;
        }
      }
    }
  }
  return best;
}

function lastFenced(text, want = () => true) {
  const fences = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).reverse();
  for (const f of fences) {
    try { const v = JSON.parse(f); if (want(v)) return v; } catch {}
  }
}

function hasVerdictKey(o) {
  return !!o && typeof o === 'object' && (typeof o.real === 'boolean' || typeof o.refuted === 'boolean' || typeof o.verdict === 'string' || typeof o.score === 'number');
}

function verdictOf(j) {
  if (typeof j.real === 'boolean') return { real: j.real, reason: j.reason || '', score: j.score ?? null };
  if (typeof j.refuted === 'boolean') return { real: !j.refuted, reason: j.reason || '', score: j.score ?? null };
  if (typeof j.verdict === 'string') return { real: /^(real|confirmed|pass|accept)/i.test(j.verdict), reason: j.reason || '', score: j.score ?? null };
  if (typeof j.score === 'number') return { real: j.score >= (j.threshold ?? 5), reason: j.reason || '', score: j.score };
}

const findingsArray = (o) => Array.isArray(o?.findings) ? o.findings : Array.isArray(o) ? o : null;
const hasFindingObjects = (o) => !!findingsArray(o)?.some((f) => f && typeof f === 'object');
const isFindingsShape = (o) => findingsArray(o)?.length === 0 || hasFindingObjects(o);

/** Fenced JSON that looks like findings, else an unfenced object with findings[]. */
function structuredOf(report) {
  if (!report) return undefined;
  const fenced = lastFenced(report, isFindingsShape);
  if (fenced !== undefined) return fenced;
  return lastBalancedObject(String(report), (o) => Array.isArray(o.findings)) ?? undefined;
}

/** Last fenced ```json block (or a bare trailing object) in a worker report. */
export function extractJson(text) {
  if (!text) return null;
  const fenced = lastFenced(text);
  return fenced !== undefined ? fenced : lastBalancedObject(String(text));
}

/** Findings from a report: an explicit findings[] block, else the whole report as one item. */
export function findingsOf(report, taskId) {
  const j = structuredOf(report);
  const arr = findingsArray(j);
  if (arr) return arr.filter((f) => f && typeof f === 'object').map((f, i) => ({ ...f, id: f.id || `${taskId}-${i + 1}`, source: taskId }));
  return report?.trim() ? [{ id: `${taskId}-1`, title: report.trim().slice(0, 140), detail: report.trim(), source: taskId }] : [];
}

const locOf = (f) => f.file || f.location || '';
const titleOf = (f) => f.title || f.detail || f.issue || f.summary || '';
const findingLine = (f, extra = '') => `- [${f.severity || '?'}] ${locOf(f) ? locOf(f) + ': ' : ''}${titleOf(f)}${extra}`;
// Same 4000-char cap already used for a single free-text stage summary.
const RESULTS_CHARS = 4000;
const findingFields = (f) => {
  const o = {};
  for (const k of ['id', 'title', 'detail', 'issue', 'summary', 'file', 'location', 'line', 'severity', 'evidence', 'fix']) {
    if (f[k] != null && f[k] !== '') o[k] = f[k];
  }
  return o;
};
function resultsText(r) {
  if (r.findings?.length) {
    const json = JSON.stringify(r.findings.map(findingFields), null, 1);
    return json.length > RESULTS_CHARS ? json.slice(0, RESULTS_CHARS) + '…' : json;
  }
  return r.summary || '';
}

export const findingKey = (f) => {
  const loc = String(locOf(f)).toLowerCase().replace(/\\/g, '/');
  const title = String(titleOf(f)).toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  if (loc || title) return `${loc}|${title}`;
  try { return JSON.stringify(f).toLowerCase().slice(0, 80); } catch { return '|'; }
};

/** Verdict from a refuter/judge report: {real:boolean} / {verdict:'real'|'refuted'} / {score}. */
export function parseVerdict(report) {
  const t = String(report || '');
  const withKey = t ? lastFenced(t, hasVerdictKey) : undefined;
  if (withKey !== undefined) return verdictOf(withKey);
  // L18: a fenced object with no verdict key is still "not real" (not a prose fallback).
  const fenced = t ? lastFenced(t) : undefined;
  if (fenced !== undefined) {
    const j = fenced && typeof fenced === 'object' && !Array.isArray(fenced) ? fenced : {};
    return verdictOf(j) || { real: false, reason: JSON.stringify(fenced).slice(0, 200), score: null };
  }
  const found = lastBalancedObject(t, hasVerdictKey);
  if (found) return verdictOf(found);
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
  const vars = { goal: ctx.goal || '', seen: ctx.seen?.length ? ctx.seen.map((f) => `- ${titleOf(f)}${locOf(f) ? ` (${locOf(f)})` : ''}`).join('\n') : '(nothing yet)' };
  for (const [id, r] of Object.entries(ctx.results || {})) vars[`results:${id}`] = resultsText(r);
  const base = { ...(ctx.defaults || {}), ...(stage.defaults || {}) };
  if (!stage.for_each) return (stage.tasks || []).map((t, i) => ({ ...base, ...t, title: t.title || `${stage.id} #${i + 1}`, spec: fill(t.spec, vars) }));
  const [srcId, field] = String(stage.for_each).split('.');
  const src = ctx.results?.[srcId];
  const items = field === 'confirmed' ? src?.confirmed || [] : field === 'rejected' ? src?.rejected || [] : src?.findings || [];
  const out = [];
  for (const item of items) for (let v = 0; v < stage.votes; v++) {
    const lens = Array.isArray(stage.lenses) && stage.lenses.length ? stage.lenses[v % stage.lenses.length] : '';
    out.push({ ...base, ...stage.task, item, vote: v, title: `${stage.task.title || stage.id}: ${titleOf(item).slice(0, 50)}${stage.votes > 1 ? ` [${v + 1}/${stage.votes}]` : ''}`, spec: fill(stage.task.spec, { ...vars, item: JSON.stringify(item, null, 1), lens }) });
  }
  return out;
}

async function runTasks(inputs, { sessionId, cwd, timeoutMs, recommend, taskRuntime, overflowApi, parallelOverride, live }) {
  // P10: resolve every selection before creating any task.
  const resolved = [];
  for (const inp of inputs) {
    let { provider, model, effort } = inp;
    let difficulty = inp.difficulty, variant = inp.variant;
    if (!provider && !model && inp.category && recommend) {
      let pick, noWorker = 'No worker available for this input.';
      try {
        const gate = accessProviders(`${inp.title || ''}\n${inp.spec || ''}`); // OG4: honour the capability access gate
        const providers = gate?.providers || null;
        pick = recommend({ category: inp.category, difficulty: inp.difficulty || 2, exclude: [...(inp.exclude || []), ...selsInFamilies(normFamilies(inp.avoid_families))], overflowApi, ...(providers ? { providers } : {}) });
      }
      catch { noWorker = 'Worker recommendation failed.'; }
      if (!pick) { resolved.push({ input: inp, noWorker }); continue; }
      // Preserve the proven visual effort even when plan/stage defaults supply an effort-only override.
      provider = pick.provider; model = pick.model; effort = ['drafting', 'modeling'].includes(inp.category) ? pick.effort : effort || pick.effort;
      difficulty = inp.difficulty || 2; // L19: persist the routed level when auto-picked
    }
    resolved.push({ input: inp, provider, model, effort, difficulty, variant });
  }
  if (resolved.some((r) => r.noWorker)) {
    return resolved.map((c) => ({ ...c, id: null, taskIds: [], task: { status: 'no_worker' }, complete: false, report: '', ok: false }));
  }
  const created = [];
  let createError = null;
  for (const r of resolved) {
    let t;
    try {
      t = taskRuntime.createTask({ sessionId, cwd, title: r.input.title, spec: r.input.spec, provider: r.provider, model: r.model, effort: r.effort, sandbox: r.input.sandbox, paths: r.input.paths, writableRoots: r.input.writable_roots, category: r.input.category, difficulty: r.difficulty, variant: r.variant, avoidFamilies: r.input.avoid_families, overflowApi, parallelOverride });
    } catch (err) {
      createError = String(err?.message || err);
      for (const c of created) { if (c.id) cancelTask(c.id); }
      break;
    }
    created.push({ ...r, id: t.id });
    if (live && t.id) live.taskIds.push(t.id);
  }
  if (createError) {
    return created.map((c) => ({ ...c, taskIds: c.id ? [c.id] : [], task: { status: 'canceled' }, complete: true, report: '', ok: false, noWorker: c.noWorker }))
      .concat([{ input: inputs[created.length] || {}, id: null, taskIds: [], task: { status: 'no_worker' }, complete: false, report: '', ok: false, noWorker: `createTask failed: ${createError}` }]);
  }
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
  const id = shortId((id) => activePlans.has(id) || existsSync(statePath('plans', `${id}.json`)) || livePlans.has(id));
  activePlans.add(id);
  options.onId?.(id);
  try { return await executePlan(id, plan, options); }
  finally { activePlans.delete(id); livePlans.delete(id); }
}

/** Snapshot of an in-flight or journaled plan (plan_status). */
export function getPlan(planId) {
  if (!planId) return null;
  if (livePlans.has(planId)) return livePlans.get(planId);
  const file = statePath('plans', `${planId}.json`);
  return existsSync(file) ? readJson(file, null) : null;
}

/** Abort every in-flight plan for this session: cancel its tasks, stop later stages. */
export function abortPlans(sessionId) {
  if (!sessionId) return;
  for (const p of livePlans.values()) {
    if (p.sessionId !== sessionId) continue;
    p.aborted = true;
    for (const tid of p.taskIds || []) cancelChain(tid);
  }
}

async function executePlan(id, plan, { sessionId, cwd, recommend = null, taskRuntime = { createTask, awaitTask, getTask }, overflowApi = false, parallelOverride = false }) {
  // 1440 min = config timer bound (below Node's 2^31-1 ms setTimeout maximum).
  const timeoutMs = Math.max(1, Math.min(1440, Number(plan.timeout_minutes) || 45)) * 60_000;
  const ctx = { goal: plan.goal, defaults: plan.defaults || {}, results: {}, seen: [] };
  const seenKeys = new Set();
  let total = 0;
  const startedAt = nowIso();
  const live = { id, sessionId, status: 'running', goal: plan.goal, startedAt, stages: {}, report: '', taskIds: [], aborted: false };
  livePlans.set(id, live);
  const aborted = () => live.aborted;
  const publish = (kind, data) => bus.publish('plan', { planId: id, sessionId, kind, ...data });
  publish('started', { goal: plan.goal, stages: plan.stages.map((s) => s.id) });

  const runStage = async (stage, outputKeys, round = 0) => {
    if (aborted()) return { tasks: [], findings: [], confirmed: [], rejected: [], incomplete: true, summary: 'Incomplete: plan aborted.' };
    const inputs = expandStage(stage, ctx);
    if (!inputs.length) return { tasks: [], findings: [], confirmed: [], rejected: [], summary: '(no inputs)' };
    if (total + inputs.length > MAX_TASKS) return { tasks: [], findings: [], confirmed: [], rejected: [], incomplete: true, summary: `Incomplete: plan exceeds ${MAX_TASKS} tasks` };
    total += inputs.length;
    publish('stage', { stage: stage.id, round, tasks: inputs.length });
    const done = await runTasks(inputs, { sessionId, cwd, timeoutMs, recommend, taskRuntime, overflowApi, parallelOverride, live });
    if (aborted()) {
      for (const d of done) if (d.id) cancelChain(d.id);
      return { tasks: done.map((d) => ({ id: d.id, title: d.input.title, status: d.task?.status || 'canceled' })), findings: [], confirmed: [], rejected: [], incomplete: true, summary: 'Incomplete: plan aborted.' };
    }
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
      // L2: group by the item object reference expandStage passed, never by a worker-supplied id.
      for (const d of done) { const k = d.input.item; if (!groups.has(k)) groups.set(k, { item: d.input.item, votes: [] }); groups.get(k).votes.push({ ...parseVerdict(d.report), taskId: d.id, ok: d.ok }); }
      for (const g of groups.values()) { const t = tally(g.votes, stage.pass || 'majority'); const entry = { ...g.item, votes: g.votes.map((v) => `${v.real ? 'real' : 'refuted'}: ${v.reason}`.slice(0, 200)), tally: `${t.real}/${t.total}` }; (t.confirmed ? result.confirmed : result.rejected).push(entry); }
      result.findings = result.confirmed;
      result.summary = `${result.confirmed.length} confirmed, ${result.rejected.length} rejected\n` + result.confirmed.map((f) => findingLine(f, ` (${f.tally})`)).join('\n');
    } else {
      if (done.every((d) => !d.ok)) {
        result.incomplete = true;
        result.summary = 'Incomplete: all tasks failed or were canceled.\n' + done.map((d) => `! task ${d.id} ${d.task?.status}: ${d.task?.error || ''}`).join('\n');
        return result;
      }
      let fresh = 0;
      for (const d of done.filter((d) => d.ok)) for (const f of findingsOf(d.report, d.id)) {
        const k = findingKey(f);
        // Stage outputs survive handoffs; global novelty only feeds context and dry convergence.
        if (!seenKeys.has(k)) { seenKeys.add(k); ctx.seen.push(f); fresh++; }
        if (!outputKeys.has(k)) { outputKeys.add(k); result.findings.push(f); }
      }
      result.fresh = fresh;
      result.summary = `${result.findings.length} findings (${fresh} new)\n` + result.findings.map((f) => findingLine(f)).join('\n') + '\n' + done.filter((d) => !d.ok).map((d) => `! task ${d.id} ${d.task?.status}: ${d.task?.error || ''}`).join('\n');
      // L17: keep the full report unless real finding objects were extracted.
      if (done.length === 1 && done[0].ok && !hasFindingObjects(structuredOf(done[0].report))) result.summary = done[0].report.slice(0, RESULTS_CHARS); // single free-text task (planner, critic)
    }
    return result;
  };

  for (const stage of plan.stages) {
    if (aborted()) {
      ctx.results[stage.id] = { tasks: [], findings: [], confirmed: [], rejected: [], incomplete: true, summary: 'Incomplete: plan aborted.' };
      publish('stage_incomplete', { stage: stage.id, tasks: 0 });
      break;
    }
    const outputKeys = new Set();
    let res = await runStage(stage, outputKeys);
    if (!res.incomplete && plan.until_dry?.stage === stage.id) {
      let dry = res.fresh ? 0 : 1; const max = Math.max(1, Number(plan.until_dry.max_rounds) || 3); const k = Math.max(1, Number(plan.until_dry.dry_rounds) || 1);
      let rounds = 1;
      for (let round = 1; round < max && dry < k; round++) {
        if (aborted()) { res.incomplete = true; res.summary += '\nIncomplete: plan aborted.'; break; }
        rounds = round + 1;
        const again = await runStage(stage, outputKeys, round);
        res.tasks.push(...again.tasks);
        if (again.incomplete) { res.incomplete = true; res.summary += `\n${again.summary}`; break; }
        res.findings.push(...again.findings);
        res.summary = `${res.findings.length} findings after ${round + 1} rounds\n` + res.findings.map((f) => findingLine(f)).join('\n');
        dry = again.fresh ? 0 : dry + 1;
      }
      if (!res.incomplete) {
        const capped = dry < k;
        res.untilDry = { rounds, dry: !capped, capped };
        if (capped) res.summary += `\n(capped at max_rounds=${max})`;
      }
    }
    ctx.results[stage.id] = res;
    live.stages = ctx.results;
    if (res.incomplete) { publish('stage_incomplete', { stage: stage.id, tasks: res.tasks.length }); break; }
    publish('stage_done', { stage: stage.id, tasks: res.tasks.length, findings: res.findings.length });
  }

  const report = plan.stages.filter((s) => ctx.results[s.id]).map((s) => `## ${s.title || s.id}\ntasks: ${ctx.results[s.id].tasks.map((t) => `${t.taskIds?.join(' -> ') || t.id}[${t.status}]${t.timedOut ? ' (timed out)' : ''} ${t.model}`).join(', ')}\n${ctx.results[s.id].summary}`).join('\n\n');
  const status = Object.values(ctx.results).some((r) => r.incomplete) ? 'incomplete' : 'done';
  const finishedAt = nowIso();
  const out = { id, status, goal: plan.goal, startedAt, finishedAt, stages: ctx.results, report };
  Object.assign(live, { status, report, stages: ctx.results, finishedAt });
  writeJson(statePath('plans', `${id}.json`), { ...out, plan });
  publish(status, { report: report.slice(0, 2000) });
  return out;
}
