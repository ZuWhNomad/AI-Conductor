import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DEFAULTS, saveConfig, loadConfig } from '../core/config.mjs';

// Exercise the actual settings renderer and Save handler with the DOM surface they use.
function uiSource(root) {
  const files = ['modules/core.js', 'modules/markdown.js', 'modules/sidebar.js', 'modules/budget.js', 'modules/chip.js', 'modules/picker.js', 'modules/transcript.js', 'modules/fleet.js', 'modules/sessions.js', 'modules/update.js', 'modules/sse.js', 'modules/modals.js', 'modules/misc.js', 'app.js'];
  return files.map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n').replace(/^\s*import\b.*$/gm, '').replace(/^\s*export\b.*$/gm, '');
}
const source = uiSource(new URL('../ui/', import.meta.url));
const start = source.indexOf('function openSettings()');
const settings = source.slice(start, source.indexOf('\nfunction ', start + 1));
function render(config = structuredClone(DEFAULTS), updateResponse = null, storage = new Map()) {
  const nodes = [], posts = [];
  const state = { config, providers: [], update: null };
  const updates = [];
  const el = (tag, cls, text) => {
    let value = '';
    const node = { tag, className: cls, textContent: text, children: [], id: '', type: '', style: {},
      get value() { return value; }, set value(v) { value = String(v); },
      append(...children) { this.children.push(...children); for (const child of children) child.parent = this; },
      setAttribute(key, value) { this[key] = value; }, focus() {},
      querySelectorAll() { return this.children.flatMap((n) => [n, ...n.querySelectorAll()]).filter((n) => ['input', 'select'].includes(n.tag)); },
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { return !this.validationMessage; },
    };
    nodes.push(node); return node;
  };
  runInNewContext(settings + '\nopenSettings();', {
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    S: state, el, $: (selector) => nodes.find((n) => '#' + n.id === selector),
    Option: function (text, value) { const n = el('option', null, text); n.value = value; return n; },
    setTimeout() {}, openModal() {}, closeModal() { state.closed = true; }, revealProviders() { state.revealed = true; }, renderProviders() {}, applyAutoRefresh() {}, refreshNewPicker() {},
    renderUpdate: () => updates.push(state.update),
    act: (fn) => fn(),
    pickerValue: (prefix) => prefix === 'wk-' ? config.worker : config.conductor,
    api: { get: async () => updateResponse, post: async (path, patch) => { posts.push({ path, patch: structuredClone(patch) }); return config; } },
  });
  return { field: (id) => nodes.find((n) => n.id === 'cfg-' + id), save: () => nodes.find((n) => n.textContent === 'Save').onclick(), posts, nodes, state, updates };
}

test('Settings update check refreshes header state', async () => {
  const response = { git: true, branch: 'main', head: 'abc', behind: 2 };
  const view = render(structuredClone(DEFAULTS), response);
  assert.equal(view.nodes.some((n) => String(n.textContent).includes('Login for subscriptions happens in a terminal')), false);
  await view.nodes.find((n) => n.textContent === 'Check for updates (GitHub)').onclick();
  assert.equal(view.state.update, response);
  assert.deepEqual(view.updates, [response]);
});

test('Settings shows the configured update policy and no guessed Grok hour', async () => {
  const view = render();
  assert.equal(view.field('conductor.autoUpdate').value, DEFAULTS.conductor.autoUpdate);
  assert.equal(view.field('bench.newModels').value, DEFAULTS.bench.newModels);
  assert.equal(view.field('bench.offPeak.start').value, DEFAULTS.bench.offPeak.start);
  assert.equal(view.field('bench.offPeak.end').value, DEFAULTS.bench.offPeak.end);
  assert.equal(view.field('bench.offPeak.weekends').checked, true);
  assert.equal(view.field('worker.efficiencyMode').checked, false);
  assert.equal(view.field('watchdog.killAfterStuckChecks').value, String(DEFAULTS.watchdog.killAfterStuckChecks));
  assert.equal(view.field('watchdog.loopRepeat').value, String(DEFAULTS.watchdog.loopRepeat));
  assert.equal(view.field('watchdog.loopTokens'), undefined);
  assert.equal(view.field('grok-reset-day').value, '-1');
  assert.equal(view.field('grok-reset-hour').value, '');
  await view.save();
  assert.deepEqual(view.posts[0].patch.bench, DEFAULTS.bench);
  assert.deepEqual(view.posts[0].patch.scorecard.usageResets.grok, { periodHours: 0 });
});

