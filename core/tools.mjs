// Conductor tools, defined once and exposed three ways: Claude Agent SDK MCP server (Claude
// conductors), streamable-HTTP MCP (Codex conductors, see server/index.mjs) and OpenAI function
// tools (Ollama / API-model conductors).
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createTask, awaitTask, getTask, cancelTask, listTasks, describeTask } from './tasks.mjs';
import { getModels, refreshModels } from './models.mjs';
import { getLimits, refreshLimits } from './limits.mjs';
import { logImprovement, resolveImprovement } from './improve.mjs';
import { folderTree } from './context.mjs';
import { PROVIDERS } from './providers/index.mjs';
import * as ollama from './providers/ollama.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { CATEGORIES, VERDICTS, rateTask, recommend, formatScores, formatScoresShort, effortForTask } from './scorecard.mjs';
import { runSmoke, formatSmoke, SMOKE_TASKS } from './smoke/index.mjs';
import { runPlan } from './plans.mjs';
import { sessionFlags } from './session-flags.mjs';
import { accessProviders, missingFor, shouldResearch, researchSpec, parseResearched } from './capabilities.mjs';

const offered = new Map(); // sessionId -> Set of capability names already offered in that chat

const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString() : '?');

/**
 * Where a retry_of sits on the review→escalation ladder (pure, so it is unit-tested). `depth` is the number of
 * attempts already in the retry chain (the chain root — the original worker — is #1, not a retry). Escalation begins
 * once the reviewed worker's rounds are spent, or after a prior model switch (depth ≥ 2). `escalationsUsed` counts
 * only prior BEST-AVAILABLE attempts: when the root was not reviewed to exhaustion the first retry was a value
 * fallback and is not counted, so `escalationRounds` grants that many genuine escalations (not one fewer).
 */
export function escalationState({ hasFailed = false, depth = 0, rootRounds = 0, failedRounds = 0, maxRounds = 3, escRounds = 2 } = {}) {
  const reviewExhausted = hasFailed && failedRounds >= maxRounds;
  const escalate = hasFailed && (reviewExhausted || depth >= 2);
  const rootReviewed = rootRounds >= maxRounds;
  const retries = hasFailed ? Math.max(0, depth - 1) : 0;
  const escalationsUsed = rootReviewed ? retries : Math.max(0, retries - 1);
  return { escalate, escalationsUsed, blocked: escalate && escalationsUsed >= escRounds, remaining: escRounds - (escalationsUsed + 1) };
}

export function formatModels(reg = getModels()) {
  const byProv = new Map();
  for (const m of reg.models) { if (!byProv.has(m.provider)) byProv.set(m.provider, []); byProv.get(m.provider).push(m); }
  const lines = [`Model registry (updated ${reg.updatedAt || 'never'}):`];
  for (const p of Object.values(PROVIDERS)) {
    const st = reg.providers[p.id] || {};
    const ms = byProv.get(p.id) || [];
    const why = st.status === 'ok' ? '' : ` — ${st.error || (st.loggedIn === false ? 'not logged in' : st.configured === false ? 'no API key' : st.installed === false ? 'not installed' : st.status || 'unknown')}`;
    lines.push(`- ${p.id} (${p.auth.type}${st.plan ? `, plan ${st.plan}` : ''}, ${st.status || 'unpolled'}${why}): ${ms.length ? ms.map((m) => `${m.id}${m.resolved && m.resolved !== m.id ? `→${m.resolved}` : ''}${m.isDefault ? '*' : ''}${m.efforts?.length ? ` [${m.efforts.join('/')}]` : ''}`).join('; ') : '(no models)'}`);
  }
  return lines.join('\n');
}

