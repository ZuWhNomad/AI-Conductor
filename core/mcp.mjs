// Conductor-wide MCP servers: one registry that every runtime attaches — Claude conductor sessions and
// Claude workers (Agent SDK `mcpServers`), Codex conductors and workers (`codex exec -c mcp_servers.*`).
// Sources, later wins: servers the user already configured for Codex (~/.codex/config.toml) and Claude
// (~/.claude.json global mcpServers), then `mcpServers` in ~/.conductor2/config.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.mjs';

const unq = (v) => v.trim().replace(/^(['"])(.*)\1$/s, '$2');

/** Parse `[mcp_servers.NAME]` tables (url | command/args/env) from a Codex config.toml. */
export function parseCodexToml(text) {
  const out = {}; let cur = null, env = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const h = /^\[mcp_servers\.([^\].]+)(\.env)?\]$/.exec(line);
    if (h) { cur = out[h[1]] = out[h[1]] || {}; env = h[2] ? (cur.env = cur.env || {}) : null; continue; }
    if (/^\[/.test(line)) { cur = null; env = null; continue; }
    if (!cur) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line); if (!kv) continue;
    const [, k, v] = kv;
    if (env) { env[k] = unq(v); continue; }
    if (k === 'url' || k === 'command') cur[k] = unq(v);
    else if (k === 'args') { try { cur.args = JSON.parse(v.replace(/'/g, '"')); } catch { cur.args = []; } }
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

/** The merged registry: { name: { url } | { command, args, env }, source: 'codex'|'claude'|'conductor' } */
export function mcpServers(cfg = loadConfig()) {
  const out = {};
  let codex = {}; try { codex = parseCodexToml(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8')); } catch {}
  for (const [n, s] of Object.entries(codex)) out[n] = { ...s, source: 'codex' };
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
 */
export function codexMcpArgs(servers) {
  const args = [];
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  for (const [name, s] of Object.entries(servers || {})) {
    if (s.source !== 'codex') {
      if (s.url) args.push('-c', `mcp_servers.${name}.url=${q(s.url)}`);
      else { args.push('-c', `mcp_servers.${name}.command=${q(s.command)}`, '-c', `mcp_servers.${name}.args=[${(s.args || []).map(q).join(',')}]`); for (const [k, v] of Object.entries(s.env || {})) args.push('-c', `mcp_servers.${name}.env.${k}=${q(v)}`); }
      args.push('-c', `mcp_servers.${name}.tool_timeout_sec=${s.toolTimeoutSec || 3600}`, '-c', `mcp_servers.${name}.startup_timeout_sec=${s.startupTimeoutSec || 30}`);
    }
    args.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`);
  }
  return args;
}
