// Benchmark hygiene + durable auto-bench plan state. Detection and queueing never execute a benchmark by
// themselves; a caller must explicitly drain the per-provider lanes.
import { getModels } from './models.mjs';
import { rootRuns, isArchived, scorecardModelId, EFFORTS } from './scorecard.mjs';
import { loadConfig } from './config.mjs';
import { runSmoke } from './smoke/index.mjs';
import { logImprovement } from './improve.mjs';
import { openTasks } from './tasks.mjs';
import { modelBlockedUntil } from './limits.mjs';
import { readJson, writeJson, statePath, nowIso } from './paths.ts';

const FILE = () => statePath('bench.json');
// The scorecard plan's coverage battery is the original eleven L1-L5 tasks. Newer fixtures do not silently move
// this bar; changing it is a scorecard-policy decision.
export const BENCH_TASK_IDS = ['read-1', 'search-1', 'edit-1', 'implement-2', 'test-2', 'refactor-3', 'debug-3', 'debug-4', 'implement-4', 'test-4', 'debug-5'];
export const BENCH_COVERAGE = Object.freeze({ rated: 8, total: 11 });

const effortRank = (effort) => effort == null ? -1 : (EFFORTS.indexOf(effort) < 0 ? EFFORTS.length : EFFORTS.indexOf(effort));
const repeatCount = (value) => {
  const n = value == null ? 1 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw Object.assign(new Error('repeats must be an integer from 1 to 5'), { status: 400 });
  return n;
};
const storedRepeatCount = (value) => { const n = Number(value); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1; };
const selId = (s) => `${s.provider}:${scorecardModelId(s.model) || 'default'}:${s.effort || 'default'}`;
const seenKey = (s) => selId(s).toLowerCase();
const modelKey = (s) => `${s.provider}:${scorecardModelId(s.model) || 'default'}`.toLowerCase();
const cloneSelection = (s) => ({ provider: s.provider, model: scorecardModelId(s.model) || null, effort: s.effort || null });
const sorted = (xs) => [...xs].sort((a, b) => a.provider.localeCompare(b.provider) || String(a.model).localeCompare(String(b.model)) || effortRank(a.effort) - effortRank(b.effort));

function emptyState() {
  return { version: 1, seededAt: null, updatedAt: null, seen: [], aliases: {}, lanes: {} };
}

function normalizeState(value) {
  const s = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = emptyState();
  out.seededAt = typeof s.seededAt === 'string' ? s.seededAt : null;
  out.updatedAt = typeof s.updatedAt === 'string' ? s.updatedAt : null;
  out.seen = [...new Set((Array.isArray(s.seen) ? s.seen : []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase()))];
  out.aliases = s.aliases && typeof s.aliases === 'object' && !Array.isArray(s.aliases) ? { ...s.aliases } : {};
  if (s.lanes && typeof s.lanes === 'object' && !Array.isArray(s.lanes)) for (const [provider, lane] of Object.entries(s.lanes)) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) continue;
    out.lanes[provider] = {
      parkedUntil: Number.isFinite(lane.parkedUntil) ? lane.parkedUntil : null,
      running: lane.running && typeof lane.running === 'object' ? lane.running : null,
      queue: (Array.isArray(lane.queue) ? lane.queue : []).filter((item) => item?.selection?.provider === provider && Array.isArray(item.remaining)).map((item) => ({
        selection: cloneSelection(item.selection),
        remaining: item.remaining.filter((id) => typeof id === 'string'),
        repeats: storedRepeatCount(item.repeats),
        repeat: Number.isInteger(item.repeat) && item.repeat >= 0 && item.repeat < storedRepeatCount(item.repeats) ? item.repeat : 0,
        probePending: !!item.probePending,
        probeFailed: !!item.probeFailed,
        queuedAt: typeof item.queuedAt === 'string' ? item.queuedAt : null,
        lastError: typeof item.lastError === 'string' ? item.lastError : null,
      })),
    };
  }
  return out;
}

