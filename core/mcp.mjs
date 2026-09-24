// Conductor-wide MCP servers: one registry that every runtime attaches — Claude conductor sessions and
// Claude workers (Agent SDK `mcpServers`), Codex conductors and workers (`codex exec -c mcp_servers.*`).
// Sources, later wins: servers the user already configured for Codex (~/.codex/config.toml) and Claude
// (~/.claude.json global mcpServers), then `mcpServers` in ~/.conductor2/config.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.mjs';

const stringToken = `"(?:[^"\\\\]|\\\\.)*"|'[^']*'`;
const keyToken = `(?:${stringToken}|[A-Za-z0-9_-]+)`;
const unq = (v) => {
  v = v.trim();
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v.startsWith('"')) return JSON.parse(v.replace(/\\(?:U([0-9a-fA-F]{8})|.)/g, (escape, hex) => hex ? JSON.stringify(String.fromCodePoint(parseInt(hex, 16))).slice(1, -1) : escape));
  return v;
};
function withoutComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === '"' && c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i).trim();
  }
  return line.trim();
}

const inlineTable = (v) => {
  const entry = new RegExp(`(?:\\{|,)\\s*(${keyToken})\\s*=\\s*(${stringToken})\\s*(?=,|\\})`, 'g');
  return Object.fromEntries([...v.matchAll(entry)].map(([, key, value]) => [unq(key), unq(value)]));
};

/** Parse `[mcp_servers.NAME]` tables, including inherited process-env requirements, from a Codex config.toml. */
export function parseCodexToml(text) {
  const out = {}; let cur = null, sub = null;
  const header = new RegExp(`^\\[mcp_servers\\.(${keyToken})(\\.env|\\.http_headers|\\.env_http_headers)?\\]$`);
  const keyValue = new RegExp(`^(${keyToken})\\s*=\\s*(.+)$`);
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = withoutComment(lines[i]);
    const h = header.exec(line);
    if (h) {
      const name = unq(h[1]); cur = out[name] = out[name] || {};
      const field = h[2] ? h[2].slice(1) : null;
      sub = field ? (cur[field] = cur[field] || {}) : null;
      continue;
    }
    if (/^\[/.test(line)) { cur = null; sub = null; continue; }
    if (!cur) continue;
    const kv = keyValue.exec(line); if (!kv) continue;
    const k = unq(kv[1]), v = kv[2];
    if (sub) { sub[k] = unq(v); continue; }
    if (k === 'url' || k === 'command' || k === 'bearer_token_env_var') cur[k] = unq(v);
    else if (k === 'args' || k === 'env_vars') {
      const chunks = [v];
      // Array comments and quoted ']' characters do not end a multiline string array.
      while (!chunks.at(-1).replace(new RegExp(stringToken, 'g'), '').includes(']') && i + 1 < lines.length) {
        chunks.push(withoutComment(lines[++i]));
      }
      try { cur[k] = [...chunks.join('\n').matchAll(new RegExp(stringToken, 'g'))].map(([s]) => unq(s)); } catch { cur[k] = []; }
    }
    else if (k === 'env' || k === 'http_headers' || k === 'env_http_headers') cur[k] = inlineTable(v);
    else if (k === 'enabled' && v.trim() === 'false') cur.disabled = true;
  }
  for (const [n, s] of Object.entries(out)) if (s.disabled || (!s.url && !s.command)) delete out[n];
  return out;
}

/** Global `mcpServers` from ~/.claude.json (url or command/args/env). */
export function readClaudeJson(file = join(homedir(), '.claude.json')) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')); const out = {};
    for (const [n, s] of Object.entries(j.mcpServers || {})) {
      if (s.url) {
        const e = { url: s.url };
        if (s.type === 'sse' || s.type === 'http') e.type = s.type;
        if (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) e.headers = s.headers;
        out[n] = e;
      } else if (s.command) out[n] = { command: s.command, args: s.args || [], env: s.env || {} };
    }
    return out;
  } catch { return {}; }
}