export function formatLimits(reg = getLimits()) {
  const lines = [`Limits (updated ${reg.updatedAt || 'never'}):`];
  for (const [id, p] of Object.entries(reg.providers)) {
    const w = (p.windows || []).map((x) => `${x.label} ${x.usedPercent ?? '?'}%${x.remaining ? ` (${x.remaining})` : ''}${x.resetsAt ? ` (resets ${fmtWhen(x.resetsAt)})` : ''}`).join(', ');
    const bal = p.balance ? `balance ${p.balance.amount} ${p.balance.currency}${p.balance.granted > 0 ? ` (${p.balance.granted} granted/free)` : ''}${p.balance.available ? '' : ' (exhausted)'}` : '';
    lines.push(`- ${id}${p.plan ? ` (plan ${p.plan})` : ''}${p.blocked ? ` BLOCKED until ${fmtWhen(p.blockedUntil)} (${p.blockedReason || 'limit'})` : ''}: ${[bal, w].filter(Boolean).join(', ') || (p.available === false ? 'no plan limits available (not logged in?)' : p.error ? `error: ${p.error}` : 'no windows reported')}${w && p.error ? ` (stale: ${p.error.slice(0, 80)})` : ''}`);
  }
  return lines.join('\n');
}

/**
 * The tool table for one conductor session. Each entry: { name, description, schema (zod object), handler(args) -> string }.
 */
