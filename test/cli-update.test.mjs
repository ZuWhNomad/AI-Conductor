import { tmpDir, HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cu = await import('../core/cli-update.mjs');
const { loadConfig, saveConfig, DEFAULTS } = await import('../core/config.mjs');

/** A stubbed exec: nothing is ever installed. `versions` is what `--version` prints, in call order (the last repeats). */
function stubExec({ versions = ['codex-cli 0.153.4'], latest = '0.157.1', installCode = 0, signedIn = true, smoke = { ok: true, notes: 'pass' }, busy = null, dev = false, test: testCode = 0 } = {}) {
  const calls = [];
  let v = 0;
  const x = {
    bin: (id) => (id === 'codex' ? { command: 'node', args: ['/npm/node_modules/@openai/codex/bin/codex.js'] } : { command: `/fake/${id}`, args: [] }),
    run: async (cmd, args) => {
      calls.push(['run', cmd, ...args]);
      if (args.includes('--version')) return { code: 0, out: versions[Math.min(v++, versions.length - 1)] };
      if (args[0] === 'update' && args[1] === '--check') return { code: 0, out: JSON.stringify({ currentVersion: '1.0.30', latestVersion: latest, channel: 'stable' }) };
      return { code: installCode, out: installCode ? 'EBUSY: resource busy or locked' : 'ok' };
    },
    npm: async (args) => {
      calls.push(['npm', ...args]);
      if (args[0] === 'view') return { code: 0, out: `${latest}\n` };
      if (args[0] === 'test') return { code: testCode, out: testCode ? 'not ok 1 - sdk' : 'ok' };
      return { code: installCode, out: installCode ? 'EBUSY' : 'ok' };
    },
    fetchJson: async () => ({ version: latest, info: { version: latest } }),
    copy: (a, b) => calls.push(['copy', a, b]),
    sdkVersion: () => versions[Math.min(v++, versions.length - 1)],
    devCheckout: () => dev,
    signedIn: async () => signedIn,
    smoke: async () => smoke,
    busy: async () => busy,
    hold: async (id, on) => calls.push(['hold', id, on]),
    refresh: async () => calls.push(['refresh']),
  };
  return { x, calls };
}
const installs = (calls) => calls.filter((c) => (c[0] === 'npm' && c[1] === 'i') || (c[0] === 'run' && (c.includes('install') || (c[2] === 'update' && c[3] === '--version'))));

test('versions: every CLI format parses; the compare is numeric; pre-releases never count as an update', () => {
  assert.equal(cu.parseVersion('codex-cli 0.157.1'), '0.157.1');
  assert.equal(cu.parseVersion('grok 1.0.30 (04b7ffed98c6) [stable]'), '1.0.30');
  assert.equal(cu.parseVersion('kimi, version 1.50.0'), '1.50.0');
  assert.equal(cu.parseVersion('1.2.11\n'), '1.2.11');
  assert.equal(cu.parseVersion('0.159.0-alpha.3-linux-arm64'), '0.159.0-alpha.3-linux-arm64');
  assert.ok(cu.cmpVersion('1.0.10', '1.0.9') > 0);
  assert.ok(cu.cmpVersion('0.153.4', '0.157.1') < 0);
  assert.equal(cu.isNewer('0.153.4', '0.157.1'), true);
  assert.equal(cu.isNewer('0.157.1', '0.157.1'), false);
  assert.equal(cu.isNewer('0.157.1', '0.158.0-alpha.15'), false);
  assert.equal(cu.isNewer('1.0.30', '1.0.41-beta.1'), false);
  assert.equal(cu.isNewer(null, '1.0.0'), false);
});

test('a check reports "update available" for a newer stable release and ignores a pre-release', async () => {
  cu.resetCliUpdateState();
  const up = await cu.checkCliUpdate('codex', { x: stubExec().x });
  assert.equal(up.current, '0.153.4'); assert.equal(up.latest, '0.157.1'); assert.equal(up.available, true);
  assert.match(cu.formatCliUpdate(up), /update available 0\.153\.4 → 0\.157\.1/);
  const pre = await cu.checkCliUpdate('grok', { x: stubExec({ versions: ['grok 1.0.30 (x) [stable]'], latest: '1.0.41-alpha.2' }).x });
  assert.equal(pre.available, false); assert.equal(pre.latest, null); assert.match(pre.error, /no stable release/);
  assert.equal(cu.cliUpdateStatus().providers.codex.available, true);
  const app = stubExec(); app.x.bin = () => ({ command: 'C:/Users/u/AppData/Local/OpenAI/Codex/bin/1/codex.exe', args: [] });
  assert.match((await cu.checkCliUpdate('codex', { x: app.x })).note, /not installed with npm/); // the Codex app's own binary
});

test('mode off skips the release lookup unless the check is manual', async () => {
  cu.resetCliUpdateState();
  saveConfig({ providers: { kimi: { cliUpdate: 'off' } } });
  try {
    const { x, calls } = stubExec({ versions: ['kimi, version 1.50.0'], latest: '1.52.0' });
    const off = await cu.checkCliUpdate('kimi', { x });
    assert.equal(off.current, '1.50.0'); assert.equal(off.latest, null); assert.equal(calls.length, 1);
    assert.equal((await cu.checkCliUpdate('kimi', { x, manual: true })).available, true);
  } finally { saveConfig({ providers: { kimi: { cliUpdate: 'notify' } } }); }
});

test('the idle gate: no install while the provider has an open task', async () => {
  cu.resetCliUpdateState();
  const { createTask, cancelTask } = await import('../core/tasks.mjs');
  const t = createTask({ cwd: tmpDir('cli-busy'), title: 't', spec: 's', provider: 'qwen-code' }); // CONDUCTOR_NO_SCHEDULE: stays queued
  try {
    assert.match(await cu.providerBusy('qwen-code'), /1 open task/);
    assert.equal(await cu.providerBusy('grok'), null);
    const { x, calls } = stubExec({ versions: ['0.23.1'], latest: '0.24.6' });
    x.busy = cu.providerBusy;
    const r = await cu.applyCliUpdate('qwen-code', { x });
    assert.equal(r.applied, false); assert.match(r.reason, /waiting: 1 open task/);
    assert.deepEqual(installs(calls), []);
  } finally { cancelTask?.(t.id); }
});

test('a passing install: exact version, held provider, verified with version + sign-in + a test call', async () => {
  cu.resetCliUpdateState();
  const { x, calls } = stubExec({ versions: ['codex-cli 0.153.4', 'codex-cli 0.157.1'] });
  const r = await cu.applyCliUpdate('codex', { x });
  assert.equal(r.applied, true, r.error); assert.equal(r.from, '0.153.4'); assert.equal(r.to, '0.157.1');
  assert.deepEqual(installs(calls), [['npm', 'i', '-g', '@openai/codex@0.157.1']]);
  assert.deepEqual(calls.filter((c) => c[0] === 'hold'), [['hold', 'codex', true], ['hold', 'codex', false]]);
  assert.equal(cu.cliVersionOf('codex'), '0.157.1');
  const hist = readFileSync(join(HOME, 'cli-updates.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(hist.at(-1).applied, true);
});

test('a failed verify reinstalls the previous exact version and logs it', async () => {
  const { listImprovements } = await import('../core/improve.mjs');
  for (const [name, o, re] of [
    ['test call', { smoke: { ok: false, notes: 'read-1: fail (not supported when using Codex with a ChatGPT account)' } }, /test call failed/],
    ['sign-in', { signedIn: false }, /sign-in probe failed/],
    ['version', { versions: ['codex-cli 0.153.4', 'codex-cli 0.153.4'] }, /--version shows 0\.153\.4, expected 0\.157\.1/],
  ]) {
    cu.resetCliUpdateState();
    const { x, calls } = stubExec({ versions: ['codex-cli 0.153.4', 'codex-cli 0.157.1', 'codex-cli 0.153.4'], ...o });
    const r = await cu.applyCliUpdate('codex', { x });
    assert.equal(r.applied, false, name); assert.match(r.error, re, name);
    assert.deepEqual(installs(calls), [['npm', 'i', '-g', '@openai/codex@0.157.1'], ['npm', 'i', '-g', '@openai/codex@0.153.4']], name);
    assert.equal(r.rolledBack, true, name);
  }
  assert.ok(listImprovements().some((e) => e.source === 'cli-update:codex' && /rolled back/.test(e.message)));
  // Grok pins through its own updater; Antigravity (no version pin) restores the binary it kept.
  cu.resetCliUpdateState();
  const g = stubExec({ versions: ['grok 1.0.30', 'grok 1.0.41', 'grok 1.0.30'], latest: '1.0.41', signedIn: false });
  await cu.applyCliUpdate('grok', { x: g.x });
  assert.deepEqual(installs(g.calls).map((c) => c.slice(2)), [['update', '--version', '1.0.41'], ['update', '--version', '1.0.30']]);
  cu.resetCliUpdateState();
  const a = stubExec({ versions: ['1.2.11', '1.2.12', '1.2.11'], latest: '1.2.12', smoke: { ok: false, notes: 'x' } });
  const ar = await cu.applyCliUpdate('antigravity', { x: a.x });
  assert.deepEqual(a.calls.filter((c) => c[0] === 'copy'), [['copy', '/fake/antigravity', '/fake/antigravity.prev'], ['copy', '/fake/antigravity.prev', '/fake/antigravity']]);
  assert.equal(ar.rolledBack, true);
});

test('Claude (Agent SDK): notify-only outside a dev checkout; in dev, npm i the exact version and run the suite', async () => {
  cu.resetCliUpdateState();
  const prod = stubExec({ versions: ['0.3.280'], latest: '0.3.283' });
  const r = await cu.applyCliUpdate('claude', { x: prod.x });
  assert.equal(r.applied, false); assert.equal(r.reason, 'update available 0.3.280 → 0.3.283 — release it through dev'); assert.deepEqual(installs(prod.calls), []);
  cu.resetCliUpdateState();
  const dev = stubExec({ versions: ['0.3.280', '0.3.283'], latest: '0.3.283', dev: true });
  const d = await cu.applyCliUpdate('claude', { x: dev.x });
  assert.equal(d.applied, true, d.error);
  assert.deepEqual(dev.calls.filter((c) => c[0] === 'npm' && c[1] !== 'view'), [['npm', 'i', '@anthropic-ai/claude-agent-sdk@0.3.283'], ['npm', 'test']]);
  cu.resetCliUpdateState();
  const bad = stubExec({ versions: ['0.3.280', '0.3.283', '0.3.280'], latest: '0.3.283', dev: true, test: 1 });
  const b = await cu.applyCliUpdate('claude', { x: bad.x });
  assert.match(b.error, /npm test failed/); assert.equal(b.rolledBack, true);
});

test('the daily check installs only for auto providers, once idle, and never retries a version that failed', async () => {
  cu.resetCliUpdateState();
  saveConfig({ providers: { codex: { cliUpdate: 'auto' }, claude: { cliUpdate: 'auto' } } });
  try {
    const busy = stubExec({ versions: ['codex-cli 0.153.4'], busy: '1 open task(s), 0 chat(s) mid-turn' });
    await cu.dailyCheck({ x: busy.x, now: Date.now() });
    assert.deepEqual(installs(busy.calls), []);
    assert.equal(cu.cliUpdateStatus().providers['qwen-code'].available, true); // notify: shown, not installed
    const idle = stubExec({ versions: ['codex-cli 0.153.4', 'codex-cli 0.157.1'] });
    await cu.dailyCheck({ x: idle.x, now: Date.now() }); // same day: no re-check, but the pending auto install runs now
    assert.deepEqual(installs(idle.calls), [['npm', 'i', '-g', '@openai/codex@0.157.1']]); // claude stays notify-only
    cu.resetCliUpdateState();
    const fail = stubExec({ versions: ['codex-cli 0.153.4'], smoke: { ok: false, notes: 'x' } });
    await cu.dailyCheck({ x: fail.x, now: Date.now() });
    await cu.dailyCheck({ x: fail.x, now: Date.now() });
    assert.equal(installs(fail.calls).filter((c) => c.at(-1) === '@openai/codex@0.157.1').length, 1);
  } finally { saveConfig({ providers: { codex: { cliUpdate: 'notify' }, claude: { cliUpdate: 'notify' } } }); }
});

test('settings: providers.<id>.cliUpdate defaults to notify and normalizes garbage', () => {
  for (const id of cu.CLI_UPDATE_IDS) assert.equal(DEFAULTS.providers[id].cliUpdate, 'notify');
  assert.equal(DEFAULTS.providers.ollama.cliUpdate, undefined); // local and opt-in: not updated here
  saveConfig({ providers: { grok: { cliUpdate: 'auto' }, kimi: { cliUpdate: 'sometimes' }, antigravity: 'nonsense' } });
  try {
    const c = loadConfig();
    assert.equal(c.providers.grok.cliUpdate, 'auto');
    assert.equal(c.providers.kimi.cliUpdate, 'notify');
    assert.equal(c.providers.antigravity.cliUpdate, 'notify');
    assert.equal(c.providers.codex.cliUpdate, 'notify');
  } finally { saveConfig({ providers: { grok: { cliUpdate: 'notify' }, kimi: { cliUpdate: 'notify' }, antigravity: { cliUpdate: 'notify' } } }); }
});

test('run rows carry the cached CLI version and the served model', async () => {
  const sc = await import('../core/scorecard.mjs');
  cu.resetCliUpdateState({ checkedAt: 0, providers: { codex: { current: '0.157.1' } } });
  const row = sc.recordRun({ id: 'cv1', title: 't', status: 'done', provider: 'codex', model: 'gpt-6-sol', category: 'read', difficulty: 1, result: { servedModel: 'gpt-6-sol', usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 } });
  assert.equal(row.cliVersion, '0.157.1'); assert.equal(row.servedModel, 'gpt-6-sol');
  const other = sc.recordRun({ id: 'cv2', title: 't', status: 'done', provider: 'kimi', model: 'kimi-k3', result: { usage: null } });
  assert.equal(other.cliVersion, null); assert.equal(other.servedModel, null);
});

test('served model: agy init, grok/qwen system init, the Codex rollout turn_context', async () => {
  const { VENDORS } = await import('../core/providers/vendors.mjs');
  const st = () => ({ threadId: null, text: '', finalText: null, usage: null, error: null, items: [], spec: {} });
  const a = st(); VENDORS.antigravity.parse({ event: 'init', conversation_id: 'c-1', init: { model: 'gemini-3.8-flash-low' } }, a, () => {});
  assert.equal(a.servedModel, 'gemini-3.8-flash-low');
  const g = st(); VENDORS.grok.parse({ type: 'system', subtype: 'init', session_id: 's', model: 'grok-4.6' }, g, () => {});
  VENDORS.grok.parse({ type: 'assistant', message: { model: 'grok-4.6-fast', content: [] } }, g, () => {});
  assert.equal(g.servedModel, 'grok-4.6-fast');
  const { rolloutModel } = await import('../core/workers/codex.mjs');
  const home = tmpDir('codex-home'); const thread = '01a0dbe1-25e9-7be0-b064-2729c5698798';
  const born = new Date(parseInt(thread.replace(/-/g, '').slice(0, 12), 16)); const pad = (n) => String(n).padStart(2, '0');
  const dir = join(home, 'sessions', String(born.getFullYear()), pad(born.getMonth() + 1), pad(born.getDate())); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-x-${thread}.jsonl`), [{ type: 'session_meta', payload: {} }, { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'low' } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(rolloutModel(thread, home), 'gpt-6-luna');
  assert.equal(rolloutModel('not-a-thread', home), null);
});
