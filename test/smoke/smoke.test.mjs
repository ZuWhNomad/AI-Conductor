import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const { BATTERY, copiedFromGrader } = await import('../../core/smoke/battery.mjs');
const { runSmoke, formatSmoke, SMOKE_TASKS, crossProviderJudge } = await import('../../core/smoke/index.mjs');
const { recordRun, rootRuns, recommend } = await import('../../core/scorecard.mjs');
const { readNdjson, statePath } = await import('../../core/paths.mjs');
const { CANARY, bare } = await import('../../core/smoke/private/common.mjs');
const PRIVATE = new URL('../../core/smoke/private/', import.meta.url);
const write = (dir, files) => { for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); } };

test('smoke grading voids structured harness failures but keeps timeout as a model fail', async () => {
  const execute = (outcome) => async (spec) => {
    const result = outcome === 'http' ? { status: 'failed', error: 'provider returned 400', result: { httpStatus: 400 } }
      : outcome === 'auth' ? { status: 'failed', error: 'Unauthorized', authFailed: true, result: { authFailed: true } }
        : outcome === 'limit' ? { status: 'failed', error: 'usage limit', limitHit: true, result: { limitHit: true } }
          : { status: 'canceled', error: 'timeout', timedOut: true, result: { timedOut: true } };
    return { id: `reliability-${outcome}`, ...spec, attempts: 1, ...result };
  };
  const http = await runSmoke({ models: [{ provider: 'codex', model: 'reliability-http', effort: 'low' }], tasks: ['read-1'], execute: execute('http') });
  const auth = await runSmoke({ models: [{ provider: 'codex', model: 'reliability-auth', effort: 'low' }], tasks: ['read-1'], execute: execute('auth') });
  const limit = await runSmoke({ models: [{ provider: 'codex', model: 'reliability-limit', effort: 'low' }], tasks: ['read-1'], execute: execute('limit') });
  const timeout = await runSmoke({ models: [{ provider: 'codex', model: 'reliability-timeout', effort: 'low' }], tasks: ['read-1'], execute: execute('timeout') });
  assert.equal(http[0].verdict, 'error'); assert.equal(auth[0].verdict, 'error'); assert.equal(limit[0].verdict, 'skipped'); assert.equal(timeout[0].verdict, 'fail');
  const rows = readNdjson(statePath('scorecard.ndjson'));
  for (const id of ['reliability-http', 'reliability-auth', 'reliability-limit']) assert.ok(rows.some((r) => r.op === 'void' && r.taskId === id), id);
  assert.ok(rows.some((r) => r.op === 'rate' && r.taskId === 'reliability-timeout' && r.verdict === 'fail'));
});

// Level 6-7 graders: every plausible wrong solution fails, every different-but-correct one passes. Mutants and
// benchmark checks that cost multi-seconds or fail by timing out run with CONDUCTOR_SMOKE_SLOW=1.
const SLOW = process.env.CONDUCTOR_SMOKE_SLOW === '1';

