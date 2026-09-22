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

/** Parse `[mcp_servers.NAME]` tables (url | command/args/env) from a Codex config.toml. */
export function parseCodexToml(text) {
  const out = {}; let cur = null, env = null;
  const header = new RegExp(`^\\[mcp_servers\\.(${keyToken})(\\.env)?\\]$`);
  const keyValue = new RegExp(`^(${keyToken})\\s*=\\s*(.+)$`);
  for (const raw of String(text || '').split('\n')) {
    const line = withoutComment(raw);
    const h = header.exec(line);
    if (h) { const name = unq(h[1]); cur = out[name] = out[name] || {}; env = h[2] ? (cur.env = cur.env || {}) : null; continue; }
    if (/^\[/.test(line)) { cur = null; env = null; continue; }
    if (!cur) continue;
    const kv = keyValue.exec(line); if (!kv) continue;
    const k = unq(kv[1]), v = kv[2];
    if (env) { env[k] = unq(v); continue; }
    if (k === 'url' || k === 'command') cur[k] = unq(v);
    else if (k === 'args') { try { cur.args = [...v.matchAll(new RegExp(stringToken, 'g'))].map(([s]) => unq(s)); } catch { cur.args = []; } }
    else if (k === 'enabled' && v.trim() === 'false') cur.disabled = true;
  }
  for (const [n, s] of Object.entries(out)) if (s.disabled || (!s.url && !s.command)) delete out[n];
  return out;
}

/** Global `mcpServers` from ~/.claude.json (url or command/args/env). */
export function readClaudeJson(file = join(homedir(), '.claude.json')) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')); const out = {};
    for (const [n, s] of Object.entries(j.mcpServers || {})) { if (s.url) out[n] = { url: s.url }; else if (s.command) out[n] = { command: s.command, args: s.args || [], env: s.env || {} }; }
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

/** Agent SDK shape. `skip` drops sources the SDK already loads itself (a conductor session with settingSources 'user' has ~/.claude.json). */
export const forClaudeSdk = (servers, { skip = [] } = {}) => Object.fromEntries(Object.entries(servers || {}).filter(([, s]) => !skip.includes(s.source)).map(([n, s]) => [n, s.url ? { type: 'http', url: s.url } : { command: s.command, args: s.args || [], env: s.env || {} }]));

/**
 * `codex exec -c` overrides. Servers Codex already knows (source 'codex') only get the approval mode
 * (exec runs with approval_policy=never, which otherwise rejects MCP calls); others are defined in full.
 * A supplied registry is authoritative: disable inherited servers absent after config removal/category scoping.
 */
export function codexMcpArgs(servers) {
  const args = [];
  if (servers == null) return args;
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
        put(name, 'env', table(Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, q(v)]))));
      }
      put(name, 'tool_timeout_sec', s.toolTimeoutSec || 3600);
      put(name, 'startup_timeout_sec', s.startupTimeoutSec || 30);
    }
    put(name, 'default_tools_approval_mode', '"approve"');
  }
  // Codex 0.153.4 splits CLI keypaths on literal dots, even inside quotes. Group dotted names
  // in ONE table override, before other paths: a later mcp_servers table would replace this one.
  if (Object.keys(dotted).length) args.unshift('-c', `mcp_servers=${table(Object.fromEntries(Object.entries(dotted).map(([n, fields]) => [n, table(fields)])))}`);
  return args;
}