export function conductorToolDefs({ sessionId, cwd }) {
  const cfg = loadConfig();
  const effortDesc = 'Reasoning effort: low|medium|high|xhigh|max (Codex also: ultra). Default from settings.';
  const finish = async (t, minutes) => {
    const done = await awaitTask(t.id, (minutes || 45) * 60_000);
    return describeTask(getTask(t.id)) + (done?.timedOut ? '\n(still running — call await_task again)' : '');
  };
  return [
    {
      name: 'delegate',
      description: 'Run a worker on a self-contained task in the project directory. Write a full spec (goal, files, constraints, acceptance criteria, verification command). Tag it with category + difficulty; leave provider/model empty to let the scorecard pick the cheapest model that has proven itself for that kind of work. Blocks until done unless background=true. Returns the worker report, changed files and diff stat (files that changed in the repo while it ran — concurrent tasks in the same directory show up in each other\'s lists) — verify them yourself, then rate_task.',
      schema: z.object({
        title: z.string().describe('Short task title'),
        spec: z.string().describe('The complete spec the worker will see (it has not seen this conversation)'),
        category: z.enum(CATEGORIES).optional().describe('Kind of work. With difficulty this selects the worker from the scorecard and trains it.'),
        difficulty: z.number().int().min(1).max(5).optional().describe('1 mechanical single-file edit/lookup · 2 small feature from a precise spec, one module · 3 multi-file or needs surrounding understanding · 4 ambiguous, debugging, cross-cutting · 5 design-heavy, high blast radius'),
        exclude: z.array(z.string()).optional().describe('provider:model[:effort] selections the auto-pick must skip'),
        retry_of: z.string().optional().describe('Task id of the failed attempt this replaces. Its model is excluded from the auto-pick, category/difficulty are inherited, and the cost of both attempts is scored as one chain (this is how ladders get measured).'),
        provider: z.string().optional().describe(`Provider id (${Object.keys(PROVIDERS).join(', ')}). Omit with model to auto-pick; fallback default: ${cfg.worker.provider}`),
        model: z.string().optional().describe('Model id for that provider; see list_models'),
        effort: z.string().optional().describe(effortDesc),
        paths: z.array(z.string()).optional().describe('Files/folders in scope; their CONTEXT.md notes are injected'),
        background: z.boolean().optional().describe('Return immediately with a task id; collect with await_task'),
        timeout_minutes: z.number().optional().describe('Max wait when blocking (default 45)'),
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('Codex sandbox for this task (default from settings). Use read-only for reviews. Honoured by Codex (OS sandbox) and by API/Ollama workers (no write, edit or run tool at all); Claude and vendor-CLI workers ignore it, so tell those reviewers "do not modify files" in the spec.'),
      }),
      handler: async (a) => {
        let { provider, model, effort, category, difficulty } = a; let pick = null;
        const failed = a.retry_of ? getTask(a.retry_of) : null;
        if (a.retry_of && !failed) return `unknown task ${a.retry_of} (retry_of)`;
        const exclude = [...(a.exclude || [])];
        let depth = 0, root = failed;
        if (failed) {
          // exclude every model already tried in this chain; remember the chain root (the original worker)
          for (let f = failed; f; f = f.retryOf ? getTask(f.retryOf) : null) { exclude.push(`${f.provider}:${f.model || 'default'}:${f.effort || 'default'}`); depth++; root = f; }
          category = category || failed.category || undefined; difficulty = difficulty || failed.difficulty || undefined;
        }
        // Review → escalation ladder (see escalationState). First delegate: best VALUE. Once the worker's review
        // rounds are spent — or after a prior model switch — a retry_of escalates to the best AVAILABLE model by
        // quality (`escalate` flips recommend() from value to best-available), bounded to worker.escalationRounds.
        const escRounds = cfg.worker.escalationRounds ?? 2;
        const { escalate, escalationsUsed, blocked, remaining } = escalationState({ hasFailed: !!failed, depth, rootRounds: root?.rounds || 0, failedRounds: failed?.rounds || 0, maxRounds: cfg.worker.maxRounds || 3, escRounds });
        if (!provider && !model && category) {
          if (blocked) return `Escalation budget spent: the best-available model was already tried ${escalationsUsed} time(s) (worker.escalationRounds=${escRounds}) after the review rounds, and the task still failed. Per the ladder, the conductor is the final fallback — finish this one yourself now (or name a provider/model explicitly to override).`;
          const gate = accessProviders(`${a.title}\n${a.spec}`);
          pick = recommend({ category, difficulty: difficulty || 2, exclude, escalate, overflowApi: !!sessionFlags(sessionId).overflowApi, providers: gate?.providers || null });
          if (!pick && gate) return `No worker is available: the task matches the access rule ${gate.names.join(', ')} (only ${gate.providers.join(', ')} can take it) and none of those is proven for ${category}@${difficulty || 2} and available now.`;
          if (!pick) return `No worker is available for ${category}@${difficulty || 2} under the current budget rules (subscription classes capped or unproven at this level; API overflow is ${sessionFlags(sessionId).overflowApi ? 'on' : 'off for this chat'}). Do the task yourself, wait for a window reset (see limits), or ask the user to enable API overflow.`;
          if (pick) { provider = pick.provider; model = pick.model; effort = effort || pick.effort; }
        }
        if (!effort && model && difficulty) effort = effortForTask({ provider: provider || cfg.worker.provider, model, difficulty, defaultEffort: cfg.worker.effort }) || undefined; // hand-routed: effort scales with difficulty, never below the default
        const t = createTask({ sessionId, cwd, title: a.title, spec: a.spec, provider, model, effort, paths: a.paths, sandbox: a.sandbox, category, difficulty, retryOf: failed?.id || null, overflowApi: !!sessionFlags(sessionId).overflowApi });
        const fb = escalate
          ? `\nEscalation attempt ${escalationsUsed + 1}/${escRounds} (best available model). On fail: ${remaining > 0 ? `delegate again with retry_of ${t.id} to escalate once more, else ` : ''}finish it yourself — the conductor is the final fallback.`
          : pick?.fallback ? `\nOn fail: delegate again with retry_of ${t.id} (auto-picks ${pick.fallback.provider}:${pick.fallback.model || 'default'}:${pick.fallback.effort || 'default'}).` : '';
        const known = offered.get(sessionId) || offered.set(sessionId, new Set()).get(sessionId);
        const offer = category ? missingFor(category).filter((e) => !known.has(e.name)) : [];
        for (const e of offer) known.add(e.name);
        const offerNote = offer.length ? `\nNot installed on this machine but would make ${category} work cheaper or better: ${offer.map((e) => `${e.name} (${e.purpose.split('. ')[0]}; installer: ${e.install.url}${e.install.command ? `, or \`${e.install.command}\`` : ''})`).join('; ')}. Tell the user once; never install it yourself.` : '';
        if (shouldResearch(category)) {
          const rt = createTask({ sessionId, cwd, title: `research: programs for ${category} work`, spec: researchSpec(category, a.title), category: 'search', difficulty: 2, noFailover: true });
          awaitTask(rt.id, 20 * 60_000).then((done) => { const found = parseResearched(done?.result?.finalMessage || '', category); if (found.length) saveConfig({ tools: { index: Object.fromEntries(found.map((e) => [e.name, e])) } }); logImprovement('idea', 'capabilities', found.length ? `research proposed ${found.map((e) => e.name).join(', ')} for ${category} work — review them (conductor doctor) and set tools.index.<name>.approved = true to use them` : `research found no program for ${category} work`, { taskId: rt.id }); }).catch(() => {});
        }
        const chosen = (pick ? `\nWorker auto-picked: ${t.provider}:${t.model}:${t.effort} — ${pick.reason}${fb}` : category && !a.provider && !a.model ? `\nWorker: configured default ${t.provider}:${t.model || 'default'} (scorecard has no qualified plan for ${category}@${difficulty || 2} yet)` : '') + offerNote;
        if (a.background) return `Task ${t.id} queued (${t.provider}/${t.model || 'default'}). Use await_task or task_status.${chosen}`;
        return (await finish(t, a.timeout_minutes)) + chosen;
      },
    },
    {
      name: 'follow_up',
      description: 'Send review comments to the same worker thread of a finished task (cheaper than a new task; keeps its context). Numbered, concrete points work best.',
      schema: z.object({ task_id: z.string(), comments: z.string(), background: z.boolean().optional(), timeout_minutes: z.number().optional(), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('Override the inherited Codex sandbox, e.g. workspace-write to turn a read-only review thread into a fix round') }),
      handler: async (a) => {
        const t = createTask({ sessionId, cwd, spec: a.comments, followUpOf: a.task_id, sandbox: a.sandbox });
        if (a.background) return `Follow-up task ${t.id} queued on thread of ${a.task_id}${t.warning ? `\nWarning: ${t.warning}` : ''}.`;
        return finish(t, a.timeout_minutes);
      },
    },
    {
      name: 'await_task',
      description: 'Wait for a background task to finish and return its report.',
      schema: z.object({ task_id: z.string(), timeout_minutes: z.number().optional() }),
      handler: async (a) => { const r = await awaitTask(a.task_id, (a.timeout_minutes || 30) * 60_000); return r ? describeTask(getTask(a.task_id)) + (r.timedOut ? '\n(still running)' : '') : `unknown task ${a.task_id}`; },
    },
    {
      name: 'task_status',
      description: 'Current status and latest actions of a task.',
      schema: z.object({ task_id: z.string() }),
      handler: async (a) => {
        const t = getTask(a.task_id); if (!t) return `unknown task ${a.task_id}`;
        const last = (t.result?.items || []).slice(-8).map((i) => `  - ${i.type}${i.command ? `: ${i.command.slice(0, 160)}` : i.name ? `: ${i.name}` : i.text ? `: ${i.text.slice(0, 160)}` : ''}`).join('\n');
        return describeTask(t) + (last ? `\nRecent actions:\n${last}` : '');
      },
    },
    { name: 'cancel_task', description: 'Cancel a queued or running task.', schema: z.object({ task_id: z.string() }), handler: async (a) => (cancelTask(a.task_id) ? `Task ${a.task_id} canceled.` : `unknown task ${a.task_id}`) },
    {
      name: 'allow_command',
      description: 'Add a command to the worker.shell allow-list so API/Ollama (non-Codex/Claude) workers may run it. Use this when a worker reports "run blocked: X is not in worker.shell allow-list" and X is a legitimate build/verify tool (e.g. openscad, cmake, pytest). Bare command name only. Refused for shells/interpreters (bash, sh, cmd, powershell) since those re-enable arbitrary execution. Every addition is logged.',
      schema: z.object({ command: z.string().describe('Bare command name to allow, e.g. "openscad" (no path, no arguments, no shell operators)') }),
      handler: async (a) => {
        const raw = String(a.command || '').trim();
        const base = raw.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
        if (!base || /[^\w.\-]/.test(base)) return `refused: "${raw}" must be a bare command name (letters, digits, . _ -) with no path, arguments, or shell operators.`;
        if (['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh', 'env', 'wsl', 'ssh'].includes(base.toLowerCase())) return `refused: "${base}" is a shell/interpreter — allowing it would re-enable arbitrary execution and defeat the boundary.`;
        const shell = loadConfig().worker?.shell;
        if (shell === true) return 'worker.shell is already unrestricted (true); no allow-list to extend.';
        if (shell === false || shell === 'off') return 'worker.shell is off (the run tool is disabled). Turn it into an allow-list in Settings first.';
        const list = Array.isArray(shell) ? shell : [];
        if (list.some((x) => x.replace(/\.(exe|cmd|bat|com|ps1)$/i, '') === base)) return `"${base}" is already on the allow-list.`;
        saveConfig({ worker: { shell: [...list, base] } });
        logImprovement('idea', 'conductor', `added "${base}" to worker.shell allow-list`, {});
        return `Added "${base}" to the worker.shell allow-list (now ${list.length + 1} commands). API/Ollama workers can run it.`;
      },
    },
    {
      name: 'rate_task',
      description: 'Record your verdict on a task after you verified it yourself (diff + tests): pass = accepted as delivered; fixable = accepted after follow-up rounds; fail = abandoned, redone elsewhere or by you. Rate the original task id once its fix rounds are over. This trains worker selection — rate honestly.',
      schema: z.object({ task_id: z.string(), verdict: z.enum(VERDICTS), notes: z.string().optional().describe('What was wrong, briefly') }),
      handler: async (a) => { if (!getTask(a.task_id)) return `unknown task ${a.task_id}`; rateTask(a.task_id, a.verdict, a.notes); return `rated ${a.task_id}: ${a.verdict}`; },
    },
    {
      name: 'model_scores',
      description: 'Scorecard. Default: the short view: best pick + runner-up per category and level, plus benched cells. detail: true (or a category) gives the full table: per model and observed ladders, category and difficulty, verdict quality, $ per task at API list price, % of the provider window, the plans with their reasons, and error rates. `delegate` without a model already auto-picks from this; call this to inspect, not to choose.',
      schema: z.object({ category: z.enum(CATEGORIES).optional(), source: z.enum(['live', 'smoke']).optional().describe('Only real delegations or only smoke runs'), detail: z.boolean().optional().describe('Full table, plans with reasons and error rates (long)') }),
      handler: async (a) => { const { dueForBench, formatBench } = await import('./bench.mjs'); const due = dueForBench(); return (a.detail || a.category ? formatScores({ category: a.category || null, source: a.source || null }) : formatScoresShort({ source: a.source || null })) + (due.length ? `\n\nBench hygiene: ${formatBench(due)}` : ''); },
    },
    {
      name: 'smoke_test',
      description: `Run the smoke battery against a model to seed its scorecard (runs in the background, one task at a time; results appear in model_scores). Tasks: ${SMOKE_TASKS.map((t) => t.id).join(', ')}. Run it before trusting a new or cheap model with real work.`,
      schema: z.object({ provider: z.string(), model: z.string().optional(), effort: z.string().optional(), tasks: z.array(z.string()).optional().describe('Battery ids; default all') }),
      handler: async (a) => {
        const sel = { provider: a.provider, model: a.model || null, effort: a.effort || null };
        if (!PROVIDERS[sel.provider]) return `unknown provider ${sel.provider}`;
        const ids = a.tasks?.length ? SMOKE_TASKS.filter((t) => a.tasks.includes(t.id)).map((t) => t.id) : SMOKE_TASKS.map((t) => t.id);
        if (!ids.length) return `no such smoke tasks; have ${SMOKE_TASKS.map((t) => t.id).join(', ')}`;
        runSmoke({ models: [sel], tasks: ids, sessionId }).then((r) => logImprovement('idea', `smoke:${sessionId}`, `smoke ${sel.provider}:${sel.model || 'default'}:${sel.effort || 'default'} finished\n${formatSmoke(r)}`)).catch((e) => logImprovement('error', 'smoke', String(e?.message || e)));
        return `Smoke test started: ${sel.provider}:${sel.model || 'default'}:${sel.effort || 'default'} on ${ids.length} task(s) (${ids.join(', ')}). Each task may take a few minutes; check model_scores with source: "smoke" later.`;
      },
    },
    {
      name: 'list_tasks', description: 'List tasks of this chat session.', schema: z.object({}),
      handler: async () => { const ts = listTasks({ sessionId }); return ts.length ? ts.map((t) => `${t.id} [${t.status}] ${t.title} (${t.provider}/${t.model || 'default'}, round ${t.rounds + 1})`).join('\n') : 'no tasks yet'; },
    },
    {
      name: 'list_models', description: 'Models available right now across providers, with status and effort levels.',
      schema: z.object({ refresh: z.boolean().optional().describe('Force a re-poll of every provider') }),
      handler: async (a) => { if (a.refresh) await refreshModels(); return formatModels(); },
    },
    {
      name: 'limits', description: 'Usage limits per provider (never assumed static). Check before large batches.',
      schema: z.object({ refresh: z.boolean().optional() }),
      handler: async (a) => { if (a.refresh) await refreshLimits(); return formatLimits(); },
    },
    {
      name: 'log_improvement', description: 'Record an error, friction or idea about this workbench for the periodic self-review.',
      schema: z.object({ kind: z.enum(['error', 'idea', 'friction']), message: z.string(), context: z.string().optional() }),
      handler: async (a) => {
        const resolved = /^resolved\s+([a-z0-9]{6,12})\b/i.exec(a.message);
        if (resolved) { resolveImprovement(resolved[1]); return `resolved ${resolved[1]}`; }
        return `logged ${logImprovement(a.kind, `conductor:${sessionId}`, a.message, a.context ? { note: a.context } : {}).id}`;
      },
    },
    {
      name: 'context_tree', description: 'Folder tree of the project with existing context notes (CLAUDE.md / CONTEXT.md / AGENTS.md) marked. Use it to decide where notes are missing.',
      schema: z.object({ depth: z.number().optional() }),
      handler: async (a) => folderTree(cwd, { depth: Math.min(8, Math.max(1, Number(a.depth) || 3)) }),
    },
    {
      name: 'install_model', description: 'Download a local model into Ollama (runs in the background; check list_models later).',
      schema: z.object({ provider: z.literal('ollama'), model: z.string() }),
      handler: async (a) => { ollama.pullModel(a.model).then(() => refreshModels({ only: ['ollama'] })).catch((e) => logImprovement('error', 'ollama', `pull ${a.model} failed: ${e.message}`)); return `Pulling ${a.model} in the background.`; },
    },
    {
      name: 'generate_image', description: 'Generate image(s) into the project (openai-images needs an OpenAI key, stability a Stability key, sd a local A1111 server).',
      schema: z.object({ prompt: z.string(), provider: z.enum(['openai-images', 'stability', 'sd']).optional(), size: z.string().optional(), n: z.number().optional(), out_dir: z.string().optional() }),
      handler: async (a) => { const t = createTask({ sessionId, cwd, title: `image: ${a.prompt.slice(0, 40)}`, spec: a.prompt, provider: a.provider || 'openai-images', imageOptions: { size: a.size, n: a.n, outDir: a.out_dir } }); await awaitTask(t.id, 10 * 60_000); return describeTask(getTask(t.id)); },
    },
    {
      name: 'run_plan',
      description: 'Execute a multi-stage plan deterministically (the orchestration playbook: planner pass, fan-out finders, adversarial refuters with votes, judge panels, until-dry loops, completeness critic). Stages run in order; each stage\'s tasks run in parallel on any providers YOU choose (leave provider/model empty to auto-pick). Findings flow between stages: ask finder tasks to end with a ```json {"findings":[{title,file,line,severity,detail,fix}]} block; refuter/judge tasks with {"real":true|false,"reason":...}. Returns a per-stage report; verify it yourself.',
      schema: z.object({
        goal: z.string().describe('One line: what the plan is for'),
        defaults: z.object({ provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), sandbox: z.string().optional(), category: z.string().optional(), difficulty: z.number().optional() }).optional().describe('Defaults for every task (a task may override)'),
        stages: z.array(z.object({
          id: z.string(), title: z.string().optional(),
          defaults: z.object({ provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), sandbox: z.string().optional(), category: z.string().optional(), difficulty: z.number().optional() }).optional(),
          tasks: z.array(z.object({ title: z.string().optional(), spec: z.string(), provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), sandbox: z.string().optional(), paths: z.array(z.string()).optional(), category: z.string().optional(), difficulty: z.number().optional() })).optional().describe('Independent tasks (fan-out). Spec placeholders: {{goal}}, {{seen}} (findings so far), {{results:<stage>}}'),
          for_each: z.string().optional().describe('Run the task template once per finding of an earlier stage: "<stage>" (its findings) or "<stage>.confirmed" / "<stage>.rejected"'),
          task: z.object({ title: z.string().optional(), spec: z.string().describe('Template; {{item}} is the finding JSON, {{lens}} the per-vote lens'), provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), sandbox: z.string().optional(), category: z.string().optional(), difficulty: z.number().optional() }).optional(),
          votes: z.number().optional().describe('for_each: independent verdicts per item (1-7); with lenses[] each vote gets a different lens'),
          lenses: z.array(z.string()).optional(),
          pass: z.enum(['majority', 'any', 'all']).optional(),
        })).min(1),
        until_dry: z.object({ stage: z.string(), max_rounds: z.number().optional(), dry_rounds: z.number().optional() }).optional().describe('Repeat the named finder stage (with {{seen}} filled) until a round adds nothing new'),
        timeout_minutes: z.number().optional(),
      }),
      handler: async (a) => {
        const r = await runPlan(a, { sessionId, cwd, recommend });
        return `Plan ${r.id} — ${r.goal}\n\n${r.report}\n\nFull record: ~/.conductor2/plans/${r.id}.json`;
      },
    },
  ];
}

