import { tmpDir } from '../_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const previous = process.env.CONDUCTOR_CODEX;
process.env.CONDUCTOR_CODEX = process.platform === 'win32' ? 'C:\\definitely\\missing\\codex.exe' : '/definitely/missing/codex';
after(() => { if (previous === undefined) delete process.env.CONDUCTOR_CODEX; else process.env.CONDUCTOR_CODEX = previous; });
const { runCodex } = await import('../../core/workers/codex.mjs');
const { runClaude } = await import('../../core/workers/claude.mjs');
const { codexCommand } = await import('../../core/proc.mjs');
const cwd = tmpDir('codex-args');

test('Codex argv disables inherited MCP servers excluded by category or removed in config', async (ctx) => {
  const { mcpServers, mcpServersFor, forClaudeSdk } = await import('../../core/mcp.mjs');
  const previousHome = process.env.CODEX_HOME;
  const fixture = tmpDir('codex-mcp');
  writeFileSync(join(fixture, 'config.toml'), `
[mcp_servers.node_repl]
command = "node"
[mcp_servers.warehouse]
url = "https://example.test/mcp?token=fixture-secret"
[mcp_servers.removed]
command = "removed-tool"
[mcp_servers.removed.env]
TOKEN = "fixture-secret"
`);
  let argv;
  const spawn = ctx.mock.method(childProcess, 'spawn', (_command, args) => {
    argv = args;
    throw new Error('fixture: captured spawn');
  });
  syncBuiltinESMExports();
  process.env.CODEX_HOME = fixture;
  try {
    for (const removal of [null, false]) {
      const cfg = { mcpServers: { warehouse: { categories: ['research'] }, removed: removal, extra: { url: 'https://extra.test/mcp' } } };
      for (const category of ['implement', 'research', null]) {
        const servers = category ? mcpServersFor(category, cfg) : { ...mcpServers(cfg), conductor: { url: 'http://127.0.0.1:1/mcp/test' } };
        const result = await runCodex({ cwd, prompt: 'fixture', mcp: servers });
        assert.equal(result.error, 'fixture: captured spawn');
        const overrides = argv.filter((_, i) => argv[i - 1] === '-c');
        assert.ok(overrides.includes('mcp_servers.removed.enabled=false'));
        assert.equal(overrides.includes('mcp_servers.warehouse.enabled=false'), category === 'implement');
        assert.equal(overrides.includes('mcp_servers.warehouse.default_tools_approval_mode="approve"'), category !== 'implement');
        assert.ok(overrides.includes('mcp_servers.node_repl.default_tools_approval_mode="approve"'));
        assert.ok(!overrides.includes('mcp_servers.node_repl.enabled=false'));
        assert.ok(overrides.includes('mcp_servers.extra.url="https://extra.test/mcp"'));
        if (!category) assert.ok(overrides.includes('mcp_servers.conductor.url="http://127.0.0.1:1/mcp/test"'));
        assert.doesNotMatch(argv.join(' '), /fixture-secret|removed-tool/);
        assert.equal(forClaudeSdk(servers).removed, undefined);
        assert.equal(!!forClaudeSdk(servers).warehouse, category !== 'implement');
      }
    }
  } finally {
    spawn.mock.restore(); syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
});

test('invalid Codex model and effort are rejected before spawning', async () => {
  for (const selection of [{ model: 'bad"model' }, { model: 'gpt-6-astra', effort: 'lo w' }, { effort: 'low"\nsandbox_mode="danger-full-access' }]) {
    const r = await runCodex({ cwd, prompt: 'x', ...selection });
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid/);
  }
});

test('Codex workers pass MCP credentials via the child environment, not argv', async (ctx) => {
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpDir('codex-env');
  let captured;
  const spawn = ctx.mock.method(childProcess, 'spawn', (command, args, options) => {
    captured = { command, args, options };
    throw new Error('fixture: captured spawn');
  });
  syncBuiltinESMExports();
  try {
    const r = await runCodex({ cwd, prompt: 'fixture', mcp: {
      tool: { command: 'fixture.exe', env: { MCP_TEST_CREDENTIAL: 'worker-secret', EMPTY: '' } },
    } });
    assert.equal(r.error, 'fixture: captured spawn');
    assert.doesNotMatch(captured.args.join(' '), /worker-secret/);
    assert.ok(captured.args.includes('mcp_servers.tool.env_vars=["MCP_TEST_CREDENTIAL","EMPTY"]'));
    assert.equal(captured.options.env.MCP_TEST_CREDENTIAL, 'worker-secret');
    assert.equal(captured.options.env.EMPTY, '');
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
    assert.equal(captured.options.env[pathKey], process.env[pathKey]);
    assert.equal(process.env.MCP_TEST_CREDENTIAL, undefined, 'parent environment is unchanged');
  } finally {
    spawn.mock.restore(); syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
});

test('already-aborted workers return without spawning', async () => {
  const ac = new AbortController(); ac.abort();
  for (const run of [runCodex, runClaude]) {
    const r = await run({ cwd, prompt: 'x', signal: ac.signal });
    assert.equal(r.ok, false);
    assert.match(r.error, /aborted/);
  }
});

test('app-server spawn failures reject without unhandled error events', async () => {
  const { withAppServer } = await import('../../core/providers/codex.mjs');
  await assert.rejects(withAppServer(() => assert.fail('must not connect')), /ENOENT|spawn/i);
});

test('Windows detects the newest desktop-bundled Codex CLI after PATH and npm', { skip: process.platform !== 'win32' }, () => {
  const saved = Object.fromEntries(['PATH', 'APPDATA', 'LOCALAPPDATA', 'CONDUCTOR_CODEX'].map((k) => [k, process.env[k]]));
  const local = tmpDir('codex-app');
  try {
    process.env.PATH = ''; process.env.APPDATA = local; process.env.LOCALAPPDATA = local;
    delete process.env.CONDUCTOR_CODEX;
    const exes = ['older', 'newer'].map((name) => join(local, 'OpenAI', 'Codex', 'bin', name, 'codex.exe'));
    for (const [i, exe] of exes.entries()) {
      mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, '');
      const date = new Date(Date.now() - (2 - i) * 60_000); utimesSync(exe, date, date);
    }
    assert.deepEqual(codexCommand(), { command: exes[1], args: [] });
    process.env.CONDUCTOR_CODEX = exes[0];
    assert.deepEqual(codexCommand(), { command: exes[0], args: [] });
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
