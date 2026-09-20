// Capability index: programs, MCP servers and access rules a worker can use, looked up by task category. One shared
// catalogue in core/policy/capabilities.json (generic, path-free) plus machine-specific entries in config
// `tools.index` (merged by name; null removes; an entry with only extra fields tags a shared one). Availability is
// detected at startup and on Refresh, asynchronously and windowless, and cached in the state dir. Nothing here ever
// installs anything: a missing program is offered to the user with its official link, once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, statePath, readJson, writeJson, nowIso } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { findCli, spawnCli } from './proc.mjs';
import { mcpServers } from './mcp.mjs';
import { getModels } from './models.mjs';
import { bus } from './bus.mjs';

const PLATFORM = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const FILE = join(REPO_ROOT, 'core', 'policy', 'capabilities.json');
const STATE = () => statePath('capabilities.json');

/** The merged index for this platform: [{ name, kind, categories, purpose, invoke, detect, install, platforms, added, keywords, match, providers, approved, source }]. */
export function loadIndex(cfg = loadConfig()) {
  let shared = []; try { shared = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
  const out = new Map(shared.filter((e) => e?.name).map((e) => [e.name, { ...e, source: 'repo' }]));
  for (const [name, e] of Object.entries(cfg.tools?.index || {})) {
    if (e === null || e === false) out.delete(name);
    else if (e && typeof e === 'object') out.set(name, { ...(out.get(name) || {}), ...e, name, source: out.has(name) ? 'repo' : 'config' });
  }
  return [...out.values()].filter((e) => !Array.isArray(e.platforms) || !e.platforms.length || e.platforms.includes(PLATFORM));
}

let status = null; // name -> { available, version, checkedAt }; the last detection, loaded from the state dir on first use
export const detectionStatus = () => status || (status = readJson(STATE(), {}));

/** Run `bin args` windowless; the first output line on exit 0, else null. Bounded to 10 s. */
function capture(bin, args) {
  return new Promise((resolve) => {
    let out = ''; let child;
    try { child = spawnCli(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10_000);
    child.stdout?.on('data', (d) => { out += d; }); child.stderr?.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? (out.trim().split('\n')[0] || '').slice(0, 80) : null); });
  });
}

/** Which entries are usable on this machine right now. Async; never on the dispatch path. */
export async function detectCapabilities(cfg = loadConfig()) {
  const next = {};
  await Promise.all(loadIndex(cfg).map(async (e) => {
    let available = false, version = null;
    if (e.kind === 'cli' && e.detect?.command) { const bin = findCli(e.detect.command); if (bin) { version = await capture(bin, e.detect.args || ['--version']); available = version != null; } }
    else if (e.kind === 'mcp') available = !!mcpServers(cfg)[e.detect?.server || e.name];
    else if (e.kind === 'access') available = !e.providers?.length || e.providers.some((p) => getModels().providers?.[p]?.status === 'ok');
    else available = true; // recipe / python-lib / app: described, not probed
    next[e.name] = { available, version, checkedAt: nowIso() };
  }));
  status = next;
  try { writeJson(STATE(), next); } catch {}
  bus.publish('capabilities', { available: Object.values(next).filter((s) => s.available).length, total: Object.keys(next).length });
  return next;
}

/** Entries for a category (null = all), each with its detected availability (null = never checked). */
export function capabilitiesFor(category, cfg = loadConfig()) {
  const st = detectionStatus();
  return loadIndex(cfg).filter((e) => !category || (e.categories || []).includes(category)).map((e) => ({ ...e, available: st[e.name]?.available ?? null, version: st[e.name]?.version ?? null }));
}

/**
 * Lines appended to a worker spec after the recipe: only what is installed (or an access note), never a proposed
 * entry that the user has not approved. The recipe and these lines share one budget, so a worker's prompt cannot
 * silently double; the caller passes what is left.
 */
export function capabilityLines(category, { maxChars = 1500, cfg = loadConfig() } = {}) {
  const lines = [];
  for (const e of capabilitiesFor(category, cfg)) {
    if (e.available === false || e.approved === false) continue;
    const l = e.kind === 'access' ? `- ${e.name}: ${e.purpose}` : `- ${e.name}${e.version ? ` (${e.version})` : ''}: ${e.purpose}. Invoke: ${e.invoke}`;
    if (lines.join('\n').length + l.length + 1 > maxChars) break;
    lines.push(l);
  }
  return lines.length ? `# Programs and services for this kind of work (installed here; prefer them over doing the same by hand)\n${lines.join('\n')}` : '';
}

