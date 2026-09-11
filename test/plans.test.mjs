import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validatePlan, extractJson, findingsOf, findingKey, parseVerdict, tally, expandStage } = await import('../core/plans.mjs');

test('plan validation catches structural mistakes', () => {
  assert.throws(() => validatePlan({}), /stages/);
  assert.throws(() => validatePlan({ stages: [{ id: 'a', tasks: [{ spec: 'x' }] }, { id: 'a', tasks: [{ spec: 'y' }] }] }), /duplicate/);
  assert.throws(() => validatePlan({ stages: [{ id: 'v', for_each: 'find', task: { spec: 'x' } }] }), /unknown earlier stage/);
  assert.throws(() => validatePlan({ stages: [{ id: 'f', tasks: [{ spec: 'x' }] }, { id: 'v', for_each: 'f' }] }), /task template/);
  const p = validatePlan({ stages: [{ tasks: [{ spec: 'x' }] }, { id: 'v', for_each: 'stage1', task: { spec: 'y' }, votes: 99 }] });
  assert.equal(p.stages[0].id, 'stage1');
  assert.equal(p.stages[1].votes, 7);
});

test('findings and verdicts are read from JSON blocks, with sane fallbacks', () => {
  const report = 'Looked around.\n```json\n{"findings":[{"title":"Null deref","file":"a.js","line":3,"severity":"high"}]}\n```';
  const fs = findingsOf(report, 't1');
  assert.equal(fs.length, 1); assert.equal(fs[0].id, 't1-1'); assert.equal(fs[0].source, 't1');
  assert.equal(findingsOf('plain prose report', 't2')[0].title, 'plain prose report');
  assert.equal(findingsOf('', 't3').length, 0);
  assert.equal(findingKey({ file: 'A.JS', title: 'Null   deref' }), 'a.js|null deref');
  assert.deepEqual(extractJson('x {"a":1}'), { a: 1 });
  assert.equal(parseVerdict('```json\n{"real": false, "reason": "handled upstream"}\n```').real, false);
  assert.equal(parseVerdict('{"verdict":"confirmed"}').real, true);
  assert.equal(parseVerdict('{"score": 7}').real, true);
  assert.equal(parseVerdict('I could not reproduce it; refuted.').real, false);
  assert.equal(parseVerdict('Confirmed: reproduces with input 0.').real, true);
});

test('tally modes', () => {
  const v = [{ real: true }, { real: false }, { real: true }];
  assert.equal(tally(v).confirmed, true);
  assert.equal(tally(v, 'all').confirmed, false);
  assert.equal(tally([{ real: false }, { real: true }], 'any').confirmed, true);
  assert.equal(tally([]).confirmed, false);
});

test('stages expand with templates, per-item votes and lenses, and inherited defaults', () => {
  const ctx = { goal: 'audit', defaults: { provider: 'codex', effort: 'low' }, seen: [{ title: 'old one' }], results: { find: { findings: [{ id: 'f1', title: 'Bug A', file: 'a.js' }, { id: 'f2', title: 'Bug B' }], summary: 'two findings' } } };
  const finders = expandStage({ id: 'find', tasks: [{ spec: 'Goal: {{goal}}. Already known:\n{{seen}}' }, { spec: 'x', provider: 'ollama', model: 'qwen3.8:latest' }] }, ctx);
  assert.equal(finders.length, 2);
  assert.match(finders[0].spec, /Goal: audit/); assert.match(finders[0].spec, /- old one/);
  assert.equal(finders[0].provider, 'codex'); assert.equal(finders[1].provider, 'ollama');
  const refuters = expandStage({ id: 'verify', for_each: 'find', votes: 2, lenses: ['read', 'reproduce'], task: { spec: 'Refute {{item}} via {{lens}}' } }, ctx);
  assert.equal(refuters.length, 4);
  assert.match(refuters[0].spec, /Bug A/); assert.match(refuters[0].spec, /via read/); assert.match(refuters[1].spec, /via reproduce/);
  assert.equal(refuters[3].item.id, 'f2'); assert.equal(refuters[3].vote, 1);
  const critic = expandStage({ id: 'critic', tasks: [{ spec: 'Given:\n{{results:find}}\nWhat is missing?' }] }, ctx);
  assert.match(critic[0].spec, /two findings/);
  assert.deepEqual(expandStage({ id: 'v2', for_each: 'find.confirmed', task: { spec: 'x' } }, ctx), []);
});
