// Deterministic multi-stage plans (fan-out, refuter votes, judge panels, until-dry loops, critic)
// executed on the task scheduler. Model-agnostic: every task carries whatever provider/model/effort
// the conductor chose (or nothing, for the auto-pick). Pure helpers are exported for tests.
//
// Split into core/plans/ (validate -> findings -> expand -> executor, each importing only the ones
// before it); this module re-exports the whole surface so existing imports keep working. New code
// imports the module it needs. awaitTask and accessProviders are imported here, not in executor.mjs:
// test/plans/_helpers.mjs replaces those two modules only when this file is the importer.
import { awaitTask } from './tasks.mjs';
import { accessProviders } from './capabilities.mjs';
import { createPlanRuntime } from './plans/executor.mjs';

export * from './plans/validate.mjs';
export * from './plans/findings.mjs';
export * from './plans/expand.mjs';
export * from './plans/executor.mjs';

export const { runPlan, getPlan, abortPlans, noWorkerReason } = createPlanRuntime({ awaitTask, accessProviders });
