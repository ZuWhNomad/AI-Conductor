import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Point the Codex home at a fixture so the registry is deterministic.
process.env.CODEX_HOME = join(HOME, 'codex');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), `
model = "gpt-6-astra"

[mcp_servers.node_repl]
args = []
command = 'C:\\tools\\node_repl.exe'
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_PATH = 'C:\\tools\\node.exe'

[mcp_servers.warehouse]
url = "https://example.test/mcp"

[mcp_servers.off]
url = "https://example.test/off"
enabled = false

[windows]
sandbox = "elevated"
`);
const { parseCodexToml, codexMcpArgs, forClaudeSdk, mcpServers, mcpServersFor, readClaudeJson } = await import('../core/mcp.mjs');
const { saveConfig } = await import('../core/config.mjs');

test('Codex config.toml MCP tables parse (url, command/args/env, disabled dropped)', () => {
  const s = parseCodexToml(`[mcp_servers.a]\nurl = "https://x/mcp"\n[mcp_servers.b]\ncommand = 'c.exe'\nargs = ["--x", "1"]\n[mcp_servers.b.env]\nK = "v"\n[other]\nurl = "no"\n[mcp_servers.c]\nenabled = false\nurl = "https://y"\n`);
  assert.deepEqual(s, { a: { url: 'https://x/mcp' }, b: { command: 'c.exe', args: ['--x', '1'], env: { K: 'v' } } });
  assert.deepEqual(readClaudeJson(join(HOME, 'missing.json')), {});
});

test('the registry merges Codex, Claude and Conductor sources; config can add or remove', () => {
  const claudeGlobal = Object.keys(readClaudeJson());
  let reg = mcpServers({ mcpServers: {} });
  assert.equal(reg.node_repl.source, 'codex');
  assert.equal(reg.warehouse.source, 'codex');
  assert.equal(reg.off, undefined);
  reg = mcpServers({ mcpServers: { extra: { url: 'https://extra/mcp' }, node_repl: null } });
  assert.equal(reg.extra.source, 'conductor');
  assert.equal(reg.node_repl, undefined);
  for (const n of claudeGlobal) assert.equal(reg[n].source, 'claude');
  saveConfig({ mcpServers: { extra: { url: 'https://extra/mcp' } } });
  assert.equal(mcpServers().extra.url, 'https://extra/mcp');
});

test('codex exec overrides: approval-only for servers Codex already has, full definition otherwise', () => {
  const args = codexMcpArgs({ warehouse: { url: 'https://example.test/mcp', source: 'codex' }, extra: { url: 'https://extra/mcp', source: 'conductor' }, tool: { command: 'x.exe', args: ['--a', 'q"t'], env: { K: 'v' }, source: 'claude' }, conductor: { url: 'http://127.0.0.1:1/mcp/s' } });
  const s = args.join(' ');
  assert.match(s, /mcp_servers\.warehouse\.default_tools_approval_mode="approve"/);
  assert.doesNotMatch(s, /mcp_servers\.warehouse\.url/);
  assert.match(s, /mcp_servers\.extra\.url="https:\/\/extra\/mcp"/);
  assert.match(s, /mcp_servers\.tool\.command="x\.exe" -c mcp_servers\.tool\.args=\["--a","q\\"t"\] -c mcp_servers\.tool\.env\.K="v"/);
  assert.match(s, /mcp_servers\.conductor\.url="http:\/\/127\.0\.0\.1:1\/mcp\/s".*mcp_servers\.conductor\.default_tools_approval_mode="approve"/);
  assert.equal(codexMcpArgs(undefined).length, 0);
});

test('Agent SDK shape and source skipping', () => {
  const reg = { a: { url: 'https://a/mcp', source: 'claude' }, b: { command: 'b.exe', args: ['1'], env: {}, source: 'codex' } };
  assert.deepEqual(forClaudeSdk(reg), { a: { type: 'http', url: 'https://a/mcp' }, b: { command: 'b.exe', args: ['1'], env: {} } });
  assert.deepEqual(Object.keys(forClaudeSdk(reg, { skip: ['claude'] })), ['b']);
});

test('a tagged server is attached only to worker tasks of its categories; untagged servers and untagged tasks get everything', () => {
  const cfg = { mcpServers: { warehouse: { categories: ['search', 'research'] }, extra: { url: 'https://extra/mcp', categories: ['modeling'] }, tool: { command: 'x.exe' } } };
  const names = (c) => Object.keys(mcpServersFor(c, cfg)).filter((n) => ['node_repl', 'warehouse', 'extra', 'tool'].includes(n)).sort();
  assert.deepEqual(names('implement'), ['node_repl', 'tool']);            // node_repl (inherited, untagged) + tool (untagged)
  assert.deepEqual(names('search'), ['node_repl', 'tool', 'warehouse']);  // the tag-only entry scoped the inherited warehouse
  assert.deepEqual(names('modeling'), ['extra', 'node_repl', 'tool']);
  assert.deepEqual(names(null), ['extra', 'node_repl', 'tool', 'warehouse']);
  assert.equal(mcpServers(cfg).warehouse.source, 'codex');                // tagging does not change where it came from
});
