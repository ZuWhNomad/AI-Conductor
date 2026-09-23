// User configuration: defaults merged with ~/.conductor2/config.json.
import { statSync } from 'node:fs';
import { readJson, writeJson, statePath } from './paths.mjs';

export const DEFAULTS = {
  port: 47474,
  openBrowser: true,
  pollMinutes: 15,                    // model + limit registry refresh cadence
  // `autoRefresh` turns on the server's model/limit poll (every pollMinutes; tabs follow its events). `detectMinutes` is a
  // much cheaper thing: how often an INSTALLED BUT SIGNED-OUT provider is re-probed so a sign-in done outside
  // the app is noticed without pressing Refresh.
  ui: { autoRefresh: false, detectMinutes: 5 },
  conductor: {                        // selection format everywhere: provider:model:effort
    provider: 'claude',               // only Claude models can conduct (Agent SDK harness)
    model: 'claude-opus-5-5[1m]',     // exact id, never an alias (aliases move when the CLI updates): move it to a new Opus on purpose
    effort: 'high',
    permissionMode: 'acceptEdits',    // 'acceptEdits' (ask for the rest) | 'bypassPermissions'
    overflowApi: false,               // new chats: may the router spend pay-per-token APIs once subscriptions are capped?
    maxWorkerConcurrency: 100,        // effectively uncapped: provider limits and the budget gate are the real budget,
                                      // and a low cap silently starves a fan-out (a cap of 3 left a queued model never run)
    budgetGate: true,                 // gate ALL task dispatch on per-window budget targets (session 95% / weekly 100%); park until reset when a provider is tapped out
    maxTurns: 9999,                   // tool turns per chat turn (Claude harness and the API/Ollama loop); a big project needs many
    turnTimeoutMinutes: 120,          // hard cap on a single conductor chat turn (Codex and API/Ollama conductors)
    autoUpdate: 'auto',               // GitHub update policy: 'auto' (pull + npm install AND self-restart into the new version, on startup + every updateCheckHours) | 'ask' (flash the Update button, apply on click) | 'off' (never check). The button flashes on 'ask' and 'auto'.
    updateCheckHours: 19,             // how often to check GitHub for updates (0 disables the periodic check; startup still checks unless autoUpdate is 'off')
    loopToolsSkip: [],                // tool names a LOOP conductor (Ollama / API) does not get; ~3k tokens of schemas go to every request, and a small model may truncate
    updateQuietMinutes: 15,           // an auto-update restart needs this long without any API write or task change: an external driver between two passes is not idle
  },
  worker: {                           // default grunt worker
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    resumeMaxAgeHours: 6,             // a task interrupted longer ago than this is not replayed at start (canceled with a reason)
    recipeChars: 6000,                // log recipes over this character budget (the full recipe is still appended)
    toolLineChars: 1500,              // character budget for capability lines appended to a worker spec
    codexSandbox: 'workspace-write',  // 'read-only' | 'workspace-write' | 'danger-full-access'
    // Per-model exceptions to codexSandbox, for a task or conductor session that names no sandbox itself.
    // gpt-6-astra: under workspace-write the Codex sandbox is denied the geometry libraries' DLLs (manifold3d "Access
    // is denied", shapely.geometry missing) and Astra correctly stops and reports it, so every modelling or drafting
    // task on the one model with a recorded modelling pass fails. Full access trades away the OS sandbox for Astra
    // only; the real fix is FIXES_BACKLOG-v2 item 17. An explicit sandbox on a task always wins.
    codexSandboxByModel: { 'gpt-6-astra': 'danger-full-access' },
    codexNetwork: true,               // allow network inside workspace-write (npm install etc.)
    // API / Ollama (openai-compat) workers have no OS sandbox. `run` is disabled by default.
    // Explicit true permits any host shell command; an array permits command names (exact basename, no shell
    // operators). Either opt-in trusts host execution: interpreters, package managers and other allowed programs
    // can access files outside the workspace. The allow-list is a command filter, not a filesystem sandbox.
    // File-tool containment checks do not constrain commands. Codex sandbox settings above are independent.
    shell: false,
    fetchAllowPrivate: false,         // the worker fetch_url tool blocks private/loopback/metadata IPs (SSRF); set true only if your workers must reach an internal docs server on the LAN
    claudePermissionMode: 'bypassPermissions', // Claude/Ollama workers run autonomously; the conductor reviews
    maxRounds: 3,                     // review -> follow_up rounds on the SAME worker before escalating to a stronger model
    escalationRounds: 2,              // after maxRounds fail: attempts on the best AVAILABLE model (scorecard top-quality, filtered by limits) before the conductor does the task itself. 0 = skip escalation (straight to the conductor)
    msw: true,                        // append the MSW kernel (core/policy/prompts/msw.md) to every worker preamble
    maxIterations: 150,               // tool-loop turns for API/Ollama workers (each turn re-sends the conversation)
    maxTurns: 500,                    // tool turns per Claude-harness worker task
    maxTurnsLocal: 60,                // tool turns for a local (Ollama-via-Claude-harness) worker task — smaller models loop more, so cap lower
    timeoutMinutes: 45,               // per worker run
    timeoutByCategory: { modeling: 240 }, // categories that legitimately run long (image->3D iterates); watch the durations in the scorecard
    longRunMinutes: 60,               // a run past this logs a friction entry so long runs stay visible
  },
  providers: {
    // API-key providers are optional; keys may also come from env vars named in providers/*.
    ollama: { baseUrl: 'http://localhost:11434', autoStart: true, harness: 'openai-compat' }, // or 'claude' (Anthropic-API compat)
    deepseek: { apiKey: null },
    moonshot: { apiKey: null },       // Kimi
    xai: { apiKey: null },            // Grok
    qwen: { apiKey: null },           // DashScope (OpenAI-compatible)
    gemini: { apiKey: null },         // Gemini OpenAI-compatible endpoint
    openai: { apiKey: null },         // DALL-E / gpt-image (API key, optional)
    stability: { apiKey: null },
    sd: { baseUrl: 'http://127.0.0.1:7860' }, // local Stable Diffusion (A1111 API)
  },
  review: { everyDays: 0 },           // 0 = manual only
  scorecard: {                        // empirical worker selection (core/scorecard.mjs)
    minSamples: 3,                    // rated runs before a model/category/level counts
    quality: 0.75,                    // mean verdict (pass 1, fixable 0.5, fail 0) a final step must reach
    qualityValueUsd: 5,               // $ one full quality point is worth (≈ what a failed task costs you in review + redo)
    hourlyUsd: 0,                     // $ per hour of worker wall clock (0 = ignore speed)
    usePriors: false,                 // route by public benchmark tier before any measured data exists
    prices: {},                       // "provider:model": { in, out, cached } $/M tokens; overrides core/priors.mjs
    effortSlackUsd: 0.01,             // a higher effort of the same model dominates a lower one when within max(this $/task, ...
    effortSlackPct: 10,               // ... this % of the lower effort's $/task) and at least as good
    // Shadow dollars are list price; what a token really costs you depends on the budget it comes from.
    // Included subscriptions are ~free until their window fills (then they count at full price, see quotaPressurePct).
    // Budget classes are walked in order for every task: the first class with a model proven at the task's level and
    // room under its cap wins; value decides within the class. Classes derive from each provider's auth (local, included
    // subscription CLI, the conductor's own plan, API key); `classes` overrides one provider, e.g. { grok: 'subscription' }.
    classOrder: ['free', 'included', 'subscription', 'conductor', 'api'],
    classes: { codex: 'subscription' },
    // Subscriptions run to 100% (exhaustion = blocked -> failover/park). Only the conductor's own plan keeps headroom: 95% of its
    // *session* window (5-hour); its weekly windows (Fable weekly included) may go to 100%.
    classCap: { free: 100, included: 100, subscription: 100, conductor: 95, api: 100 },
    providerWeight: { ollama: 0, antigravity: 0.1, grok: 0.1, kimi: 0.1, 'qwen-code': 0.1, deepseek: 0.3, moonshot: 0.3, xai: 0.3, qwen: 0.3, gemini: 0.3, openai: 0.3, codex: 0.6, claude: 1 }, // within-class value scaling
    usageBudgets: { grok: 10000000 }, // flat token budget for providers whose CLI reports no window (Grok): 100% at N in+out tokens. Advisory only — never gates dispatch.
    usageOvershootPct: 110,           // when an estimate runs this far past its projected 100% without the provider failing, prompt the user to re-verify the limit/reset (it likely reset early, or the budget is low)
    usageGapHours: { default: 6 },    // a gap this long in a provider's own activity starts a fresh usage window; per-provider override, e.g. { grok: 24 } for a daily reset
    windowTargets: { session: 95, other: 100 }, // dispatch gate: a rolling session/5-hour window is used to 95%, weekly/monthly/budget windows to 100%
    difficultyEffort: { 1: 'low', 2: 'medium', 3: 'medium', 4: 'high', 5: 'xhigh' }, // cold-start effort per difficulty (clamped to what the model offers)
    blockedMinutes: 30,               // how long a provider is assumed blocked after a limit hit when it gives no retry-after
    quotaPressurePct: 80,             // a provider whose busiest window is past this % is charged at full list price
    // Use-it-or-lose-it: a subscription's weekly/monthly window that resets soon with quota unused loses that quota
    // at reset, so spending it now is ~free. Within wasteHorizonHours of a reset, the model's cost is discounted
    // toward 0 in proportion to (how close the reset is) × (how much headroom is unused) × wasteStrength. Quality still
    // dominates selection (utility = value×quality − cost), so this only tips the balance among comparable choices.
    wasteHorizonHours: 48,            // start favouring a soon-resetting subscription this many hours before its reset
    wasteStrength: 0.9,               // 0 = off; 1 = a fully-unused window at its reset is treated as free
    // Reset schedules for providers whose CLI reports NO window (Grok, …). Times are the machine's LOCAL timezone,
    // DST-aware — never a hard-coded zone. Per provider: { periodHours, resetHour } for a daily wall-clock reset
    // (add resetDay 0-6 from Sunday + periodHours 168 for weekly), or { periodHours, anchorAt } to step from an
    // explicit instant; periodHours 0 or absent = no schedule.
    // EMPTY ON PURPOSE: a plan's reset can move, and assuming the wrong one is worse than assuming none — it zeroes
    // the usage bar early and hands out a use-it-or-lose-it discount that was never earned. Set yours in Settings.
    usageResets: {},

    rebenchDays: 21,                  // `conductor bench` re-runs a selection's battery after this many days
    // Reservation, derived from data: a provider's cost on a task is multiplied by 1 + reservePct × weight × (its measured
    // ceiling − the task's difficulty), so capacity proven at level 4-5 is held back for level 4-5 work.
    reservePct: 0.5,
  },
  server: { lagWarnMs: 500 },         // event-loop lag (p99 over the last minute) above this logs a friction entry: the server is stalling
  smoke: { timeoutMinutes: 10 },      // per smoke-battery task
  tools: {                            // capability index (core/capabilities.mjs): programs, MCP servers, access rules a worker can use, by category
    index: {},                        // machine-specific entries by name: { kind, categories, purpose, invoke, detect, install, platforms }; null removes a shared one; extra fields tag it
    researchOnMiss: false,            // a category with no entry at all → one bounded background search task proposes programs (unapproved until you set approved: true)
  },
  mcpServers: {},                     // conductor-wide MCP: name -> { url } | { command, args, env } [+ categories: ['search', ...]]; null removes an inherited one; { categories } alone tags an inherited one. Tagged servers are attached only to worker tasks of those categories
};

