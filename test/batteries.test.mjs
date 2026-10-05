import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendNdjson, REPO_ROOT, statePath, writeJson } from '../core/paths.ts';

const batteriesFile = join(REPO_ROOT, 'core', 'policy', 'batteries.json');
const shipped = JSON.parse(readFileSync(batteriesFile, 'utf8'));
const target = shipped.cells.find((c) => c.provider === 'codex' && c.model && c.difficulty <= 5
  && c.category !== 'modeling' && c.category !== 'drafting' && (c.pass + 0.5 * c.fixable) / c.rated >= 0.75);
assert.ok(target, 'fixture needs one routable shipped Codex cell');

writeJson(join(HOME, 'models.json'), {
  updatedAt: 'battery-test', providers: { [target.provider]: { status: 'ok' } },
  models: [{ provider: target.provider, id: target.model, kind: 'agent', cost: 'subscription', efforts: target.effort ? [target.effort] : [] }],
});
delete process.env.CONDUCTOR_NO_SHIPPED;

const sc = await import('../core/scorecard.mjs');
const { loadConfig, saveConfig } = await import('../core/config.mjs');

const keyOf = (c) => `${c.provider}:${c.model || 'default'}:${c.effort || 'default'}|${c.category}|${c.difficulty}`;
const targetKey = keyOf(target);

test('shipped aggregate schema is privacy-limited', () => {
  assert.equal(sc.validBatteriesDocument(shipped), true);
  assert.ok(shipped.cells.length > 0);
  assert.deepEqual(Object.keys(shipped).sort(), ['cells', 'generatedAt', 'schemaVersion']);
  const forbidden = new Set(['title', 'notes', 'taskId', 'id', 'path', 'dir', 'cwd']);
  for (const cell of shipped.cells) assert.equal(Object.keys(cell).some((k) => forbidden.has(k)), false);
});

test('shipped cells feed summarize/recommend, are marked, and lose to a local cell', () => {
  let summary = sc.summarize({ source: 'smoke' });
  const fallback = summary.find((g) => `${g.sel}|${g.category}|${g.difficulty}` === targetKey);
  assert.equal(fallback?.shipped, true);
  assert.equal(sc.recommend({ category: target.category, difficulty: target.difficulty })?.model, target.model);
  assert.match(sc.formatScores({ category: target.category, source: 'smoke' }), /\[shipped\]/);

  const id = 'local-replaces-shipped';
  sc.recordRun({ id, title: 'local fixture', source: 'smoke', status: 'done', provider: target.provider, model: target.model,
    effort: target.effort, category: target.category, difficulty: target.difficulty,
    result: { usage: { input_tokens: 10, output_tokens: 2 }, durationMs: 25 } });
  sc.rateTask(id, 'fail');
  summary = sc.summarize({ source: 'smoke' });
  const local = summary.find((g) => `${g.sel}|${g.category}|${g.difficulty}` === targetKey);
  assert.equal(local.shipped, undefined);
  assert.equal(local.rated, 1);
  assert.equal(local.fail, 1);

  const before = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { shippedBatteries: false } });
    assert.equal(sc.summarize({ source: 'smoke' }).some((g) => g.shipped), false);
  } finally { saveConfig({ scorecard: before }); }
});

test('scores --distill folds local smoke rows and writes stable sorted aggregates', () => {
  const run = (id, fields = {}) => appendNdjson(statePath('scorecard.ndjson'), {
    op: 'run', ts: '2026-09-20T12:00:00.000Z', taskId: id, source: 'smoke', status: 'done', provider: 'codex',
    model: 'distill-model[1m]', effort: 'low', category: 'debug', difficulty: 2,
    tokens: { in: 10, out: 2, cached: 3, write: 0, v: 2 }, costUsd: 0, durationMs: 40, ...fields,
  });
  run('distill-latest-rate');
  appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: '2026-09-20T12:01:00.000Z', taskId: 'distill-latest-rate', verdict: 'fail', notes: 'not shipped' });
  appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: '2026-09-20T12:02:00.000Z', taskId: 'distill-latest-rate', verdict: 'pass', notes: 'also not shipped' });
  run('distill-void', { category: 'read' });
  appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: '2026-09-20T12:02:00.000Z', taskId: 'distill-void', verdict: 'pass' });
  appendNdjson(statePath('scorecard.ndjson'), { op: 'void', ts: '2026-09-20T12:03:00.000Z', taskId: 'distill-void', reason: 'private reason' });
  run('distill-live', { source: 'live', category: 'edit' });
  appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: '2026-09-20T12:02:00.000Z', taskId: 'distill-live', verdict: 'pass' });
  run('distill-archived', { model: 'archived-model', category: 'docs' });
  appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: '2026-09-20T12:02:00.000Z', taskId: 'distill-archived', verdict: 'pass' });

  const before = loadConfig().scorecard;
  const out = join(tmpDir('distill'), 'batteries.json');
  try {
    saveConfig({ scorecard: { archived: ['codex:archived-model'] } });
    const invoke = () => spawnSync(process.execPath, ['bin/conductor.mjs', 'scores', '--distill', '--out', out], {
      cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, CONDUCTOR_HOME: HOME },
    });
    const first = invoke();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /distilled \d+ aggregate cell/);
    const bytes = readFileSync(out, 'utf8');
    const doc = JSON.parse(bytes);
    assert.equal(sc.validBatteriesDocument(doc), true);
    const cell = doc.cells.find((c) => c.model === 'distill-model' && c.category === 'debug');
    assert.deepEqual({ rated: cell.rated, pass: cell.pass, fail: cell.fail, avgTokens: cell.avgTokens, lastRunDate: cell.lastRunDate },
      { rated: 1, pass: 1, fail: 0, avgTokens: 15, lastRunDate: '2026-09-20' });
    assert.equal(doc.cells.some((c) => c.category === 'read' && c.model === 'distill-model'), false);
    assert.equal(doc.cells.some((c) => c.category === 'edit' && c.model === 'distill-model'), false);
    assert.equal(doc.cells.some((c) => c.model === 'archived-model'), false);
    assert.deepEqual(doc.cells, [...doc.cells].sort((a, b) => a.provider.localeCompare(b.provider) || String(a.model).localeCompare(String(b.model)) || String(a.effort).localeCompare(String(b.effort)) || a.category.localeCompare(b.category) || a.difficulty - b.difficulty));
    const second = invoke();
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(readFileSync(out, 'utf8'), bytes);
  } finally { saveConfig({ scorecard: before }); }
});