for (const b of BATTERY) {
  test(`battery ${b.id}: check fails on the untouched fixture and passes on the reference solution`, { skip: b.id === 'refactor-6' && !SLOW ? 'slow benchmark (CONDUCTOR_SMOKE_SLOW=1)' : false }, async () => {
    const dir = tmpDir(`smoke-${b.id}`);
    b.setup(dir);
    assert.equal(copiedFromGrader(dir), false, 'a fixture carries the canary');
    const untouched = await b.check(dir, { result: { finalMessage: 'Done. See src/http/parse.mjs:1 for area, distance.' } });
    assert.equal(untouched.pass, false, `untouched fixture passed: ${untouched.notes}`);
    assert.notEqual(untouched.notes, 'copied from the grader');
    const solved = b.solve(dir) || {};
    assert.equal(copiedFromGrader(dir), false, 'solve() writes the canary');
    const ok = await b.check(dir, { result: { finalMessage: solved.finalMessage || 'done' } });
    assert.equal(ok.pass, true, ok.notes);
    for (const rel of b.hidden || []) assert.equal(existsSync(join(dir, rel)), false, `${rel} left behind`);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('read-3 extraction requires a deep-equal JSON answer', async () => {
  const b = BATTERY.find((x) => x.id === 'read-3'), dir = tmpDir('extract-deep-equal');
  b.setup(dir); b.solve(dir);
  const answer = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  answer.extra = true;
  write(dir, { 'result.json': JSON.stringify(answer) });
  assert.equal((await b.check(dir)).pass, false);
  rmSync(dir, { recursive: true, force: true });
});

test('read-2 classification enforces the stated 10-of-12 accuracy bar', async () => {
  const b = BATTERY.find((x) => x.id === 'read-2'), dir = tmpDir('classify-threshold');
  b.setup(dir); b.solve(dir);
  const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  labels[0].label = 'feature'; labels[1].label = 'feature';
  write(dir, { 'labels.json': JSON.stringify(labels) });
  assert.equal((await b.check(dir)).pass, true, '10 correct labels should pass');
  labels[2].label = 'billing';
  write(dir, { 'labels.json': JSON.stringify(labels) });
  assert.equal((await b.check(dir)).pass, false, '9 correct labels should fail');
  rmSync(dir, { recursive: true, force: true });
});

test('implement-3 SQL compares rows deeply on a fresh grader database', async () => {
  const b = BATTERY.find((x) => x.id === 'implement-3'), dir = tmpDir('sql-rows');
  b.setup(dir); b.solve(dir);
  write(dir, { 'query.sql': 'SELECT name AS customer, 0 AS order_count, 0 AS gross_cents, 0 AS refund_cents, 0 AS net_cents FROM customers ORDER BY name;' });
  const r = await b.check(dir);
  assert.equal(r.pass, false);
  assert.equal(existsSync(join(dir, 'judge.sqlite')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('review-4 applies both recall and precision thresholds', async () => {
  const b = BATTERY.find((x) => x.id === 'review-4'), dir = tmpDir('review-thresholds');
  b.setup(dir);
  write(dir, { 'review.json': JSON.stringify({ findings: [3, 7, 11, 99] }) });
  assert.equal((await b.check(dir)).pass, true, '75% recall and precision should pass');
  write(dir, { 'review.json': JSON.stringify({ findings: [3, 7, 11, 98, 99] }) });
  assert.equal((await b.check(dir)).pass, false, 'precision below 75% should fail');
  write(dir, { 'review.json': JSON.stringify({ findings: [3, 7] }) });
  assert.equal((await b.check(dir)).pass, false, 'recall below 75% should fail');
  rmSync(dir, { recursive: true, force: true });
});

test('ui-2 uses string checks for the media rule and inline handlers', async () => {
  const b = BATTERY.find((x) => x.id === 'ui-2'), dir = tmpDir('ui-string-checks');
  b.setup(dir); b.solve(dir);
  const good = readFileSync(join(dir, 'index.html'), 'utf8');
  write(dir, { 'index.html': good.replace('99.98%', '98%') });
  assert.equal((await b.check(dir)).pass, false);
  write(dir, { 'index.html': good.replace('@media (max-width: 640px)', '@media (max-width: 641px)') });
  assert.equal((await b.check(dir)).pass, false);
  write(dir, { 'index.html': good.replace('<body>', '<body onclick="go()">') });
  assert.equal((await b.check(dir)).pass, false);
  rmSync(dir, { recursive: true, force: true });
});

test('research-4 and research-5 bury filing facts and reject the seeded traps', async () => {
  const { research4Pack, research5Pack, RESEARCH4_REFERENCE, RESEARCH5_REFERENCE } = await import('../../core/smoke/private/deterministic.mjs');
  const bury = (pack, minChars) => {
    let n = 0;
    for (const body of Object.values(pack.files)) n += body.length;
    assert.ok(n >= minChars, `fixture is ${n} chars`);
    for (const { file, sentence } of pack.anchors) {
      const body = pack.files[file], i = body.indexOf(sentence);
      assert.ok(i > 3000 && i + sentence.length < body.length - 3000, `${file} fact is not buried: ${sentence.slice(0, 48)}`);
      assert.equal(body.lastIndexOf(sentence), i, `${file} repeats a fact sentence`);
    }
  };
  bury(research4Pack(), 150_000);
  bury(research5Pack(), 100_000);
  const run = async (id, message) => {
    const b = BATTERY.find((x) => x.id === id), dir = tmpDir(id);
    b.setup(dir);
    const r = await b.check(dir, { result: { finalMessage: message } });
    rmSync(dir, { recursive: true, force: true });
    return r;
  };
  const ref4 = bare(RESEARCH4_REFERENCE), ref5 = bare(RESEARCH5_REFERENCE);
  assert.equal((await run('research-4', '')).pass, false, 'empty research-4 answer');
  assert.equal((await run('research-5', '')).pass, false, 'empty research-5 answer');
  assert.equal((await run('research-4', ref4)).pass, true);
  assert.equal((await run('research-5', ref5)).pass, true);
  const variant4 = ref4
    .replace('so the quarter beat consensus by $0.13.', 'so diluted EPS exceeded the $2.05 consensus by $0.13.')
    .replace('### Citation\n[10-Q]\n### Quote\n"Cash and cash equivalents were $86 million at quarter end."', '### Citation\n[8-K]\n### Quote\n"Cash and cash equivalents were $86 million at quarter end."');
  const variant5 = ref5.replace('The company\'s matrix reports the aggregate only: 4 of 9 directors are women.', 'Women hold 4 of 9 board seats in the disclosed aggregate.');
  assert.equal((await run('research-4', variant4)).pass, true, 'research-4 variant');
  assert.equal((await run('research-5', variant5)).pass, true, 'research-5 variant');
  const differentQuote4 = ref4
    .replace('Third-quarter revenue was $412 million', 'Third-quarter revenue was $412M')
    .replace('current order backlog of $1.62 billion', 'current order backlog of $1.62B')
    .replace("$1.40 billion backlog", "$1.40 bn backlog")
    .replace('Cash and cash equivalents were $86 million at quarter end.\n### Citation', 'Cash and cash equivalents were $86M at quarter end.\n### Citation')
    .replace('"Corvane Grid Systems reported third-quarter revenue of $412 million and diluted earnings per share of $2.18."', '“Cash and cash equivalents were $86 million at quarter end”');
  assert.equal((await run('research-4', differentQuote4)).pass, true, 'research-4 accepts a different cited sentence and abbreviated money');
  const differentQuote5 = ref5
    .replace('54 percent of net revenue, consumer packaging for 31 percent, and all other activities for 15 percent', '54% of net revenue, consumer packaging for 31%, and all other activities for 15%')
    .replace('guidance is $900 million', 'guidance is $900M')
    .replace('$840 million figure', '$840 mn figure')
    .replace('"Industrial products accounted for 54 percent of net revenue, consumer packaging for 31 percent, and all other activities for 15 percent."', '"A sustained rise in recovered-fiber prices would compress margins before contracts reset."');
  assert.equal((await run('research-5', differentQuote5)).pass, true, 'research-5 accepts a different cited sentence and compact numbers');
  const phrasing4 = ref4.replace('The 10-Q reports a current order backlog of $1.62 billion. The analyst note\'s $1.40 billion backlog conflicts with that later figure and is stale.', 'The 10-Q reports a current backlog of $1.62 billion, whereas the analyst note records $1.40 billion as prepared before the quarter closed.');
  assert.equal((await run('research-4', phrasing4)).pass, true, 'research-4 does not attach current to a stale figure in another clause');
  const targetPhrasing4 = ref4.replace('The note states a twelve-month price target of $300, which is inconsistent with a 24 times multiple applied to an earnings basis of $8.50. The corrected product is $204 and that corrected figure is the target.', 'The analyst\'s stated twelve-month target is $300. It is not supported by the note\'s own numbers: a 24 times multiple applied to $8.50 yields a target of $204.');
  assert.equal((await run('research-4', targetPhrasing4)).pass, true, 'research-4 accepts a separately stated correction of the analyst target');
  const terseTarget4 = ref4.replace('The note states a twelve-month price target of $300, which is inconsistent with a 24 times multiple applied to an earnings basis of $8.50. The corrected product is $204 and that corrected figure is the target.', 'The analyst\'s twelve-month price target is $300, but its own numbers support $204: 24 × $8.50 = $204.');
  assert.notEqual(terseTarget4, ref4);
  assert.equal((await run('research-4', terseTarget4)).pass, true, 'research-4 accepts a terse correction that names the supported figure (GPT-6 phrasing, 2026-10-01)');
  const phrasing5 = ref5
    .replace('Ada Pell has served as chief executive officer for 6 years', 'Ada Pell has served as chief executive officer for six years')
    .replace('Jon Vesper has served as chief financial officer for 3 years', 'Jon Vesper has served as chief financial officer for three years')
    .replace('The company\'s matrix reports the aggregate only: 4 of 9 directors are women.', 'The board has 9 directors. In aggregate, 4 are women.')
    .replace('A share repurchase authorization was not disclosed in the sources.', 'A share repurchase authorization was not disclosed in the sources. The 10-Q discusses a $12 million dividend, not a buyback.');
  assert.equal((await run('research-5', phrasing5)).pass, true, 'research-5 accepts equivalent counts and the disclosed dividend');
  const fail = async (id, message, note) => assert.match((await run(id, message)).notes, note);
  await fail('research-4', ref4.replace('The corrected product is $204 and that corrected figure is the target.', 'The corrected product is $204. The price target of $300 is supported by the note.'), /wrong target/);
  await fail('research-4', ref4.replace('The analyst note\'s $1.40 billion backlog conflicts with that later figure and is stale.', 'The documents agree on the order backlog of $1.62 billion and also mention $1.40 billion.'), /R2/);
  await fail('research-4', ref4.replace('The 10-Q reports a current order backlog of $1.62 billion. The analyst note\'s $1.40 billion backlog conflicts with that later figure and is stale.', 'Although the documents conflict, the 10-Q mentions $1.62B. The current backlog is $1.40B.'), /treats the stale backlog as current/);
  await fail('research-4', ref4.replace('Rating: BUY', 'Rating: SELL'), /does not match the rule/);
  await fail('research-4', ref4.replace('Rating: BUY\n', ''), /rating line is missing/);
  await fail('research-4', ref4.replace('"Corvane Grid Systems reported third-quarter', '"Corvane Grid Systems posted third-quarter'), /quote is not verbatim/);
  await fail('research-4', ref4.replace('"Corvane Grid Systems reported third-quarter revenue of $412 million and diluted earnings per share of $2.18."', '"The note sets a twelve-month price target of $300 by applying a 24 times multiple to an earnings basis of $8.50."'), /quote is not verbatim/);
  await fail('research-5', ref5.replace('not disclosed in the sources.', 'not disclosed in the sources, aside from a $250 million program.'), /D4 contains a figure/);
  await fail('research-5', ref5.replace('4 of 9 directors are women.', '4 of 9 directors are women. Ada Pell is a woman.'), /named individual/);
  await fail('research-5', ref5.replace('The $840 million figure repeated in the news item is stale.', 'The $840 million figure repeated in the news item is stale. The latest full-year print of $840 million is the one to use.'), /stale guidance/);
  await fail('research-5', ref5.replace('The latest full-year net revenue guidance is $900 million. The $840 million figure repeated in the news item is stale.', 'The latest full-year net revenue guidance is $840M. The $900M figure is stale.'), /stale guidance/);
  await fail('research-5', ref5.replace(/\n## D6[\s\S]*$/, ''), /exactly 6 D sections/);
  await fail('research-5', ref5.replace('"Industrial products accounted for 54 percent of net revenue, consumer packaging for 31 percent, and all other activities for 15 percent."', '"Industrial products supplied 54 percent of revenue, consumer packaging 31 percent, and other activities 15 percent."'), /quote is not verbatim/);
  await fail('research-5', ref5.replace('"Industrial products accounted for 54 percent of net revenue, consumer packaging for 31 percent, and all other activities for 15 percent."', '"Management set full-year net revenue guidance at $900 million."'), /quote is not verbatim/);
  assert.match(ref5, /\$12 million/);
  assert.equal((await run('research-5', ref5)).pass, true, 'D4 answer says not disclosed while the quote states an amount');
  for (const id of ['research-4', 'research-5']) assert.doesNotMatch(BATTERY.find((x) => x.id === id).spec, /stale|contradicted|does not equal|inconsistent/i, id);
  const judgeDir = tmpDir('research-4-judge');
  const judgeTask = BATTERY.find((x) => x.id === 'research-4');
  judgeTask.setup(judgeDir);
  const filler = research4Pack().files['filings/10-K.md'].split(/\n\n+/).find((p) => !p.startsWith('#') && p.length > 80);
  const fillerSentence = filler.split(/(?<=\.)\s/)[0];
  const judged = judgeTask.judge(judgeDir, { result: { finalMessage: `${ref4}\n"${fillerSentence}"` } });
  assert.match(judged, /RELEVANT SOURCE PARAGRAPHS \(the rest of each document is generic boilerplate\)/);
  assert.match(judged, /\$412 million/);
  assert.ok(judged.includes(fillerSentence), 'a quoted boilerplate sentence is included');
  assert.ok(judged.length < 20_000, `judge prompt is ${judged.length} chars`);
  rmSync(judgeDir, { recursive: true, force: true });
  const b = BATTERY.find((x) => x.id === 'research-4'), dir = tmpDir('research-4-edit');
  b.setup(dir);
  write(dir, { 'filings/10-Q.md': readFileSync(join(dir, 'filings/10-Q.md'), 'utf8') + '\n' });
  assert.match((await b.check(dir, { result: { finalMessage: ref4 } })).notes, /was modified/);
  rmSync(dir, { recursive: true, force: true });
});

test('research-3 requires gold claims, sections, citations and verbatim excerpt quotes', async () => {
  const b = BATTERY.find((x) => x.id === 'research-3'), dir = tmpDir('research-checks');
  b.setup(dir); const solved = b.solve(dir);
  assert.equal((await b.check(dir, { result: solved })).pass, true);
  const variant = solved.finalMessage
    .replace('Revenue increased 14% to $228 million', 'Revenue increased 14 percent to $228M')
    .replace('Gross margin expanded from 41% to 46%.', 'Gross margin expanded from 41 per cent to 46 per cent.')
    .replace('$72 million in cash', '72 million dollars in cash')
    .replace('$18 million for a second assembly line', '$18 mn for a second assembly line')
    .replace('"Brindle Components ended the quarter with $72 million of cash and no long-term debt."', '“The company expects capital spending of $18 million in FY2027, primarily for a second assembly line scheduled to enter service in October”');
  assert.equal((await b.check(dir, { result: { finalMessage: variant } })).pass, true, 'different cited sentence and compact numbers');
  const singular = solved.finalMessage.replace('Industry shipments are forecast to grow 9% as regional grid upgrades accelerate.', 'Forecast 9% shipment growth driven by regional grid upgrades is the opportunity.');
  assert.equal((await b.check(dir, { result: { finalMessage: singular } })).pass, true, 'singular shipment phrasing');
  const noQuote = solved.finalMessage.replace('"Alder Systems reported', '"Alder reported');
  assert.match((await b.check(dir, { result: { finalMessage: noQuote } })).notes, /quote is not verbatim/);
  const wrongExcerpt = solved.finalMessage.replace('"Brindle Components ended the quarter with $72 million of cash and no long-term debt."', '"Alder Systems reported that FY2026 revenue rose 14% to $228 million, while gross margin widened from 41% to 46%."');
  assert.match((await b.check(dir, { result: { finalMessage: wrongExcerpt } })).notes, /quote is not verbatim/);
  const sentenceRun = solved.finalMessage.replace('"Alder Systems reported that FY2026 revenue rose 14% to $228 million, while gross margin widened from 41% to 46%."', '“Alder Systems reported that FY2026 revenue rose 14% to $228 million, while gross margin widened from 41% to 46%.\nManagement attributed most of the margin gain to a richer mix of subscription contracts rather than lower staffing costs”');
  assert.equal((await b.check(dir, { result: { finalMessage: sentenceRun } })).pass, true, 'contiguous sentence run with normalized whitespace and quotes');
  const noClaim = solved.finalMessage.replace('Revenue increased 14% to $228 million in FY2026.', 'Revenue increased in FY2026.');
  assert.match((await b.check(dir, { result: { finalMessage: noClaim } })).notes, /required gold claim/);
  rmSync(dir, { recursive: true, force: true });
});

test('writing variants enforce adherence and use only an optional different-provider judge', async () => {
  for (const id of ['writing-2', 'writing-3']) {
    const b = BATTERY.find((x) => x.id === id), dir = tmpDir(id);
    b.setup(dir); const solved = b.solve(dir), worker = { provider: 'deepseek', result: solved };
    assert.equal((await b.check(dir, worker)).pass, true, id);
    let request;
    const judged = await b.check(dir, worker, { judge: async (r) => { request = r; return { provider: 'claude', yes: false, notes: 'taste' }; } });
    assert.equal(judged.pass, false, id); assert.match(judged.notes, /cross-provider judge \(claude\): NO/);
    assert.equal(request.workerProvider, 'deepseek'); assert.match(request.question, /Reply with exactly YES or NO\.$/);
    assert.equal((await b.check(dir, worker, { judge: async () => ({ provider: 'deepseek', yes: false }) })).pass, true, 'same-provider verdict is ignored');
    rmSync(dir, { recursive: true, force: true });
  }
  const b = BATTERY.find((x) => x.id === 'writing-2'), dir = tmpDir('writing-slop');
  b.setup(dir); const solved = b.solve(dir);
  const slop = solved.finalMessage.replace('Rain stitched', "In today's fast-paced world, rain stitched");
  assert.match((await b.check(dir, { result: { finalMessage: slop } })).notes, /banned filler/);
  rmSync(dir, { recursive: true, force: true });
});

test('the default subjective judge is off when no different provider is available', async () => {
  const { getModels } = await import('../../core/models.mjs');
  const reg = getModels(), saved = { models: reg.models, providers: reg.providers };
  try {
    reg.models = [{ provider: 'deepseek', id: 'deepseek-chat', kind: 'agent' }]; reg.providers = { deepseek: { status: 'ok' } };
    assert.equal(await crossProviderJudge({ workerProvider: 'deepseek', question: 'Reply YES or NO.', cwd: process.cwd() }), null);
  } finally { Object.assign(reg, saved); }
});

test('video-extraction-2 requires verbatim quotes and timestamps inside the supporting cue', async () => {
  const b = BATTERY.find((x) => x.id === 'video-extraction-2'), dir = tmpDir('video-extraction');
  b.setup(dir); b.solve(dir);
  const good = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
  assert.equal((await b.check(dir)).pass, true);
  good[0].quote = 'Enrollment was distributed across the full service area.';
  good[1].claim = 'Peak electricity demand fell 8% during the six-week trial.';
  write(dir, { 'claims.json': JSON.stringify(good) });
  assert.equal((await b.check(dir)).pass, true, 'different transcript sentence and percent format');
  good[0].quote = 'Enrollment covered most of the service area.'; write(dir, { 'claims.json': JSON.stringify(good) });
  assert.match((await b.check(dir)).notes, /quote is not verbatim/);
  good[0].quote = good[1].quote; write(dir, { 'claims.json': JSON.stringify(good) });
  assert.match((await b.check(dir)).notes, /quote is not verbatim/);
  good[0].quote = 'The pilot enrolled 120 households across three neighborhoods.';
  good[0].timestamp = '00:11'; write(dir, { 'claims.json': JSON.stringify(good) });
  assert.match((await b.check(dir)).notes, /outside its transcript cue/);
  good[0].timestamp = '00:07'; good[0].quote = good[0].quote.replace('120', '121'); write(dir, { 'claims.json': JSON.stringify(good) });
  assert.match((await b.check(dir)).notes, /quote is not verbatim/);
  rmSync(dir, { recursive: true, force: true });
});

// Level 6-7 graders: every plausible wrong solution fails, every different-but-correct one passes. Mutants that fail only
// by timing out (refactor-6's benchmark kill, implement-7's 60 s test timeout) run with CONDUCTOR_SMOKE_SLOW=1.
for (const id of ['refactor-6', 'implement-6', 'implement-7', 'debug-7']) {
  const b = BATTERY.find((x) => x.id === id);
  const { MUTANTS, SLOW_MUTANTS = {}, VARIANTS } = await import(new URL(`${id}.mjs`, PRIVATE));
  const cases = [...Object.entries(MUTANTS), ...(SLOW ? Object.entries(SLOW_MUTANTS) : [])].map(([name, files]) => ['mutant', name, files, false])
    .concat(Object.entries(VARIANTS).map(([name, files]) => ['variant', name, files, true]));
  for (const [kind, name, files, pass] of cases) {
    const slowBench = id === 'refactor-6' && (kind === 'variant' || name.includes('gaming the equivalence test') || name.includes('forged BENCH line'));
    test(`${id} ${kind} ${pass ? 'passes' : 'fails'}: ${name}`, { skip: slowBench && !SLOW ? 'slow benchmark (CONDUCTOR_SMOKE_SLOW=1)' : false }, async () => {
      const dir = tmpDir(`smoke-${id}`);
      b.setup(dir); b.solve(dir); write(dir, bare(files));
      const r = await b.check(dir, { result: { finalMessage: 'done' } });
      assert.equal(r.pass, pass, r.notes);
      assert.notEqual(r.notes, 'copied from the grader');
      rmSync(dir, { recursive: true, force: true });
    });
  }
}

test('canary: every private module and every body in it except a fixture carries it; a planted copy fails every check', async () => {
  const fixtures = new Set();
  for (const b of BATTERY) {
    const dir = tmpDir(`smoke-fixture-${b.id}`);
    b.setup(dir);
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) fixtures.add(readFileSync(join(e.parentPath, e.name), 'utf8'));
    rmSync(dir, { recursive: true, force: true });
  }
  const bodies = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(bodies) : []);
  for (const f of readdirSync(PRIVATE).filter((f) => f.endsWith('.mjs'))) {
    assert.ok(readFileSync(new URL(f, PRIVATE), 'utf8').includes(CANARY), f);
    if (f === 'common.mjs') continue; // the canary itself, the helpers and the PRNG source
    for (const [name, v] of Object.entries(await import(new URL(f, PRIVATE)))) for (const s of bodies(v)) assert.ok(fixtures.has(s) || s.includes(CANARY), `${f} ${name}: no canary`);
  }
  assert.ok((await import(new URL('implement-6.mjs', PRIVATE))).patchHidden().includes(CANARY));
  const { OVERLAP_FAST } = await import(new URL('refactor-6.mjs', PRIVATE));
  for (const b of BATTERY) {
    const dir = tmpDir(`smoke-canary-${b.id}`);
    b.setup(dir); b.solve(dir);
    write(dir, { 'lib/deep/notes.txt': `copied\n// ${CANARY}\n` });
    assert.deepEqual(await b.check(dir, { result: { finalMessage: 'done' } }), { pass: false, notes: 'copied from the grader' }, b.id);
    rmSync(dir, { recursive: true, force: true });
  }
  const dir = tmpDir('smoke-canary-verbatim'); // the reference copied verbatim from private/ is caught too
  const b = BATTERY.find((x) => x.id === 'refactor-6');
  b.setup(dir); write(dir, { 'src/overlap.mjs': OVERLAP_FAST });
  assert.equal((await b.check(dir)).notes, 'copied from the grader');
  rmSync(dir, { recursive: true, force: true });
});

test("canary: the grader's own hidden files never trigger it, even when left behind", async () => {
  const hidden = {
    'refactor-6': (m) => [m.OVERLAP_HIDDEN, m.OVERLAP_BENCH], 'implement-6': (m) => [m.patchHidden()],
    'implement-7': (m) => [m.MULTIPART_HIDDEN], 'debug-7': (m) => [m.CACHE_HIDDEN],
  };
  for (const [id, bodies] of Object.entries(hidden)) {
    const b = BATTERY.find((x) => x.id === id);
    const dir = tmpDir(`smoke-hidden-${id}`);
    b.setup(dir); b.solve(dir);
    const left = bodies(await import(new URL(`${id}.mjs`, PRIVATE)));
    b.hidden.forEach((rel, i) => write(dir, { [rel]: left[i] })); // as if a killed earlier check had left them behind
    if (id === 'refactor-6' && !SLOW) {
      assert.equal(copiedFromGrader(dir, b.hidden), false, `${id}: canary triggered on hidden files`);
      b.hidden.forEach((rel) => rmSync(join(dir, rel), { force: true }));
    } else {
      const r = await b.check(dir, { result: { finalMessage: 'done' } });
      assert.equal(r.pass, true, `${id}: ${r.notes}`);
    }
    for (const rel of b.hidden) assert.equal(existsSync(join(dir, rel)), false, `${id}: ${rel} left behind`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scratch dirs and task titles are neutral (no conductor, smoke or task id); the dirs are removed', async () => {
  const specs = [];
  const execute = async (spec) => { specs.push(spec); assert.ok(existsSync(spec.cwd)); return { status: 'canceled', timedOut: true }; };
  await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['read-1', 'debug-7'], execute });
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((s) => s.smokeId), ['read-1', 'debug-7']); // the id travels beside the title, not in it
  for (const { cwd, title } of specs) {
    assert.equal(dirname(cwd), realpathSync.native(tmpdir()));
    assert.match(basename(cwd), /^w-[A-Za-z0-9]{6}$/);
    assert.doesNotMatch(title, /conductor|smoke|read-1|debug-7/i);
    assert.equal(existsSync(cwd), false);
  }
});

test('smoke tasks at difficulty 6+ get smoke.hardTimeoutMinutes (30); the rest smoke.timeoutMinutes (20)', async () => {
  const { loadConfig, saveConfig, DEFAULTS } = await import('../../core/config.mjs');
  assert.deepEqual([DEFAULTS.smoke.timeoutMinutes, DEFAULTS.smoke.hardTimeoutMinutes], [20, 30]);
  const previous = loadConfig().smoke;
  const waits = [];
  const execute = async (spec, minutes) => { waits.push([spec.difficulty, minutes]); return { status: 'canceled', timedOut: true }; };
  const models = [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks = ['debug-5', 'refactor-6', 'implement-6', 'implement-7', 'debug-7'];
  try {
    await runSmoke({ models, tasks, execute });
    assert.deepEqual(waits.splice(0), [[5, 20], [6, 30], [6, 30], [7, 30], [7, 30]]);
    saveConfig({ smoke: { hardTimeoutMinutes: 45 } });
    await runSmoke({ models, tasks: ['debug-5', 'debug-7'], execute });
    await runSmoke({ models, tasks: ['debug-5', 'debug-7'], execute, timeoutMinutes: 3, hardTimeoutMinutes: 4 });
    assert.deepEqual(waits.splice(0), [[5, 20], [7, 45], [5, 3], [7, 4]]);
    saveConfig({ smoke: { hardTimeoutMinutes: -1 } });
    assert.equal(loadConfig().smoke.hardTimeoutMinutes, 30);
    saveConfig({ smoke: { hardTimeoutMinutes: 1e9 } });
    assert.equal(loadConfig().smoke.hardTimeoutMinutes, 1440);
  } finally { saveConfig({ smoke: previous }); }
});

test('routing ignores difficulty > 7: L8 rows neither pool into nor lift a pick; live tasks route 1-7', async () => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const scorecard = loadConfig().scorecard;
  saveConfig({ scorecard: { minSamples: 3 } });
  try {
  const reg = { providers: { codex: { status: 'ok' } }, models: ['gpt-5.6-luna', 'gpt-5.6-terra'].map((id) => ({ provider: 'codex', id, kind: 'agent' })) };
  const row = (model, difficulty, rated, quality, avgUsd) => ({ sel: `codex:${model}:low`, steps: 1, provider: 'codex', model, effort: 'low', category: 'debug', difficulty, rated, n: rated, pass: rated * quality, fixable: 0, fail: rated * (1 - quality), phantom: 0, quality, accept: quality, avgUsd, avgDurationMs: 1000 });
  // Luna: one cheap rated run at L7 (below the sample floor) plus passing L8 runs that would pool into it if routed. Terra: proven at L7.
  const base = [row('gpt-5.6-luna', 7, 1, 1, 0.001), row('gpt-5.6-terra', 7, 3, 1, 0.05)];
  const hard = [row('gpt-5.6-luna', 8, 3, 1, 0.001), row('gpt-5.6-terra', 8, 3, 0, 0.05)];
  for (let d = 1; d <= 7; d++) assert.deepEqual(recommend({ category: 'debug', difficulty: d, summary: [...base, ...hard], reg }), recommend({ category: 'debug', difficulty: d, summary: base, reg }), `level ${d}`);
  const r = recommend({ category: 'debug', difficulty: 7, summary: [...base, ...hard], reg });
  assert.equal(r.model, 'gpt-5.6-terra');
  assert.doesNotMatch(r.reason, /pooled/);
  const { createTask, cancelTask } = await import('../../core/tasks.mjs');
  const cwd = tmpDir('smoke-difficulty');
  const smoke = createTask({ cwd, spec: 'x', provider: 'deepseek', difficulty: 7, source: 'smoke' });
  const live = createTask({ cwd, spec: 'x', provider: 'deepseek', difficulty: 6 });
  const over = createTask({ cwd, spec: 'x', provider: 'deepseek', difficulty: 8 });
  assert.equal(smoke.difficulty, 7);
  assert.equal(live.difficulty, 6);
  assert.equal(over.difficulty, null);
  cancelTask(smoke.id); cancelTask(live.id); cancelTask(over.id);
  rmSync(cwd, { recursive: true, force: true });
  } finally { saveConfig({ scorecard }); }
});

test('implement-4: eval named in a comment or string passes; a real eval or new Function fails', async () => {
  const b = BATTERY.find((x) => x.id === 'implement-4');
  const dir = tmpDir('smoke-implement-4-eval');
  b.setup(dir); b.solve(dir);
  const calc = readFileSync(join(dir, 'src/calc.mjs'), 'utf8');
  writeFileSync(join(dir, 'src/calc.mjs'), `// Recursive descent: no eval() / new Function.\n/* never eval(src) */\nconst note = 'no new Function here';\n${calc}`);
  const prose = await b.check(dir, { result: { finalMessage: 'done' } });
  assert.equal(prose.pass, true, prose.notes);
  for (const bad of ['const f = new Function("return 1");', 'const v = eval("1+1");']) {
    writeFileSync(join(dir, 'src/calc.mjs'), `${bad}\n${calc}`);
    const r = await b.check(dir, { result: { finalMessage: 'done' } });
    assert.equal(r.pass, false); assert.match(r.notes, /^uses eval \/ new Function: /);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('battery ids are unique and follow category-level', () => {
  const ids = SMOKE_TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of SMOKE_TASKS) {
    assert.ok(Number.isInteger(t.difficulty) && t.difficulty >= 1 && t.difficulty <= 7, t.id);
    // research-5 is the second difficulty-4 research task; the id suffix is the benchmark number.
    if (t.id === 'research-5') assert.equal(t.difficulty, 4);
    else assert.equal(t.id, `${t.category}-${t.difficulty}`);
  }
  assert.deepEqual([6, 7].map((d) => SMOKE_TASKS.filter((t) => t.difficulty === d).map((t) => t.id).sort()), [['implement-6', 'refactor-6'], ['debug-7', 'implement-7']]);
});

test('runSmoke rates each run from its check and the rows reach the scorecard as smoke runs', async () => {
  let n = 0;
  const execute = async (spec) => {
    const b = BATTERY.find((x) => x.spec === spec.spec);
    const solved = n++ % 2 === 0 ? b.solve(spec.cwd) || {} : {};
    const t = { id: `smoke${n}`, ...spec, status: 'done', attempts: 1, result: { finalMessage: solved.finalMessage || 'done', usage: { input_tokens: 100, output_tokens: 10 }, durationMs: 5 } };
    recordRun(t);
    return t;
  };
  const results = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat', effort: null }], tasks: ['read-1', 'edit-1', 'debug-3'], execute });
  assert.deepEqual(results.map((r) => r.verdict), ['pass', 'fail', 'pass']);
  assert.equal(results[1].category, 'edit');
  const smoke = rootRuns({ source: 'smoke' });
  assert.equal(smoke.length, 3);
  assert.deepEqual(smoke.map((r) => r.verdict).sort(), ['fail', 'pass', 'pass']);
  assert.match(formatSmoke(results), /deepseek:deepseek-chat:default: 2\/3 passed/);
  await assert.rejects(runSmoke({ models: [] }), { status: 400 });
  await assert.rejects(runSmoke({ models: [{ provider: 'deepseek' }], tasks: ['nope'], execute }), /no matching smoke tasks/);
});

test('runSmoke repeats each selected task sequentially and filters by level', async () => {
  let calls = 0; const specs = [];
  const execute = async (spec) => {
    calls++; specs.push(spec);
    const t = { id: `repeat-${calls}`, ...spec, status: 'done', attempts: 1, result: { finalMessage: 'done', usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 } };
    recordRun(t);
    return t;
  };
  const results = await runSmoke({ models: [{ provider: 'deepseek', model: 'repeat-model' }], tasks: ['read-1', 'debug-5'], levels: [1], repeats: 3, execute });
  assert.equal(results.length, 3);
  assert.equal(calls, 3);
  assert.deepEqual(specs.map((s) => s.smokeId), ['read-1', 'read-1', 'read-1']);
});

test('a task that did not finish is rated fail with the reason', async () => {
  const execute = async (spec) => ({ id: 'late', ...spec, status: 'canceled', timedOut: true, attempts: 1, result: null });
  const [r] = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.notes, 'timeout');
});

test('a smoke task that never dispatched is skipped and not rated', async () => {
  const execute = async (spec) => ({ id: 'queued', ...spec, status: 'canceled', attempts: 0, error: 'skipped', result: null });
  const [r] = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'skipped');
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => a.taskId === 'queued' && a.verdict)), 'never rateTask when attempts is 0');
});

test('GP: a parked smoke task is canceled before scratch cleanup and remains skipped', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  const { getTask, cancelTask } = await import('../../core/tasks.mjs');
  const { bus } = await import('../../core/bus.mjs');
  const previous = loadConfig(), priorLimit = getLimits().providers.deepseek;
  const timeoutMinutes = previous.smoke.timeoutMinutes;
  delete getLimits().providers.deepseek;
  saveConfig({ providers: { deepseek: { apiKey: 'test-key' } } });
  ctx.mock.method(PROVIDERS.deepseek, 'pollLimits', async () => ({ provider: 'deepseek', windows: [], blocked: false }));
  ctx.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).pathname, '/v1/chat/completions');
    return new Response('rate limit', { status: 429, headers: { 'retry-after': String((timeoutMinutes + 1) * 60) } });
  });
  let taskId, scratchPresentAtCancel = false;
  const onTask = (e) => {
    if (e.type !== 'task' || e.task.sessionId !== 'gp-smoke-park') return;
    taskId = e.task.id;
    if (e.task.status === 'canceled') scratchPresentAtCancel = existsSync(e.task.cwd);
  };
  bus.on('event', onTask);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    const [r] = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-flash' }], tasks: ['read-1'], sessionId: 'gp-smoke-park', timeoutMinutes });
    const task = getTask(r.taskId);
    assert.equal(r.verdict, 'skipped');
    assert.equal(task.attempts, 1);
    assert.equal(task.status, 'canceled');
    assert.equal(task.error, 'provider limit (parked)');
    assert.equal(task.limitHit, true);
    assert.equal(scratchPresentAtCancel, true);
    assert.equal(existsSync(task.cwd), false);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    bus.off('event', onTask); if (taskId) cancelTask(taskId);
    if (priorLimit) getLimits().providers.deepseek = priorLimit;
    else delete getLimits().providers.deepseek;
    saveConfig({ providers: previous.providers });
  }
});