const FILE = () => statePath('config.json');
const plain = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function deepMerge(a, b, path = '') {
  if (b === undefined || (b === null && plain(a))) return structuredClone(a);
  if (!plain(b)) return b;
  const out = plain(a) ? structuredClone(a) : {};
  for (const [k, v] of Object.entries(b)) {
    // Registry entries use null as a tombstone; ordinary object subtrees keep their values.
    out[k] = v === null && (path === 'mcpServers' || path === 'tools.index') ? null : deepMerge(a?.[k], v, path ? `${path}.${k}` : k);
  }
  return out;
}

// The overrides file is read once per change (stat, not read+parse, on every call): loadConfig() sits on every hot
// path. Callers still get a fresh merged object each time, so mutating it never leaks.
let fileCache = { key: null, value: {} };
function overrides() {
  let key = 'none';
  try { const s = statSync(FILE()); key = `${s.size}:${s.mtimeMs}`; } catch {}
  if (key !== fileCache.key) fileCache = { key, value: key === 'none' ? {} : readJson(FILE(), {}) };
  return fileCache.value;
}

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

/** The Codex sandbox a task or session gets when it does not name one: the model's exception, else the default. */
export function codexSandboxFor(model, cfg = loadConfig()) {
  const byModel = cfg.worker?.codexSandboxByModel || {};
  const s = model && byModel[model];
  return SANDBOXES.includes(s) ? s : cfg.worker?.codexSandbox || 'workspace-write';
}

