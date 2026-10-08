// Read-mostly tools: scores, eligibility, framework, smoke, task list, models, limits, the improvement log, context tree.
import { z } from 'zod';
import { refreshModels } from '../models.mjs';
import { refreshLimits } from '../limits.mjs';
import { logImprovement, resolveImprovement } from '../improve.mjs';
import { folderTree } from '../context.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { CATEGORIES, formatScores, formatScoresShort, isArchived, setEligibility } from '../scorecard.mjs';
import { runSmoke, formatSmoke, SMOKE_TASKS } from '../smoke/index.mjs';
import { listTasks, describeTask } from '../tasks.mjs';
import { frameworkFor } from '../recipes.mjs';
import { selOf, formatModels, formatLimits, resumeAt } from './_shared.mjs';

export function defs({ sessionId, cwd, maxBlockMs }) {
  return [
    {
      name: 'model_scores',
      description: 'Scorecard. Default: the short view gives every category@level as a pick with n/date, capped selection/reset, or no data, plus benched cells. detail: true (or a category) gives the full table: per model and observed ladders, category and difficulty, verdict quality, consistency/repeats for smoke evidence, $ per task at API list price, % of the provider window, the plans with their reasons, and error rates. archived: true shows only archived history (full table, no routing plans or bench hygiene). `delegate` without a model already auto-picks from this; call this to inspect, not to choose.',
      schema: z.object({ category: z.enum(CATEGORIES).optional(), source: z.enum(['live', 'smoke']).optional().describe('Only real delegations or only smoke runs'), detail: z.boolean().optional().describe('Full table, plans with reasons and error rates (long)'), archived: z.boolean().optional().describe('Show only archived selections') }),
      handler: async (a) => {
        if (a.archived) return formatScores({ category: a.category || null, source: a.source || null, archived: true });
        const { dueForBench, formatBench } = await import('../bench.mjs'); const due = dueForBench();
        return (a.detail || a.category ? formatScores({ category: a.category || null, source: a.source || null }) : formatScoresShort({ source: a.source || null })) + (due.length ? `\n\nBench hygiene: ${formatBench(due)}` : '');
      },
    },
    {
      name: 'model_eligibility',
      description: 'Manually block or allow one exact provider:model:effort selection for one scorecard category. The latest decision wins. Block prevents automatic picks; allow lifts a computed bench. Explicit pins and smoke probes remain available.',
      schema: z.object({
        sel: z.string().describe('Exact provider:model:effort selection shown by model_scores'),
        category: z.enum(CATEGORIES),
        action: z.enum(['block', 'allow']),
        reason: z.string().min(1).describe('Why this manual override is needed; shown in score explanations'),
      }),
      handler: async (a) => {
        const row = setEligibility(a.sel, a.category, a.action, a.reason);
        return `${row.action === 'block' ? 'blocked' : 'allowed'} ${row.sel} for ${row.category}: ${row.reason}`;
      },
    },
    {
      name: 'framework',
      description: 'Fetch an optional starting framework for a scorecard category.',
      schema: z.object({ type: z.string().describe('Scorecard category, such as research or review.') }),
      handler: async ({ type }) => {
        const f = frameworkFor(type);
        return f ? `framework: ${f.id}\n${f.text}` : '(none)';
      },
    },
    {
      name: 'smoke_test',
      description: `Run the smoke battery against a model to seed its scorecard (runs in the background, one task at a time; results appear in model_scores). Tasks: ${SMOKE_TASKS.map((t) => t.id).join(', ')}. Use levels and repeats to measure consistency. Run it before trusting a new or cheap model with real work.`,
      schema: z.object({ provider: z.string(), model: z.string().optional(), effort: z.string().optional(), tasks: z.array(z.string()).optional().describe('Battery ids; default all'), levels: z.array(z.number().int().min(1).max(7)).optional().describe('Difficulty levels; default all'), repeats: z.number().int().min(1).max(5).optional().describe('Runs per battery task; default 1') }),
      handler: async (a) => {
        const sel = { provider: a.provider, model: a.model || null, effort: a.effort || null };
        if (!PROVIDERS[sel.provider]) return `unknown provider ${sel.provider}`;
        const levels = a.levels?.length ? [...new Set(a.levels)] : null;
        const ids = a.tasks?.length ? SMOKE_TASKS.filter((t) => a.tasks.includes(t.id) && (!levels || levels.includes(t.difficulty))).map((t) => t.id) : SMOKE_TASKS.filter((t) => !levels || levels.includes(t.difficulty)).map((t) => t.id);
        if (!ids.length) return `no such smoke tasks; have ${SMOKE_TASKS.map((t) => t.id).join(', ')}`;
        const repeats = a.repeats || 1;
        runSmoke({ models: [sel], tasks: ids, repeats, sessionId }).then((r) => logImprovement('idea', `smoke:${sessionId}`, `smoke ${selOf(sel)} finished\n${formatSmoke(r)}`)).catch((e) => logImprovement('error', 'smoke', String(e?.message || e)));
        const levelText = levels ? ` at levels ${levels.join(',')}` : '';
        return `Smoke test started: ${selOf(sel)} on ${ids.length} task(s)${levelText} x ${repeats} repeat(s) (${ids.join(', ')}). Each task may take a few minutes; check model_scores with source: "smoke" later.${isArchived(sel.provider, sel.model, undefined, sel.effort) ? '\narchived: results show under archived: true' : ''}`;
      },
    },
    {
      name: 'list_tasks', description: 'List tasks of this chat session.', schema: z.object({}),
      handler: async () => { const ts = listTasks({ sessionId }); return ts.length ? ts.map((t) => `${describeTask(t).split('\n')[0]}${t.status === 'parked' ? ` — parked until ${resumeAt(t)}` : t.status === 'stale' ? ' — stale (needs the user)' : ''}`).join('\n') : 'no tasks yet'; },
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
  ];
}