test('smoke timeouts are per invocation and bench probes never write config, even on failure', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getModels } = await import('../../core/models.mjs');
  const { runBench } = await import('../../core/bench.mjs');
  const previous = loadConfig().smoke;
  saveConfig({ smoke: { timeoutMinutes: 17 } });
  const file = join(HOME, 'config.json');
  const before = readFileSync(file, 'utf8');
  const models = [{ provider: 'deepseek', model: 'timeout-probe' }];
  const waits = [];
  const execute = async (_spec, minutes) => { waits.push(minutes); return { status: 'canceled', timedOut: true }; };
  const reg = getModels(); const saved = { models: reg.models, providers: reg.providers };
  const probeWaits = [], during = [];
  try {
    await runSmoke({ models, tasks: ['read-1'], execute, timeoutMinutes: 3 });
    await runSmoke({ models, tasks: ['read-1'], execute });
    assert.deepEqual(waits, [3, 17]);
    reg.models = [{ provider: 'codex', id: 'timeout-probe', kind: 'agent', efforts: [] }]; reg.providers = { codex: { status: 'ok' } };
    ctx.mock.method(globalThis, 'setTimeout', (fn, ms) => {
      probeWaits.push(ms); during.push(readFileSync(file, 'utf8'));
      queueMicrotask(fn); return {};
    });
    await assert.rejects(runBench({ onResult: () => { throw new Error('probe interrupted'); } }), /probe interrupted/);
    assert.deepEqual(probeWaits, [3 * 60_000], 'the bench passes the probe timeout to the real smoke executor');
    assert.deepEqual(during, [before], 'config stays untouched during the probe');
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(loadConfig().smoke.timeoutMinutes, 17);
  } finally { Object.assign(reg, saved); saveConfig({ smoke: previous }); }
});

