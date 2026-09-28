import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DEFAULTS } from '../core/config.mjs';

// Exercise the actual settings renderer and Save handler with the DOM surface they use.
const source = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function openSettings()');
const settings = source.slice(start, source.indexOf('\nfunction ', start + 1));
function render(config = structuredClone(DEFAULTS), updateResponse = null) {
  const nodes = [], posts = [];
  const state = { config, providers: [], update: null };
  const updates = [];
  const el = (tag, cls, text) => {
    let value = '';
    const node = { tag, className: cls, textContent: text, children: [], id: '', type: '', style: {},
      get value() { return value; }, set value(v) { value = String(v); },
      append(...children) { this.children.push(...children); },
      querySelectorAll() { return this.children.flatMap((n) => [n, ...n.querySelectorAll()]).filter((n) => ['input', 'select'].includes(n.tag)); },
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { return !this.validationMessage; },
    };
    nodes.push(node); return node;
  };
  runInNewContext(settings + '\nopenSettings();', {
    S: state, el, $: (selector) => nodes.find((n) => '#' + n.id === selector),
    Option: function (text, value) { const n = el('option', null, text); n.value = value; return n; },
    setTimeout() {}, openModal() {}, closeModal() {}, renderProviders() {}, applyAutoRefresh() {}, refreshNewPicker() {},
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

test('empty optional numbers stay unset and Settings has no duplicate Quit', async () => {
  const view = render();
  view.field('worker.timeoutByCategory.modeling').value = '';
  view.field('providers.deepseek.budgetUsd').value = '';
  await view.save();
  assert.equal(view.posts[0].patch.worker.timeoutByCategory, undefined);
  assert.equal(view.posts[0].patch.providers?.deepseek?.budgetUsd, undefined);
  assert.equal(view.nodes.some((n) => n.textContent === 'Quit conductor (stop the server)'), false);
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
