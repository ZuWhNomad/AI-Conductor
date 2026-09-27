import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeJson } from '../core/paths.mjs';

writeJson(join(HOME, 'models.json'), { updatedAt: 'x', providers: { codex: { status: 'ok' }, claude: { status: 'ok' } }, models: [
  { provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent' },
  { provider: 'claude', id: 'haiku', kind: 'agent' },
] });

const sc = await import('../core/scorecard.mjs');
const exp = await import('../core/experiment.mjs');

const EXPENSIVE = { in: 50_000, cached: 50_000, out: 10_000, write: 0, v: 2 };
const CHEAP = { in: 10_000, cached: 0, out: 1_000, write: 0, v: 2 };

const runRow = ({ id, arm, category = 'implement', tokens = EXPENSIVE, durationMs = 1000, provider = 'codex', model = 'gpt-5.6-luna', smokeId, experimentId = 'exp1' }) => ({
  op: 'run', ts: '2026-01-01T00:00:00.000Z', taskId: id, source: 'smoke',
  provider, model, effort: 'low', category, status: 'done', tokens, costUsd: 0, costBasis: 'tokens', durationMs,
  experiment: { id: experimentId, arm }, smokeId: smokeId || null, title: smokeId || id,
});
const rateRow = (id, verdict) => ({ op: 'rate', ts: '2026-01-01T00:00:01.000Z', taskId: id, verdict });

function writeLedger(dir, rows) {
  writeFileSync(join(dir, 'scorecard.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function stamp(id, rows) {
  return rows.map((r) => (r.op === 'run' && r.experiment ? { ...r, experiment: { id, arm: r.experiment.arm } } : r));
}
function pair(id, { A, B, heldout = 't3', extraA = [], extraB = [] } = {}) {
  const rec = exp.createExperiment({ id, hypothesis: 'h', mechanism: 'm', heldout, tasks: 't1,t2' });
  const dirA = tmpDir('exp-a'), dirB = tmpDir('exp-b');
  writeLedger(dirA, stamp(id, A.concat(extraA)));
  writeLedger(dirB, stamp(id, B.concat(extraB)));
  return { rec, dirA, dirB, report: exp.reportExperiment(id, { stateDirs: [dirA, dirB] }) };
}

const task = (prefix, arm, i, o = {}) => {
  const id = `${prefix}${arm}${i}`;
  return [runRow({ id, arm, ...o }), rateRow(id, o.verdict || 'pass')];
};

test('run rows are tagged only when CONDUCTOR_EXPERIMENT is valid', () => {
  const base = { title: 't', status: 'done', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'implement', result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } };
  delete process.env.CONDUCTOR_EXPERIMENT;
  const unset = sc.recordRun({ id: 'tag-unset', ...base });
  assert.equal(Object.hasOwn(unset, 'experiment'), false);

  process.env.CONDUCTOR_EXPERIMENT = 'exp1:A';
  const tagged = sc.recordRun({ id: 'tag-ok', ...base });
  assert.deepEqual(tagged.experiment, { id: 'exp1', arm: 'A' });

  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (const bad of ['nope', 'foo:', ':A', 'x:y:z', 'this-id-is-way-too-long-to-be-valid-xxxxxxxx:A']) {
      process.env.CONDUCTOR_EXPERIMENT = bad;
      const row = sc.recordRun({ id: `tag-bad-${bad.length}`, ...base });
      assert.equal(Object.hasOwn(row, 'experiment'), false, bad);
    }
  } finally {
    console.warn = orig;
    delete process.env.CONDUCTOR_EXPERIMENT;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /CONDUCTOR_EXPERIMENT ignored/);
});

test('report: B cheaper and not worse → keep B', () => {
  const { report } = pair('cheap-b', {
    A: [1, 2, 3].flatMap((i) => task('c', 'A', i, { tokens: EXPENSIVE, smokeId: 't1' })),
    B: [1, 2, 3].flatMap((i) => task('c', 'B', i, { tokens: CHEAP, smokeId: 't1' })),
    heldout: '',
  });
  assert.equal(report.keep, 'keep-b');
  assert.equal(report.arms.A.runs, 3);
  assert.equal(report.arms.B.runs, 3);
  assert.equal(report.arms.A.accepted, 3);
  assert.equal(report.arms.B.accepted, 3);
  assert.equal(report.arms.A.categories.implement.accepted, 3);
  assert.equal(report.arms.B.categories.implement.accepted, 3);
  assert.ok(report.arms.B.medianUsd < report.arms.A.medianUsd);
  assert.equal(report.arms.A.tokens.in.total, 150_000);
  assert.equal(report.arms.B.tokens.in.total, 30_000);
  assert.equal(report.arms.A.tokens.in.median, 50_000);
  assert.equal(report.arms.B.tokens.in.median, 10_000);
});

test('report: B cheaper but loses an accepted run in one category → keep A', () => {
  const { report } = pair('lose-cat', {
    A: [
      ...[1, 2].flatMap((i) => task('l', 'A', i, { category: 'implement', tokens: EXPENSIVE, smokeId: 't1' })),
      ...[3, 4].flatMap((i) => task('l', 'A', i, { category: 'edit', tokens: EXPENSIVE, smokeId: 't2' })),
    ],
    B: [
      ...[1, 2].flatMap((i) => task('l', 'B', i, { category: 'implement', tokens: CHEAP, smokeId: 't1' })),
      ...[3].flatMap((i) => task('l', 'B', i, { category: 'edit', tokens: CHEAP, smokeId: 't2' })),
      ...[4].flatMap((i) => task('l', 'B', i, { category: 'edit', tokens: CHEAP, smokeId: 't2', verdict: 'fail' })),
    ],
    heldout: '',
  });
  assert.equal(report.keep, 'keep-a');
  assert.ok(report.arms.B.medianUsd < report.arms.A.medianUsd);
  assert.equal(report.arms.A.categories.edit.accepted, 2);
  assert.equal(report.arms.B.categories.edit.accepted, 1);
  assert.equal(report.arms.A.categories.implement.accepted, 2);
  assert.equal(report.arms.B.categories.implement.accepted, 2);
});

test('report: B not cheaper → keep A', () => {
  const { report } = pair('not-cheap', {
    A: [1, 2, 3].flatMap((i) => task('n', 'A', i, { tokens: CHEAP, smokeId: 't1' })),
    B: [1, 2, 3].flatMap((i) => task('n', 'B', i, { tokens: EXPENSIVE, smokeId: 't1' })),
    heldout: '',
  });
  assert.equal(report.keep, 'keep-a');
  assert.ok(report.arms.B.medianUsd > report.arms.A.medianUsd);
  assert.equal(report.arms.A.accepted, 3);
  assert.equal(report.arms.B.accepted, 3);
});

test('held-out table and single-family warning appear when they should', () => {
  const { report: single } = pair('held-warn', {
    A: [1, 2, 3].flatMap((i) => task('w', 'A', i, { tokens: EXPENSIVE, smokeId: 't1' })),
    B: [1, 2, 3].flatMap((i) => task('w', 'B', i, { tokens: CHEAP, smokeId: 't1' })),
    heldout: 't3',
  });
  assert.equal(single.keep, 'keep-b');
  assert.ok(single.warnings.includes("B's win rests on a single family"));
  assert.ok(single.warnings.includes('no held-out rows'));
  assert.equal(single.heldout.A.runs, 0);
  assert.equal(single.heldout.B.runs, 0);
  const text = exp.formatReport(single);
  assert.match(text, /held-out/);
  assert.match(text, /warning: B's win rests on a single family/);
  assert.match(text, /warning: no held-out rows/);

  const { report: both } = pair('held-ok', {
    A: [
      ...[1, 2].flatMap((i) => task('h', 'A', i, { tokens: EXPENSIVE, smokeId: 't1' })),
      ...[3].flatMap((i) => task('h', 'A', i, { tokens: EXPENSIVE, smokeId: 't3' })),
    ],
    B: [
      ...[1].flatMap((i) => task('h', 'B', i, { tokens: CHEAP, smokeId: 't1', provider: 'codex', model: 'gpt-5.6-luna' })),
      ...[2].flatMap((i) => task('h', 'B', i, { tokens: CHEAP, smokeId: 't1', provider: 'claude', model: 'haiku' })),
      ...[3].flatMap((i) => task('h', 'B', i, { tokens: CHEAP, smokeId: 't3', provider: 'claude', model: 'haiku' })),
    ],
  });
  assert.equal(both.keep, 'keep-b');
  assert.equal(both.heldout.A.runs, 1);
  assert.equal(both.heldout.B.runs, 1);
  assert.deepEqual(both.arms.B.families, ['claude', 'gpt']);
  assert.equal(both.warnings.length, 0);
  assert.match(exp.formatReport(both), /held-out/);
  assert.doesNotMatch(exp.formatReport(both), /warning:/);
});

test('report reuses void fold and v1 token normalisation; untagged rows are ignored', () => {
  const { report } = pair('reuse', {
    A: [
      ...task('r', 'A', 1, { tokens: { in: 100, cached: 40, out: 20 }, smokeId: 't1' }), // v1 inclusive → uncached 60
    ],
    B: [
      ...task('r', 'B', 1, { tokens: CHEAP, smokeId: 't1' }),
    ],
    extraA: [
      { ...runRow({ id: 'void-me', arm: 'A', smokeId: 't1' }), tokens: EXPENSIVE },
      { op: 'void', ts: '2026-01-01T00:00:02.000Z', taskId: 'void-me', reason: 'harness' },
      { op: 'run', ts: '2026-01-01T00:00:00.000Z', taskId: 'untagged', source: 'smoke', provider: 'codex', model: 'gpt-5.6-luna', category: 'implement', status: 'done', tokens: EXPENSIVE, durationMs: 1 },
      rateRow('untagged', 'pass'),
    ],
    heldout: '',
  });
  assert.equal(report.arms.A.runs, 1);
  assert.equal(report.arms.A.tokens.in.total, 60);
  assert.equal(report.arms.A.tokens.cached.total, 40);
});

test('experiment new/list/report CLI and stored verdict', () => {
  const dirA = tmpDir('cli-a'), dirB = tmpDir('cli-b');
  writeLedger(dirA, [1, 2, 3].flatMap((i) => task('k', 'A', i, { experimentId: 'cli1', tokens: EXPENSIVE, smokeId: 't1' })));
  writeLedger(dirB, [1, 2, 3].flatMap((i) => task('k', 'B', i, { experimentId: 'cli1', tokens: CHEAP, smokeId: 't1' })));
  const run = (args) => spawnSync(process.execPath, ['bin/conductor.mjs', ...args], { encoding: 'utf8', env: process.env, cwd: join(import.meta.dirname, '..') });
  const created = run(['experiment', 'new', 'cli1', '--hypothesis', 'h', '--mechanism', 'm', '--heldout', 't3']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /cli1/);
  const listed = run(['experiment', 'list']);
  assert.match(listed.stdout, /cli1/);
  const reported = run(['experiment', 'report', 'cli1', '--state-dir', dirA, '--state-dir', dirB, '--json', '--verdict', 'keep-a', '--note', 'human']);
  assert.equal(reported.status, 0, reported.stderr);
  const j = JSON.parse(reported.stdout);
  assert.equal(j.keep, 'keep-b');
  assert.equal(j.verdict.keep, 'keep-a');
  assert.equal(j.verdict.note, 'human');
  const rec = JSON.parse(readFileSync(join(HOME, 'experiments', 'cli1.json'), 'utf8'));
  assert.equal(rec.verdict.keep, 'keep-a');
});
