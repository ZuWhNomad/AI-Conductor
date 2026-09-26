import { tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

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
function fakeSpec(lines, { exitCode = 0, parse = VENDORS.antigravity.parse, parseText, stderr = '', onClose, env } = {}) {
  const script = `const L=${JSON.stringify(lines)};for(const l of L)console.log(typeof l==='string'?l:JSON.stringify(l));${stderr ? `console.error(${JSON.stringify(stderr)});` : ''}process.exit(${exitCode})`;
  return { id: 'fake', label: 'Fake CLI', bin: () => process.execPath, headlessArgs: () => ({ args: ['-e', script], threadId: null }), parse, parseText, onClose, env, loginHint: 'fake login' };
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

test('qwen-code resumes the requested thread id', () => {
  const { args } = VENDORS['qwen-code'].headlessArgs({ prompt: 'x', cwd: 'F:/ws', resumeThreadId: 'session-123' });
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'session-123');
  assert.ok(!args.includes('--continue'));
});

// Qwen 0.23 Claude-style frames (same Anthropic Messages wire format grok uses; qwen has no usageInputExclusive).
const QWEN_FRAMES = [
  { type: 'system', subtype: 'init', session_id: 'qwen-sess-1', model: 'qwen3-coder-plus' },
  { type: 'assistant', message: { id: 'msg_0', role: 'assistant', content: [{ type: 'text', text: 'created hi.txt' }], stop_reason: 'end_turn' } },
  { type: 'result', subtype: 'success', is_error: false, result: 'created hi.txt', usage: { input_tokens: 40, output_tokens: 8, cache_read_input_tokens: 2 } },
];

test('qwen-code: Claude-style stream-json frames parse to text, usage and session', async () => {
  const spec = VENDORS['qwen-code'];
  const st = { threadId: null, text: '', finalText: null, usage: null, error: null, items: [], unknown: 0, spec };
  for (const obj of QWEN_FRAMES) spec.parse(obj, st, () => {});
  assert.equal(st.finalText, 'created hi.txt');
  assert.equal(st.error, null);
  assert.equal(st.threadId, 'qwen-sess-1');
  assert.equal(st.items.filter((i) => i.type === 'agent_message').length, 1);
  assert.equal(st.usage.input_tokens, 40);
  assert.equal(st.usage.output_tokens, 8);
  assert.equal(st.usage.exclusive, undefined);
});

test('qwen-code: exit 0 with [API Error: 429 ...] assistant text is a limit hit', async () => {
  const text = '[API Error: 429 {"error":{"message":"quota exceeded"}}]';
  const lines = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, result: text },
  ];
  const r = await runVendorCli(fakeSpec(lines, { parse: VENDORS['qwen-code'].parse, onClose: VENDORS['qwen-code'].onClose }), { id: 't', cwd: tmpDir('qwen-api-err'), prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.limitHit, true);
  assert.match(r.error, /API Error: 429/);
});