export function loadConfig() {
  return normalize(deepMerge(DEFAULTS, overrides()));
}

function normalize(cfg) {
  if (!plain(cfg)) cfg = structuredClone(DEFAULTS);
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (plain(value) && !plain(cfg[key])) cfg[key] = structuredClone(value);
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) cfg.port = DEFAULTS.port;
  for (const [name, value] of Object.entries(cfg.providers)) {
    const p = cfg.providers[name] = plain(value) ? value : structuredClone(DEFAULTS.providers[name] || {});
    if ('baseUrl' in p && typeof p.baseUrl !== 'string') {
      if (DEFAULTS.providers[name]?.baseUrl) p.baseUrl = DEFAULTS.providers[name].baseUrl;
      else delete p.baseUrl; // providers with their own endpoint use that default
    }
  }
  for (const [name, s] of Object.entries(cfg.mcpServers)) {
    if (s === false) { cfg.mcpServers[name] = null; continue; } // legacy removal spelling
    if (s === null) continue;
    if (!plain(s)) { delete cfg.mcpServers[name]; continue; }
    for (const key of ['url', 'command']) if (key in s && typeof s[key] !== 'string') delete s[key];
    if ('args' in s) s.args = Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string') : [];
    if ('env' in s) s.env = plain(s.env) ? Object.fromEntries(Object.entries(s.env).filter(([, v]) => typeof v === 'string')) : {};
  }
  if (!plain(cfg.ui)) cfg.ui = { ...DEFAULTS.ui };
  cfg.ui.autoRefresh = !!cfg.ui.autoRefresh;
  if (!plain(cfg.server)) cfg.server = { ...DEFAULTS.server };
  if (!plain(cfg.scorecard.windowTargets)) cfg.scorecard.windowTargets = { ...DEFAULTS.scorecard.windowTargets };
  // 0 is a documented OFF switch for these two, so it must survive: only garbage (negative, NaN) resets.
  for (const [obj, defaults, key] of [[cfg.conductor, DEFAULTS.conductor, 'updateCheckHours'], [cfg.ui, DEFAULTS.ui, 'detectMinutes']]) {
    if (!Number.isFinite(obj[key]) || obj[key] < 0) obj[key] = defaults[key];
  }
  for (const [obj, defaults, key] of [
    [cfg, DEFAULTS, 'pollMinutes'],
    ...['maxWorkerConcurrency', 'maxTurns', 'turnTimeoutMinutes', 'updateQuietMinutes'].map((key) => [cfg.conductor, DEFAULTS.conductor, key]),
    ...['maxTurns', 'timeoutMinutes', 'maxRounds', 'maxIterations', 'maxTurnsLocal', 'longRunMinutes', 'recipeChars', 'toolLineChars'].map((key) => [cfg.worker, DEFAULTS.worker, key]),
    ...['minSamples', 'quality', 'qualityValueUsd', 'blockedMinutes'].map((key) => [cfg.scorecard, DEFAULTS.scorecard, key]),
    ...Object.keys(DEFAULTS.scorecard.windowTargets).map((key) => [cfg.scorecard.windowTargets, DEFAULTS.scorecard.windowTargets, key]),
    [cfg.smoke, DEFAULTS.smoke, 'timeoutMinutes'], [cfg.server, DEFAULTS.server, 'lagWarnMs'],
  ]) {
    if (!Number.isFinite(obj[key]) || obj[key] <= 0) obj[key] = defaults[key];
  }
  if (!Number.isInteger(cfg.worker.escalationRounds) || cfg.worker.escalationRounds < 0) cfg.worker.escalationRounds = DEFAULTS.worker.escalationRounds; // 0 allowed (disable escalation), negatives/non-integers reset
  if (cfg.scorecard.quality > 1) cfg.scorecard.quality = DEFAULTS.scorecard.quality;
  if (!Number.isFinite(cfg.scorecard.hourlyUsd) || cfg.scorecard.hourlyUsd < 0) cfg.scorecard.hourlyUsd = 0;
  cfg.scorecard.usePriors = !!cfg.scorecard.usePriors;
  if (!plain(cfg.scorecard.prices)) cfg.scorecard.prices = {};
  if (!plain(cfg.scorecard.providerWeight)) cfg.scorecard.providerWeight = { ...DEFAULTS.scorecard.providerWeight };
  if (!Number.isFinite(cfg.scorecard.quotaPressurePct)) cfg.scorecard.quotaPressurePct = DEFAULTS.scorecard.quotaPressurePct;
  if (!Number.isFinite(cfg.scorecard.reservePct) || cfg.scorecard.reservePct < 0) cfg.scorecard.reservePct = DEFAULTS.scorecard.reservePct;
  if (!Array.isArray(cfg.scorecard.classOrder) || !cfg.scorecard.classOrder.length) cfg.scorecard.classOrder = [...DEFAULTS.scorecard.classOrder];
  if (!plain(cfg.scorecard.classes)) cfg.scorecard.classes = { ...DEFAULTS.scorecard.classes };
  if (!plain(cfg.scorecard.classCap)) cfg.scorecard.classCap = { ...DEFAULTS.scorecard.classCap };
  if (!plain(cfg.worker.timeoutByCategory)) cfg.worker.timeoutByCategory = { ...DEFAULTS.worker.timeoutByCategory };
  for (const [obj, key] of [[cfg.worker, 'timeoutByCategory'], [cfg.scorecard, 'usageBudgets'], [cfg.scorecard, 'usageGapHours']]) {
    if (!plain(obj[key])) obj[key] = {};
    for (const [name, value] of Object.entries(obj[key])) {
      if (!Number.isFinite(value) || value <= 0) delete obj[key][name];
    }
  }
  for (const key of ['wasteHorizonHours', 'wasteStrength']) {
    if (!Number.isFinite(cfg.scorecard[key])) cfg.scorecard[key] = DEFAULTS.scorecard[key];
  }
  cfg.scorecard.wasteHorizonHours = Math.max(1, cfg.scorecard.wasteHorizonHours);
  cfg.scorecard.wasteStrength = Math.max(0, Math.min(1, cfg.scorecard.wasteStrength));
  if (!Number.isFinite(cfg.scorecard.rebenchDays) || cfg.scorecard.rebenchDays <= 0) cfg.scorecard.rebenchDays = DEFAULTS.scorecard.rebenchDays;
  cfg.conductor.overflowApi = !!cfg.conductor.overflowApi;
  if (!Number.isFinite(cfg.scorecard.effortSlackUsd) || cfg.scorecard.effortSlackUsd < 0) cfg.scorecard.effortSlackUsd = DEFAULTS.scorecard.effortSlackUsd;
  if (!Number.isFinite(cfg.scorecard.effortSlackPct) || cfg.scorecard.effortSlackPct < 0) cfg.scorecard.effortSlackPct = DEFAULTS.scorecard.effortSlackPct;
  // Config timer bounds: minutes at one day; hours at 596, below Node's 2^31-1 ms timer maximum.
  for (const [obj, key] of [[cfg, 'pollMinutes'], [cfg.worker, 'timeoutMinutes'], [cfg.conductor, 'turnTimeoutMinutes'], [cfg.smoke, 'timeoutMinutes'], [cfg.ui, 'detectMinutes']]) {
    obj[key] = Math.min(1440, obj[key]);
  }
  for (const key of Object.keys(cfg.worker.timeoutByCategory)) cfg.worker.timeoutByCategory[key] = Math.min(1440, cfg.worker.timeoutByCategory[key]);
  cfg.conductor.updateCheckHours = Math.min(596, cfg.conductor.updateCheckHours);
  // A reset schedule the user entered: clamp the wall-clock fields (a <select> hands us strings, and garbage here
  // would move the reset instant). Any provider, not just Grok, since `usageResets` ships empty.
  for (const s of Object.values(cfg.scorecard.usageResets || {})) {
    if (!plain(s)) continue;
    const clamp = (v, hi, fallback) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(0, n)) : fallback; };
    if (s.resetDay != null) s.resetDay = clamp(s.resetDay, 6, null);
    if (s.resetHour != null) s.resetHour = clamp(s.resetHour, 23, 0);
    if (s.resetMinute != null) s.resetMinute = clamp(s.resetMinute, 59, 0);
    // A wall-clock schedule with no period would be read as "no schedule", silently ignoring a day the user set.
    // Infer the obvious one: a weekday means weekly, an hour alone means daily. An explicit 0 stays 0 (= not set).
    if (s.periodHours == null && (s.resetDay != null || s.resetHour != null)) s.periodHours = s.resetDay != null ? 168 : 24;
  }
  return cfg;
}

