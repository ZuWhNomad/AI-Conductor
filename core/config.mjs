// User configuration: defaults merged with ~/.conductor2/config.json.
import { statSync } from 'node:fs';
import { readJson, writeJson, statePath } from './paths.mjs';

export const DEFAULTS = {
  port: 47474,
  openBrowser: true,
  pollMinutes: 15,                    // model + limit registry refresh cadence
  ui: { autoRefresh: false, autoRefreshMinutes: 15 }, // Providers-panel client-side auto-refresh; separate from pollMinutes (server registry poll)
  conductor: {                        // selection format everywhere: provider:model:effort
    provider: 'claude',               // only Claude models can conduct (Agent SDK harness)
    model: 'claude-fable-5-1[1m]',    // null = Claude Code CLI default (currently Opus 5)
    effort: 'high',
    permissionMode: 'acceptEdits',    // 'acceptEdits' (ask for the rest) | 'bypassPermissions'
    overflowApi: false,               // new chats: may the router spend pay-per-token APIs once subscriptions are capped?
    maxWorkerConcurrency: 8,          // parallel worker tasks; provider limits, not this cap, are the real budget
    budgetGate: true,                 // gate ALL task dispatch on per-window budget targets (session 95% / weekly 100%); park until reset when a provider is tapped out
    maxTurns: 9999,                   // tool turns per chat turn (Claude harness and the API/Ollama loop); a big project needs many
    turnTimeoutMinutes: 120,          // hard cap on a single conductor chat turn (Codex and API/Ollama conductors)
    autoUpdate: 'auto',               // GitHub update policy: 'auto' (pull + npm install AND self-restart into the new version, on startup + every updateCheckHours) | 'ask' (flash the Update button, apply on click) | 'off' (never check). The button flashes on 'ask' and 'auto'.
    updateCheckHours: 19,             // how often to check GitHub for updates (0 disables the periodic check; startup still checks unless autoUpdate is 'off')
    updateQuietMinutes: 15,           // an auto-update restart needs this long without any API write or task change: an external driver between two passes is not idle
  },
  worker: {                           // default grunt worker
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    resumeMaxAgeHours: 6,             // a task interrupted longer ago than this is not replayed at start (canceled with a reason)
    codexSandbox: 'workspace-write',  // 'read-only' | 'workspace-write' | 'danger-full-access'
    codexNetwork: true,               // allow network inside workspace-write (npm install etc.)
    // API / Ollama (openai-compat) workers have no OS sandbox of their own, unlike Codex and Claude. Their `run`
    // tool spawns a host shell in the workspace, so an injected third-party model could otherwise read the plaintext
    // key store and exfiltrate it. The boundary: `true` = any command; `false` = the run tool is disabled; an array
    // = an allow-list of permitted command NAMES (exact basename; a single command with no shell operators). Default
    // is an allow-list covering the benchmark + common coding tools; the trusted conductor can extend it at runtime
    // (the `allow_command` tool, logged). Do NOT add a shell (bash/sh/cmd/powershell) — that re-enables arbitrary
    // execution. File tools stay sandboxed to the workspace regardless of this setting.
    shell: ['py', 'python', 'python3', 'node', 'npm', 'npx', 'git', 'openscad', 'potrace', 'pip', 'pytest'],
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
    // Reset schedule for providers whose CLI reports NO window (Grok, …), so the use-it-or-lose-it discount still
    // applies. Times are the machine's LOCAL (system) timezone, DST-aware — never a hard-coded zone. Per provider:
    // { periodHours, resetHour } for a daily wall-clock reset (add resetDay 0-6 + periodHours 168 for weekly), or
    // { periodHours, anchorAt } to step from an explicit instant. Set once; "use till it fails" refines the boundary
    // over time. Grok is seeded with a daily 18:00 local reset — change resetHour if yours differs.
    usageResets: { grok: { periodHours: 168, resetDay: 1, resetHour: 18 } }, // Grok = WEEKLY, Monday 18:00 local (the observed reset was Mon 14 Sep 6pm); change resetDay/resetHour if yours differs

    rebenchDays: 21,                  // `conductor bench` re-runs a selection's battery after this many days
    // Reservation, derived from data: a provider's cost on a task is multiplied by 1 + reservePct × weight × (its measured
    // ceiling − the task's difficulty), so capacity proven at level 4-5 is held back for level 4-5 work.
    reservePct: 0.5,
  },
  server: { lagWarnMs: 500 },         // event-loop lag (p99 over the last minute) above this logs a friction entry: the server is stalling
  smoke: { timeoutMinutes: 10 },      // per smoke-battery task
  mcpServers: {},                     // conductor-wide MCP: name -> { url } | { command, args, env }; null removes an inherited one
};

