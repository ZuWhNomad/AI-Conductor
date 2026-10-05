// Task tools: delegate, follow_up, await_task, task_status, cancel_task, worktree_cleanup, rate_task.
import { z } from 'zod';
import { createTask, getTask, cancelChain, describeTask, cleanupWorktree, awaitTask } from '../tasks.mjs';
import { familyOf, normFamilies, selsInFamilies } from '../models.mjs';
import { logImprovement } from '../improve.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { loadConfig, saveConfig } from '../config.mjs';
import { CATEGORIES, VERDICTS, ROUTED_MAX_DIFFICULTY, rateTask, effortForTask, recommend } from '../scorecard.mjs';
import { accessProviders, missingFor, shouldResearch, researchSpec, parseResearched, loadIndex } from '../capabilities.mjs';
import { noWorkerReason, SANDBOX_VALUES } from '../plans.mjs';
import { sessionFlags } from '../session-flags.mjs';
import { checkVariant } from '../recipes.mjs';
import { taskWaits, escalationState, atCeiling, selOf, resumeAt } from './_shared.mjs';

const offered = new Map(); // sessionId -> Set of capability names already offered in that chat

/**
 * Tool definitions for one conductor session. `rate_task` is last here; index.mjs lifts it to sit after the job tools.
 */