test('an environment failure is voided immediately, not left as a failed attempt', async () => {
  const execute = async (spec) => { const t = { id: 'envfail', ...spec, status: 'failed', attempts: 1, error: 'getaddrinfo ENOTFOUND api.example', result: null }; recordRun(t); return t; };
  const [r] = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'error');
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => a.taskId === 'envfail')), 'voided at detection time');
});

test('a smoke timeout still records a run so the fail rating lands', { timeout: 30_000 }, async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  const conductor = loadConfig().conductor;
  const prevPoll = PROVIDERS.deepseek.pollLimits;
  PROVIDERS.deepseek.pollLimits = async () => ({ provider: 'deepseek', windows: [], blocked: false });
  saveConfig({ providers: { deepseek: { apiKey: 'test-key' } }, conductor: { budgetGate: false } });
  ctx.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      return new Promise((_, reject) => {
        const s = opts?.signal;
        if (!s) return;
        if (s.aborted) return reject(s.reason || new Error('aborted'));
        s.addEventListener('abort', () => reject(s.reason || new Error('aborted')), { once: true });
      });
    }
    return new Response('{}', { status: 200 });
  });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    const results = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-flash', effort: null }], tasks: ['read-1'], timeoutMinutes: 0.05 });
    assert.equal(results[0].verdict, 'fail');
    assert.equal(results[0].notes, 'timeout');
    assert.ok(results[0].taskId);
    const smoke = rootRuns({ source: 'smoke' });
    const row = smoke.find((c) => c.attempts.some((a) => a.taskId === results[0].taskId));
    assert.ok(row, 'timeout cancellation must leave a scorecard run row for rateTask to attach to');
    assert.equal(row.attempts[0].verdict, 'fail');
    assert.equal(row.attempts[0].notes, 'timeout');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    PROVIDERS.deepseek.pollLimits = prevPoll;
    saveConfig({ conductor });
  }
});