/** Known-but-missing entries for a category: offered to the user once per chat, never installed by Conductor. */
export function missingFor(category, cfg = loadConfig()) {
  return capabilitiesFor(category, cfg).filter((e) => e.available === false && e.install?.url && e.approved !== false);
}

/** Access gate: an access entry whose `match` appears in the task text restricts the pick to its providers. */
export function accessProviders(text, cfg = loadConfig()) {
  const low = String(text || '').toLowerCase();
  const hits = loadIndex(cfg).filter((e) => e.kind === 'access' && (e.match || []).some((m) => low.includes(String(m).toLowerCase())) && e.providers?.length);
  return hits.length ? { providers: [...new Set(hits.flatMap((e) => e.providers))], names: hits.map((e) => e.name) } : null;
}

/** Rows for `conductor doctor` and the UI: installed / missing (with the official link) / proposed. */
export function capabilityReport(cfg = loadConfig()) {
  return capabilitiesFor(null, cfg).map((e) => ({
    name: e.name, kind: e.kind, categories: e.categories || [], added: e.added || 'curated',
    status: e.approved === false ? `proposed (${e.added || 'researched'}; approve it in config tools.index.${e.name}.approved)` : e.kind === 'access' ? (e.providers?.length ? `access rule → ${e.providers.join(', ')}${e.available ? '' : ' (none of them available now)'}` : 'access note only (no provider gate)') : e.available == null ? 'not checked yet' : e.available ? `installed${e.version ? ` (${e.version})` : ''}` : `missing${e.install?.url ? ` → ${e.install.url}` : ''}${e.install?.command ? ` (${e.install.command})` : ''}`,
  }));
}

// --- research on a miss (opt-in: config tools.researchOnMiss) ---------------------------------------------------
const RESEARCHED = () => statePath('capabilities-researched.json');
/** True when a category has no entry at all and was not researched in the last 30 days; records the attempt. */
export function shouldResearch(category, cfg = loadConfig()) {
  if (!cfg.tools?.researchOnMiss || !category || capabilitiesFor(category, cfg).length) return false;
  const seen = readJson(RESEARCHED(), {});
  if (seen[category] && Date.now() - Date.parse(seen[category]) < 30 * 86_400_000) return false;
  try { writeJson(RESEARCHED(), { ...seen, [category]: nowIso() }); } catch {}
  return true;
}
export const researchSpec = (category, example) => `Find existing software that does "${category}" work better or cheaper than a language model (for example: ${example}).
Only official sources: the vendor's site, the project's own GitHub releases, winget or Homebrew. Never a download mirror. Do not install anything.
Report as a fenced json block: an array of entries { "name", "kind": "cli"|"mcp"|"python-lib"|"app", "purpose" (one line: what it does better than a model), "invoke" (how to call it, no absolute paths), "detect": { "command", "args": ["--version"] }, "install": { "url", "command" }, "platforms": ["win","mac","linux"], "licence" }.
Up to 3 entries, best first; an empty array when nothing fits. One paragraph of reasoning before the block.`;
/** Entries out of a research report, marked researched + unapproved. Anything malformed is dropped. */
export function parseResearched(report, category) {
  const m = /```json\s*([\s\S]*?)```/.exec(report || ''); if (!m) return [];
  let arr; try { arr = JSON.parse(m[1]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter((e) => e && typeof e.name === 'string' && /^[a-z0-9._-]+$/i.test(e.name) && typeof e.purpose === 'string' && /^https:\/\//.test(e.install?.url || ''))
    .slice(0, 3).map((e) => ({ name: e.name, kind: ['cli', 'mcp', 'python-lib', 'app'].includes(e.kind) ? e.kind : 'app', categories: [category], purpose: String(e.purpose).slice(0, 200), invoke: String(e.invoke || '').slice(0, 200),
      detect: e.detect?.command ? { command: String(e.detect.command), args: Array.isArray(e.detect.args) ? e.detect.args.map(String) : ['--version'] } : undefined,
      install: { url: e.install.url, command: e.install.command ? String(e.install.command).slice(0, 120) : undefined }, platforms: Array.isArray(e.platforms) ? e.platforms : undefined,
      added: `researched ${nowIso().slice(0, 10)}`, approved: false }));
}