test('Settings exposes wrapping auto-bench hours and can clear the restriction', async () => {
  const config = structuredClone(DEFAULTS);
  config.bench = { newModels: 'auto', offPeak: { start: '22:00', end: '06:00', weekends: true } };
  const view = render(config);
  assert.equal(view.field('bench.newModels').value, 'auto');
  assert.equal(view.field('bench.offPeak.start').value, '22:00');
  assert.equal(view.field('bench.offPeak.end').value, '06:00');
  assert.equal(view.field('bench.offPeak.weekends').checked, true);
  view.field('bench.offPeak.weekends').checked = false;
  view.field('bench.offPeak.start').value = '';
  view.field('bench.offPeak.end').value = '';
  await view.save();
  assert.deepEqual(view.posts[0].patch.bench, { newModels: 'auto', offPeak: { start: '', end: '', weekends: false } });
});

test('Settings toggles and saves global efficiency mode', async () => {
  const config = structuredClone(DEFAULTS);
  config.worker.efficiencyMode = true;
  const view = render(config);
  assert.equal(view.field('worker.efficiencyMode').type, 'checkbox');
  assert.equal(view.field('worker.efficiencyMode').checked, true);
  view.field('worker.efficiencyMode').checked = false;
  await view.save();
  assert.equal(view.posts[0].patch.worker.efficiencyMode, false);
});

test('B10: Settings exposes and saves the scorecard cold-start mode', async () => {
  const config = structuredClone(DEFAULTS);
  config.scorecard.coldStart = 'priors';
  const view = render(config);
  assert.equal(view.field('scorecard.coldStart').value, 'priors');
  view.field('scorecard.coldStart').value = 'off';
  await view.save();
  assert.equal(view.posts[0].patch.scorecard.coldStart, 'off');
});

test('a Grok reset needs an explicit valid hour, including midnight', async () => {
  const view = render();
  view.field('grok-reset-day').value = 3;
  for (const hour of ['', 'invalid', '-1', '24', '1.5']) {
    view.field('grok-reset-hour').value = hour;
    await view.save();
    assert.equal(view.posts.length, 0);
    assert.match(view.field('grok-reset-hour').validationMessage, /Enter your reset hour/);
  }
  view.field('grok-reset-hour').value = 0;
  await view.save();
  assert.deepEqual(view.posts[0].patch.scorecard.usageResets.grok, { periodHours: 168, resetDay: 3, resetHour: 0 });
});

test('saved update policy and reset hour are displayed and preserved', async () => {
  const config = structuredClone(DEFAULTS);
  config.conductor.autoUpdate = 'ask';
  config.scorecard.usageResets.grok = { periodHours: 168, resetDay: 2, resetHour: 9 };
  const view = render(config);
  assert.equal(view.field('conductor.autoUpdate').value, 'ask');
  assert.equal(view.field('grok-reset-hour').value, '9');
  await view.save();
  assert.deepEqual(view.posts[0].patch.scorecard.usageResets.grok, config.scorecard.usageResets.grok);
});

test('emptying a saved API key sends apiKey: "", untouched mask is omitted', async () => {
  const config = structuredClone(DEFAULTS);
  config.providers.deepseek = { apiKey: '••••' };
  config.providers.moonshot = { apiKey: '••••' };
  const view = render(config);
  assert.equal(view.field('providers.deepseek.apiKey').value, '••••');
  view.field('providers.deepseek.apiKey').value = '';
  await view.save();
  assert.equal(view.posts[0].patch.providers?.deepseek?.apiKey, '');
});

