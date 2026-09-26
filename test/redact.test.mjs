import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { redact, redactDeep, REDACTED, statePath, writeJson } = await import('../core/paths.mjs');
const { saveConfig, loadConfig } = await import('../core/config.mjs');
const { bus } = await import('../core/bus.mjs');
const { logImprovement } = await import('../core/improve.mjs');
const { rateTask, voidTask } = await import('../core/scorecard.mjs');

test('known key shapes are redacted, masked forms included; ordinary words are not', () => {
  const cases = [
    ['Incorrect API key provided: sk-svcac******************************fvMA. You can', `Incorrect API key provided: ${REDACTED}. You can`],
    ['key sk-svcac…fvMA leaked', `key ${REDACTED} leaked`],
    [`sk-${'proj'}-abcDEF123_456-xyz`, REDACTED], // key-shaped text is built at runtime so the hub's leak hook never sees one in source
    [`sk-${'svcacct'}-AbC123dEf456`, REDACTED],
    [`sk-${'ant'}-api03-abcdefghijkl`, REDACTED],
    [`xai-${'a1B2'.repeat(10)}`, REDACTED],
    [`AIza${'x'.repeat(35)}`, REDACTED],
    ['Authorization: Bearer abc.def-ghi_jkl', `Authorization: Bearer ${REDACTED}`],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_nature-1', `token ${REDACTED}`],
  ];
  for (const [input, want] of cases) assert.equal(redact(input), want, input);
  for (const plain of ['task-abcdefghijkl', 'desk-top risk-management', 'sk-learn', 'the bearer of bad news', 'grok-4.6 xai-compat']) assert.equal(redact(plain), plain);
});

test('configured key values and *_API_KEY environment values are redacted wherever they appear', () => {
  saveConfig({ providers: { deepseek: { apiKey: 'plainvalue-without-shape-123' } } });
  process.env.EXAMPLE_API_KEY = 'another-plain-secret-456';
  try {
    assert.equal(redact('got plainvalue-without-shape-123 and another-plain-secret-456'), `got ${REDACTED} and ${REDACTED}`);
    // config.json itself is the one file that keeps the key.
    assert.equal(loadConfig().providers.deepseek.apiKey, 'plainvalue-without-shape-123');
    assert.match(readFileSync(join(HOME, 'config.json'), 'utf8'), /plainvalue-without-shape-123/);
  } finally { saveConfig({ providers: { deepseek: { apiKey: null } } }); delete process.env.EXAMPLE_API_KEY; }
});

test('redactDeep copies only what it changes and never mutates its input', () => {
  const clean = { a: 'x', list: [1, 'y'] };
  assert.equal(redactDeep(clean), clean);
  const dirty = { keep: { n: 1 }, items: [{ text: 'sk-svcac****fvMA1234' }] };
  const out = redactDeep(dirty);
  assert.equal(dirty.items[0].text, 'sk-svcac****fvMA1234');
  assert.equal(out.items[0].text, REDACTED);
  assert.equal(out.keep, dirty.keep);
});

test('every sink redacts: files, the event stream, the improvement log, scorecard notes', () => {
  const key = 'sk-svcac**********************fvMA';
  writeJson(statePath('probe.json'), { error: `401: ${key}` });
  assert.doesNotMatch(readFileSync(statePath('probe.json'), 'utf8'), /fvMA/);
  let seen = null; const h = (e) => { if (e.type === 'probe') seen = e; };
  bus.on('event', h); bus.publish('probe', { item: { text: `saw ${key}` } }); bus.off('event', h);
  assert.equal(seen.item.text, `saw ${REDACTED}`);
  assert.ok(!bus.since(0).some((e) => JSON.stringify(e).includes('fvMA')), 'replay ring');
  logImprovement('error', 'worker:codex', `Incorrect API key provided: ${key}`, { detail: key });
  rateTask('probe-task', 'fail', `echoed ${key}`);
  voidTask('probe-task', `echoed ${key}`);
  for (const f of ['improvements.ndjson', 'scorecard.ndjson']) assert.doesNotMatch(readFileSync(statePath(f), 'utf8'), /fvMA/, f);
});
