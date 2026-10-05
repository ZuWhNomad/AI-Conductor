// Plan shape. Imports nothing from this folder.

/** Shared enum for sandbox values (used in run_plan and delegate schemas). */
export const SANDBOX_VALUES = /** @type {const} */ (['read-only', 'workspace-write', 'danger-full-access']);

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