export function getBenchState() { return normalizeState(readJson(FILE(), null)); }
function saveState(state) {
  state.updatedAt = nowIso();
  writeJson(FILE(), state);
  return state;
}

function registryModels(reg = getModels()) {
  const grouped = new Map();
  for (const m of reg?.models || []) {
    if (m.kind !== 'agent' || /embed/i.test(m.id) || reg.providers?.[m.provider]?.status !== 'ok') continue;
    const model = scorecardModelId(m.id), key = `${m.provider}:${model}`.toLowerCase();
    let g = grouped.get(key);
    if (!g) { g = { provider: m.provider, model, efforts: new Set(), aliases: new Set(), cost: m.cost || null }; grouped.set(key, g); }
    for (const effort of Array.isArray(m.efforts) ? m.efforts : []) g.efforts.add(effort);
    const aliases = Array.isArray(m.aliasOf) ? m.aliasOf : (typeof m.aliasOf === 'string' ? [m.aliasOf] : []);
    for (const alias of aliases) g.aliases.add(alias);
    if (m.cost === 'free-local') g.cost = m.cost;
  }
  return [...grouped.values()].map((g) => ({ ...g, efforts: EFFORTS.filter((e) => g.efforts.has(e)).concat([...g.efforts].filter((e) => !EFFORTS.includes(e)).sort()), aliases: [...g.aliases] }));
}

function registrySelections(reg = getModels()) {
  return registryModels(reg).flatMap((m) => (m.efforts.length ? m.efforts : [null]).map((effort) => ({ provider: m.provider, model: m.model, effort, cost: m.cost, aliases: m.aliases, offeredEfforts: m.efforts })));
}

function allowed(s, cfg = loadConfig()) {
  return !isArchived(s.provider, s.model, cfg.scorecard);
}

function coverageFor(selection, offeredEfforts, runs) {
  const ids = new Set(); let newest = null;
  for (const chain of runs) for (const a of chain.attempts || []) {
    if (a.provider !== selection.provider || scorecardModelId(a.model) !== selection.model || !a.verdict || a.verdict === 'phantom') continue;
    if (offeredEfforts.length && (a.effort || null) !== selection.effort) continue;
    if (!BENCH_TASK_IDS.includes(a.smokeId)) continue;
    ids.add(a.smokeId);
    if (!newest || Date.parse(a.ts) > Date.parse(newest)) newest = a.ts;
  }
  return { ids, newest };
}

/** Every uncovered offered effort. Coverage requires 8/11 distinct, rated, non-voided smoke tasks. */
export function dueForBench({ days = loadConfig().scorecard.rebenchDays, reg = getModels(), runs = rootRuns({ source: 'smoke' }) } = {}) {
  const cfg = loadConfig(), cutoff = Date.now() - days * 86_400_000, due = [];
  for (const s of registrySelections(reg)) {
    if (!allowed(s, cfg)) continue;
    const coverage = coverageFor(s, s.offeredEfforts, runs);
    if (coverage.ids.size < BENCH_COVERAGE.rated) {
      due.push({ ...cloneSelection(s), covered: coverage.ids.size, remaining: BENCH_TASK_IDS.filter((id) => !coverage.ids.has(id)), why: coverage.ids.size ? `${coverage.ids.size}/${BENCH_COVERAGE.total} battery tasks rated` : 'never benchmarked' });
    } else if (coverage.newest && Date.parse(coverage.newest) < cutoff) {
      due.push({ ...cloneSelection(s), covered: coverage.ids.size, remaining: BENCH_TASK_IDS.filter((id) => !coverage.ids.has(id)), why: `last battery ${coverage.newest.slice(0, 10)}` });
    }
  }
  return sorted(due);
}

