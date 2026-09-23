import { tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runVendorCli } = await import('../../core/workers/vendor-cli.mjs');
const { VENDORS, providerFor } = await import('../../core/providers/vendors.mjs');

// Events captured from a real `agy -p ... --output-format stream-json` run (agy 1.1.27, 2026-09-08).
const AGY = [
  { event: 'init', conversation_id: 'c-1', init: { model: 'gemini-3.8-flash-low' } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 13550, output_tokens: 151, thinking_tokens: 0, cache_read_tokens: 0 } } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'hi.txt' } } } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'I have created' } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: ' hi.txt.\n', usage: { input_tokens: 5763, output_tokens: 102, thinking_tokens: 0, cache_read_tokens: 8125 } } },
  { event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: 'I have created hi.txt.\n', num_turns: 1, usage: { input_tokens: 19313, output_tokens: 253 } } },
];

/** A spec whose "binary" is node printing the given lines — exercises the runner end to end. */
function fakeSpec(lines, { exitCode = 0, parse = VENDORS.antigravity.parse, parseText, stderr = '' } = {}) {
  const script = `const L=${JSON.stringify(lines)};for(const l of L)console.log(typeof l==='string'?l:JSON.stringify(l));${stderr ? `console.error(${JSON.stringify(stderr)});` : ''}process.exit(${exitCode})`;
  return { id: 'fake', label: 'Fake CLI', bin: () => process.execPath, headlessArgs: () => ({ args: ['-e', script], threadId: null }), parse, parseText, loginHint: 'fake login' };
}