test('P21: Settings save refreshes only providers whose key or URL changed', async () => {
  const config = structuredClone(DEFAULTS);
  config.providers.deepseek = { apiKey: '••••' };
  const view = render(config);
  view.field('providers.deepseek.apiKey').value = 'sk-new';
  await view.save();
  assert.equal(view.posts.length, 2);
  assert.deepEqual(view.posts[1], { path: '/api/models/refresh', patch: { only: ['deepseek'] } });
});

test('U5: Settings reveals effective sandbox for astra worker', () => {
  const config = structuredClone(DEFAULTS);
  config.worker = { provider: 'codex', model: 'gpt-6-astra', effort: 'high', codexSandbox: 'workspace-write' };
  const view = render(config);
  assert.equal(view.field('worker.codexSandbox').value, 'workspace-write');
});

test('Settings shows each worker CLI update mode and saves it per provider', async () => {
  const config = structuredClone(DEFAULTS); config.providers.grok.cliUpdate = 'auto';
  const view = render(config);
  assert.equal(view.field('providers.codex.cliUpdate').value, 'notify');
  assert.equal(view.field('providers.grok.cliUpdate').value, 'auto');
  view.field('providers.antigravity.cliUpdate').value = 'off';
  await view.save();
  assert.equal(view.posts[0].patch.providers.antigravity.cliUpdate, 'off');
  assert.equal(view.posts[0].patch.providers.grok.cliUpdate, 'auto');
});

test('clearing saved optional numbers removes their effective overrides and Settings has no duplicate Quit', async () => {
  const config = saveConfig({ worker: { timeoutByCategory: { modeling: 45 } }, providers: { deepseek: { budgetUsd: 100 } } });
  const saved = render(config);
  assert.equal(saved.field('worker.timeoutByCategory.modeling').value, '45');
  assert.equal(saved.field('providers.deepseek.budgetUsd').value, '100');
  saved.field('worker.timeoutByCategory.modeling').value = '';
  saved.field('providers.deepseek.budgetUsd').value = '';
  await saved.save();
  saveConfig(saved.posts[0].patch);
  assert.equal(loadConfig().worker.timeoutByCategory.modeling, undefined);
  assert.equal(loadConfig().providers.deepseek.budgetUsd, null);
  const view = render();
  view.field('worker.timeoutByCategory.modeling').value = '';
  view.field('providers.deepseek.budgetUsd').value = '';
  await view.save();
  assert.equal(view.posts[0].patch.worker.timeoutByCategory.modeling, null);
  assert.equal(view.posts[0].patch.providers.deepseek.budgetUsd, null);
  assert.equal(view.nodes.some((n) => n.textContent === 'Quit conductor (stop the server)'), false);
});

test('Settings update check prevents concurrent requests and restores the button on success and failure', async () => {
  for (const fail of [false, true]) {
    let finish;
    const response = new Promise((resolve, reject) => { finish = fail ? reject : resolve; });
    const view = render(structuredClone(DEFAULTS), response);
    const button = view.nodes.find((n) => n.textContent === 'Check for updates (GitHub)');
    const first = button.onclick();
    assert.equal(button.disabled, true);
    await button.onclick(); // must return without waiting for the pending request
    finish(fail ? new Error('check failed') : { git: true, head: 'abc', branch: 'main' });
    await first;
    assert.equal(button.disabled, false);
    if (fail) assert.ok(view.nodes.some((n) => n.textContent === 'check failed'));
    else assert.equal(view.updates.length, 1);
  }
});