const SECRET_MASK = '••••';
const secretName = (name) => /token|key|secret|pass|auth|bearer|credential|header/i.test(name);
const secretFlag = (flag) => flag === '-H' || flag === '-t' || (/^--?[^=]+$/.test(flag) && secretName(flag));
const envAssignment = (arg) => { const m = /^([^=]+)=/.exec(arg); return m && secretName(m[1]) ? m[1] : null; };
const hasMask = (value) => typeof value === 'string' && (value.includes(SECRET_MASK) || value.toLowerCase().includes(encodeURIComponent(SECRET_MASK).toLowerCase()));
// Positional URLs and --endpoint=URL both occur in MCP launch arguments.
const maskUrlArg = (arg) => arg.replace(/^((?:--?[^=]+=)?)([a-z][a-z\d+.-]*:\/\/.*)$/i, (_, flag, url) => flag + maskUrlSecrets(url));

function maskMcpArgs(args) {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const a = String(out[i] ?? '');
    const env = /^(?:-e|--env)$/i.test(a) && envAssignment(String(out[i + 1] ?? ''));
    if (env) { out[++i] = env + '=' + SECRET_MASK; continue; }
    const inlineEnv = /^(--env=)([^=]+)=/i.exec(a);
    if (inlineEnv && secretName(inlineEnv[2])) { out[i] = inlineEnv[1] + inlineEnv[2] + '=' + SECRET_MASK; continue; }
    const eq = a.indexOf('=');
    if (eq > 0 && secretFlag(a.slice(0, eq))) { out[i] = a.slice(0, eq + 1) + SECRET_MASK; continue; }
    if (secretFlag(a) && i + 1 < out.length) { out[++i] = SECRET_MASK; continue; }
    out[i] = maskUrlArg(a);
  }
  return out;
}