const FILE = () => statePath('config.json');
const plain = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function deepMerge(a, b) {
  if (b === null && plain(a)) return a;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a?.[k], v);
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

export function loadConfig() {
  return normalize(deepMerge(DEFAULTS, overrides()));
}

function normalize(cfg) {
  if (!plain(cfg.ui)) cfg.ui = { ...DEFAULTS.ui };
  cfg.ui.autoRefresh = !!cfg.ui.autoRefresh;
  if (!Number.isFinite(cfg.ui.autoRefreshMinutes) || cfg.ui.autoRefreshMinutes < 1) cfg.ui.autoRefreshMinutes = DEFAULTS.ui.autoRefreshMinutes;
  else cfg.ui.autoRefreshMinutes = Math.min(1440, Math.floor(cfg.ui.autoRefreshMinutes));
  for (const [obj, defaults, key] of [[cfg, DEFAULTS, 'pollMinutes'], [cfg.conductor, DEFAULTS.conductor, 'maxWorkerConcurrency'], [cfg.conductor, DEFAULTS.conductor, 'maxTurns'], [cfg.worker, DEFAULTS.worker, 'maxTurns'], [cfg.worker, DEFAULTS.worker, 'timeoutMinutes'], [cfg.worker, DEFAULTS.worker, 'maxRounds'], [cfg.scorecard, DEFAULTS.scorecard, 'minSamples'], [cfg.scorecard, DEFAULTS.scorecard, 'quality'], [cfg.scorecard, DEFAULTS.scorecard, 'qualityValueUsd'], [cfg.smoke, DEFAULTS.smoke, 'timeoutMinutes']]) {
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
  if (!Number.isFinite(cfg.scorecard.rebenchDays) || cfg.scorecard.rebenchDays <= 0) cfg.scorecard.rebenchDays = DEFAULTS.scorecard.rebenchDays;
  cfg.conductor.overflowApi = !!cfg.conductor.overflowApi;
  if (!Number.isFinite(cfg.scorecard.effortSlackUsd) || cfg.scorecard.effortSlackUsd < 0) cfg.scorecard.effortSlackUsd = DEFAULTS.scorecard.effortSlackUsd;
  if (!Number.isFinite(cfg.scorecard.effortSlackPct) || cfg.scorecard.effortSlackPct < 0) cfg.scorecard.effortSlackPct = DEFAULTS.scorecard.effortSlackPct;
  // Minutes feed setTimeout; anything past a day is a typo (and > 2^31 ms fires immediately).
  if (cfg.worker.timeoutMinutes > 1440) cfg.worker.timeoutMinutes = 1440;
  if (cfg.pollMinutes > 1440) cfg.pollMinutes = 1440;
  const grokReset = cfg.scorecard.usageResets?.grok;
  if (plain(grokReset)) {
    const day = Math.floor(Number(grokReset.resetDay));
    grokReset.resetDay = Number.isFinite(day) ? Math.min(6, Math.max(0, day)) : DEFAULTS.scorecard.usageResets.grok.resetDay;
    const hour = Math.floor(Number(grokReset.resetHour));
    grokReset.resetHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : DEFAULTS.scorecard.usageResets.grok.resetHour;
    if (grokReset.resetMinute != null) {
      const minute = Math.floor(Number(grokReset.resetMinute));
      grokReset.resetMinute = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
    }
  }
  return cfg;
}

const SECRET_MASK = '••••';

export function saveConfig(patch) {
  if (!plain(patch)) throw Object.assign(new Error('settings must be a plain object'), { status: 400 });
  const clean = structuredClone(patch);
  // Never let a redaction sentinel from publicConfig round-trip back and overwrite the real secret with the mask.
  for (const p of Object.values(clean.providers || {})) if (p && typeof p === 'object' && p.apiKey === SECRET_MASK) delete p.apiKey;
  for (const s of Object.values(clean.mcpServers || {})) if (s?.env && typeof s.env === 'object') for (const k of Object.keys(s.env)) if (s.env[k] === SECRET_MASK) delete s.env[k];
  // Merge the patch onto the RAW file (the user's overrides), not onto loadConfig() (which already has DEFAULTS
  // folded in). Then persist only the keys that still differ from DEFAULTS, so the file stays the user's overrides
  // and a future change to a DEFAULT actually reaches the user instead of being frozen at its old value.
  const effective = normalize(deepMerge(DEFAULTS, deepMerge(readJson(FILE(), {}), clean)));
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
  } catch { return u.includes('?') ? `${u.split('?')[0]}?${SECRET_MASK}` : u; }
}
