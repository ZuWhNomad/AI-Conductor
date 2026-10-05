// runPlan on the task scheduler. Mutable registry lives in createPlanRuntime (one per facade evaluation).
// awaitTask and accessProviders are arguments: test/plans/_helpers.mjs replaces ./tasks.mjs and
// ./capabilities.mjs only when the importer is core/plans.mjs, including its ?tool-fixture copy.
import { createTask, getTask, cancelTask, cancelChain } from '../tasks.mjs';
import { statePath, writeJson, readJson, nowIso, shortId } from '../paths.mjs';
import { bus } from '../bus.mjs';
import { normFamilies, selsInFamilies } from '../models.mjs';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.mjs';
import { ROUTED_MAX_DIFFICULTY, summarize } from '../scorecard.mjs';
import { validatePlan } from './validate.mjs';
import { findingsOf, findingKey, parseVerdict, tally, findingLine, hasFindingObjects, structuredOf } from './findings.mjs';
import { expandStage, RESULTS_CHARS } from './expand.mjs';

export function createPlanRuntime({ awaitTask, accessProviders }) {
  const MAX_TASKS = 200;
  const activePlans = new Set();
  const livePlans = new Map(); // id -> in-flight record (plan_status + abortPlans)

  function waitForFirstWorkerEvent(taskId, timeoutMs) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); bus.off('event', onEvent); resolve(); };
      const onEvent = (e) => { if (e.type === 'worker' && e.taskId === taskId) done(); };
      const timer = setTimeout(done, timeoutMs);
      bus.on('event', onEvent);
    });
  }

  function noWorkerReason({ category, difficulty }, gate, overflowApi) {
    difficulty ||= 2;
    if (gate) return `No worker is available: the task matches the access rule ${gate.names.join(', ')} (only ${gate.providers.join(', ')} can take it) and none of those is proven for ${category}@${difficulty} and available now.`;
    const bar = loadConfig().scorecard?.quality ?? 0.75;
    const proven = summarize().some((g) => g.category === category && g.difficulty >= difficulty && g.difficulty <= ROUTED_MAX_DIFFICULTY && g.rated > 0 && (g.quality ?? 0) >= bar);
    if (!proven) return `No worker is available for ${category}@${difficulty}: nothing is proven at this level yet. Pin a provider/model explicitly (which always runs and seeds the scorecard) or run smoke_test.`;
    return `No worker is available for ${category}@${difficulty} under the current budget rules (subscription classes capped at this level; API overflow is ${overflowApi ? 'on' : 'off for this chat'}). Do the task yourself, wait for a window reset (see limits), or ask the user to enable API overflow.`;
  }

  async function runTasks(inputs, { sessionId, cwd, timeoutMs, recommend, taskRuntime, overflowApi, parallelOverride, live, warmupSeconds = 20 }) {
    // P10: resolve every selection before creating any task.
    const resolved = [];
    for (const inp of inputs) {
      let { provider, model, effort } = inp;
      let difficulty = inp.difficulty, variant = inp.variant;
      if (!provider && !model && inp.category && recommend) {
        let pick, gate;
        try {
          gate = accessProviders(`${inp.title || ''}\n${inp.spec || ''}`); // OG4: honour the capability access gate
          pick = recommend({ category: inp.category, difficulty: inp.difficulty || 2, exclude: [...(inp.exclude || []), ...selsInFamilies(normFamilies(inp.avoid_families))], escalate: false, overflowApi, providers: gate?.providers || null });
        }
        catch { resolved.push({ input: inp, noWorker: 'Worker recommendation failed.' }); continue; }
        if (!pick) { resolved.push({ input: inp, noWorker: noWorkerReason({ category: inp.category, difficulty: inp.difficulty }, gate, overflowApi) }); continue; }
        // Preserve the proven visual effort even when plan/stage defaults supply an effort-only override.
        provider = pick.provider; model = pick.model; effort = ['drafting', 'modeling'].includes(inp.category) ? pick.effort : effort || pick.effort;
        difficulty = inp.difficulty || 2; // L19: persist the routed level when auto-picked
      }
      resolved.push({ input: inp, provider, model, effort, difficulty, variant, pinned: !!(inp.provider && inp.model) });
    }
    const created = [];
    let createError = null;
    let createdCount = 0, firstCreatedId = null;
    for (const r of resolved) {
      if (r.noWorker) { created.push({ ...r, id: null }); continue; }
      if (createdCount === 1 && resolved.length >= 3 && warmupSeconds > 0 && firstCreatedId) {
        await (taskRuntime.waitForFirstEvent?.(firstCreatedId, warmupSeconds * 1000) || waitForFirstWorkerEvent(firstCreatedId, warmupSeconds * 1000));
      }
      let t;
      try {
        const explicitEfficiency = r.input.efficiency_mode ?? (r.input.no_failover == null ? undefined : !!r.input.no_failover);
        t = taskRuntime.createTask({ sessionId, cwd, title: r.input.title, spec: r.input.spec, provider: r.provider, model: r.model, effort: r.effort, sandbox: r.input.sandbox, paths: r.input.paths, writableRoots: r.input.writable_roots, isolate: r.input.isolate, category: r.input.category, difficulty: r.difficulty, variant: r.variant, avoidFamilies: r.input.avoid_families, efficiencyMode: explicitEfficiency ?? (r.pinned ? true : undefined), overflowApi, parallelOverride });
      } catch (err) {
        createError = String(err?.message || err);
        for (const c of created) { if (c.id) cancelTask(c.id); }
        break;
      }
      created.push({ ...r, id: t.id });
      createdCount++;
      firstCreatedId ||= t.id;
      if (live && t.id) live.taskIds.push(t.id);
    }
    if (createError) {
      return created.map((c) => c.noWorker
        ? { ...c, taskIds: [], task: { status: 'no_worker' }, complete: false, report: '', ok: false }
        : { ...c, taskIds: c.id ? [c.id] : [], task: { status: 'canceled' }, complete: true, report: '', ok: false })
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
   * Returns { id, status, stages: {id: {tasks, findings, confirmed, rejected, unverified, summary}}, report }.
   * An incomplete stage stops the plan; its active tasks remain on the scheduler.
   * taskRuntime is injectable so stage ordering can be tested without launching workers.
   */
  async function runPlan(plan, options = {}) {
    validatePlan(plan);
    const id = shortId((id) => activePlans.has(id) || existsSync(statePath('plans', `${id}.json`)) || livePlans.has(id));
    activePlans.add(id);
    options.onId?.(id);
    try { return await executePlan(id, plan, options); }
    finally { activePlans.delete(id); livePlans.delete(id); }
  }

  /** Snapshot of an in-flight or journaled plan (plan_status). */
  function getPlan(planId) {
    if (!planId) return null;
    if (livePlans.has(planId)) return livePlans.get(planId);
    const file = statePath('plans', `${planId}.json`);
    return existsSync(file) ? readJson(file, null) : null;
  }

  /** Abort every in-flight plan for this session: cancel its tasks, stop later stages. */
  function abortPlans(sessionId) {
    if (!sessionId) return;
    for (const p of livePlans.values()) {
      if (p.sessionId !== sessionId) continue;
      p.aborted = true;
      for (const tid of p.taskIds || []) cancelChain(tid);
    }
  }

  async function executePlan(id, plan, { sessionId, cwd, recommend = null, taskRuntime = { createTask, awaitTask, getTask }, overflowApi = false, parallelOverride = false, warmupSeconds }) {
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
      if (aborted()) return { tasks: [], findings: [], confirmed: [], rejected: [], unverified: [], incomplete: true, summary: 'Incomplete: plan aborted.' };
      const inputs = expandStage(stage, ctx);
      if (!inputs.length) return { tasks: [], findings: [], confirmed: [], rejected: [], unverified: [], summary: '(no inputs)' };
      if (total + inputs.length > MAX_TASKS) return { tasks: [], findings: [], confirmed: [], rejected: [], unverified: [], incomplete: true, summary: `Incomplete: plan exceeds ${MAX_TASKS} tasks` };
      total += inputs.length;
      publish('stage', { stage: stage.id, round, tasks: inputs.length });
      const warmup = warmupSeconds ?? loadConfig().plans?.warmupSeconds ?? 20;
      const done = await runTasks(inputs, { sessionId, cwd, timeoutMs, recommend, taskRuntime, overflowApi, parallelOverride, live, warmupSeconds: warmup });
      if (aborted()) {
        for (const d of done) if (d.id) cancelChain(d.id);
        return { tasks: done.map((d) => ({ id: d.id, title: d.input.title, status: d.task?.status || 'canceled' })), findings: [], confirmed: [], rejected: [], unverified: [], incomplete: true, summary: 'Incomplete: plan aborted.' };
      }
      const result = { tasks: done.map((d) => ({ id: d.id, ...(d.taskIds.length > 1 ? { taskId: d.taskIds.at(-1), taskIds: d.taskIds } : {}), ...(d.task?.timedOut ? { timedOut: true } : {}), ...(d.noWorker ? { error: d.noWorker } : {}), title: d.input.title, status: d.task?.status, model: d.noWorker ? 'none' : `${d.task?.provider}:${d.task?.model || 'default'}:${d.task?.effort || 'default'}`, changedFiles: d.task?.changedFiles || [] })), findings: [], confirmed: [], rejected: [], unverified: [] };
      if (done.some((d) => !d.complete)) {
        result.incomplete = true;
        result.summary = done.some((d) => d.noWorker) ? 'Incomplete: no worker available for one or more inputs.' : 'Incomplete: tasks have not reached a terminal status.';
        if (done.some((d) => d.task?.timedOut)) result.summary = `${done.some((d) => d.noWorker) ? result.summary + '\n' : ''}Incomplete: stage deadline reached; tasks may still be active.`;
        return result;
      }
      if (stage.for_each && done.every((d) => !d.ok)) {
        result.incomplete = true;
        result.summary = 'Incomplete: all voters failed or were canceled; no verdict was reached.\n' + done.map((d) => `! task ${d.id} ${d.task?.status}: ${d.task?.error || ''}`).join('\n');
        return result;
      }
      if (stage.for_each) {
        const groups = new Map();
        // L2: group by the item object reference expandStage passed, never by a worker-supplied id.
        for (const d of done) { const k = d.input.item; if (!groups.has(k)) groups.set(k, { item: d.input.item, done: [] }); groups.get(k).done.push(d); }
        for (const g of groups.values()) {
          const finished = g.done.filter((d) => d.ok), failed = g.done.filter((d) => !d.ok);
          if (!finished.length) { result.unverified.push({ ...g.item, votes: [], failedTasks: failed.map((d) => d.id) }); continue; }
          const votes = finished.map((d) => ({ ...parseVerdict(d.report), taskId: d.id, ok: true }));
          const t = tally(votes, stage.pass || 'majority');
          const tallyStr = failed.length ? `${t.real}/${t.total} (${failed.length} vote${failed.length === 1 ? '' : 's'} failed)` : `${t.real}/${t.total}`;
          const entry = { ...g.item, votes: votes.map((v) => `${v.real ? 'real' : 'refuted'}: ${v.reason}`.slice(0, 200)), tally: tallyStr, ...(failed.length ? { failedTasks: failed.map((d) => d.id) } : {}) };
          (t.confirmed ? result.confirmed : result.rejected).push(entry);
        }
        result.findings = result.confirmed;
        const counts = [`${result.confirmed.length} confirmed`, `${result.rejected.length} rejected`];
        if (result.unverified.length) counts.push(`${result.unverified.length} unverified`);
        const lines = [counts.join(', ')];
        for (const f of result.confirmed) lines.push(findingLine(f, ` (${f.tally})`));
        for (const f of result.unverified) lines.push(findingLine(f, ` (unverified: failed task${f.failedTasks?.length === 1 ? '' : 's'} ${(f.failedTasks || []).join(', ')})`));
        result.summary = lines.join('\n');
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
        ctx.results[stage.id] = { tasks: [], findings: [], confirmed: [], rejected: [], unverified: [], incomplete: true, summary: 'Incomplete: plan aborted.' };
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

    const report = plan.stages.filter((s) => ctx.results[s.id]).map((s) => `## ${s.title || s.id}\ntasks: ${ctx.results[s.id].tasks.map((t) => `${t.taskIds?.join(' -> ') || t.id}[${t.status}]${t.timedOut ? ' (timed out)' : ''} ${t.model}${t.error ? ` — ${t.error}` : ''}`).join(', ')}\n${ctx.results[s.id].summary}`).join('\n\n');
    const status = Object.values(ctx.results).some((r) => r.incomplete) ? 'incomplete' : 'done';
    const finishedAt = nowIso();
    const out = { id, status, goal: plan.goal, startedAt, finishedAt, stages: ctx.results, report };
    Object.assign(live, { status, report, stages: ctx.results, finishedAt });
    writeJson(statePath('plans', `${id}.json`), { ...out, plan });
    publish(status, { report: report.slice(0, 2000) });
    return out;
  }

  return { runPlan, getPlan, abortPlans, noWorkerReason };
}