/** Restore masked MCP args by flag identity (nth occurrence of the same flag/form). No match → drop the flag pair, never persist the mask. */
function restoreMcpArgs(posted, stored) {
  const eq = new Map(), split = new Map(), urls = new Map();
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  for (let i = 0; i < stored.length; i++) {
    const a = String(stored[i] ?? '');
    const env = /^(?:-e|--env)$/i.test(a) && envAssignment(String(stored[i + 1] ?? ''));
    if (env) { push(split, `${a.toLowerCase()}=${env.toLowerCase()}`, stored[i + 1]); i++; continue; }
    const inlineEnv = /^(--env=)([^=]+)=/i.exec(a);
    if (inlineEnv && secretName(inlineEnv[2])) { push(eq, `${inlineEnv[1].toLowerCase()}${inlineEnv[2].toLowerCase()}=`, stored[i]); continue; }
    const eqAt = a.indexOf('=');
    if (eqAt > 0 && secretFlag(a.slice(0, eqAt))) { push(eq, a.slice(0, eqAt + 1).toLowerCase(), stored[i]); continue; }
    if (secretFlag(a) && i + 1 < stored.length) { push(split, a.toLowerCase(), stored[++i]); continue; }
    const masked = maskUrlArg(a);
    if (hasMask(masked) && !hasMask(a)) push(urls, masked, a);
  }
  const eqSeen = new Map(), splitSeen = new Map(), urlSeen = new Map();
  const nth = (map, k) => { const n = map.get(k) || 0; map.set(k, n + 1); return n; };
  const out = [];
  for (let i = 0; i < posted.length; i++) {
    const a = String(posted[i] ?? '');
    const env = /^(?:-e|--env)$/i.test(a) && envAssignment(String(posted[i + 1] ?? ''));
    if (env) {
      const key = `${a.toLowerCase()}=${env.toLowerCase()}`, n = nth(splitSeen, key), next = posted[i + 1];
      if (hasMask(next)) { const got = split.get(key)?.[n]; if (got != null && !hasMask(got)) out.push(a, got); i++; continue; }
      out.push(a, next); i++; continue;
    }
    const inlineEnv = /^(--env=)([^=]+)=/i.exec(a);
    if (inlineEnv && secretName(inlineEnv[2])) {
      const key = `${inlineEnv[1].toLowerCase()}${inlineEnv[2].toLowerCase()}=`, n = nth(eqSeen, key);
      if (hasMask(a)) { const got = eq.get(key)?.[n]; if (got != null && !hasMask(got)) out.push(got); }
      else out.push(a);
      continue;
    }
    const eqAt = a.indexOf('=');
    if (eqAt > 0 && secretFlag(a.slice(0, eqAt))) {
      const key = a.slice(0, eqAt + 1).toLowerCase(), n = nth(eqSeen, key);
      if (hasMask(a)) { const got = eq.get(key)?.[n]; if (got != null && !hasMask(got)) out.push(got); }
      else out.push(posted[i]);
      continue;
    }
    if (secretFlag(a) && i + 1 < posted.length) {
      const key = a.toLowerCase(), n = nth(splitSeen, key), next = posted[i + 1];
      if (hasMask(next)) {
        const got = split.get(key)?.[n];
        if (got != null && !hasMask(got)) { out.push(posted[i]); out.push(got); }
        i++;
        continue;
      }
      out.push(posted[i], posted[++i]);
      continue;
    }
    if (hasMask(a)) {
      const got = urls.get(a)?.[nth(urlSeen, a)];
      if (got != null) out.push(got);
      continue;
    }
    out.push(posted[i]);
  }
  return out;
}

