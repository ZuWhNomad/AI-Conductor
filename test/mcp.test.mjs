import { HOME } from './_env.mjs';
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

// Intercept user config reads so the registry is deterministic without changing either runtime's home.
let claudeFixture = { mcpServers: { claude_retained: { command: 'claude-fixture.exe', args: ['--fixture'], env: { KEY: 'fixture' } } } };
const readFile = fs.readFileSync;
mock.method(fs, 'readFileSync', (file, ...args) => {
  if (basename(String(file)) === '.claude.json') return JSON.stringify(claudeFixture);
  if (basename(String(file)) === 'config.toml') return codexFixture;
  return readFile(file, ...args);
});
syncBuiltinESMExports();
after(() => { mock.restoreAll(); syncBuiltinESMExports(); });

let codexFixture = `
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
`;
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
  const { args, env } = codexMcpArgs({ warehouse: { url: 'https://example.test/mcp', source: 'codex' }, extra: { url: 'https://extra/mcp', source: 'conductor' }, tool: { command: 'x.exe', args: ['--a', 'q"t'], env: { K: 'v' }, source: 'claude' }, conductor: { url: 'http://127.0.0.1:1/mcp/s' } });
  const s = args.join(' ');
  assert.match(s, /mcp_servers\.warehouse\.default_tools_approval_mode="approve"/);
  assert.doesNotMatch(s, /mcp_servers\.warehouse\.url/);
  assert.match(s, /mcp_servers\.extra\.url="https:\/\/extra\/mcp"/);
  assert.match(s, /mcp_servers\.tool\.command="x\.exe" -c mcp_servers\.tool\.args=\["--a","q\\"t"\] -c mcp_servers\.tool\.env_vars=\["K"\]/);
  assert.deepEqual(env, { K: 'v' });
  assert.match(s, /mcp_servers\.conductor\.url="http:\/\/127\.0\.0\.1:1\/mcp\/s".*mcp_servers\.conductor\.default_tools_approval_mode="approve"/);
  assert.deepEqual(codexMcpArgs(undefined), { args: [], env: {} });
});

test('Agent SDK shape and source skipping', () => {
  const reg = { a: { url: 'https://a/mcp', source: 'claude' }, b: { command: 'b.exe', args: ['1'], env: {}, source: 'codex' } };
  assert.deepEqual(forClaudeSdk(reg), { a: { type: 'http', url: 'https://a/mcp' }, b: { command: 'b.exe', args: ['1'], env: {} } });
  assert.deepEqual(Object.keys(forClaudeSdk(reg, { skip: ['claude'] })), ['b']);
});

test('L24: Claude type/headers and Codex bearer/http_headers reach the Agent SDK as ${VAR} expansions, not literal secrets', () => {
  const previous = claudeFixture;
  try {
    claudeFixture = { mcpServers: {
      quantgpt: { type: 'http', url: 'https://mcp.quantgpt.test', headers: { Authorization: 'Bearer ${QUANTGPT_KEY}' } },
      sse_svc: { type: 'sse', url: 'https://sse.test/mcp', headers: { 'X-Trace': '1' } },
    } };
    const claude = readClaudeJson();
    assert.equal(claude.quantgpt.type, 'http');
    assert.equal(claude.quantgpt.headers.Authorization, 'Bearer ${QUANTGPT_KEY}');
    assert.equal(claude.sse_svc.type, 'sse');
    const sdk = forClaudeSdk({
      quantgpt: { ...claude.quantgpt, source: 'claude' },
      sse_svc: { ...claude.sse_svc, source: 'claude' },
      warehouse: { url: 'https://example.test/mcp', bearer_token_env_var: 'WAREHOUSE_TOKEN', http_headers: { 'X-Region': 'us' }, env_http_headers: { 'X-Api-Key': 'WAREHOUSE_API_KEY' }, source: 'codex' },
    });
    assert.deepEqual(sdk.quantgpt, { type: 'http', url: 'https://mcp.quantgpt.test', headers: { Authorization: 'Bearer ${QUANTGPT_KEY}' } });
    assert.deepEqual(sdk.sse_svc, { type: 'sse', url: 'https://sse.test/mcp', headers: { 'X-Trace': '1' } });
    assert.equal(sdk.warehouse.type, 'http');
    assert.equal(sdk.warehouse.headers.Authorization, 'Bearer ${WAREHOUSE_TOKEN}');
    assert.equal(sdk.warehouse.headers['X-Region'], 'us');
    assert.equal(sdk.warehouse.headers['X-Api-Key'], '${WAREHOUSE_API_KEY}');
    assert.doesNotMatch(JSON.stringify(sdk), /sk-|secret|literal-token/);
  } finally { claudeFixture = previous; }

  const parsed = parseCodexToml(`[mcp_servers.figma]
url = "https://mcp.figma.test"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
env_http_headers = { "X-User" = "FIGMA_USER" }
[mcp_servers.custom.http_headers]
"X-Organization-ID" = "org-123"
[mcp_servers.custom]
url = "https://custom.test/mcp"
`);
  assert.equal(parsed.figma.bearer_token_env_var, 'FIGMA_OAUTH_TOKEN');
  assert.equal(parsed.figma.http_headers['X-Figma-Region'], 'us-east-1');
  assert.equal(parsed.figma.env_http_headers['X-User'], 'FIGMA_USER');
  assert.equal(parsed.custom.http_headers['X-Organization-ID'], 'org-123');
});

