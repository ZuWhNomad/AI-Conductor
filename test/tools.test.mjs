import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { conductorToolDefs } from '../core/tools.mjs';
import { createTask, getTask, cancelTask, listTasks } from '../core/tasks.mjs';
import { abortPlans } from '../core/plans.mjs';
import { loadConfig, saveConfig } from '../core/config.mjs';
import { CATEGORIES } from '../core/scorecard.mjs';
import { bus } from '../core/bus.mjs';

const cwd = () => tmpDir('tools');
const defs = (opts = {}) => conductorToolDefs({ sessionId: opts.sessionId || 'tools', cwd: opts.cwd || cwd(), maxBlockMs: opts.maxBlockMs });
const handler = (name, opts) => defs(opts).find((d) => d.name === name).handler;

test('L9: maxBlockMs caps blocking waits and run_plan; plan_status reads the live or journaled plan', async (t) => {
  const dir = cwd();
  const waits = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { waits.push(ms); queueMicrotask(fn); return {}; });
  const tools = defs({ sessionId: 'l9', cwd: dir, maxBlockMs: 1234 });
  const task = createTask({ cwd: dir, spec: 'hang', provider: 'ollama', model: 'qwen' });
  try {
    const awaitMsg = await tools.find((d) => d.name === 'await_task').handler({ task_id: task.id });
    assert.match(awaitMsg, /still running — call await_task/);
    assert.equal(waits.pop(), 1234);
    const del = await tools.find((d) => d.name === 'delegate').handler({ title: 'hang', spec: 'hang', provider: 'ollama', model: 'qwen' });
    assert.match(del, /still running — call await_task/);
    assert.equal(waits.pop(), 1234);
    const planMsg = await tools.find((d) => d.name === 'run_plan').handler({
      goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'hang', provider: 'ollama', model: 'qwen' }] }],
    });
    assert.match(planMsg, /still running — call plan_status/);
    const planId = /Plan (\S+)/.exec(planMsg)[1];
    assert.ok(planId);
    const status = await tools.find((d) => d.name === 'plan_status').handler({ plan_id: planId });
    assert.match(status, new RegExp(`Plan ${planId}`));
    assert.equal(await tools.find((d) => d.name === 'plan_status').handler({ plan_id: 'missing' }), 'unknown plan missing');
    abortPlans('l9');
  } finally {
    for (const task of listTasks()) cancelTask(task.id);
  }
});