export function saveConfig(patch) {
  if (!plain(patch)) throw Object.assign(new Error('settings must be a plain object'), { status: 400 });
  const clean = structuredClone(patch);
  const raw = readJson(FILE(), {});
  const stored = plain(raw) ? raw : {};
  // Never let a redaction sentinel from publicConfig round-trip back and overwrite the real secret with the mask.
  for (const p of Object.values(clean.providers || {})) if (p && typeof p === 'object' && p.apiKey === SECRET_MASK) delete p.apiKey;
  for (const [name, s] of Object.entries(clean.mcpServers || {})) {
    if (!s || typeof s !== 'object') continue;
    if (hasMask(s.url)) delete s.url;
    if (s.env && typeof s.env === 'object') for (const k of Object.keys(s.env)) if (s.env[k] === SECRET_MASK) delete s.env[k];
    const prev = stored.mcpServers?.[name]?.args;
    if (Array.isArray(s.args)) s.args = restoreMcpArgs(s.args, Array.isArray(prev) ? prev : []);
  }
  // Merge the patch onto the RAW file (the user's overrides), not onto loadConfig() (which already has DEFAULTS
  // folded in). Then persist only the keys that still differ from DEFAULTS, so the file stays the user's overrides
  // and a future change to a DEFAULT actually reaches the user instead of being frozen at its old value.
  const effective = normalize(deepMerge(DEFAULTS, deepMerge(stored, clean)));
  writeJson(FILE(), pruneToDefaults(effective, DEFAULTS));
  fileCache = { key: null, value: {} }; // our own write: re-read on the next load even if size and mtime did not move
  return effective;
}

