import { HOME } from './_env.mjs';
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

// CONDUCTOR_HOME does not change os.homedir(): intercept every default Claude config read.
let claudeFixture = { mcpServers: { claude_retained: { command: 'claude-fixture.exe', args: ['--fixture'], env: { KEY: 'fixture' } } } };
const readFile = fs.readFileSync;
mock.method(fs, 'readFileSync', (file, ...args) => basename(String(file)) === '.claude.json'
  ? JSON.stringify(claudeFixture) : readFile(file, ...args));
syncBuiltinESMExports();
after(() => { mock.restoreAll(); syncBuiltinESMExports(); });

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
enabled = false # user disabled

[mcp_servers."private.db"] # quoted dotted name
url = "https://example.test/private#fragment"

[mcp_servers.'retained.db']
url = "https://example.test/retained"

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
  assert.deepEqual(readClaudeJson(), claudeFixture.mcpServers);
  let reg = mcpServers({ mcpServers: {} });
  assert.equal(reg.node_repl.source, 'codex');
  assert.equal(reg.warehouse.source, 'codex');
  assert.equal(reg.off, undefined);
  reg = mcpServers({ mcpServers: { extra: { url: 'https://extra/mcp' }, node_repl: null } });
  assert.equal(reg.extra.source, 'conductor');
  assert.equal(reg.node_repl, undefined);
  assert.equal(reg.claude_retained.source, 'claude');
  saveConfig({ mcpServers: { extra: { url: 'https://extra/mcp' } } });
  assert.equal(mcpServers().extra.url, 'https://extra/mcp');
});

