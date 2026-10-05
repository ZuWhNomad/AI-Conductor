import { HOME, tmpDir } from '../_env.mjs';
import { after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

const { PROVIDERS } = await import('../../core/providers/index.mjs');
const originalProviders = { ...PROVIDERS };
for (const [id, provider] of Object.entries(PROVIDERS)) {
  PROVIDERS[id] = { ...provider, pollLimits: mock.fn(async () => ({ provider: id, windows: [], blocked: false })) };
}
const unexpectedIO = [];
const rejectIO = (operation) => {
  unexpectedIO.push(operation);
  throw new Error(`unexpected external I/O: ${operation}`);
};
mock.method(globalThis, 'fetch', (url) => rejectIO(`fetch ${url}`));
const { findCli } = await import('../../core/proc.mjs');
const git = findCli('git');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[method];
  mock.method(childProcess, method, (command, ...args) => {
    if (git && command === git && ['execFile', 'execFileSync'].includes(method)) return original(command, ...args);
    return rejectIO(`${method} ${command}`);
  });
}
syncBuiltinESMExports();
// Only the worker completion endpoint belongs in worker-start/completion counts.
const mockCompletions = (ctx, respond) => ctx.mock.method(globalThis, 'fetch', (url, options) => {
  if (new URL(url).pathname !== '/v1/chat/completions') return rejectIO(`fetch ${url}`);
  return respond(url, options);
});

const { createTask, cancelTask, failHungTask, cancelChain, awaitTask, getTask, listTasks, openTasks, describeTask, publicTask, taskSummary, schedule, abortRunning, awaitRunning, flushRecords, setDraining, reviewParked } = await import('../../core/tasks.mjs');
const { bus } = await import('../../core/bus.mjs');
const { getModels } = await import('../../core/models.mjs');
const waitForTaskStatus = (id, statuses) => {
  const current = getTask(id);
  if (statuses.includes(current?.status)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); bus.off('event', onEvent); };
    const onEvent = (event) => {
      if (event.type !== 'task' || event.task?.id !== id || !statuses.includes(event.task.status)) return;
      cleanup(); resolve(getTask(id));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`task ${id} did not reach ${statuses.join('/')}`)); }, 15000);
    bus.on('event', onEvent);
    onEvent({ type: 'task', task: getTask(id) });
  });
};
const waitForLocalTaskStatus = (tk, id, statuses) => {
  const current = tk.getTask(id);
  if (statuses.includes(current?.status)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); bus.off('event', onEvent); };
    const onEvent = (event) => {
      if (event.type !== 'task' || event.task?.id !== id || !statuses.includes(event.task.status)) return;
      cleanup(); resolve(tk.getTask(id));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`task ${id} did not reach ${statuses.join('/')}`)); }, 15000);
    bus.on('event', onEvent);
    onEvent({ type: 'task', task: tk.getTask(id) });
  });
};
const registryModels = (ctx, models) => {
  const reg = getModels(), previous = { models: reg.models, providers: reg.providers };
  // Selection reads the imported registry cache, not later writes to models.json.
  reg.models = models;
  reg.providers = Object.fromEntries(models.map((m) => [m.provider, { status: 'ok' }]));
  ctx.after(() => Object.assign(reg, previous));
};
afterEach(async () => {
  await flushRecords(); // scoring outlives awaitTask; finish it before the next test installs its fetch spy
  assert.deepEqual(unexpectedIO, [], 'caught worker/poll errors must still fail the test');
});
after(async () => {
  await flushRecords();
  Object.assign(PROVIDERS, originalProviders);
  mock.restoreAll();
  syncBuiltinESMExports();
});

// A fresh task module captures the controlled execFile promise, without adding a production test hook.
export async function tasksWithGit(ctx, exec) {
  const original = childProcess.execFile;
  const originalSync = childProcess.execFileSync;
  const syncCalls = [];
  childProcess.execFile = Object.assign(() => { throw new Error('expected promisified execFile'); }, { [promisify.custom]: (bin, args, opts) => {
    assert.deepEqual(args.slice(0, 5), ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '--no-optional-locks']);
    return exec(bin, args.slice(5), opts);
  } });
  childProcess.execFileSync = (...args) => { syncCalls.push(args); throw new Error('synchronous git on the task path'); };
  syncBuiltinESMExports();
  ctx.after(() => {
    childProcess.execFile = original;
    childProcess.execFileSync = originalSync;
    syncBuiltinESMExports();
    assert.deepEqual(syncCalls, [], 'task creation, dispatch and completion must not run synchronous git');
  });
  const tk = await import(`../../core/tasks.mjs?${encodeURIComponent(ctx.name)}`);
  for (const t of tk.listTasks()) tk.cancelTask(t.id); // isolate this scheduler from earlier journal entries
  return tk;
}

// Exercise scheduler outcomes without depending on a vendor's parser or external service.
export async function tasksWithWorker(ctx, worker) {
  globalThis.__w1Worker = ctx.mock.fn(worker);
  globalThis.__w1Costs = [];
  const workerUrl = `w1-worker:${encodeURIComponent(ctx.name)}`;
  const sweepUrl = `w1-sweep:${encodeURIComponent(ctx.name)}`;
  const realSweep = new URL('../../core/sweep.mjs', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes('/core/tasks.mjs')) {
        if (specifier === './workers/index.mjs') return { url: workerUrl, shortCircuit: true };
        if (specifier === './sweep.mjs') return { url: sweepUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === workerUrl) return { format: 'module', shortCircuit: true, source: 'export const runWorker = (...args) => globalThis.__w1Worker(...args);' };
      if (url === sweepUrl) return { format: 'module', shortCircuit: true, source: `
        export * from ${JSON.stringify(realSweep)};
        import { measuredCostByWindow as measure } from ${JSON.stringify(realSweep)};
        export const measuredCostByWindow = (...args) => { globalThis.__w1Costs.push(args.slice(1)); return measure(...args); };
      ` };
      return nextLoad(url, context);
    },
  });
  const tk = await import(`../../core/tasks.mjs?w1=${encodeURIComponent(ctx.name)}`);
  for (const t of tk.openTasks()) tk.cancelTask(t.id);
  ctx.after(async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    for (const t of tk.openTasks()) tk.cancelTask(t.id);
    await tk.flushRecords();
    hooks.deregister(); delete globalThis.__w1Worker; delete globalThis.__w1Costs;
  });
  return tk;
}

export function initRepo(cwd) {
  const run = (...args) => childProcess.execFileSync(git, args, { cwd, windowsHide: true, encoding: 'utf8' });
  run('init', '--quiet');
  run('config', 'user.name', 'Test');
  run('config', 'user.email', 'test@example.com');
  writeFileSync(join(cwd, 'same.txt'), 'base\n');
  run('add', '--', 'same.txt');
  run('commit', '--quiet', '-m', 'fixture');
  return run;
}

export {
  HOME, tmpDir, PROVIDERS, git, findCli, mockCompletions,
  createTask, cancelTask, failHungTask, cancelChain, awaitTask, getTask, listTasks, openTasks,
  describeTask, publicTask, taskSummary, schedule, abortRunning, awaitRunning, flushRecords,
  setDraining, reviewParked, bus, getModels,
  waitForTaskStatus, waitForLocalTaskStatus, registryModels,
};