test('timeouts immediately before a provider limit surfaces are voided as the same quota stall', async () => {
  let n = 0;
  const execute = async (spec) => {
    n++;
    const t = n <= 2 ? { id: `stall${n}`, ...spec, status: 'canceled', timedOut: true, attempts: 1, result: null } : { id: `lim${n}`, ...spec, status: 'canceled', error: 'canceled', limitHit: true, attempts: 1, result: null };
    recordRun(t); return t;
  };
  const rs = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['read-1', 'search-1', 'edit-1', 'implement-2'], execute });
  assert.deepEqual(rs.map((r) => r.verdict), ['error', 'error', 'skipped']);
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => /^stall/.test(a.taskId) && a.verdict)), 'stalled timeouts do not count as failures');
});

test('timeouts immediately before a dispatch-wait limit skip are voided as the same quota stall', async () => {
  let n = 0;
  const execute = async (spec) => {
    n++;
    const t = n <= 2 ? { id: `stalldisp${n}`, ...spec, status: 'canceled', timedOut: true, attempts: 1, result: null } : { id: `parkdisp${n}`, ...spec, status: 'canceled', attempts: 0, error: 'skipped', parked: true, result: null };
    recordRun(t); return t;
  };
  const rs = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['read-1', 'search-1', 'edit-1', 'implement-2'], execute });
  assert.deepEqual(rs.map((r) => r.verdict), ['error', 'error', 'skipped']);
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => /^stalldisp/.test(a.taskId) && a.verdict)), 'stalled timeouts do not count as failures');
});