function aliasTargets(reg) {
  const out = {};
  for (const m of registryModels(reg)) for (const alias of m.aliases) out[`${m.provider}:${alias}`.toLowerCase()] = `${m.provider}:${m.model}`.toLowerCase();
  return out;
}

/**
 * Called after a registry refresh. The first usable registry is silently seeded; later exact selection/effort
 * additions and alias moves are returned once, persisted before any notice is logged, and optionally queued.
 */
export function noteNewModels(before, after) {
  const state = getBenchState(), stamp = nowIso();
  if (!state.seededAt) {
    const seed = before?.models?.length ? before : after;
    state.seen = registrySelections(seed).map(seenKey);
    state.aliases = aliasTargets(seed);
    state.seededAt = stamp;
    saveState(state);
    return [];
  }

  const seen = new Set(state.seen), all = registrySelections(after), fresh = [];
  for (const s of all) if (!seen.has(seenKey(s))) fresh.push(cloneSelection(s));
  const aliases = aliasTargets(after), movedTargets = new Set();
  for (const [alias, target] of Object.entries(aliases)) if (state.aliases[alias] && state.aliases[alias] !== target) movedTargets.add(target);
  if (!fresh.length && !movedTargets.size) return [];
  for (const s of all) if (movedTargets.has(modelKey(s))) fresh.push({ ...cloneSelection(s), aliasMoved: true });

  for (const s of all) seen.add(seenKey(s)); // excluded/covered listings are still remembered, so flaps stay silent
  state.seen = [...seen]; state.aliases = aliases;
  const due = new Set(dueForBench({ days: Infinity, reg: after }).map(seenKey));
  const candidates = sorted([...new Map(fresh.filter((s) => due.has(seenKey(s))).map((s) => [seenKey(s), s])).values()]);
  const listed = new Map(all.map((s) => [seenKey(s), s]));
  const cfg = loadConfig(), mode = cfg.bench.newModels, listingChange = candidates.length > 5;
  const automatic = candidates.filter((s) => mode === 'auto' && !listingChange && listed.get(seenKey(s))?.cost !== 'api');
  saveState(state);
  if (automatic.length) enqueueBench(automatic, { reg: after });
  if (candidates.length) logImprovement('idea', 'models', `new benchmark selection${candidates.length === 1 ? '' : 's'} listed: ${candidates.map(selId).join(', ')}${listingChange ? ' (listing change: approval required)' : ''}`);
  return candidates;
}

/** Add selections to durable provider lanes, cheapest effort first, without starting work. */
export function enqueueBench(selections, { reg = getModels(), taskIds = BENCH_TASK_IDS, probe = true, repeats = 1 } = {}) {
  const repeatTotal = repeatCount(repeats);
  const cfg = loadConfig(), state = getBenchState(), listed = new Map(registrySelections(reg).map((s) => [seenKey(s), s]));
  const attempts = rootRuns({ source: 'smoke' }), existing = new Set(Object.values(state.lanes).flatMap((lane) => (lane.queue || []).map((item) => seenKey(item.selection))));
  const additions = [];
  for (const requested of sorted(selections || [])) {
    const meta = listed.get(seenKey(requested));
    if (!meta || !allowed(meta, cfg) || existing.has(seenKey(meta))) continue;
    const coverage = coverageFor(cloneSelection(meta), meta.offeredEfforts, attempts);
    const requestedRemaining = Array.isArray(requested.remaining) ? requested.remaining : taskIds;
    const remaining = requestedRemaining.filter((id) => taskIds.includes(id) && !coverage.ids.has(id));
    if (!remaining.length) continue;
    additions.push({ meta, coverage, remaining }); existing.add(seenKey(meta));
  }
  const probedModels = new Set(Object.values(state.lanes).flatMap((lane) => (lane.queue || []).filter((item) => item.probePending).map((item) => modelKey(item.selection))));
  for (const chain of attempts) for (const a of chain.attempts || []) if (a.smokeId && a.verdict && a.verdict !== 'phantom') probedModels.add(modelKey(a));
  for (const { meta, coverage, remaining } of additions) {
    const lane = state.lanes[meta.provider] ||= { parkedUntil: null, running: null, queue: [] };
    const firstForModel = !probedModels.has(modelKey(meta));
    const probePending = probe && firstForModel && coverage.ids.size === 0 && remaining.includes('read-1');
    if (probePending) probedModels.add(modelKey(meta));
    lane.queue.push({ selection: cloneSelection(meta), remaining, repeats: repeatTotal, repeat: 0, probePending, probeFailed: false, queuedAt: nowIso(), lastError: null });
  }
  for (const lane of Object.values(state.lanes)) lane.queue.sort((a, b) => String(a.selection.model).localeCompare(String(b.selection.model)) || effortRank(a.selection.effort) - effortRank(b.selection.effort));
  if (additions.length) saveState(state);
  return getBenchState();
}