/** Keep only the keys of `cfg` that differ from `def` (deep), so config.json holds overrides, not a frozen copy of DEFAULTS. */
function pruneToDefaults(cfg, def) {
  if (!plain(cfg)) return cfg;
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (plain(v) && plain(def?.[k])) { const sub = pruneToDefaults(v, def[k]); if (Object.keys(sub).length) out[k] = sub; }
    else if (JSON.stringify(v) !== JSON.stringify(def?.[k])) out[k] = v;
  }
  return out;
}

/** Redact secrets for the UI. */
export function publicConfig(cfg = loadConfig()) {
  const c = structuredClone(cfg);
  for (const p of Object.values(c.providers)) {
    if (p && typeof p === 'object' && 'apiKey' in p) p.apiKey = p.apiKey ? SECRET_MASK : null;
  }
  // MCP server env AND url often carry tokens/keys; mask both so they never round-trip through /api/state or /api/settings.
  for (const s of Object.values(c.mcpServers || {})) {
    if (!s || typeof s !== 'object') continue;
    if (s.env && typeof s.env === 'object') for (const k of Object.keys(s.env)) if (s.env[k]) s.env[k] = SECRET_MASK;
    if (typeof s.url === 'string') s.url = maskUrlSecrets(s.url);
    if (Array.isArray(s.args)) s.args = maskMcpArgs(s.args);
  }
  return c;
}

/** Strip a URL's userinfo and mask its query values (a token in an MCP url's query/userinfo must not leak via /api/state). */
function maskUrlSecrets(u) {
  try {
    const url = new URL(u);
    if (url.username || url.password) { url.username = SECRET_MASK; url.password = ''; }
    for (const k of [...url.searchParams.keys()]) url.searchParams.set(k, SECRET_MASK);
    return url.toString();
  } catch { return SECRET_MASK; } // e.g. multi-host DB URIs: no unparsed credential-bearing prefix is safe to expose
}
