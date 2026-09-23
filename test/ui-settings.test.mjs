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
function render(config = structuredClone(DEFAULTS)) {
  const nodes = [], posts = [];
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
    S: { config, providers: [] }, el, $: (selector) => nodes.find((n) => '#' + n.id === selector),
    Option: function (text, value) { const n = el('option', null, text); n.value = value; return n; },
    setTimeout() {}, openModal() {}, closeModal() {}, renderProviders() {}, applyAutoRefresh() {}, refreshNewPicker() {},
    pickerValue: (prefix) => prefix === 'wk-' ? config.worker : config.conductor,
    api: { post: async (path, patch) => { posts.push({ path, patch: structuredClone(patch) }); return config; } },
  });
  return { field: (id) => nodes.find((n) => n.id === 'cfg-' + id), save: () => nodes.find((n) => n.textContent === 'Save').onclick(), posts };
}

test('Settings shows the configured update policy and no guessed Grok hour', async () => {
  const view = render();
  assert.equal(view.field('conductor.autoUpdate').value, DEFAULTS.conductor.autoUpdate);
  assert.equal(view.field('grok-reset-day').value, '-1');
  assert.equal(view.field('grok-reset-hour').value, '');
  await view.save();
  assert.deepEqual(view.posts[0].patch.scorecard.usageResets.grok, { periodHours: 0 });
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
  config.providers.xai = { apiKey: null };
  const view = render(config);
  assert.equal(view.field('providers.deepseek.apiKey').value, '••••');
  view.field('providers.deepseek.apiKey').value = '';
  await view.save();
  assert.equal(view.posts[0].patch.providers?.deepseek?.apiKey, '');
  assert.equal(view.posts[0].patch.providers?.moonshot, undefined);
  assert.equal(view.posts[0].patch.providers?.xai, undefined);
});
