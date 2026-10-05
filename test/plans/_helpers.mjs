import { HOME } from '../_env.mjs';
import { readJson, writeJson, statePath } from '../../core/paths.mjs';
import { saveConfig, loadConfig } from '../../core/config.mjs';
import { bus } from '../../core/bus.mjs';
import { registerHooks } from 'node:module';
import { setSessionFlags } from '../../core/session-flags.mjs';
import { createTask, getTask } from '../../core/tasks.mjs';

export { HOME, readJson, writeJson, statePath, saveConfig, loadConfig, bus, setSessionFlags, createTask, getTask };

export const { validatePlan, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan, abortPlans, getPlan } = await import('../../core/plans.mjs');
export const { buildPrompt } = await import('../../core/tasks.mjs');

// Legacy injected runtimes in this file test plan results, not asynchronous worker warm-up.
saveConfig({ plans: { warmupSeconds: 0 } });

// Handler regressions for plan routing and retry ancestry.
// Execute the actual handlers and plan executor. Only selection, capability research and task waits
// are mocked; createTask persists real records under _env and its scheduler is disabled.
const calls = [];
const pick = { provider: 'stub', model: 'next', effort: 'high', reason: 'fixture' };
globalThis.toolFixtures = {
  recommend(input) { calls.push(input); return pick; },
  async awaitTask(id) {
    const task = getTask(id);
    task.status = 'done';
    task.result = { finalMessage: task.spec === 'find' ? '{"findings":[{"title":"Bug"}]}' : '{"real":true}' };
    return task;
  },
};
const urls = Object.fromEntries(['tools', 'plans', 'tasks', 'scorecard', 'capabilities'].map((name) => [name, new URL(`../../core/${name}.mjs`, import.meta.url).href]));
const sources = {
  tasks: `export * from ${JSON.stringify(urls.tasks)}; export const awaitTask = (...args) => globalThis.toolFixtures.awaitTask(...args);`,
  scorecard: `export * from ${JSON.stringify(urls.scorecard)}; export const recommend = (...args) => globalThis.toolFixtures.recommend(...args);`,
  capabilities: 'export const accessProviders = () => null, missingFor = () => [], shouldResearch = () => false, researchSpec = () => "", parseResearched = () => [], loadIndex = () => [];',
};
// Folder modules import ../tasks.mjs; the facade spelling is ./tasks.mjs. A ?query does not fork
// cached folder modules, so plans.mjs?tool-fixture's imports of core/plans/* and core/tools/* keep it.
const MOCKED = { './tasks.mjs': 'tasks', '../tasks.mjs': 'tasks', './scorecard.mjs': 'scorecard', '../scorecard.mjs': 'scorecard', './capabilities.mjs': 'capabilities', '../capabilities.mjs': 'capabilities' };
const pathOf = (url) => (url || '').split('?')[0];
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || '';
    const path = pathOf(parent);
    if (/\/core\/(?:plans|tools)(\.mjs|\/)/.test(path)) {
      if (MOCKED[specifier]) return { url: `tool-fixture:${MOCKED[specifier]}`, shortCircuit: true };
      const plansFromTools = (/\/core\/tools\.mjs$/.test(path) && specifier === './plans.mjs') || (/\/core\/tools\//.test(path) && specifier === '../plans.mjs');
      if (plansFromTools) return { url: `${urls.plans}?tool-fixture`, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    const query = parent.includes('?') ? parent.slice(parent.indexOf('?')) : '';
    if (query && /\/core\/(?:plans|tools)\/[^/?]+$/.test(resolved.url)) return { ...resolved, url: resolved.url + query, shortCircuit: true };
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url.startsWith('tool-fixture:')) return { format: 'module', source: sources[url.slice('tool-fixture:'.length)], shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { conductorToolDefs, selOf } = await import('../../core/tools.mjs');
hooks.deregister();
const handler = (name, sessionId = name) => conductorToolDefs({ sessionId, cwd: HOME }).find((tool) => tool.name === name).handler;
const attempt = (input = {}) => {
  const task = createTask({ cwd: HOME, spec: 'fixture', provider: 'stub', model: 'original', effort: 'low', category: 'code', difficulty: 2, ...input });
  Object.assign(task, { status: 'done', threadId: `thread-${task.id}`, attempts: 1 });
  return task;
};
const delegate = (failed) => handler('delegate')({ title: 'retry', spec: 'fixture', retry_of: failed.id, background: true });

export { calls, pick, handler, attempt, delegate, conductorToolDefs, selOf };