test('kimi spec sets PYTHONUTF8 and the runner merges spec.env() into the child', async () => {
  assert.deepEqual(VENDORS.kimi.env(), { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  const script = `console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:process.env.PYTHONUTF8+'|'+process.env.PYTHONIOENCODING}}))`;
  const spec = { id: 'fake', bin: () => process.execPath, headlessArgs: () => ({ args: ['-e', script] }), parse: VENDORS.antigravity.parse, env: VENDORS.kimi.env };
  const r = await runVendorCli(spec, { id: 't', cwd: tmpDir('kimi-env'), prompt: 'x' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.finalMessage, '1|utf-8');
});

test('kimi unrecognised JSON objects fall back to parseText instead of failing the run', async () => {
  const opts = { parse: VENDORS.kimi.parse, parseText: VENDORS.kimi.parseText, exitCode: 0 };
  const echoed = { error: 'Heads up: not a run failure', message: 'echoed prompt' };
  const r = await runVendorCli(fakeSpec([echoed, 'done'], opts), { id: 't', cwd: tmpDir('kimi-unrec'), prompt: 'x' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.finalMessage, /done/);
});

test('kimi headlessArgs uses --output-format stream-json (confirmed on kimi --help 1.50)', () => {
  const { args } = VENDORS.kimi.headlessArgs({ prompt: 'hi', cwd: 'F:/ws' });
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
});

test('auto-continue sums usage from the interrupted first run', async () => {
  let n = 0;
  const spec = {
    id: 'fake', bin: () => process.execPath,
    headlessArgs: () => {
      n++;
      if (n === 1) return { args: ['-e', `console.log(JSON.stringify({event:'result',result:{status:'ERROR',error:'stream was interrupted',usage:{input_tokens:10,output_tokens:3}}})); process.exit(1)`], threadId: 'th-cont' };
      return { args: ['-e', `console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'done',usage:{input_tokens:4,output_tokens:2}}}))`], threadId: 'th-cont' };
    },
    parse: VENDORS.antigravity.parse,
  };
  const r = await runVendorCli(spec, { id: 't', cwd: tmpDir('v-cont'), prompt: 'x' });
  assert.equal(r.ok, true, r.error);
  assert.equal(n, 2);
  assert.equal(r.usage.input_tokens, 14);
  assert.equal(r.usage.output_tokens, 5);
});

test('grok long-prompt temp file is created with mode 0o600', (t) => {
  let seen;
  const orig = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (path, data, options) => { seen = options; return orig.call(fs, path, data, options); });
  syncBuiltinESMExports();
  let pf;
  try {
    const big = VENDORS.grok.headlessArgs({ prompt: 'x'.repeat(20000), cwd: 'F:/ws', model: 'grok-4.6' });
    pf = big.args[big.args.indexOf('--prompt-file') + 1];
    assert.equal(seen?.mode, 0o600);
    if (process.platform !== 'win32') assert.equal(statSync(pf).mode & 0o777, 0o600);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    try { if (pf) unlinkSync(pf); } catch {}
  }
});

test('detect and listModels share one models probe; loginCommand computes canLogin once', async () => {
  const cwd = tmpDir('probe-once');
  const nfile = join(cwd, 'n.txt');
  writeFileSync(nfile, '0');
  const script = join(cwd, 'cli.js');
  writeFileSync(script, `const { writeFileSync, readFileSync } = require('node:fs');
const f = ${JSON.stringify(nfile)};
writeFileSync(f, String(Number(readFileSync(f, 'utf8')) + 1));
console.log('  * grok-4.6 (default)');
`);
  const WIN = process.platform === 'win32';
  const bin = join(cwd, WIN ? 'grok.cmd' : 'grok');
  if (WIN) writeFileSync(bin, `@echo off\r\n"${process.execPath}" "%~dp0cli.js" %*\r\n`);
  else { writeFileSync(bin, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`); chmodSync(bin, 0o755); }
  let binCalls = 0;
  const p = providerFor({ ...VENDORS.grok, bin: () => { binCalls++; return bin; } });
  await p.detect();
  await p.listModels();
  assert.equal(readFileSync(nfile, 'utf8'), '1');
  binCalls = 0;
  p.loginCommand();
  p.loginCommand();
  assert.equal(binCalls, 1);
});

test('read-only sandbox maps to vendor plan flags confirmed on each CLI --help', () => {
  const t = { prompt: 'hi', cwd: 'F:/ws', timeoutMs: 60_000, sandbox: 'read-only' };
  const agy = VENDORS.antigravity.headlessArgs(t);
  assert.equal(agy.args[agy.args.indexOf('--mode') + 1], 'plan');
  assert.ok(!agy.args.includes('--dangerously-skip-permissions'));
  const grok = VENDORS.grok.headlessArgs(t);
  assert.equal(grok.args[grok.args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(!grok.args.includes('--always-approve'));
  const qwen = VENDORS['qwen-code'].headlessArgs(t);
  assert.equal(qwen.args[qwen.args.indexOf('--approval-mode') + 1], 'plan');
  const kimi = VENDORS.kimi.headlessArgs(t);
  assert.ok(kimi.args.includes('--plan'));
  assert.ok(!kimi.args.includes('--yolo'));
  const open = { prompt: 'hi', cwd: 'F:/ws', timeoutMs: 60_000 };
  assert.ok(VENDORS.antigravity.headlessArgs(open).args.includes('--dangerously-skip-permissions'));
  assert.ok(VENDORS.grok.headlessArgs(open).args.includes('--always-approve'));
  assert.equal(VENDORS['qwen-code'].headlessArgs(open).args[VENDORS['qwen-code'].headlessArgs(open).args.indexOf('--approval-mode') + 1], 'yolo');
  assert.ok(VENDORS.kimi.headlessArgs(open).args.includes('--yolo'));
});

test('grok: a 402 exhausted balance (recorded 2026-09-25, reason only in errors[]) is a limit hit with the reason, not error_during_execution', async () => {
  const line = { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 900, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, errors: ["Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"] };
  const r = await runVendorCli(fakeSpec([line], { exitCode: 1, parse: VENDORS.grok.parse }), { id: 't', cwd: tmpDir('grok402'), prompt: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /balance exhausted/);
  assert.equal(r.limitHit, true);
});

test('grok: the out-of-balance run as `grok` 1.0.30 really emits it (2026-09-25: result on stdout, same text on stderr) is a limit hit', async () => {
  // Recorded live: `grok --output-format streaming-messages-json -p …` with the Grok Build balance spent. Zero tokens,
  // subtype error_during_execution, the reason only in errors[] and on stderr.
  const result = { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 1164, duration_api_ms: 0, num_turns: 0, stop_reason: null, total_cost_usd: 0.0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } }, modelUsage: {}, errors: ['Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}'], session_id: '01a0db55-537e-75b3-b8ff-68dbb6c1acff' };
  const stderr = 'Error: Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}';
  for (const exitCode of [0, 1]) {
    const r = await runVendorCli(fakeSpec([{ type: 'system', subtype: 'init', session_id: result.session_id, model: 'grok-4.6', permissionMode: 'plan' }, result], { exitCode, stderr, parse: VENDORS.grok.parse }), { id: 't', cwd: tmpDir('grok402live'), prompt: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.limitHit, true, `exit ${exitCode}`);
    assert.equal(r.authFailed, false);
  }
});

test('grok: a plan-mode tool cancel (read from the grok session events) is an environment failure, not a model fail', async () => {
  const { mkdirSync } = await import('node:fs');
  const home = tmpDir('grok-home'), cwd = tmpDir('grokplan'), session = 'fd7366bc-7640-419e-b3ce-c4415cfc9bf2';
  const dir = join(home, 'sessions', encodeURIComponent(cwd), session);
  mkdirSync(dir, { recursive: true });
  // Recorded 2026-09-24 (grok 1.0.30, task x8mvhdjw): the tail of ~/.grok/sessions/<cwd>/<session>/events.jsonl.
  writeFileSync(join(dir, 'events.jsonl'), [
    '{"ts":"2026-09-24T22:31:28.872Z","type":"permission_resolved","tool_name":"grep","decision":"allow","wait_ms":0}',
    '{"ts":"2026-09-24T22:32:37.328Z","type":"tool_started","tool_name":"write"}',
    '{"ts":"2026-09-24T22:32:37.329Z","type":"permission_requested","tool_name":"write"}',
    '{"ts":"2026-09-24T22:32:37.335Z","type":"permission_resolved","tool_name":"write","decision":"cancelled","wait_ms":6}',
    '{"ts":"2026-09-24T22:32:37.381Z","type":"turn_ended","outcome":"cancelled","cancellation_category":"permission_cancelled"}',
  ].join('\n') + '\n');
  const previous = process.env.GROK_HOME; process.env.GROK_HOME = home;
  try {
    const lines = [
      { type: 'system', subtype: 'init', session_id: session, model: 'grok-4.6', permissionMode: 'plan' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I will write a scratch inspector.' }, { type: 'tool_use', id: 'c1', name: 'write', input: { file_path: 'x.py' } }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 75542, output_tokens: 10084 } },
    ];
    const spec = { ...fakeSpec(lines, { exitCode: 0, parse: VENDORS.grok.parse }), onClose: VENDORS.grok.onClose };
    const r = await runVendorCli(spec, { id: 't', cwd, prompt: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.envFailed, true);
    assert.equal(r.limitHit, false);
    assert.equal(r.authFailed, false);
    assert.match(r.error, /plan\) mode cancelled the write call/);
    // Same stream, but grok recorded a normal error end: not an environment failure.
    writeFileSync(join(dir, 'events.jsonl'), '{"ts":"2026-09-15T22:52:38.414Z","type":"turn_ended","outcome":"error"}\n');
    assert.equal((await runVendorCli(spec, { id: 't', cwd, prompt: 'x' })).envFailed, false);
  } finally { if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous; }
});

test('grok: the decision comes from http_status, not the text; text is only a logged fallback', async () => {
  const { httpStatusOf } = await import('../../core/providers/vendors.mjs');
  const { statePath } = await import('../../core/paths.mjs');
  const rec = (status) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 0, output_tokens: 0 }, errors: [`Internal error: {
  "message": "API error (status ${status})",
  "http_status": ${status}
}`] });
  assert.equal(httpStatusOf(rec(402)), 402);
  for (const [status, limitHit, authFailed] of [[402, true, false], [429, true, false], [401, false, true], [403, false, true], [500, false, false]]) {
    const r = await runVendorCli(fakeSpec([rec(status)], { exitCode: 1, parse: VENDORS.grok.parse }), { id: 't', cwd: tmpDir('grokstatus'), prompt: 'x' });
    assert.deepEqual([r.limitHit, r.authFailed], [limitHit, authFailed], String(status));
  }
  // A 500 whose text says "quota": the structured status wins, no keyword decision.
  const quotaText = { ...rec(500), errors: ['Internal error: {"message": "quota exceeded", "http_status": 500}'] };
  assert.equal((await runVendorCli(fakeSpec([quotaText], { exitCode: 1, parse: VENDORS.grok.parse }), { id: 't', cwd: tmpDir('grokstatus'), prompt: 'x' })).limitHit, false);
  // No http_status at all: the text fallback still decides, and says so in the improvement log.
  const fb = await runVendorCli({ ...fakeSpec([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limit reached'] }], { exitCode: 1, parse: VENDORS.grok.parse }), id: 'fallback-probe' }, { id: 't', cwd: tmpDir('grokstatus'), prompt: 'x' });
  assert.equal(fb.limitHit, true);
  assert.match(readFileSync(statePath('improvements.ndjson'), 'utf8'), /"source":"worker:fallback-probe","message":"limit failure recognised from text: fallback-probe gave no structured status/);
});