test('Codex env forwarding keeps secrets off argv except conflicting per-server values', () => {
  const overridden = codexMcpArgs({ node_repl: { command: 'node', env: { NODE_PATH: 'replacement-secret' } } });
  assert.ok(overridden.args.includes('mcp_servers.node_repl.env={}'), 'clear inherited literal values before forwarding replacements');
  assert.deepEqual(overridden.env, { NODE_PATH: 'replacement-secret' });
  assert.doesNotMatch(overridden.args.join(' '), /replacement-secret/);
  const result = codexMcpArgs({
    first: { command: 'node', env: { SHARED: 'same-secret', TOKEN: 'first-secret', UNIQUE: 'unique-secret' } },
    'second.db': { command: 'node', env: { SHARED: 'same-secret', TOKEN: 'second-secret' } },
  });
  assert.deepEqual(result.env, { SHARED: 'same-secret', UNIQUE: 'unique-secret' });
  assert.doesNotMatch(result.args.join(' '), /same-secret|unique-secret/);
  assert.ok(result.args.includes('mcp_servers.first.env_vars=["SHARED","UNIQUE"]'));
  assert.ok(result.args.includes('mcp_servers.first.env={"TOKEN"="first-secret"}'));
  assert.match(result.args[1], /"second.db"=.*"env_vars"=\["SHARED"\],"env"=\{"TOKEN"="second-secret"\}/);
  const inherited = codexMcpArgs({
    known: { source: 'codex', command: 'node', env: { TOKEN: 'inherited-secret' } },
    added: { command: 'node', env: { TOKEN: 'added-secret' } },
  });
  assert.deepEqual(inherited.env, {});
  assert.doesNotMatch(inherited.args.join(' '), /inherited-secret/);
  assert.ok(inherited.args.includes('mcp_servers.added.env={"TOKEN"="added-secret"}'));
});

test('Codex environment collisions respect Windows case-insensitive names', { skip: process.platform !== 'win32' }, () => {
  const { args, env } = codexMcpArgs({
    first: { command: 'node', env: { Token: 'first-secret' } },
    second: { command: 'node', env: { TOKEN: 'second-secret' } },
  });
  assert.deepEqual(env, {});
  assert.ok(args.includes('mcp_servers.first.env={"Token"="first-secret"}'));
  assert.ok(args.includes('mcp_servers.second.env={"TOKEN"="second-secret"}'));
});

