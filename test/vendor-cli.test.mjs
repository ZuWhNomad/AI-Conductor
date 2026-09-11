import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runVendorCli } = await import('../core/workers/vendor-cli.mjs');
const { VENDORS, providerFor } = await import('../core/providers/vendors.mjs');

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
function fakeSpec(lines, { exitCode = 0, parse = VENDORS.antigravity.parse } = {}) {
  const script = `const L=${JSON.stringify(lines)};for(const l of L)console.log(typeof l==='string'?l:JSON.stringify(l));process.exit(${exitCode})`;
  return { id: 'fake', label: 'Fake CLI', bin: () => process.execPath, headlessArgs: () => ({ args: ['-e', script], threadId: null }), parse, loginHint: 'fake login' };
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

test('grok and antigravity model lists parse', () => {
  assert.deepEqual(VENDORS.grok.parseModels('You are not authenticated.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n'), [{ id: 'grok-4.5', label: 'grok-4.5' }]);
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
  const { VENDORS } = await import('../core/providers/vendors.mjs');
  const spec = VENDORS.grok; const st = { threadId: null, text: '', finalText: null, usage: null, error: null, items: [], unknown: 0, spec };
  const emit = () => {};
  const lines = [
    { type: 'system', subtype: 'init', session_id: '01a08d12-75c4-7a63-a13e-3fad8a8b838b', model: 'grok-4.6', permissionMode: 'bypassPermissions' },
    { type: 'assistant', message: { id: 'msg_0', role: 'assistant', model: 'grok-4.6', content: [{ type: 'thinking', thinking: 'reply pong' }, { type: 'text', text: 'pong' }], stop_reason: 'end_turn' } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'pong', usage: { input_tokens: 15559, output_tokens: 41, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 }, total_cost_usd: 0.031428, session_id: '01a08d12-ac3f-7341-b8ec-77cb6e8fb010' },
  ];
  const { _P } = await import('../core/workers/vendor-cli.mjs').catch(() => ({}));
  for (const obj of lines) spec.parse(obj, st, emit);
  assert.equal(st.finalText, 'pong');
  assert.equal(st.error, null);
  assert.equal(st.threadId, '01a08d12-75c4-7a63-a13e-3fad8a8b838b');
  assert.equal(st.items.filter((i) => i.type === 'agent_message').length, 1);
  assert.equal(spec.headlessArgs({ prompt: 'x', cwd: 'C:\w' }).args.includes('streaming-messages-json'), true);
  assert.equal(spec.usageInputExclusive, true);
});

test('a quota error printed on stdout (kimi 1.50, 403 access_terminated_error) counts as a limit hit', async () => {
  const { VENDORS } = await import('../core/providers/vendors.mjs');
  const st = { threadId: null, text: '', finalText: null, usage: null, error: null, items: [], unknown: 0 };
  VENDORS.kimi.parseText(`Error code: 403 - {'error': {'message': "You've reached your monthly usage limit for this billing cycle.", 'type': 'access_terminated_error'}}`, st);
  const LIMIT_RE = /rate[_ -]?limit|quota (?:exceeded|exhausted|reached)|usage limit|too many requests|\b429\b|resource[_ ]exhausted|plan limit|insufficient (?:credits|quota|balance)/i;
  assert.match(st.text, LIMIT_RE);
});

test('antigravity: `agy -p /usage --output-format json` (1.2.1, recorded 2026-09-11) parses into model-group windows', async () => {
  const { parseAgyUsage } = await import('../core/providers/vendors.mjs');
  const rec = '{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\\tWeekly Limit Remaining\\t83%\\t2026-09-17T20:44:33Z\\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.8341392278671265,"reset_time":"2026-09-17T20:44:33Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.9859520792961121,"reset_time":"2026-09-11T12:06:03Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.6587018370628357,"reset_time":"2026-09-17T20:46:25Z"},{"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0,"reset_time":"2026-09-11T12:08:32Z"}]}]}}}';
  const u = parseAgyUsage(rec);
  assert.equal(u.windows.length, 4);
  const g5 = u.windows.find((w) => w.id === 'antigravity:gemini-5h');
  assert.deepEqual({ ...g5, resetsAt: new Date(g5.resetsAt).toISOString() }, { id: 'antigravity:gemini-5h', label: 'Gemini 5-hour', usedPercent: 1.4, resetsAt: '2026-09-11T12:06:03.000Z', windowMinutes: 300, models: '^(gemini)' });
  const c5 = u.windows.find((w) => w.id === 'antigravity:3p-5h');
  assert.equal(c5.usedPercent, 100); assert.equal(c5.models, '^(claude|gpt)'); assert.equal(c5.label, 'Claude and GPT 5-hour');
  assert.equal(parseAgyUsage('jetski: no output produced'), null);
  // The router applies a window only to the models it meters: Claude on the Google plan is full, Gemini is not.
  const lim = await import('../core/limits.mjs');
  const sc = await import('../core/scorecard.mjs');
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: u.windows };
  assert.equal(sc.providerUsedPct('antigravity', { model: 'gemini-3.8-flash-low' }), 16.59);
  assert.equal(sc.providerUsedPct('antigravity', { model: 'claude-sonnet-4-6' }), 100);
  assert.equal(sc.providerAvailable('antigravity', { model: 'gemini-3.8-flash-low' }), true);
  assert.equal(sc.providerAvailable('antigravity', { model: 'claude-sonnet-4-6' }), false);
  assert.equal(sc.providerAvailable('antigravity', { model: 'gpt-oss-120b-medium' }), false);
  assert.equal(sc.providerUsedPct('antigravity'), 100); // no model: busiest window, as before
  delete lim.getLimits().providers.antigravity;
});