test('a user cancel before dispatch skips without voiding preceding timeouts', async () => {
  let n = 0;
  const execute = async (spec) => {
    n++;
    const t = n <= 1 ? { id: `stalluser${n}`, ...spec, status: 'canceled', timedOut: true, attempts: 1, result: null } : { id: `cancuser${n}`, ...spec, status: 'canceled', attempts: 0, error: 'canceled', result: null };
    recordRun(t); return t;
  };
  const rs = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['read-1', 'search-1'], execute });
  assert.deepEqual(rs.map((r) => r.verdict), ['fail', 'skipped']);
  assert.ok(rootRuns().some((c) => c.attempts.some((a) => a.taskId === 'stalluser1' && a.verdict === 'fail')), 'preceding timeout remains a failure on user cancel');
});

test('importing a worker module that process.exit does not kill the check', async () => {
  const b = BATTERY.find((x) => x.id === 'edit-1');
  const dir = tmpDir('smoke-s5');
  b.setup(dir);
  writeFileSync(join(dir, 'src/math.mjs'), 'process.exit(0);\nexport function add() { return 0; }\n');
  const r = await b.check(dir);
  assert.equal(r.pass, false);
  assert.match(r.notes, /import did not finish|import failed/);
  rmSync(dir, { recursive: true, force: true });
});