const jsonSchema = (schema) => { const s = z.toJSONSchema(schema); delete s.$schema; return s; };

/** Claude Agent SDK in-process MCP server. */
export function conductorTools({ sessionId, cwd }) {
  const cfg = loadConfig();
  return createSdkMcpServer({
    name: 'conductor',
    version: '2.0.0',
    alwaysLoad: true, // delegation tools are the point; never hide them behind tool search
    instructions: `Workbench tools. Worker selection is empirical: tag delegate calls with category + difficulty and omit provider/model to let the scorecard pick; fallback default worker ${cfg.worker.provider}/${cfg.worker.model} (${cfg.worker.effort}). Rate finished tasks with rate_task. Tasks run in ${cwd}.`,
    tools: conductorToolDefs({ sessionId, cwd }).map((d) => tool(d.name, d.description, d.schema.shape, async (args) => ({ content: [{ type: 'text', text: String(await d.handler(args)) }] }))),
  });
}

/** MCP `tools/list` shape (for the streamable-HTTP endpoint used by Codex conductors). */
export const toolsAsMcp = (defs) => defs.map((d) => ({ name: d.name, description: d.description, inputSchema: jsonSchema(d.schema) }));

/** OpenAI function-calling shape (for loop conductors). */
export const toolsAsFunctions = (defs) => defs.map((d) => ({ def: { name: d.name, description: d.description, parameters: jsonSchema(d.schema) }, impl: (args) => d.handler(d.schema.parse(args || {})) }));

/** Claude-family subagents available to a Claude conductor through the built-in Agent tool. */
export const CONDUCTOR_AGENTS = {
  'haiku-swarm': {
    description: 'Cheap, fast Claude worker for reading, searching, summarizing and small mechanical edits. Spawn several in parallel for fan-out.',
    prompt: 'You are a fast worker in a swarm. Do exactly the narrow task you were given, verify what you can, and return a compact result (facts, file paths, line numbers). No speculation, no scope creep.',
    model: 'haiku',
  },
  'sonnet-worker': {
    description: 'Mid-strength Claude worker for self-contained coding tasks when Codex is unavailable or the task needs Claude Code tools/skills.',
    prompt: 'You are a coding worker. Follow the spec exactly, run the verification command, and end with a report: done / files changed / verified / doubts.',
    model: 'sonnet',
  },
  reviewer: {
    description: 'Adversarial reviewer for diffs: finds bugs, security issues, unverified claims and scope creep. Read-only plus running tests.',
    prompt: 'You are an adversarial code reviewer. Read the diff and the surrounding code, run the tests, and report only real problems ranked by severity with file:line references. Say "no findings" when the change is sound.',
    model: 'inherit',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
};