test('codex exec overrides: approval-only for servers Codex already has, full definition otherwise', () => {
  const args = codexMcpArgs({ warehouse: { url: 'https://example.test/mcp', source: 'codex' }, extra: { url: 'https://extra/mcp', source: 'conductor' }, tool: { command: 'x.exe', args: ['--a', 'q"t'], env: { K: 'v' }, source: 'claude' }, conductor: { url: 'http://127.0.0.1:1/mcp/s' } });
  const s = args.join(' ');
  assert.match(s, /mcp_servers\.warehouse\.default_tools_approval_mode="approve"/);
  assert.doesNotMatch(s, /mcp_servers\.warehouse\.url/);
  assert.match(s, /mcp_servers\.extra\.url="https:\/\/extra\/mcp"/);
  assert.match(s, /mcp_servers\.tool\.command="x\.exe" -c mcp_servers\.tool\.args=\["--a","q\\"t"\] -c mcp_servers\.tool\.env=\{"K"="v"\}/);
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

test('quoted TOML names, escaped strings and inline comments preserve filtering and values', () => {
  const servers = parseCodexToml(String.raw`
[mcp_servers."private.db"] # table comment
url = "https://fixture.test/#kept" # value comment
enabled = false # user disabled
[mcp_servers."private_db"]
command = 'C:\tools\fixture.exe' # literal backslashes
args = ["it's#literal", 'second#literal', "quote\"#kept", "C:\\tools"] # array comment
[mcp_servers."private_db".env] # env table
"KEY.NAME" = "line\nquote\"#kept\\end" # value comment
UNICODE = "\U00000022\\U00000041" # decoded quote followed by a literal escape
[mcp_servers.'literal.db']
url = 'https://fixture.test/#literal'
[mcp_servers."escaped\u005fname"]
url = "https://fixture.test/escaped"
`);
  assert.deepEqual(servers, {
    private_db: { command: 'C:\\tools\\fixture.exe', args: ["it's#literal", 'second#literal', 'quote"#kept', 'C:\\tools'], env: { 'KEY.NAME': 'line\nquote"#kept\\end', UNICODE: '"\\U00000041' } },
    'literal.db': { url: 'https://fixture.test/#literal' },
    escaped_name: { url: 'https://fixture.test/escaped' },
  });
  assert.equal(forClaudeSdk(servers)['private.db'], undefined);
});

test('Codex dotted names share one table override, preserving exclusion, approvals and environment values', () => {
  const cfg = { mcpServers: { 'private.db': null, warehouse: { categories: ['research'] } } };
  const registry = mcpServersFor('implement', cfg);
  registry['new.db'] = { command: 'C:\\tools\\fixture.exe', args: ['q"t', 'line\nnext'], env: { 'KEY.NAME': 'slash\\quote"\n#kept' }, toolTimeoutSec: 42, startupTimeoutSec: 12 };
  const args = codexMcpArgs(registry);
  const tables = args.filter((arg) => arg.startsWith('mcp_servers='));
  assert.deepEqual(tables, ['mcp_servers={"private.db"={"enabled"=false},"retained.db"={"default_tools_approval_mode"="approve"},"new.db"={"command"="C:\\\\tools\\\\fixture.exe","args"=["q\\"t","line\\nnext"],"env"={"KEY.NAME"="slash\\\\quote\\"\\n#kept"},"tool_timeout_sec"=42,"startup_timeout_sec"=12,"default_tools_approval_mode"="approve"}}']);
  assert.equal(args[1], tables[0], 'table comes before all other paths so it cannot erase them');
  assert.ok(args.includes('mcp_servers.warehouse.enabled=false'), 'category exclusion survives');
  assert.ok(args.includes('mcp_servers.node_repl.default_tools_approval_mode="approve"'));
  assert.ok(!args.some((arg) => /mcp_servers\.(?:"|private\.|retained\.|new\.)/.test(arg)), 'never quote a dotted CLI keypath');
  assert.ok(!args.some((arg) => arg.includes('mcp_servers.off.')), 'already disabled server stays disabled');
});

test('MCP fixtures control Claude precedence and saved tombstones remove inherited servers', () => {
  const previous = claudeFixture;
  try {
    claudeFixture = { mcpServers: { node_repl: { url: 'https://claude-fixture.test/mcp' } } };
    assert.equal(mcpServers({ mcpServers: {} }).node_repl.source, 'claude');
    saveConfig({ mcpServers: { node_repl: { command: 'override.exe' } } });
    saveConfig({ mcpServers: { node_repl: null } });
    assert.equal(mcpServers().node_repl, undefined);
    assert.ok(codexMcpArgs(mcpServers()).includes('mcp_servers.node_repl.enabled=false'));
  } finally { claudeFixture = previous; }
});

test('Claude conductor passes the complete filtered registry in strict mode and retains its built-in server', async () => {
  const sdkUrl = 'data:text/javascript,' + encodeURIComponent(`
    export let captured;
    export function query(input) { captured = input; return (async function* () {})(); }
    export async function getSessionMessages() { return []; }
    export function tool(name, description, schema, handler) { return { name, description, schema, handler }; }
    export function createSdkMcpServer(config) { return { type: 'sdk', ...config }; }
  `);
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === '@anthropic-ai/claude-agent-sdk'
      ? { url: sdkUrl, shortCircuit: true } : nextResolve(specifier, context);
  } });
  const previous = claudeFixture;
  try {
    claudeFixture = { mcpServers: { ...previous.mcpServers, removed: { url: 'https://removed.test' }, disabled: { url: 'https://disabled.test' } } };
    saveConfig({ mcpServers: { removed: null, disabled: false, conductor: { url: 'https://must-not-replace-built-in.test' } } });
    const { createSession, sendMessage, deleteSession } = await import('../core/conductor.mjs');
    const session = createSession({ cwd: HOME, provider: 'claude' });
    try {
      await sendMessage(session.id, 'fixture');
      const { captured } = await import(sdkUrl);
      const { options } = captured;
      assert.equal(options.strictMcpConfig, true);
      const expected = forClaudeSdk(mcpServers());
      delete expected.conductor;
      const { conductor, ...external } = options.mcpServers;
      assert.deepEqual(external, expected);
      assert.equal(external.claude_retained.command, 'claude-fixture.exe');
      assert.equal(external.removed, undefined);
      assert.equal(external.disabled, undefined);
      assert.equal(conductor.type, 'sdk');
      assert.equal(conductor.name, 'conductor');
      assert.ok(conductor.tools.length > 0);
      assert.ok(options.allowedTools.includes('mcp__claude_retained'));
      assert.ok(!options.allowedTools.includes('mcp__removed'));
    } finally { deleteSession(session.id); }
  } finally { claudeFixture = previous; hooks.deregister(); }
});