test('inherited Codex env_vars and HTTP bearer env references preserve original values, including unset', () => {
  const key = 'REVIEW_SHARED_CREDENTIAL';
  const previous = process.env[key], previousFixture = codexFixture;
  try {
    for (const field of ['env_vars', 'bearer_token_env_var']) {
      const inheritedKey = process.platform === 'win32' ? key.toLowerCase() : key;
      codexFixture = `[mcp_servers.inherited]\n${field === 'env_vars' ? 'command = "fixture.exe"' : 'url = "https://fixture.test/mcp"'}\n${field} = ${field === 'env_vars' ? `["${inheritedKey}"]` : `"${inheritedKey}"`}\n`;
      for (const original of ['inherited-fixture', '', undefined, 'added-fixture']) {
        if (original === undefined) delete process.env[key]; else process.env[key] = original;
        const added = { command: 'added.exe', env: { [key]: 'added-fixture' } };
        const registry = mcpServers({ mcpServers: { added } });
        assert.deepEqual(registry.inherited[field], field === 'env_vars' ? [inheritedKey] : inheritedKey);
        const { args, env } = codexMcpArgs(registry);
        const conflict = original !== 'added-fixture';
        assert.equal(Object.hasOwn(env, key), !conflict, `${field}, original ${original}: preserve shared env`);
        const childEnv = { ...process.env, ...env };
        const actualKey = Object.keys(childEnv).find((k) => process.platform === 'win32' ? k.toUpperCase() === key : k === key);
        assert.equal(actualKey === undefined ? undefined : childEnv[actualKey], original);
        assert.ok(args.includes(conflict ? 'mcp_servers.added.env_vars=[]' : `mcp_servers.added.env_vars=["${key}"]`));
        assert.ok(args.includes(conflict ? `mcp_servers.added.env={"${key}"="added-fixture"}` : 'mcp_servers.added.env={}'));
        assert.doesNotMatch(args.join(' '), /inherited-fixture/);
        // The authoritative registry can remove an inherited requirement; it then need not constrain forwarding.
        const removed = codexMcpArgs(mcpServers({ mcpServers: { inherited: null, added } }));
        assert.equal(removed.env[key], 'added-fixture');
        assert.ok(removed.args.includes('mcp_servers.inherited.enabled=false'));
      }
    }
  } finally {
    codexFixture = previousFixture;
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('multiline TOML string arrays retain inherited env requirements and comments do not hide entries', () => {
  const key = 'REVIEW_SHARED_CREDENTIAL';
  const previous = process.env[key], previousFixture = codexFixture;
  codexFixture = String.raw`
[mcp_servers.inherited]
args = [ # a comment containing ] must not close the array
  'bracket]#literal',
  "quote\"#kept", # trailing comment
]
env_vars = [ # "IGNORED_COMMENT_KEY" ]
  # another comment and a blank line

  "REVIEW_SHARED_CREDENTIAL", # ] "ALSO_IGNORED"
  'REVIEW_OTHER_CREDENTIAL',
] # trailing comma is valid
command = 'fixture.exe'
[mcp_servers.after]
url = 'https://fixture.test/mcp'
`;
  try {
    const expected = { args: ['bracket]#literal', 'quote"#kept'], env_vars: [key, 'REVIEW_OTHER_CREDENTIAL'], command: 'fixture.exe' };
    assert.deepEqual(parseCodexToml(codexFixture).inherited, expected);
    for (const original of ['inherited-fixture', undefined]) {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
      const registry = mcpServers({ mcpServers: { added: { command: 'added.exe', env: { [key]: 'synthetic-secret' } } } });
      assert.deepEqual(registry.inherited, { ...expected, source: 'codex' });
      assert.equal(registry.after.url, 'https://fixture.test/mcp');
      const { args, env } = codexMcpArgs(registry);
      assert.equal(Object.hasOwn(env, key), false, 'added credentials cannot alter the inherited requirement');
      assert.equal(({ ...process.env, ...env })[key], original);
      assert.ok(args.includes('mcp_servers.added.env_vars=[]'));
      assert.ok(args.includes(`mcp_servers.added.env={"${key}"="synthetic-secret"}`));
      assert.doesNotMatch(args.join(' '), /inherited-fixture/);
    }
  } finally {
    codexFixture = previousFixture;
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('inline TOML env tables preserve the same credential collisions as env subtables', () => {
  const previousFixture = codexFixture;
  const declarations = [
    String.raw`env = { REVIEW_SHARED_CREDENTIAL = "inherited-fixture", "KEY.NAME" = 'comma,brace}#kept', 'QUOTED' = "quote\"#kept" } # trailing comment`,
    String.raw`[mcp_servers.inherited.env]
REVIEW_SHARED_CREDENTIAL = "inherited-fixture"
"KEY.NAME" = 'comma,brace}#kept'
'QUOTED' = "quote\"#kept"`,
  ];
  const expectedEnv = { REVIEW_SHARED_CREDENTIAL: 'inherited-fixture', 'KEY.NAME': 'comma,brace}#kept', QUOTED: 'quote"#kept' };
  try {
    for (const declaration of declarations) {
      codexFixture = `[mcp_servers.inherited]\ncommand = "fixture.exe"\n${declaration}\n`;
      assert.deepEqual(parseCodexToml(codexFixture).inherited.env, expectedEnv);
      const registry = mcpServers({ mcpServers: { added: { command: 'added.exe', env: { REVIEW_SHARED_CREDENTIAL: 'synthetic-secret' } } } });
      assert.deepEqual(registry.inherited.env, expectedEnv);
      const { args, env } = codexMcpArgs(registry);
      assert.equal(Object.hasOwn(env, 'REVIEW_SHARED_CREDENTIAL'), false);
      assert.ok(args.includes('mcp_servers.added.env_vars=[]'));
      assert.ok(args.includes('mcp_servers.added.env={"REVIEW_SHARED_CREDENTIAL"="synthetic-secret"}'));
      assert.doesNotMatch(args.join(' '), /inherited-fixture/);
    }
  } finally { codexFixture = previousFixture; }
});

test('D1: MCP instructions refuse a tagged delegate when no plan qualifies instead of naming a fallback default worker', () => {
  const src = readFile(fileURLToPath(new URL('../core/tools.mjs', import.meta.url)), 'utf8');
  assert.match(src, /when the scorecard has no qualified plan the delegate is refused/);
  assert.match(src, /name a provider\/model explicitly \(which always runs and seeds the scorecard\) or do small work yourself/);
  assert.doesNotMatch(src, /fallback default worker/);
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
  const { args, env } = codexMcpArgs(registry);
  const tables = args.filter((arg) => arg.startsWith('mcp_servers='));
  assert.deepEqual(tables, ['mcp_servers={"private.db"={"enabled"=false},"retained.db"={"default_tools_approval_mode"="approve"},"new.db"={"command"="C:\\\\tools\\\\fixture.exe","args"=["q\\"t","line\\nnext"],"env_vars"=["KEY.NAME"],"env"={},"tool_timeout_sec"=42,"startup_timeout_sec"=12,"default_tools_approval_mode"="approve"}}']);
  assert.equal(env['KEY.NAME'], 'slash\\quote"\n#kept');
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
    assert.ok(codexMcpArgs(mcpServers()).args.includes('mcp_servers.node_repl.enabled=false'));
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

test('Codex conductor sessions forward MCP credentials through runCodex into the child env', async (ctx) => {
  let captured;
  const previous = process.env.CONDUCTOR_CODEX;
  process.env.CONDUCTOR_CODEX = 'fixture-codex.exe';
  const spawn = ctx.mock.method(childProcess, 'spawn', (command, args, options) => {
    captured = { command, args, options };
    throw new Error('fixture: captured conductor spawn');
  });
  syncBuiltinESMExports();
  const { createSession, sendMessage, deleteSession } = await import('../core/conductor.mjs');
  saveConfig({ mcpServers: { credentials: { command: 'fixture.exe', env: { MCP_TEST_CREDENTIAL: 'conductor-secret' } } } });
  const session = createSession({ cwd: HOME, provider: 'codex', model: 'gpt-6-astra' });
  try {
    await sendMessage(session.id, 'fixture');
    assert.ok(captured, 'conductor reaches the common Codex runner');
    assert.doesNotMatch(captured.args.join(' '), /conductor-secret/);
    assert.ok(captured.args.includes('mcp_servers.credentials.env_vars=["MCP_TEST_CREDENTIAL"]'));
    assert.equal(captured.options.env.MCP_TEST_CREDENTIAL, 'conductor-secret');
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
    assert.equal(captured.options.env[pathKey], process.env[pathKey]);
  } finally {
    deleteSession(session.id);
    spawn.mock.restore(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.CONDUCTOR_CODEX; else process.env.CONDUCTOR_CODEX = previous;
  }
});