test('vendor runner folds agy stream-json into the common result', async () => {
  const seen = [];
  const r = await runVendorCli(fakeSpec(AGY), { id: 't', cwd: tmpDir('vendor'), prompt: 'x', onEvent: (e, d) => seen.push(e + ':' + (d.item?.type || d.toolUseId || '')) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.threadId, 'c-1');
  assert.equal(r.finalMessage, 'I have created hi.txt.');
  assert.deepEqual(r.usage, { input_tokens: 19313, output_tokens: 253, cached_input_tokens: 8125, reasoning_output_tokens: 0 }); // per-step deltas, not the result total again
  assert.ok(seen.includes('item:tool_use') && seen.includes('tool_result:agy-2') && seen.includes('item:agent_message'));
});

test('vendor runner classifies auth and limit failures and non-zero exits', async () => {
  const signedOut = await runVendorCli(fakeSpec([{ type: 'error', message: 'Not signed in. Run `grok login`.' }], { exitCode: 1, parse: VENDORS.grok.parse }), { id: 't', cwd: tmpDir('v2'), prompt: 'x' });
  assert.equal(signedOut.ok, false);
  assert.equal(signedOut.authFailed, true);
  assert.match(signedOut.error, /Not signed in/);
  const limited = await runVendorCli(fakeSpec([{ event: 'result', result: { status: 'ERROR', error: 'quota exceeded, try again later' } }]), { id: 't', cwd: tmpDir('v3'), prompt: 'x' });
  assert.equal(limited.limitHit, true);
  const silent = await runVendorCli(fakeSpec([]), { id: 't', cwd: tmpDir('v4'), prompt: 'x' });
  assert.match(silent.error, /no output/);
});

test('a successful run with a 429 retry on stderr is not a limit hit', async () => {
  const r = await runVendorCli(fakeSpec(AGY, { exitCode: 0, stderr: 'Attempt 1 failed with status 429. Retrying...' }), { id: 't', cwd: tmpDir('v429'), prompt: 'x' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.limitHit, false);
  assert.equal(r.authFailed, false);
});

test('grok and antigravity model lists parse', () => {
  assert.deepEqual(VENDORS.grok.parseModels('You are not authenticated.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n'), [{ id: 'grok-4.5', label: 'grok-4.5', isDefault: true }]);
  // Recorded from `grok models` on a signed-in machine (2026-09-20): the default is starred, the rest are dashed.
  assert.deepEqual(VENDORS.grok.parseModels('You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n'), [
    { id: 'grok-4.6', label: 'grok-4.6', isDefault: true },
    { id: 'grok-4.5', label: 'grok-4.5', isDefault: false },
  ]);
  assert.deepEqual(VENDORS.antigravity.parseModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n').map((m) => m.id), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
});

test('providerFor exposes install/login commands and reports a missing binary', async () => {
  const p = providerFor({ ...VENDORS.grok, bin: () => null });
  const det = await p.detect();
  assert.equal(det.installed, false);
  assert.match(p.installCommand(), /x\.ai\/cli\/install/);
  assert.match(p.loginCommand(), /grok login$/);
  assert.equal(p.kind, 'vendor-cli');
  assert.deepEqual(await p.listModels(), []);
});

test('grok: streaming-messages-json shapes recorded 2026-09-10 parse to text, usage and session', async () => {
  const { VENDORS } = await import('../../core/providers/vendors.mjs');
  const spec = VENDORS.grok; const st = { threadId: null, text: '', finalText: null, usage: null, error: null, items: [], unknown: 0, spec };
  const emit = () => {};
  const lines = [
    { type: 'system', subtype: 'init', session_id: '01a08d12-75c4-7a63-a13e-3fad8a8b838b', model: 'grok-4.6', permissionMode: 'bypassPermissions' },
    { type: 'assistant', message: { id: 'msg_0', role: 'assistant', model: 'grok-4.6', content: [{ type: 'thinking', thinking: 'reply pong' }, { type: 'text', text: 'pong' }], stop_reason: 'end_turn' } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'pong', usage: { input_tokens: 15559, output_tokens: 41, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 }, total_cost_usd: 0.031428, session_id: '01a08d12-ac3f-7341-b8ec-77cb6e8fb010' },
  ];
  const { _P } = await import('../../core/workers/vendor-cli.mjs').catch(() => ({}));
  for (const obj of lines) spec.parse(obj, st, emit);
  assert.equal(st.finalText, 'pong');
  assert.equal(st.error, null);
  assert.equal(st.threadId, '01a08d12-75c4-7a63-a13e-3fad8a8b838b');
  assert.equal(st.items.filter((i) => i.type === 'agent_message').length, 1);
  assert.equal(spec.headlessArgs({ prompt: 'x', cwd: 'C:\w' }).args.includes('streaming-messages-json'), true);
  assert.equal(spec.usageInputExclusive, true);
});

const KIMI_QUOTA = `Error code: 403 - {'error': {'message': "You've reached your monthly usage limit for this billing cycle.", 'type': 'access_terminated_error'}}`;

test('a quota error printed on stdout (kimi 1.50, 403 access_terminated_error) counts as a limit hit', async () => {
  const { VENDORS } = await import('../../core/providers/vendors.mjs');
  const st = { threadId: null, text: '', finalText: null, usage: null, error: null, items: [], unknown: 0 };
  VENDORS.kimi.parseText(KIMI_QUOTA, st);
  const LIMIT_RE = /rate[_ -]?limit|quota (?:exceeded|exhausted|reached)|usage limit|too many requests|\b429\b|resource[_ ]exhausted|plan limit|insufficient (?:credits|quota|balance)/i;
  assert.match(st.text, LIMIT_RE);
});

test('kimi monthly usage limit on stdout is a limit hit at exit 1 and at exit 0 with only that line', async () => {
  const opts = { parse: VENDORS.kimi.parse, parseText: VENDORS.kimi.parseText };
  const failed = await runVendorCli(fakeSpec([KIMI_QUOTA], { ...opts, exitCode: 1 }), { id: 't', cwd: tmpDir('kimi-lim1'), prompt: 'x' });
  assert.equal(failed.ok, false);
  assert.equal(failed.limitHit, true);
  const zero = await runVendorCli(fakeSpec([KIMI_QUOTA], { ...opts, exitCode: 0 }), { id: 't', cwd: tmpDir('kimi-lim0'), prompt: 'x' });
  assert.equal(zero.ok, false);
  assert.equal(zero.limitHit, true);
});

test('a 2000-char kimi report containing rate limit at exit 0 is not a quota failure', async () => {
  const opts = { parse: VENDORS.kimi.parse, parseText: VENDORS.kimi.parseText };
  const needle = 'rate limit';
  const report = needle + ' ' + 'a'.repeat(2000 - needle.length - 1);
  assert.equal(report.length, 2000);
  const r = await runVendorCli(fakeSpec([report], { ...opts, exitCode: 0 }), { id: 't', cwd: tmpDir('kimi-long'), prompt: 'x' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.limitHit, false);
});

test('a failed run whose narration mentions 429 is not a limit hit', async () => {
  const opts = { parse: VENDORS.kimi.parse, parseText: VENDORS.kimi.parseText, exitCode: 1 };
  const narration = 'Implementing retry on 429 rate limit as specified.\n' + 'x'.repeat(400);
  const r = await runVendorCli(fakeSpec([narration], opts), { id: 't', cwd: tmpDir('fail-429-narr'), prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.limitHit, false);
});

test('short kimi successes mentioning quota handling are not quota failures', async () => {
  const opts = { parse: VENDORS.kimi.parse, parseText: VENDORS.kimi.parseText, exitCode: 0 };
  for (const line of [
    'no 429 today',
    'Added 429 retry with backoff; tests pass.',
    'Handled the too many requests response; tests passed.',
    'Handled the monthly usage limit error; tests passed.',
    'Added tests for quota exceeded and insufficient balance.',
    'Fixed the rate limit reached response.',
    `Handled this response: ${KIMI_QUOTA}`,
    `${KIMI_QUOTA}\nHandled the error; tests passed.`,
  ]) {
    const r = await runVendorCli(fakeSpec([line], opts), { id: 't', cwd: tmpDir('kimi-429-ok'), prompt: 'x' });
    assert.equal(r.ok, true, `${line}: ${r.error}`);
    assert.equal(r.limitHit, false, line);
  }
});

test('antigravity: `agy -p /usage --output-format json` (1.2.1, recorded 2026-09-11) parses into model-group windows', async () => {
  const { parseAgyUsage } = await import('../../core/providers/vendors.mjs');
  const rec = '{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\\tWeekly Limit Remaining\\t83%\\t2026-09-17T20:44:33Z\\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.8341392278671265,"reset_time":"2026-09-17T20:44:33Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.9859520792961121,"reset_time":"2026-09-11T12:06:03Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.6587018370628357,"reset_time":"2026-09-17T20:46:25Z"},{"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0,"reset_time":"2026-09-11T12:08:32Z"}]}]}}}';
  const u = parseAgyUsage(rec);
  assert.equal(u.windows.length, 4);
  const g5 = u.windows.find((w) => w.id === 'antigravity:gemini-5h');
  assert.deepEqual({ ...g5, resetsAt: new Date(g5.resetsAt).toISOString() }, { id: 'antigravity:gemini-5h', label: 'Gemini 5-hour', usedPercent: 1.4, resetsAt: '2026-09-11T12:06:03.000Z', windowMinutes: 300, models: '^(gemini)' });
  const c5 = u.windows.find((w) => w.id === 'antigravity:3p-5h');
  assert.equal(c5.usedPercent, 100); assert.equal(c5.models, '^(claude|gpt)'); assert.equal(c5.label, 'Claude and GPT 5-hour');
  assert.equal(parseAgyUsage('jetski: no output produced'), null);
  // The router applies a window only to the models it meters: Claude on the Google plan is full, Gemini is not.
  const lim = await import('../../core/limits.mjs');
  const sc = await import('../../core/scorecard.mjs');
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: u.windows.map((w) => ({ ...w, resetsAt: Date.now() + 60_000 })) };
  assert.equal(sc.providerUsedPct('antigravity', { model: 'gemini-3.8-flash-low' }), 16.59);
  assert.equal(sc.providerUsedPct('antigravity', { model: 'claude-sonnet-4-6' }), 100);
  assert.equal(sc.providerAvailable('antigravity', { model: 'gemini-3.8-flash-low' }), true);
  assert.equal(sc.providerAvailable('antigravity', { model: 'claude-sonnet-4-6' }), false);
  assert.equal(sc.providerAvailable('antigravity', { model: 'gpt-oss-120b-medium' }), false);
  assert.equal(sc.providerUsedPct('antigravity'), 100); // no model: busiest window, as before
  delete lim.getLimits().providers.antigravity;
});

test('parseAgyUsage escapes regex metacharacters in group names (C++ Models)', async () => {
  const { parseAgyUsage } = await import('../../core/providers/vendors.mjs');
  const rec = '{"command":{"data":{"groups":[{"name":"C++ Models","description":"Models within this group: C++ Models","buckets":[{"id":"cpp-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.5,"reset_time":"2026-09-17T20:44:33Z"}]}]}}}';
  const u = parseAgyUsage(rec);
  assert.equal(u.windows[0].models, '^(c\\+\\+)');
  assert.doesNotThrow(() => new RegExp(u.windows[0].models));
});

test('the Claude "weekly Fable" window applies to Fable models only', async () => {
  const lim = await import('../../core/limits.mjs'); const sc = await import('../../core/scorecard.mjs');
  lim.getLimits().providers.claude = { provider: 'claude', windows: [{ id: 'claude:5h', label: '5-hour', usedPercent: 20 }, { id: 'claude:w', label: 'weekly', usedPercent: 60 }, { id: 'claude:wf', label: 'weekly Fable', usedPercent: 94 }] };
  assert.equal(sc.providerUsedPct('claude', { model: 'claude-opus-4-8' }), 60);   // Fable window ignored for Opus
  assert.equal(sc.providerUsedPct('claude', { model: 'claude-fable-5-1[1m]' }), 94);
  assert.equal(sc.providerUsedPct('claude'), 94);                                    // no model: busiest, as before
  delete lim.getLimits().providers.claude;
});

test('Method C: collapseEffortFamilies folds -low/-medium/-high into one family model with real efforts + concrete-id map', async () => {
  const { collapseEffortFamilies } = await import('../../core/providers/vendors.mjs');
  const out = collapseEffortFamilies([
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  ]);
  assert.equal(out.length, 2, 'three variants collapse to one family + the passthrough');
  const fam = out.find((m) => m.id === 'gemini-3.8-flash');
  assert.deepEqual(fam.efforts, ['low', 'medium', 'high']);
  assert.deepEqual(fam.effortIds, { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' });
  assert.equal(fam.label, 'Gemini 3.8 Flash'); // the (Low/Medium/High) parenthetical is stripped for the family label
  const pass = out.find((m) => m.id === 'claude-sonnet-4-6');
  assert.ok(pass && !pass.efforts, 'a model with no effort suffix passes through untouched');
});

test('Method C: antigravity headlessArgs maps (family, effort) -> concrete id and never passes --effort', async () => {
  const { getModels } = await import('../../core/models.mjs');
  getModels().models.push({ provider: 'antigravity', id: 'gemini-3.8-flash', kind: 'agent', efforts: ['low', 'medium', 'high'], effortIds: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' } });
  const a = VENDORS.antigravity.headlessArgs({ model: 'gemini-3.8-flash', effort: 'high', prompt: 'x', cwd: 'F:/ws', timeoutMs: 60000 });
  assert.equal(a.args[a.args.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.ok(!a.args.includes('--effort'), 'agy rejects --effort; the level lives in the id');
  // a legacy raw id (+ spurious effort) dispatches as-is — never a bogus "gemini-3.6-flash-low-high"
  const b = VENDORS.antigravity.headlessArgs({ model: 'gemini-3.6-flash-low', effort: 'high', prompt: 'x', cwd: 'F:/ws', timeoutMs: 60000 });
  assert.equal(b.args[b.args.indexOf('--model') + 1], 'gemini-3.6-flash-low');
  // an out-of-range effort on a known family clamps to the top variant, never a bare (unroutable) family id
  const c = VENDORS.antigravity.headlessArgs({ model: 'gemini-3.8-flash', effort: 'ultra', prompt: 'x', cwd: 'F:/ws', timeoutMs: 60000 });
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  // no effort on a known family dispatches its cheapest (lowest listed) variant, never a bare family id
  const d = VENDORS.antigravity.headlessArgs({ model: 'gemini-3.8-flash', effort: null, prompt: 'x', cwd: 'F:/ws', timeoutMs: 60000 });
  assert.equal(d.args[d.args.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.ok(!d.args.includes('--effort'), 'agy rejects --effort; the level lives in the id');
});

test('grok headlessArgs: a large prompt goes to --prompt-file (outside cwd), a small one stays inline (Windows arg-length safety)', async () => {
  const { VENDORS } = await import('../../core/providers/vendors.mjs');
  const small = VENDORS.grok.headlessArgs({ prompt: 'hi', cwd: 'F:/ws', model: 'grok-4.6', effort: 'high' });
  assert.ok(small.args.includes('-p') && !small.args.includes('--prompt-file'));
  const big = VENDORS.grok.headlessArgs({ prompt: 'x'.repeat(20000), cwd: 'F:/ws', model: 'grok-4.6', effort: 'high' });
  assert.ok(!big.args.includes('-p') && big.args.includes('--prompt-file'));
  const pf = big.args[big.args.indexOf('--prompt-file') + 1];
  assert.ok(/grok-prompt-.*\.txt$/.test(pf) && !pf.includes('F:/ws')); // outside the workspace
  assert.equal((await import('node:fs')).readFileSync(pf, 'utf8').length, 20000);
});

test('antigravity, qwen-code and kimi: a 40k prompt is not passed as a long argv argument', () => {
  const prompt = 'x'.repeat(40_000);
  const t = { prompt, cwd: 'F:/ws', timeoutMs: 60_000 };
  for (const id of ['antigravity', 'qwen-code', 'kimi']) {
    const { args, cleanup } = VENDORS[id].headlessArgs(t);
    try {
      const long = (args || []).filter((a) => typeof a === 'string' && a.length > 8000);
      assert.equal(long.length, 0, `${id} put a ${long[0]?.length} char argument on argv`);
    } finally { try { cleanup?.(); } catch {} }
  }
});

test('antigravity: a 40k prompt uses --input-format text and does not pass -p; short prompts still pass -p', () => {
  const long = VENDORS.antigravity.headlessArgs({ prompt: 'x'.repeat(40_000), cwd: 'F:/ws', timeoutMs: 60_000 });
  const i = long.args.indexOf('--input-format');
  assert.ok(i >= 0 && long.args[i + 1] === 'text', 'long prompt must set --input-format text');
  assert.ok(!long.args.includes('-p'), 'agy 1.2.8 -p takes a prompt value; omit it when piping stdin');
  assert.equal(long.stdinPrompt, true);
  const short = VENDORS.antigravity.headlessArgs({ prompt: 'hi', cwd: 'F:/ws', timeoutMs: 60_000 });
  assert.ok(short.args.includes('-p'));
  assert.equal(short.args[short.args.indexOf('-p') + 1], 'hi');
  assert.ok(!short.stdinPrompt);
});

test('vendor runner sends the prompt on stdin when headlessArgs sets stdinPrompt', async () => {
  const script = `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:s}}));});`;
  const spec = { id: 'fake', bin: () => process.execPath, headlessArgs: () => ({ args: ['-e', script], stdinPrompt: true }), parse: VENDORS.antigravity.parse };
  const r = await runVendorCli(spec, { id: 't', cwd: tmpDir('stdin'), prompt: 'hello-stdin' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.finalMessage, 'hello-stdin');
});