test('all-providers Other keeps the selection and hints when provider is missing', () => {
  const other = source.slice(source.indexOf('function resolveOther('), source.indexOf('/** Read a picker.', source.indexOf('function resolveOther(')));
  const model = { value: '__other__', dataset: { selection: 'codex:gpt-6-sol' }, options: [{}], add(option) { this.options.push(option); } };
  const hints = [];
  const context = {
    ALL: '*',
    $: (selector) => selector.endsWith('provider') ? { value: '*' } : model,
    window: { prompt: () => 'gpt-6-astra' }, alert: (message) => hints.push(message),
    Option: function (label, value) { return { label, value }; },
  };
  runInNewContext(other + '\nresolveOther("new-", true);', context);
  assert.equal(model.value, 'codex:gpt-6-sol');
  assert.match(hints[0], /provider:model/);
  assert.equal(model.options.length, 1);
  model.value = '__other__'; context.window.prompt = () => 'codex:gpt-6-astra';
  runInNewContext(other + '\nresolveOther("new-", true);', context);
  assert.equal(model.value, 'codex:gpt-6-astra');
});

const panelOf = (node) => node?.className === 'settings-panel' ? node.id : node?.parent ? panelOf(node.parent) : null;
test('Settings tabs place every control once and save hidden panels together', async () => {
  const view = render();
  const controls = view.nodes.filter((node) => ['input', 'select'].includes(node.tag));
  assert.equal(new Set(controls.map((node) => node.id)).size, controls.length);
  for (const node of controls) {
    const expected = /cliUpdate|grok-reset/.test(node.id) ? 'subscriptions' : /providers.deepseek/.test(node.id) ? 'keys' : 'general';
    assert.equal(panelOf(node), 'settings-' + expected, node.id);
    assert.ok(view.nodes.some((label) => label.htmlFor === node.id) || node['aria-label'], node.id + ' has a label');
  }
  for (const label of ['Check for updates (GitHub)', 'Run doctor (environment check)']) assert.equal(panelOf(view.nodes.find((node) => node.textContent === label)), 'settings-general');
  const save = view.nodes.find((node) => node.textContent === 'Save');
  assert.equal(panelOf(save), null);
  view.nodes.find((node) => node.id === 'settings-tab-keys').onclick();
  view.field('conductor.maxTurns').value = 123;
  view.field('providers.codex.cliUpdate').value = 'off';
  view.field('providers.deepseek.budgetUsd').value = 42;
  await view.save();
  const patch = view.posts[0].patch;
  assert.equal(patch.conductor.maxTurns, 123);
  assert.equal(patch.providers.codex.cliUpdate, 'off');
  assert.equal(patch.providers.deepseek.budgetUsd, 42);
  assert.equal(patch.worker.provider, DEFAULTS.worker.provider);
  assert.equal(patch.conductor.provider, DEFAULTS.conductor.provider);
});

test('Settings remembers a valid tab, tolerates storage failures and reuses sign-in navigation', () => {
  const storage = new Map();
  let view = render(undefined, null, storage);
  view.nodes.find((node) => node.id === 'settings-tab-subscriptions').onclick();
  view = render(undefined, null, storage);
  assert.equal(view.nodes.find((node) => node.id === 'settings-subscriptions').hidden, false);
  view.nodes.find((node) => node.textContent === 'Manage subscription sign-ins').onclick();
  assert.equal(view.state.closed, true);
  assert.equal(view.state.revealed, true);
  for (const store of [new Map([['settingsTab', 'invalid']]), { get() { throw Error('blocked'); }, set() { throw Error('blocked'); } }]) {
    view = render(undefined, null, store);
    assert.equal(view.nodes.find((node) => node.id === 'settings-general').hidden, false);
  }
});

test('untouched saved key stays masked and is omitted from the patch', async () => {
  const config = structuredClone(DEFAULTS);
  config.providers.deepseek.apiKey = '\u2022\u2022\u2022\u2022';
  const view = render(config);
  assert.equal(view.field('providers.deepseek.apiKey').value, config.providers.deepseek.apiKey);
  await view.save();
  assert.equal(view.posts[0].patch.providers.deepseek?.apiKey, undefined);
  assert.equal(view.posts.length, 1);
});