function defaultOpenTasks() { return openTasks(); }
async function defaultExecute(selection, task, { probe }) {
  const [result] = await runSmoke({ models: [selection], tasks: [task], timeoutMinutes: probe ? 3 : undefined });
  return result;
}

const clockMinutes = (clock) => {
  const match = /^(\d{2}):(\d{2})$/.exec(clock || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Whether a Date falls in a configured local wall-clock window. Equal endpoints cover the full day. */
export function isOffPeak(date, window = loadConfig().bench.offPeak) {
  if (!window) return true;
  if (window.weekends && (date.getDay() === 0 || date.getDay() === 6)) return true;
  const start = clockMinutes(window.start), end = clockMinutes(window.end);
  if (start == null || end == null) return true;
  if (start === end) return true;
  const minute = date.getHours() * 60 + date.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Next opening in local calendar time; Date construction keeps the wall clock stable across DST boundaries. */
export function nextOffPeakStart(date, window = loadConfig().bench.offPeak) {
  if (!window || isOffPeak(date, window)) return null;
  const start = clockMinutes(window.start);
  if (start == null) return null;
  const hour = Math.floor(start / 60), minute = start % 60, candidates = [];
  // Both offsets around a fall-back transition can represent the same wall time. Construct each valid instant
  // explicitly; the native local constructor remains the gap-normalizing fallback for a skipped spring time.
  for (const day of [0, 1]) {
    const anchor = new Date(date.getFullYear(), date.getMonth(), date.getDate() + day, 12);
    const y = anchor.getFullYear(), m = anchor.getMonth(), d = anchor.getDate();
    const offsets = new Set([-1, 0, 1].map((delta) => new Date(y, m, d + delta, 12).getTimezoneOffset()));
    for (const offset of offsets) {
      const candidate = new Date(Date.UTC(y, m, d, hour, minute) + offset * 60_000);
      if (candidate.getFullYear() === y && candidate.getMonth() === m && candidate.getDate() === d && candidate.getHours() === hour && candidate.getMinutes() === minute) candidates.push(candidate);
    }
    candidates.push(new Date(y, m, d, hour, minute, 0, 0));
    if (window.weekends && (anchor.getDay() === 0 || anchor.getDay() === 6)) candidates.push(new Date(y, m, d, 0, 0, 0, 0));
  }
  return candidates.filter((candidate) => candidate > date).sort((a, b) => a - b)[0] || null;
}

/** Earliest useful automatic wake, combining durable provider parking with the local off-peak window. */
export function nextBenchWakeAt(state, now = Date.now(), window = loadConfig().bench.offPeak) {
  return Math.min(...Object.values(state.lanes).map((lane) => {
    if (!lane.queue.length) return Infinity;
    const ready = lane.parkedUntil > now ? lane.parkedUntil : now;
    if (isOffPeak(new Date(ready), window)) return ready > now ? ready : Infinity;
    return nextOffPeakStart(new Date(ready), window)?.getTime() || Infinity;
  }));
}

/**
 * Drain all currently runnable lanes. Providers run in parallel; each provider runs one selection/task at a time.
 * A full/rejected provider is parked durably, live work wins, and every completed task is removed before returning.
 */
export async function runBenchQueue({ execute = defaultExecute, tasks = defaultOpenTasks, blockedUntil = modelBlockedUntil, now = () => Date.now(), reg = getModels(), onResult = null, respectOffPeak = false } = {}) {
  const state = getBenchState(), results = [], listed = new Map(registrySelections(reg).map((s) => [seenKey(s), s]));
  const persist = () => saveState(state);
  // If the process died after the smoke row landed but before bench.json advanced, fold that durable evidence first.
  const attempts = rootRuns({ source: 'smoke' }), listedModels = new Set([...listed.values()].map(modelKey));
  for (const lane of Object.values(state.lanes)) for (let i = lane.queue.length - 1; i >= 0; i--) {
    const item = lane.queue[i], meta = listed.get(seenKey(item.selection));
    // The model is listed but no longer offers this effort (an SDK update gave it effort levels): the item can never
    // run and would pause the lane ahead of its replacements. Its pending probe passes to the model's cheapest effort.
    if (!meta && listedModels.has(modelKey(item.selection))) {
      lane.queue.splice(i, 1);
      const heir = item.probePending && lane.queue.find((q) => modelKey(q.selection) === modelKey(item.selection) && q.remaining.includes('read-1'));
      if (heir) heir.probePending = true;
      continue;
    }
    if (!meta) continue;
    const done = coverageFor(item.selection, meta.offeredEfforts, attempts).ids;
    item.remaining = item.remaining.filter((id, index) => !done.has(id) || (index === 0 && item.repeat > 0));
    if (item.probePending && done.has('read-1')) item.probePending = false;
    if (lane.running && seenKey(lane.running.selection) === seenKey(item.selection) && done.has(lane.running.task)) lane.running = null;
    if (!item.remaining.length) lane.queue.splice(i, 1);
  }
  persist();
  const laneRuns = Object.entries(state.lanes).map(async ([provider, lane]) => {
    while (lane.queue.length) {
      const current = lane.queue[0], meta = listed.get(seenKey(current.selection));
      if (!meta) break; // a flapping/temporarily unavailable listing pauses durable work; it does not erase it
      if (!allowed(meta)) { lane.queue.shift(); lane.running = null; persist(); continue; }
      if (current.probeFailed) break;
      const open = tasks() || [];
      if (open.some((t) => t.source !== 'smoke' && ['queued', 'running'].includes(t.status))) break;
      if (open.some((t) => t.provider === provider && ['queued', 'running', 'parked'].includes(t.status))) break;
      const at = Number(now());
      if (lane.parkedUntil && lane.parkedUntil > at) break;
      lane.parkedUntil = null;
      const blocked = Number(blockedUntil(provider, current.selection.model)) || 0;
      if (blocked > at) { lane.parkedUntil = blocked; persist(); break; }
      if (respectOffPeak && !isOffPeak(new Date(at))) break;
      const task = current.remaining[0];
      if (!task) { lane.queue.shift(); lane.running = null; persist(); continue; }
      const repeat = current.repeat || 0, repeatTotal = current.repeats || 1;
      const probe = current.probePending && task === 'read-1' && repeat === 0;
      lane.running = { selection: current.selection, task, probe, repeat: repeat + 1, repeats: repeatTotal, startedAt: nowIso() };
      persist();
      let result;
      try { result = await execute(current.selection, task, { probe, repeat: repeat + 1, repeats: repeatTotal }); }
      catch (e) { current.lastError = String(e?.message || e); lane.running = null; persist(); throw e; }
      const row = { ...result, provider, model: current.selection.model, effort: current.selection.effort, task, probe };
      results.push(row); lane.running = null;
      if (['pass', 'fail', 'fixable'].includes(row.verdict)) {
        current.lastError = null;
        if (repeat + 1 < repeatTotal) current.repeat = repeat + 1;
        else { current.repeat = 0; current.remaining.shift(); }
        if (probe) { current.probePending = false; if (row.verdict !== 'pass') current.probeFailed = true; }
        if (!current.remaining.length) lane.queue.shift();
      } else {
        current.lastError = String(row.notes || row.verdict || 'benchmark did not complete');
        const retryAt = Number(blockedUntil(provider, current.selection.model)) || 0;
        if (retryAt > Number(now())) lane.parkedUntil = retryAt;
      }
      persist();
      onResult?.(row);
      if (!['pass', 'fail', 'fixable'].includes(row.verdict) || current.probeFailed) break;
    }
  });
  await Promise.all(laneRuns);
  return { results, state: getBenchState() };
}

let queueEnabled = false, queueRun = null, queueWake = null, queueAgain = false;
/** Server lifecycle hook: resume durable work now, then again at its earliest provider reset. */
export function startBenchQueue() { queueEnabled = true; wakeBenchQueue(); }
export function stopBenchQueue() { queueEnabled = false; queueAgain = false; clearTimeout(queueWake); queueWake = null; }
export function wakeBenchQueue() {
  if (!queueEnabled || process.env.CONDUCTOR_NO_SCHEDULE) return queueRun;
  if (queueRun) { queueAgain = true; return queueRun; }
  if (!Object.values(getBenchState().lanes).some((lane) => lane.queue.length)) return null;
  clearTimeout(queueWake); queueWake = null;
  queueRun = runBenchQueue({ respectOffPeak: true }).catch((e) => {
    try { logImprovement('error', 'bench', `bench queue paused: ${e?.message || e}`); } catch {}
  }).finally(() => {
    queueRun = null;
    if (!queueEnabled) return;
    if (queueAgain) { queueAgain = false; queueMicrotask(wakeBenchQueue); return; }
    const now = Date.now(), next = nextBenchWakeAt(getBenchState(), now);
    if (Number.isFinite(next)) { queueWake = setTimeout(wakeBenchQueue, Math.min(2 ** 31 - 1, next - now)); queueWake.unref?.(); }
  });
  return queueRun;
}

/** Explicit CLI/manual runner: queue the current due set, then drain whatever is runnable. */
export async function runBench({ days, repeats = 1, onResult = null } = {}) {
  const repeatTotal = repeatCount(repeats);
  const due = dueForBench({ days });
  enqueueBench(due, { repeats: repeatTotal });
  const { results } = await runBenchQueue({ onResult });
  const bySelection = new Map();
  for (const r of results) {
    const key = selId(r), x = bySelection.get(key) || { provider: r.provider, model: r.model, effort: r.effort, probe: null, pass: 0, total: 0, notes: '' };
    if (r.probe) x.probe = r.verdict;
    x.total++; if (r.verdict === 'pass') x.pass++; if (r.notes) x.notes = r.notes;
    bySelection.set(key, x);
  }
  return [...bySelection.values()].map((x) => ({ ...x, probe: x.probe || 'none', battery: `${x.pass}/${x.total}` }));
}

export function formatBench(due, { cfg = loadConfig(), now = new Date() } = {}) {
  const lines = due.length
    ? [`${due.length} selection(s) due for a battery:`, ...due.map((d) => `- ${selId(d)} — ${d.why}`)]
    : [`Every listed selection meets the ${BENCH_COVERAGE.rated}/${BENCH_COVERAGE.total} battery coverage bar.`];
  if (cfg.bench.newModels === 'auto' && cfg.bench.offPeak && !isOffPeak(now, cfg.bench.offPeak)) {
    lines.push(`auto-bench waits for off-peak (${cfg.bench.offPeak.start}${cfg.bench.offPeak.weekends ? '; weekends included' : ''})`);
  }
  return lines.join('\n');
}