function readCodexServers() {
  try { return parseCodexToml(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8')); } catch { return {}; }
}

/** The merged registry: { name: { url } | { command, args, env }, source: 'codex'|'claude'|'conductor' } */
export function mcpServers(cfg = loadConfig()) {
  const out = {};
  for (const [n, s] of Object.entries(readCodexServers())) out[n] = { ...s, source: 'codex' };
  for (const [n, s] of Object.entries(readClaudeJson())) out[n] = { ...s, source: 'claude' };
  for (const [n, s] of Object.entries(cfg.mcpServers || {})) {
    if (s === null || s === false) delete out[n];
    else if (s.url || s.command) out[n] = { ...s, source: 'conductor' };
    else if (Array.isArray(s.categories) && out[n]) out[n] = { ...out[n], categories: s.categories }; // tag-only entry: scope an inherited server
  }
  return out;
}

/**
 * The servers a WORKER task gets: every server with no `categories`, plus those tagged with the task's category.
 * Untagged tasks get everything (unchanged behaviour). Every registered server used to be attached to every worker
 * (~45 tool schemas into a refactor); scoping is the first measurable saving of the capability index (plan Part H3).
 */
export function mcpServersFor(category, cfg = loadConfig()) {
  const all = mcpServers(cfg);
  if (!category) return all;
  return Object.fromEntries(Object.entries(all).filter(([, s]) => !Array.isArray(s.categories) || !s.categories.length || s.categories.includes(category)));
}

/** Agent SDK HTTP/SSE shape. Prefer `${VAR}` header values over literal secrets (SDK config is serialized onto argv). headersHelper is a marketplace-only SDK field, not McpHttpServerConfig. */
function sdkHttp(s) {
  const headers = { ...(s.headers || {}), ...(s.http_headers || {}) };
  if (s.env_http_headers && typeof s.env_http_headers === 'object') {
    for (const [k, v] of Object.entries(s.env_http_headers)) if (v) headers[k] = `\${${v}}`;
  }
  if (s.bearer_token_env_var) headers.Authorization = `Bearer \${${s.bearer_token_env_var}}`;
  const out = { type: s.type === 'sse' ? 'sse' : 'http', url: s.url };
  if (Object.keys(headers).length) out.headers = headers;
  return out;
}

/** Agent SDK shape. `skip` drops sources the SDK already loads itself (a conductor session with settingSources 'user' has ~/.claude.json). */
export const forClaudeSdk = (servers, { skip = [] } = {}) => Object.fromEntries(Object.entries(servers || {}).filter(([, s]) => !skip.includes(s.source)).map(([n, s]) => [n, s.url ? sdkHttp(s) : { command: s.command, args: s.args || [], env: s.env || {} }]));

/**
 * `codex exec -c` overrides. Servers Codex already knows (source 'codex') only get the approval mode
 * (exec runs with approval_policy=never, which otherwise rejects MCP calls); others are defined in full.
 * A supplied registry is authoritative: disable inherited servers absent after config removal/category scoping.
 * Returns { args, env }; merge env into the Codex process environment, never its argv. Conflicting env names
 * cannot be forwarded from one process environment: only those keys retain per-server literal overrides.
 */
export function codexMcpArgs(servers) {
  const args = [], env = {};
  if (servers == null) return { args, env };
  const envKey = (key) => process.platform === 'win32' ? key.toUpperCase() : key;
  const values = new Map(), conflicts = new Set();
  const originalEnv = new Map(Object.entries(process.env).map(([k, v]) => [envKey(k), v]));
  const requireValue = (key, value) => {
    const k = envKey(key);
    if (values.has(k) && values.get(k) !== value) conflicts.add(k);
    values.set(k, value);
  };
  for (const s of Object.values(servers)) {
    if (s.source === 'codex') {
      const required = s.url ? [s.bearer_token_env_var].filter(Boolean) : s.env_vars || [];
      // Absence is a requirement too: an added server must not supply another server's missing credential.
      for (const key of required) requireValue(key, originalEnv.get(envKey(key)));
    }
    if (s.url) continue;
    for (const [key, value] of Object.entries(s.env || {})) requireValue(key, String(value));
  }
  const q = (v) => JSON.stringify(String(v)).replace(/\x7f/g, '\\u007f');
  const table = (entries) => `{${Object.entries(entries).map(([k, v]) => `${q(k)}=${v}`).join(',')}}`;
  const dotted = {};
  const put = (name, key, value) => {
    if (name.includes('.')) (dotted[name] ||= {})[key] = value;
    else args.push('-c', `mcp_servers.${name}.${key}=${value}`);
  };
  for (const name of Object.keys(readCodexServers())) {
    if (!Object.hasOwn(servers, name)) put(name, 'enabled', 'false');
  }
  for (const [name, s] of Object.entries(servers || {})) {
    if (s.source !== 'codex') {
      if (s.url) put(name, 'url', q(s.url));
      else {
        put(name, 'command', q(s.command));
        put(name, 'args', `[${(s.args || []).map(q).join(',')}]`);
        const forward = [], literal = {};
        for (const [key, value] of Object.entries(s.env || {})) {
          if (conflicts.has(envKey(key))) literal[key] = q(value);
          else { forward.push(key); env[envKey(key)] = String(value); }
        }
        put(name, 'env_vars', `[${forward.map(q).join(',')}]`);
        put(name, 'env', table(literal)); // also clear an inherited env table that would override forwarded values
      }
      put(name, 'tool_timeout_sec', s.toolTimeoutSec || 3600);
      put(name, 'startup_timeout_sec', s.startupTimeoutSec || 30);
    }
    put(name, 'default_tools_approval_mode', '"approve"');
  }
  // Codex 0.153.4 splits CLI keypaths on literal dots, even inside quotes. Group dotted names
  // in ONE table override, before other paths: a later mcp_servers table would replace this one.
  if (Object.keys(dotted).length) args.unshift('-c', `mcp_servers=${table(Object.fromEntries(Object.entries(dotted).map(([n, fields]) => [n, table(fields)])))}`);
  return { args, env };
}