test('L32: run_plan category is z.enum(CATEGORIES) and difficulty is int 1-5 in all four places', () => {
  const schema = defs().find((d) => d.name === 'run_plan').schema;
  const base = { goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x' }] }] };
  assert.throws(() => schema.parse({ ...base, defaults: { category: 'typo-category' } }));
  assert.throws(() => schema.parse({ goal: 'g', stages: [{ id: 'a', defaults: { category: 'typo-category' }, tasks: [{ spec: 'x' }] }] }));
  assert.throws(() => schema.parse({ goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x', category: 'typo-category' }] }] }));
  assert.throws(() => schema.parse({ goal: 'g', stages: [{ id: 'a', for_each: 'z', task: { spec: 'x', category: 'typo-category' } }] }));
  for (const difficulty of [0, 6, 1.5]) {
    assert.throws(() => schema.parse({ ...base, defaults: { difficulty } }));
    assert.throws(() => schema.parse({ goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x', difficulty }] }] }));
  }
  for (const category of CATEGORIES) {
    assert.equal(schema.parse({ goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x', category, difficulty: 5 }] }] }).stages[0].tasks[0].category, category);
  }
});

test('L25: delegate and run_plan accept a known variant and reject an unknown one', async () => {
  const dir = cwd();
  const delBad = await handler('delegate', { cwd: dir })({ title: 't', spec: 's', category: 'modeling', variant: 'not-a-variant', background: true });
  assert.match(delBad, /unknown variant/);
  const delOk = await handler('delegate', { cwd: dir })({ title: 't', spec: 's', category: 'modeling', variant: 'recipe-c', provider: 'ollama', model: 'qwen', background: true });
  const id = /^Task (\S+)/.exec(delOk)?.[1];
  assert.equal(getTask(id).variant, 'recipe-c');
  const planBad = await handler('run_plan', { cwd: dir })({ goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x', category: 'summarize', variant: 'nope' }] }] });
  assert.match(planBad, /unknown variant/);
  cancelTask(id);
});

test('GP: run_plan validates variants after merging plan, stage and task or template defaults', async () => {
  const sessionId = 'gp-plan-variants', created = [];
  const onTask = (e) => {
    if (e.type !== 'task' || e.task.sessionId !== sessionId || e.task.status !== 'queued') return;
    const task = getTask(e.task.id); created.push(task);
    Object.assign(task, { status: 'done', result: { finalMessage: task.spec === 'vote' ? '{"real":true}' : '{"findings":[{"title":"item"}]}' } });
  };
  bus.on('event', onTask);
  try {
    const run = handler('run_plan', { sessionId });
    const report = await run({ goal: 'variants', defaults: { provider: 'ollama', model: 'qwen', category: 'summarize' }, stages: [
      { id: 'find', defaults: { category: 'modeling' }, tasks: [{ spec: 'find', variant: 'recipe-c' }] },
      { id: 'inherit', defaults: { category: 'modeling', variant: 'recipe-c' }, tasks: [{ spec: 'find' }] },
      { id: 'vote', for_each: 'find', defaults: { category: 'summarize', variant: 'video-general' }, task: { spec: 'vote', category: 'modeling', variant: 'recipe-c' } },
    ] });
    assert.match(report, /^Plan /);
    assert.deepEqual(created.map((t) => [t.category, t.variant]), Array.from({ length: 3 }, () => ['modeling', 'recipe-c']));
    const invalid = await run({ goal: 'invalid inheritance', defaults: { category: 'modeling', variant: 'recipe-c' }, stages: [
      { id: 'a', defaults: { category: 'summarize' }, tasks: [{ spec: 'x' }] },
    ] });
    assert.match(invalid, /unknown variant "recipe-c" for summarize/);
    assert.equal(created.length, 3);
  } finally {
    bus.off('event', onTask);
    for (const task of created) cancelTask(task.id);
  }
});

test('S8: allow_command denies start/call/forfiles; description drops pytest/cmake and says programs are trusted', async () => {
  const tool = defs().find((d) => d.name === 'allow_command');
  assert.doesNotMatch(tool.description, /pytest|cmake/);
  assert.match(tool.description, /trusted/i);
  const previous = loadConfig().worker.shell;
  saveConfig({ worker: { shell: ['git'] } });
  try {
    for (const command of ['start', 'call', 'forfiles', 'START.EXE']) {
      assert.match(await tool.handler({ command }), /refused/);
    }
  } finally { saveConfig({ worker: { shell: previous } }); }
});

test('I2: unproven scorecard refusal names pin provider/model or smoke_test, not budget caps', async () => {
  const msg = await handler('delegate')({ title: 't', spec: 's', category: 'implement' });
  assert.match(msg, /pin a provider\/model/i);
  assert.match(msg, /smoke_test/);
  assert.doesNotMatch(msg, /budget rules|capped or unproven/);
});

test('I7: allow_command names config.json or POST /api/settings, not Settings', async () => {
  const previous = loadConfig().worker.shell;
  saveConfig({ worker: { shell: false } });
  try {
    const msg = await handler('allow_command')({ command: 'openscad' });
    assert.match(msg, /config\.json/);
    assert.match(msg, /\/api\/settings/);
    assert.doesNotMatch(msg, /in Settings/);
  } finally { saveConfig({ worker: { shell: previous } }); }
});

test('I12: the unreachable configured-default branch is gone', () => {
  const src = readFileSync(fileURLToPath(new URL('../core/tools.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /configured default \$\{t\.provider\}/);
});

test('L47: delegate reads loadConfig() inside the handler, not once at tool-table construction', async () => {
  const dir = cwd();
  const tools = conductorToolDefs({ sessionId: 'l47', cwd: dir });
  const previous = loadConfig().worker;
  saveConfig({ worker: { provider: 'ollama', model: 'qwen3.8' } });
  try {
    const msg = await tools.find((d) => d.name === 'delegate').handler({ title: 't', spec: 's', background: true });
    const id = /^Task (\S+)/.exec(msg)[1];
    assert.equal(getTask(id).provider, 'ollama');
    cancelTask(id);
  } finally { saveConfig({ worker: previous }); }
});

test('L19: auto-picked delegate persists difficulty 2', async () => {
  // Empty scorecard → auto-pick refuses (I2). Pin is not auto-pick. Use a tagged call that
  // would auto-pick if recommend returned something: covered in plans.test.mjs L19 via runPlan.
  const schema = defs().find((d) => d.name === 'delegate').schema;
  assert.equal(schema.parse({ title: 't', spec: 's', difficulty: 3 }).difficulty, 3);
  assert.throws(() => schema.parse({ title: 't', spec: 's', difficulty: 0 }));
  assert.throws(() => schema.parse({ title: 't', spec: 's', difficulty: 6 }));
});

test('L23: cancel_task follows a failover to the live replacement and reports an already-finished task', async () => {
  const dir = cwd();
  const original = createTask({ cwd: dir, spec: 'x', provider: 'ollama', model: 'qwen' });
  const replacement = createTask({ cwd: dir, spec: 'x', provider: 'ollama', model: 'qwen', retryOf: original.id });
  Object.assign(getTask(original.id), { status: 'failed', failedOverTo: replacement.id });
  const msg = await handler('cancel_task')({ task_id: original.id });
  assert.match(msg, new RegExp(`Canceled ${replacement.id}`));
  assert.equal(getTask(replacement.id).status, 'canceled');
  assert.match(await handler('cancel_task')({ task_id: replacement.id }), /already canceled/);
  assert.match(await handler('cancel_task')({ task_id: 'nope' }), /unknown task/);
});

test('delegate avoid_families: a pin still runs, the default worker is refused, and the auto-pick skips them', async (t) => {
  const tool = defs().find((d) => d.name === 'delegate');
  const del = (a) => tool.handler(tool.schema.parse({ title: 't', spec: 's', background: true, ...a }));
  const created = async (a) => { const msg = await del(a), task = getTask(/^Task (\S+)/.exec(msg)?.[1]); assert.ok(task, msg); cancelTask(task.id); return task; };
  // A reviewer lists its own family too: the pin runs, and failover leaves both families.
  assert.deepEqual((await created({ provider: 'antigravity', model: 'claude-sonnet-4-6', avoid_families: ['Claude', 'grok', 'claude'] })).avoidFamilies, ['claude', 'grok']);
  assert.match(await del({ avoid_families: ['GPT'] }), /default worker codex:gpt-6-astra is in an avoided family \(gpt/);
  assert.equal((await created({ avoid_families: ['claude'] })).provider, 'codex');
  const { getModels } = await import('../core/models.mjs');
  const { recordRun, rateTask, recommend } = await import('../core/scorecard.mjs');
  const reg = getModels(), models = reg.models, scorecard = loadConfig().scorecard;
  reg.models = [{ provider: 'antigravity', id: 'claude-sonnet-4-6', kind: 'agent' }, { provider: 'grok', id: 'grok-4.6', kind: 'agent' }];
  saveConfig({ scorecard: { minSamples: 1 } });
  t.after(() => { reg.models = models; saveConfig({ scorecard }); });
  for (const [rid, provider, model] of [['avd-a', 'antigravity', 'claude-sonnet-4-6'], ['avd-g', 'grok', 'grok-4.6']]) {
    recordRun({ id: rid, title: 't', status: 'done', provider, model, effort: null, category: 'docs', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(rid, 'pass');
  }
  assert.equal(recommend({ category: 'docs', difficulty: 2 }).provider, 'grok', 'without avoid_families the Grok model wins');
  assert.equal((await created({ category: 'docs', avoid_families: ['grok'] })).model, 'claude-sonnet-4-6');
  assert.match(await del({ category: 'docs', avoid_families: ['claude', 'grok'] }), /No worker is available/);
});

test('run_plan passes avoid_families through from a task or the defaults', async () => {
  const sessionId = 'avoid-plan', created = [];
  const onTask = (e) => {
    if (e.type !== 'task' || e.task.sessionId !== sessionId || e.task.status !== 'queued') return;
    const task = getTask(e.task.id); created.push(task);
    Object.assign(task, { status: 'done', result: { finalMessage: 'ok' } });
  };
  bus.on('event', onTask);
  try {
    const tool = defs({ sessionId }).find((d) => d.name === 'run_plan');
    await tool.handler(tool.schema.parse({ goal: 'g', defaults: { provider: 'ollama', model: 'qwen', avoid_families: ['gpt'] }, stages: [{ id: 'a', tasks: [{ spec: 'x', avoid_families: ['Claude', 'claude', 'grok'] }, { spec: 'y' }] }] }));
    assert.deepEqual(created.map((t) => t.avoidFamilies), [['claude', 'grok'], ['gpt']]);
  } finally {
    bus.off('event', onTask);
    for (const task of created) cancelTask(task.id);
  }
});
