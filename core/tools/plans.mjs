// Plan tools: run_plan, plan_status.
import { z } from 'zod';
import { CATEGORIES, ROUTED_MAX_DIFFICULTY, recommend } from '../scorecard.mjs';
import { SANDBOX_VALUES, runPlan, getPlan } from '../plans.mjs';
import { statePath } from '../paths.mjs';
import { sessionFlags } from '../session-flags.mjs';
import { checkVariant } from '../recipes.mjs';

export function defs({ sessionId, cwd, maxBlockMs }) {
  return [
    {
      name: 'run_plan',
      description: 'Execute a multi-stage plan deterministically (the orchestration playbook: planner pass, fan-out finders, adversarial refuters with votes, judge panels, until-dry loops, completeness critic). Stages run in order; each stage\'s tasks run in parallel on any providers YOU choose (leave provider/model empty to auto-pick). Findings flow between stages: ask finder tasks to end with a ```json {"findings":[{title,file,line,severity,detail,fix}]} block; refuter/judge tasks with {"real":true|false,"reason":...}. Returns a per-stage report; verify it yourself.',
      schema: z.object({
        goal: z.string().describe('One line: what the plan is for'),
        defaults: z.object({ provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), efficiency_mode: z.boolean().optional(), no_failover: z.boolean().optional(), sandbox: z.enum(SANDBOX_VALUES).optional(), isolate: z.boolean().optional(), category: z.enum(CATEGORIES).optional(), difficulty: z.number().int().min(1).max(ROUTED_MAX_DIFFICULTY).optional(), variant: z.string().optional(), avoid_families: z.array(z.string()).optional(), writable_roots: z.array(z.string()).optional() }).optional().describe('Defaults for every task (a task may override)'),
        stages: z.array(z.object({
          id: z.string(), title: z.string().optional(),
          defaults: z.object({ provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), efficiency_mode: z.boolean().optional(), no_failover: z.boolean().optional(), sandbox: z.enum(SANDBOX_VALUES).optional(), isolate: z.boolean().optional(), category: z.enum(CATEGORIES).optional(), difficulty: z.number().int().min(1).max(ROUTED_MAX_DIFFICULTY).optional(), variant: z.string().optional(), avoid_families: z.array(z.string()).optional(), writable_roots: z.array(z.string()).optional() }).optional(),
          tasks: z.array(z.object({ title: z.string().optional(), spec: z.string(), provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), efficiency_mode: z.boolean().optional(), no_failover: z.boolean().optional(), sandbox: z.enum(SANDBOX_VALUES).optional(), isolate: z.boolean().optional().describe('Per-task git worktree (same as delegate isolate)'), paths: z.array(z.string()).optional(), writable_roots: z.array(z.string()).optional().describe('Absolute paths of existing directories the worker may also write, e.g. a sibling git worktree (Codex --add-dir, Claude additionalDirectories, Antigravity --add-dir). The task still runs in the project directory.'), category: z.enum(CATEGORIES).optional(), difficulty: z.number().int().min(1).max(ROUTED_MAX_DIFFICULTY).optional(), variant: z.string().optional(), avoid_families: z.array(z.string()).optional().describe('Model families the auto-pick and a limit failover must not land on (as delegate)') })).optional().describe('Independent tasks (fan-out). Spec placeholders: {{goal}}, {{seen}} (findings so far), {{results:<stage>}}'),
          for_each: z.string().optional().describe('Run the task template once per finding of an earlier stage: "<stage>" (its findings) or "<stage>.confirmed" / "<stage>.rejected" / "<stage>.unverified"'),
          task: z.object({ title: z.string().optional(), spec: z.string().describe('Template; {{item}} is the finding JSON, {{lens}} the per-vote lens'), provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), efficiency_mode: z.boolean().optional(), no_failover: z.boolean().optional(), sandbox: z.enum(SANDBOX_VALUES).optional(), isolate: z.boolean().optional(), category: z.enum(CATEGORIES).optional(), difficulty: z.number().int().min(1).max(ROUTED_MAX_DIFFICULTY).optional(), variant: z.string().optional(), avoid_families: z.array(z.string()).optional(), writable_roots: z.array(z.string()).optional() }).optional(),
          votes: z.number().optional().describe('for_each: independent verdicts per item (1-7); with lenses[] each vote gets a different lens'),
          lenses: z.array(z.string()).optional(),
          pass: z.enum(['majority', 'any', 'all']).optional(),
        })).min(1),
        until_dry: z.object({ stage: z.string(), max_rounds: z.number().optional(), dry_rounds: z.number().optional() }).optional().describe('Repeat the named finder stage (with {{seen}} filled) until a round adds nothing new'),
        timeout_minutes: z.number().max(1440).optional(),
      }),
      handler: async (a) => {
        const picks = (a.stages || []).flatMap((s) => (s.for_each ? [s.task] : s.tasks || [])
          .map((p) => ({ ...a.defaults, ...s.defaults, ...p })));
        for (const p of picks) {
          const bad = checkVariant(p.category, p.variant);
          if (bad) return bad;
        }
        let planId;
        const pending = runPlan(a, { sessionId, cwd, recommend, overflowApi: !!sessionFlags(sessionId).overflowApi, parallelOverride: !!sessionFlags(sessionId).parallelOverride, onId: (id) => { planId = id; } });
        const format = (r) => `Plan ${r.id} — ${r.goal}\n\n${r.report}\n\nFull record: ${statePath('plans', `${r.id}.json`)}`;
        if (maxBlockMs == null) return format(await pending);
        let timer;
        try {
          const winner = await Promise.race([
            pending.then((r) => ({ r })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({}), maxBlockMs); }),
          ]);
          if (winner.r) return format(winner.r);
          return `Plan ${planId} still running — call plan_status with plan_id ${planId}.`;
        } finally { clearTimeout(timer); }
      },
    },
    {
      name: 'plan_status',
      description: 'Status and report of a run_plan: the in-flight record if still running, else the journaled result.',
      schema: z.object({ plan_id: z.string() }),
      handler: async (a) => {
        const p = getPlan(a.plan_id);
        if (!p) return `unknown plan ${a.plan_id}`;
        return `Plan ${p.id} — ${p.status}${p.goal ? ` — ${p.goal}` : ''}\n\n${p.report || '(still running)'}${p.startedAt ? `\nstartedAt: ${p.startedAt}` : ''}${p.finishedAt ? `\nfinishedAt: ${p.finishedAt}` : ''}`;
      },
    },
  ];
}