export function defs({ sessionId, cwd, maxBlockMs }) {
  const effortDesc = 'Reasoning effort: low|medium|high|xhigh|max (Codex also: ultra). Default from settings.';
  const capWait = (minutes, task = null) => {
    let want = minutes == null ? undefined : minutes * 60_000;
    if (want == null && maxBlockMs != null) {
      const cfg = loadConfig().worker;
      const configured = task ? (cfg.timeoutByCategory[task.category] ?? cfg.timeoutMinutes) : cfg.timeoutMinutes;
      want = (configured > 0 ? configured : 55) * 60_000;
    }
    if (maxBlockMs == null) return want;
    return Math.min(want, maxBlockMs);
  };
  const stillRunning = '\n(still running — call await_task)';
  const backgroundStatus = (t) => `${t.status}${t.status === 'parked' ? ` until ${resumeAt(t)}` : ''}`;
  const trackedWait = async (taskId, promise) => {
    const ids = taskWaits.get(sessionId) || new Set(); ids.add(taskId); taskWaits.set(sessionId, ids);
    try { return await promise; }
    finally { ids.delete(taskId); if (!ids.size) taskWaits.delete(sessionId); }
  };
  const finish = async (t, minutes) => {
    const done = await trackedWait(t.id, awaitTask(t.id, capWait(minutes, t)));
    const task = done?.id ? getTask(done.id) || done : getTask(t.id);
    return describeTask(task) + (done?.followedFrom ? `\nFollowed from task ${done.followedFrom}.` : '') + (done?.timedOut ? stillRunning : '');
  };
  return [
    {
      name: 'delegate',
      description: 'Run a worker on a self-contained task in the project directory. Write a full spec (goal, files, constraints, acceptance criteria, verification command). Tag it with category + difficulty; leave provider/model empty to let the scorecard pick the cheapest model that has proven itself for that kind of work. Blocks until done unless background=true. Returns the worker report, changed files and diff stat (files that changed in the repo while it ran — concurrent tasks in the same directory show up in each other\'s lists) — verify them yourself, then rate_task.',
      schema: z.object({
        title: z.string().describe('Short task title'),
        spec: z.string().describe('The complete spec the worker will see (it has not seen this conversation)'),
        category: z.enum(CATEGORIES).optional().describe('Kind of work. With difficulty this selects the worker from the scorecard and trains it.'),
        difficulty: z.number().int().min(1).max(ROUTED_MAX_DIFFICULTY).optional().describe('1 mechanical single-file edit/lookup · 2 small feature from a precise spec, one module · 3 multi-file or needs surrounding understanding · 4 ambiguous, debugging, cross-cutting · 5 design-heavy, high blast radius · 6 long multi-step change with non-obvious correctness constraints (performance with exact behaviour kept, applying/merging complex patches) · 7 hard concurrency/protocol/parsing work where subtle bugs survive normal testing'),
        exclude: z.array(z.string()).optional().describe('provider:model[:effort] selections the auto-pick must skip'),
        avoid_families: z.array(z.string()).optional().describe('Model families (claude, gpt, grok, gemini, deepseek) that the auto-pick, the default worker and a limit failover must not land on; a pinned model still runs. For a review: the finder\'s family and the reviewer\'s own.'),
        retry_of: z.string().optional().describe('Task id of the failed attempt this replaces. Its model is excluded from the auto-pick, category/difficulty are inherited, and the cost of both attempts is scored as one chain (this is how ladders get measured).'),
        provider: z.string().optional().describe(`Provider id (${Object.keys(PROVIDERS).join(', ')}). Omit with model to auto-pick; fallback default: ${loadConfig().worker.provider}`),
        model: z.string().optional().describe('Model id for that provider; see list_models'),
        effort: z.string().optional().describe(effortDesc),
        variant: z.string().optional().describe('Recipe variant for this category (e.g. recipe-c, video-finance). Must be one of the variants registered for the category.'),
        paths: z.array(z.string()).optional().describe('Files/folders in scope; their CONTEXT.md notes are injected'),
        background: z.boolean().optional().describe('Return immediately with a task id; collect with await_task'),
        efficiency_mode: z.boolean().optional().describe('Override the global efficiency-mode setting: true waits on this model at its usage limit; false allows failover, including for an explicit provider/model pin'),
        no_failover: z.boolean().optional().describe('Deprecated: same as efficiency_mode: true'),
        writable_roots: z.array(z.string()).optional().describe('Absolute paths of existing directories the worker may also write, e.g. a sibling git worktree (Codex --add-dir, Claude additionalDirectories, Antigravity --add-dir). The task still runs in the project directory.'),
        isolate: z.boolean().optional().describe('Run in a per-task git worktree (branch conductor/<task id>) so parallel editors do not overwrite each other. Ignored in a non-git cwd or when sandbox is read-only. Follow-ups reuse the same worktree; retry_of gets a fresh one.'),
        timeout_minutes: z.number().max(1440).optional().describe('Max wait when blocking (default: the task/category run timeout when set, else 55 minutes)'),
        sandbox: z.enum(SANDBOX_VALUES).optional().describe('Task sandbox (default from settings). Use read-only for reviews. Codex enforces it with an OS sandbox; API workers disable write, edit and run tools; Claude disallows Bash, Edit, Write and NotebookEdit. Vendor CLIs use a disposable git snapshot when available, otherwise their plan-mode flags. Claude and vendor modes are best-effort, so also tell those reviewers "do not modify files" in the spec.'),
      }),
      handler: async (a) => {
        const cfg = loadConfig(); // L47: settings must not be captured once per Claude session
        let { provider, model, effort, category, difficulty, variant } = a; let pick = null;
        const badVariant = checkVariant(category, variant);
        if (badVariant) return badVariant;
        const failed = a.retry_of ? getTask(a.retry_of) : null;
        if (a.retry_of && !failed) return `unknown task ${a.retry_of} (retry_of)`;
        const avoid = normFamilies(a.avoid_families), avoided = selsInFamilies(avoid);
        const exclude = [...(a.exclude || []), ...avoided];
        let depth = 0, root = failed;
        if (failed) {
          // Count attempts once, keeping the latest review rounds while resolving each attempt's retry link.
          const visited = new Set();
          for (let f = failed; f && !visited.has(f.id);) {
            // A provider-limit cutoff or never-started task is not a quality escalation. A replacement that ran and
            // failed on quality still counts, even though reroutedFrom records that it arrived via a limit handoff.
            if (!f.limitHit && (f.attempts || 0) > 0) { depth++; root = f; }
            while (f && !visited.has(f.id)) {
              visited.add(f.id);
              if ((f.attempts || 0) > 0 && !f.limitHit) exclude.push(selOf(f));
              if (!f.followUpOf) break;
              f = getTask(f.followUpOf);
              if (f && visited.has(f.id)) { f = null; break; }
            }
            f = f?.retryOf ? getTask(f.retryOf) : null;
          }
          category = category || failed.category || undefined; difficulty = difficulty || failed.difficulty || undefined;
          variant = variant || failed.variant || undefined;
        }
        // Review → escalation ladder (see escalationState). First delegate: best VALUE. Once the worker's review
        // rounds are spent — or after a prior model switch — a retry_of escalates to the best AVAILABLE model by
        // quality (`escalate` flips recommend() from value to best-available), bounded to worker.escalationRounds.
        const escRounds = cfg.worker.escalationRounds;
        const { escalate, escalationsUsed, blocked, remaining } = escalationState({ hasFailed: !!failed, depth, rootRounds: root?.rounds || 0, failedRounds: failed?.rounds || 0, maxRounds: cfg.worker.maxRounds, escRounds });
        if (!provider && !model && category) {
          if (blocked) return `Escalation budget spent: the best-available model was already tried ${escalationsUsed} time(s) (worker.escalationRounds=${escRounds}) after the review rounds, and the task still failed. Per the ladder, the conductor is the final fallback — finish this one yourself now (or name a provider/model explicitly to override).`;
          const gate = accessProviders(`${a.title}\n${a.spec}`);
          // Escalate only when there is something better to escalate TO. The chain's own selections are excluded
          // from the auto-pick, so a worker that is already the ceiling would be "escalated" to a weaker model.
          if (escalate && failed) {
            const top = recommend({ category, difficulty: difficulty || 2, exclude: [...(a.exclude || []), ...avoided], escalate: true, overflowApi: !!sessionFlags(sessionId).overflowApi, providers: gate?.providers || null });
            // L44: compare top against every selection in the chain, not only the latest attempt.
            if (top && (exclude.includes(selOf(top)) || atCeiling(top, failed))) return `Already at the ceiling for ${category}@${difficulty || 2}: ${selOf(top)} is the best available model, so a retry_of here could only route downward. Keep following up on ${failed.id} instead — worker.maxRounds=${cfg.worker.maxRounds} does not apply once the worker IS the ceiling — or finish it yourself if the rounds stop paying off. To switch anyway, name a provider/model explicitly.`;
          }
          pick = recommend({ category, difficulty: difficulty || 2, exclude, escalate, overflowApi: !!sessionFlags(sessionId).overflowApi, providers: gate?.providers || null });
          if (!pick) return noWorkerReason({ category, difficulty }, gate, !!sessionFlags(sessionId).overflowApi);
          // Visual passes prove a model AND its effort; effort-only overrides cannot change an automatic pick.
          provider = pick.provider; model = pick.model; effort = ['drafting', 'modeling'].includes(category) ? pick.effort : effort || pick.effort;
          difficulty = difficulty || 2; // L19: persist the routed level when auto-picked
        }
        // A pin runs as pinned (a reviewer lists its own family too, so failover leaves it); the configured default
        // worker, like the auto-pick, must stay outside avoid_families.
        const defaultFamily = !provider && !model ? familyOf(cfg.worker.provider, cfg.worker.model) : null;
        if (avoid.includes(defaultFamily)) return `The default worker ${cfg.worker.provider}:${cfg.worker.model || 'default'} is in an avoided family (${defaultFamily}; avoid_families: ${avoid.join(', ')}). Pin a provider/model, or tag category to auto-pick one outside those families.`;
        if (!effort && model && difficulty) effort = effortForTask({ provider: provider || cfg.worker.provider, model, difficulty, defaultEffort: cfg.worker.effort }) || undefined; // hand-routed: effort scales with difficulty, never below the default
        if (failed) {
          const resolvedProvider = provider || cfg.worker.provider;
          const resolved = { provider: resolvedProvider, model: model || (resolvedProvider === cfg.worker.provider ? cfg.worker.model : null), effort: effort || cfg.worker.effort };
          if (exclude.includes(selOf(resolved))) return `retry_of ${failed.id} would re-run ${selOf(resolved)}, which is already in the chain. Name a different provider/model, or tag category so the scorecard can pick.`;
        }
        const pinned = !!(a.provider && a.model);
        const explicitEfficiency = a.efficiency_mode ?? (a.no_failover == null ? undefined : !!a.no_failover);
        const t = createTask({ sessionId, cwd, title: a.title, spec: a.spec, provider, model, effort, paths: a.paths, sandbox: a.sandbox, writableRoots: a.writable_roots, isolate: a.isolate, category, difficulty, variant, retryOf: failed?.id || null, avoidFamilies: avoid, efficiencyMode: explicitEfficiency ?? (pinned ? true : undefined), overflowApi: !!sessionFlags(sessionId).overflowApi, parallelOverride: !!sessionFlags(sessionId).parallelOverride });
        const fb = escalate
          ? `\nEscalation attempt ${escalationsUsed + 1}/${escRounds} (best available model). On fail: ${remaining > 0 ? `delegate again with retry_of ${t.id} to escalate once more, else ` : ''}finish it yourself — the conductor is the final fallback.`
          : pick?.fallback ? `\nOn fail: delegate again with retry_of ${t.id} (auto-picks ${selOf(pick.fallback)}).` : '';
        const known = offered.get(sessionId) || offered.set(sessionId, new Set()).get(sessionId);
        const offer = category ? missingFor(category).filter((e) => !known.has(e.name)) : [];
        for (const e of offer) known.add(e.name);
        const offerNote = offer.length ? `\nNot installed on this machine but would make ${category} work cheaper or better: ${offer.map((e) => `${e.name} (${e.purpose.split('. ')[0]}; installer: ${e.install.url}${e.install.command ? `, or \`${e.install.command}\`` : ''})`).join('; ')}. Tell the user once; never install it yourself.` : '';
        if (shouldResearch(category)) {
          const rt = createTask({ sessionId, cwd, title: `research: programs for ${category} work`, spec: researchSpec(category, a.title), category: 'search', difficulty: 2, noFailover: true });
          awaitTask(rt.id, 20 * 60_000).then((done) => {
            if (done?.timedOut) { logImprovement('idea', 'capabilities', 'research did not finish', { taskId: rt.id }); return; }
            const found = parseResearched(done?.result?.finalMessage || '', category);
            const indexed = new Set(loadIndex().map((e) => e.name));
            const fresh = found.filter((e) => !indexed.has(e.name));
            if (fresh.length) saveConfig({ tools: { index: Object.fromEntries(fresh.map((e) => [e.name, e])) } });
            logImprovement('idea', 'capabilities', fresh.length ? `research proposed ${fresh.map((e) => e.name).join(', ')} for ${category} work — review them (conductor doctor) and set tools.index.<name>.approved = true to use them` : found.length ? `research proposed only names already indexed for ${category} work` : `research found no program for ${category} work`, { taskId: rt.id });
          }).catch(() => {});
        }
        const chosen = (pick ? `\nWorker auto-picked: ${selOf(t)} — ${pick.reason}${fb}` : '') + offerNote;
        if (a.background) return `Task ${t.id} ${backgroundStatus(t)} (${t.provider}/${t.model || 'default'}). Use await_task or task_status.${chosen}`;
        return (await finish(t, a.timeout_minutes)) + chosen;
      },
    },
    {
      name: 'follow_up',
      description: 'Send review comments to the same worker thread of a finished task (cheaper than a new task; keeps its context). Numbered, concrete points work best.',
      schema: z.object({ task_id: z.string(), comments: z.string(), background: z.boolean().optional(), timeout_minutes: z.number().max(1440).optional(), sandbox: z.enum(SANDBOX_VALUES).optional().describe('Override the inherited Codex sandbox, e.g. workspace-write to turn a read-only review thread into a fix round') }),
      handler: async (a) => {
        const t = createTask({ sessionId, cwd, spec: a.comments, followUpOf: a.task_id, sandbox: a.sandbox, parallelOverride: !!sessionFlags(sessionId).parallelOverride });
        if (a.background) return `Follow-up task ${t.id} ${backgroundStatus(t)} on thread of ${a.task_id}${t.warning ? `\nWarning: ${t.warning}` : ''}.`;
        return finish(t, a.timeout_minutes);
      },
    },
    {
      name: 'await_task',
      description: 'Wait for a background task to finish and return its report. Set wait_if_parked to keep waiting through provider-limit parks.',
      schema: z.object({ task_id: z.string(), timeout_minutes: z.number().max(1440).optional(), wait_if_parked: z.boolean().optional().describe('Keep waiting through parks until the timeout or task completion') }),
      handler: async (a) => {
        const t = getTask(a.task_id);
        const r = await trackedWait(a.task_id, awaitTask(a.task_id, capWait(a.timeout_minutes, t), { onPark: a.wait_if_parked ? 'never' : 'deadline' }));
        const task = r?.id ? getTask(r.id) || r : getTask(a.task_id);
        return r ? describeTask(task) + (r.followedFrom ? `\nFollowed from task ${r.followedFrom}.` : '') + (r.timedOut ? stillRunning : '') : `unknown task ${a.task_id}`;
      },
    },
    {
      name: 'task_status',
      description: 'Current status of a task. While it runs: a coarse progress snapshot (elapsed time, last activity or tool, tokens when known; refreshed about once a minute, not a live stream). After it ends: its latest actions.',
      schema: z.object({ task_id: z.string() }),
      handler: async (a) => {
        const t = getTask(a.task_id); if (!t) return `unknown task ${a.task_id}`;
        const last = (t.result?.items || []).slice(-8).map((i) => `  - ${i.type}${i.command ? `: ${i.command.slice(0, 160)}` : i.name ? `: ${i.name}` : i.text ? `: ${i.text.slice(0, 160)}` : ''}`).join('\n');
        return describeTask(t) + (last ? `\nRecent actions:\n${last}` : '');
      },
    },
    { name: 'cancel_task', description: 'Cancel a queued or running task.', schema: z.object({ task_id: z.string() }), handler: async (a) => { const r = cancelChain(a.task_id); if (!r) return `unknown task ${a.task_id}`; return r.canceled.length ? `Canceled ${r.canceled.join(', ')}${r.canceled[0] !== a.task_id ? ` (the live replacement of ${a.task_id})` : ''}.` : `Task ${a.task_id} is already ${r.already}; nothing to cancel.`; } },
    {
      name: 'worktree_cleanup',
      description: 'Remove the git worktree created for an isolated task (isolate: true). Optionally delete its conductor/<id> branch. Does not merge.',
      schema: z.object({ task_id: z.string(), delete_branch: z.boolean().optional().describe('Also git branch -D the isolation branch') }),
      handler: async (a) => cleanupWorktree(a.task_id, { deleteBranch: !!a.delete_branch }),
    },
    {
      name: 'rate_task',
      description: 'Record your verdict on a task after you verified it yourself (diff + tests): pass = accepted as delivered; fixable = accepted after follow-up rounds; close = a near miss that scores 0; fail = abandoned, redone elsewhere or by you; void = the model was not at fault (harness, sign-in, bad fixture): the run is dropped from every score. Rate the original task id once its fix rounds are over. This trains worker selection — rate honestly.',
      schema: z.object({ task_id: z.string(), verdict: z.enum([...VERDICTS, 'void']), notes: z.string().optional().describe('What was wrong, briefly') }),
      handler: async (a) => {
        let t = getTask(a.task_id);
        if (!t) return `unknown task ${a.task_id}`;
        // OB8: a task that failed over to another has no run row (limit hits are not scored); follow the chain
        // to the final task so the rating reaches the actual recorded attempt.
        const visited = new Set();
        while (t.failedOverTo && !visited.has(t.id)) { visited.add(t.id); const next = getTask(t.failedOverTo); if (!next) break; t = next; }
        rateTask(t.id, a.verdict, a.notes);
        return t.id === a.task_id ? `rated ${a.task_id}: ${a.verdict}` : `rated ${t.id} (followed failedOverTo from ${a.task_id}): ${a.verdict}`;
      },
    },
  ];
}