test('L6/L7 smoke runs are recorded and listed in the scores table', async () => {
  const { formatScores } = await import('../../core/scorecard.mjs');
  const execute = async (spec) => { const t = { id: 'hard7', ...spec, status: 'done', attempts: 1, result: { finalMessage: 'done', usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 5 } }; recordRun(t); return t; };
  const [r] = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-chat' }], tasks: ['debug-7'], execute });
  assert.equal(r.verdict, 'fail');
  assert.match(formatScores({ source: 'smoke' }), /\| debug@7 \|/);
});

test('environment failure classification includes old smoke patterns', async () => {
  const { envFailure } = await import('../../core/scorecard.mjs');
  assert.ok(envFailure({ error: 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac***fvMA.' }));
  assert.ok(envFailure({ error: 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.' }));
  assert.ok(envFailure({ error: 'Selected model is at capacity' }));
  assert.ok(envFailure({ error: 'model is at capacity' }));
  assert.equal(envFailure({ error: 'tests failed: expected 3, got 4' }), null);
});

test('a second smoke run for a selection+task already in flight skips it instead of running it twice', async () => {
  const release = Promise.withResolvers(); let calls = 0;
  const execute = async (spec) => { calls++; await release.promise; return { id: `dup${calls}`, ...spec, status: 'done', attempts: 1, result: { finalMessage: 'done', durationMs: 1 } }; };
  const sel = [{ provider: 'deepseek', model: 'deepseek-chat' }];
  const first = runSmoke({ models: sel, tasks: ['read-1'], execute });
  await new Promise((r) => setImmediate(r));
  const [dup] = await runSmoke({ models: sel, tasks: ['read-1'], execute });
  assert.equal(dup.verdict, 'skipped');
  assert.match(dup.notes, /already running/);
  release.resolve();
  await first;
  assert.equal(calls, 1);
  const again = runSmoke({ models: sel, tasks: ['read-1'], execute }); // finished: a later run is not blocked
  await again;
  assert.equal(calls, 2);
});
