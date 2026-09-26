// Worker CLI updates. Each subscription CLI has a recipe: its current version (`--version`), the latest STABLE release,
// and how to install an exact version. A daily check records "update available X → Y"; providers.<id>.cliUpdate decides
// the rest: 'off' (never checks), 'notify' (shows it), 'auto' (installs it once the provider is idle). Every install is
// verified (version, sign-in, one tiny real task) and rolled back to the previous version on any failure.
// Claude runs on the Agent SDK in package.json: checked here, bumped only in a dev checkout (git + its own .state), and
// reaches other instances as a release. The global Claude Code CLI only opens sign-in terminals, so it is not tracked.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readJson, writeJson, appendNdjson, statePath, nowIso, resolveStateDir } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { bus } from './bus.mjs';
import { logImprovement } from './improve.mjs';
import { codexCommand, findCli } from './proc.mjs';
import { VENDORS, capture } from './providers/vendors.mjs';
import { npmCommand } from './update.mjs';

const WIN = process.platform === 'win32';
const DAY = 86_400_000;
const SDK = '@anthropic-ai/claude-agent-sdk';
const AGY_MANIFEST = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'; // agy's install script reads <platform>.json: { version, url, sha512 }

// --- versions -----------------------------------------------------------------------------------------------------
export const parseVersion = (text) => /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(String(text || ''))?.[0] || null;
export const isStable = (v) => /^\d+\.\d+\.\d+$/.test(v || '');
const core = (v) => String(v).split('-')[0].split('.').map(Number);
export function cmpVersion(a, b) { const x = core(a), y = core(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }
/** A stable `latest` newer than `current`; pre-releases never count. */
export const isNewer = (current, latest) => !!parseVersion(current) && isStable(latest) && cmpVersion(latest, current) > 0;

// --- how commands run (every one goes through `x`, which tests replace) ------------------------------------------------
function run(cmd, args, { cwd, timeoutMs = 120_000, shell = false } = {}) {
  if (!shell) return capture(cmd, args, { cwd, timeoutMs }); // npm shims unwrapped, no shell
  return new Promise((resolve) => execFile(cmd, args, { cwd, shell: true, windowsHide: true, timeout: timeoutMs, maxBuffer: 4e6, encoding: 'utf8' }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${so || ''}${se || ''}` })));
}
async function signedIn(id) {
  const { PROVIDERS } = await import('./providers/index.mjs');
  const p = PROVIDERS[id];
  if (p.account) return !!(await p.account()).loggedIn;
  const d = await p.detect();
  return d.installed !== false && d.loggedIn !== false;
}
/** One tiny real task (the smoke battery's read-1) on the provider's default model. A limit skip is not a failure. */
async function smokeProbe(id) {
  const { getModels } = await import('./models.mjs');
  const ms = getModels().models.filter((m) => m.provider === id && m.kind === 'agent');
  const m = ms.find((x) => x.isDefault) || ms[0];
  if (!m) return { ok: false, notes: 'no model listed for the test call' };
  const { runSmoke } = await import('./smoke/index.mjs');
  const [r] = await runSmoke({ models: [{ provider: id, model: m.id, effort: m.efforts?.includes('low') ? 'low' : null }], tasks: ['read-1'], timeoutMinutes: 5, sessionId: 'cli-update' });
  return { ok: r?.verdict === 'pass' || (r?.verdict === 'skipped' && /limit/i.test(r.notes || '')), notes: `read-1 on ${m.id}: ${r?.verdict || 'none'}${r?.notes ? ` (${r.notes.slice(0, 160)})` : ''}` };
}
/** Idle = no queued, running or parked task and no conductor chat mid-turn on this provider (Windows locks a running binary). */
export async function providerBusy(id) {
  const { openTasks } = await import('./tasks.mjs');
  const { listSessions } = await import('./conductor.mjs');
  const tasks = openTasks().filter((t) => t.provider === id).length;
  const chats = listSessions().filter((s) => s.provider === id && s.status === 'running').length;
  return tasks || chats ? `${tasks} open task(s), ${chats} chat(s) mid-turn` : null;
}
async function hold(id, on) { const { heldProviders } = await import('./tasks.mjs'); if (on) heldProviders.add(id); else heldProviders.delete(id); }

export const EXEC = {
  run,
  npm: (args, o = {}) => { const n = npmCommand(); return n ? run(n.command, [...n.args, ...args], { ...o, shell: n.shell }) : { code: 1, out: 'npm not found' }; },
  fetchJson: async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); },
  copy: copyFileSync,
  sdkVersion: () => readJson(join(REPO_ROOT, 'node_modules', ...SDK.split('/'), 'package.json'), {})?.version || null,
  devCheckout: () => existsSync(join(REPO_ROOT, '.git')) && resolveStateDir() === join(REPO_ROOT, '.state'),
  bin: (id) => { if (id === 'codex') return codexCommand(); const b = VENDORS[id]?.bin(); return b ? { command: b, args: [] } : null; },
  signedIn, smoke: smokeProbe, busy: providerBusy, hold,
  refresh: (id) => import('./models.mjs').then((m) => m.refreshModels({ only: [id] })),
};

// --- recipes: version / latest / apply / rollback per provider ---------------------------------------------------------------
const cliVersion = (id) => async (x) => { const c = x.bin(id); return c ? parseVersion((await x.run(c.command, [...c.args, '--version'], { timeoutMs: 30_000 })).out) : null; };
const binOf = (x, id) => { const c = x.bin(id); if (!c) throw new Error(`${id} CLI not found`); return c.command; };
const npmLatest = (pkg) => async (x) => (await x.npm(['view', pkg, 'version'], { timeoutMs: 60_000 })).out.split('\n').map((l) => l.trim()).filter((l) => parseVersion(l) === l).pop() || null;
const npmGlobal = (pkg) => (x, v) => x.npm(['i', '-g', `${pkg}@${v}`], { timeoutMs: 600_000 });
/** kimi installs with `pip install --user` into a PythonXY Scripts folder; update with that same Python. */
function kimiPip(x) {
  const bin = x.bin('kimi')?.command || '';
  if (!WIN) return { command: 'python3', args: ['-m', 'pip'] };
  const m = /[\\/]Python3(\d+)[\\/]Scripts[\\/]/i.exec(bin); const py = findCli('py');
  return m && py ? { command: py, args: [`-3.${m[1]}`, '-m', 'pip'] } : null;
}
const pipInstall = (x, v) => { const p = kimiPip(x); return p ? x.run(p.command, [...p.args, 'install', '--user', '--disable-pip-version-check', `kimi-cli==${v}`], { timeoutMs: 600_000 }) : { code: 1, out: 'no pip for kimi' }; };
const agyPlatform = () => `${WIN ? 'windows' : process.platform}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;

export const RECIPES = {
  codex: {
    version: cliVersion('codex'),
    latest: npmLatest('@openai/codex'),
    manual: (x) => { const c = x.bin('codex'); return c && ![c.command, ...c.args].some((s) => /node_modules[\\/]@openai[\\/]codex/.test(s)) ? 'this codex was not installed with npm: update it with the app that installed it' : null; },
    apply: npmGlobal('@openai/codex'), rollback: npmGlobal('@openai/codex'),
  },
  'qwen-code': { version: cliVersion('qwen-code'), latest: npmLatest('@qwen-code/qwen-code'), apply: npmGlobal('@qwen-code/qwen-code'), rollback: npmGlobal('@qwen-code/qwen-code') },
  grok: {
    version: cliVersion('grok'),
    // `grok update --check --json` (grok 1.0.30): {"currentVersion","latestVersion","channel":"stable",...}; --version <v> installs an exact release.
    latest: async (x) => { const line = (await x.run(binOf(x, 'grok'), ['update', '--check', '--json'], { timeoutMs: 60_000 })).out.split('\n').find((l) => l.trim().startsWith('{')); return line ? JSON.parse(line).latestVersion || null : null; },
    apply: (x, v) => x.run(binOf(x, 'grok'), ['update', '--version', v], { timeoutMs: 600_000 }),
    rollback: (x, v) => x.run(binOf(x, 'grok'), ['update', '--version', v], { timeoutMs: 600_000 }),
  },
  antigravity: {
    version: cliVersion('antigravity'),
    latest: async (x) => (await x.fetchJson(`${AGY_MANIFEST}/${agyPlatform()}.json`))?.version || null,
    // `agy update` takes no version, so the previous binary is kept beside it and copied back on a failed verify.
    apply: async (x) => { const b = binOf(x, 'antigravity'); x.copy(b, `${b}.prev`); return x.run(b, ['update'], { timeoutMs: 600_000 }); },
    rollback: async (x) => { const b = binOf(x, 'antigravity'); x.copy(`${b}.prev`, b); return { code: 0, out: `restored ${b}.prev` }; },
  },
  kimi: {
    version: cliVersion('kimi'),
    latest: async (x) => (await x.fetchJson('https://pypi.org/pypi/kimi-cli/json'))?.info?.version || null,
    manual: (x) => (kimiPip(x) ? null : 'kimi was not installed with pip --user under a PythonXY folder: update it the way it was installed'),
    apply: pipInstall, rollback: pipInstall,
  },
  claude: {
    version: async (x) => parseVersion(x.sdkVersion()),
    latest: npmLatest(SDK),
    manual: (x) => (x.devCheckout() ? null : 'release it through dev'),
    noAuto: true, // a dependency bump is reviewed and released, never installed behind the user's back
    apply: (x, v) => x.npm(['i', `${SDK}@${v}`], { cwd: REPO_ROOT, timeoutMs: 600_000 }),
    rollback: (x, v) => x.npm(['i', `${SDK}@${v}`], { cwd: REPO_ROOT, timeoutMs: 600_000 }),
    // The running server keeps the SDK it loaded; the suite is the check. The change stays uncommitted for review.
    verify: async (x) => { const r = await x.npm(['test'], { cwd: REPO_ROOT, timeoutMs: 1_800_000 }); return r.code === 0 ? null : `npm test failed: ${r.out.trim().slice(-300)}`; },
  },
};
export const CLI_UPDATE_IDS = Object.keys(RECIPES);

// --- state: <state>/cli-updates.json, history in cli-updates.ndjson ------------------------------------------------------
const FILE = () => statePath('cli-updates.json');
let state = readJson(FILE(), null) || { checkedAt: 0, providers: {} };
const save = () => { try { writeJson(FILE(), state); } catch {} bus.publish('cli-update', { checkedAt: state.checkedAt }); };
const entry = (id) => (state.providers[id] ||= {});
export const modeOf = (id, cfg = loadConfig()) => cfg.providers?.[id]?.cliUpdate || 'notify';

/** The cached `--version` of a provider's CLI (the SDK version for claude); never probed per task. */
export const cliVersionOf = (id) => state.providers[id]?.current || null;
export function cliUpdateStatus() {
  const cfg = loadConfig();
  return { checkedAt: state.checkedAt || null, providers: Object.fromEntries(CLI_UPDATE_IDS.map((id) => [id, { ...state.providers[id], mode: modeOf(id, cfg) }])) };
}

/** Current version always; the latest stable one unless the mode is 'off' (a manual check ignores the mode). */
export async function checkCliUpdate(id, { x = EXEC, manual = false } = {}) {
  const r = RECIPES[id];
  if (!r) throw Object.assign(new Error(`no CLI update recipe for "${id}". Known: ${CLI_UPDATE_IDS.join(', ')}`), { status: 400 });
  const out = { current: null, latest: null, available: false, note: null, error: null, at: nowIso() };
  try { out.current = await r.version(x); } catch (e) { out.error = String(e?.message || e); }
  if (!out.current) out.error ||= 'not installed';
  else if (manual || modeOf(id) !== 'off') {
    try { const l = parseVersion(await r.latest(x)); if (isStable(l)) out.latest = l; else out.error = `no stable release found${l ? ` (latest is ${l})` : ''}`; } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
    out.available = isNewer(out.current, out.latest);
    if (out.available) out.note = r.manual?.(x) || null;
  }
  Object.assign(entry(id), out);
  save();
  return { id, ...entry(id), mode: modeOf(id) };
}

const tail = (s) => String(s || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
async function verify(id, r, x, to) {
  const now = await r.version(x).catch(() => null);
  if (now !== to) return `--version shows ${now || 'nothing'}, expected ${to}`;
  if (r.verify) return r.verify(x);
  if (!(await x.signedIn(id).catch(() => false))) return 'the sign-in probe failed after the update';
  const s = await x.smoke(id).catch((e) => ({ ok: false, notes: String(e?.message || e) }));
  return s.ok ? null : `the test call failed: ${s.notes}`;
}

const applying = new Set();
/**
 * Install the latest stable version when the provider is idle, verify it, and roll back to the previous exact version on
 * any failure. Always resolves to { id, applied, from, to, reason|error, rolledBack } and records it as `last`.
 */
export async function applyCliUpdate(id, { x = EXEC } = {}) {
  if (applying.has(id)) return { id, applied: false, reason: 'an update is already running' };
  applying.add(id); entry(id).applying = true;
  let res;
  try {
    const st = await checkCliUpdate(id, { x, manual: true });
    const r = RECIPES[id];
    const busy = st.available && !st.note ? await x.busy(id) : null;
    if (!st.available) res = { applied: false, from: st.current, reason: st.error || `up to date (${st.current})` };
    else if (st.note) res = { applied: false, from: st.current, to: st.latest, reason: `update available ${st.current} → ${st.latest} — ${st.note}` };
    else if (busy) res = { applied: false, from: st.current, to: st.latest, reason: `waiting: ${busy}` };
    else {
      const from = st.current, to = st.latest;
      await x.hold(id, true); // queued tasks of this provider wait; only the verify task runs
      try {
        const inst = await r.apply(x, to);
        const fail = inst.code !== 0 ? `install failed: ${tail(inst.out)}` : await verify(id, r, x, to);
        if (!fail) res = { applied: true, from, to };
        else {
          const back = await r.rollback(x, from).catch((e) => ({ code: 1, out: String(e?.message || e) }));
          const now = await r.version(x).catch(() => null);
          res = { applied: false, from, to, error: fail, rolledBack: now === from, rollback: back.code === 0 ? `reinstalled ${from}` : `rollback failed: ${tail(back.out)}` };
          logImprovement('error', `cli-update:${id}`, `${id} ${from} → ${to} failed and was rolled back${now === from ? '' : ` INCOMPLETELY (now ${now || 'missing'})`}: ${fail}`, { from, to, now, rollback: res.rollback });
        }
        entry(id).current = (await r.version(x).catch(() => null)) || entry(id).current;
        entry(id).available = isNewer(entry(id).current, entry(id).latest);
        appendNdjson(statePath('cli-updates.ndjson'), { ts: nowIso(), id, ...res });
      } finally { await x.hold(id, false); }
      if (res.applied) Promise.resolve().then(() => x.refresh(id)).catch(() => {}); // the registry re-probes the new binary
    }
  } catch (e) { res = { applied: false, error: String(e?.message || e) }; }
  finally { applying.delete(id); entry(id).applying = false; }
  entry(id).last = { ...res, at: nowIso() };
  if (res.applied === false && res.error) entry(id).failedTo = res.to || null; else if (res.applied) entry(id).failedTo = null;
  save();
  return { id, ...res };
}

let running = null;
/**
 * The daily check, driven by the server's model re-probe timer. Due once a day: every CLI's version and latest release.
 * Every call: 'auto' providers with an update install it once idle (a version that failed verification is not retried).
 * The first call in a process refreshes the cached versions, so run rows carry the version actually installed.
 */
let fresh = false;
export function dailyCheck({ x = EXEC, now = Date.now() } = {}) {
  if ((process.env.CONDUCTOR_NO_POLL && x === EXEC) || running) return running; // tests pass a stubbed x

  running = (async () => {
    const due = now - (state.checkedAt || 0) >= DAY;
    if (due || !fresh) {
      await Promise.all(CLI_UPDATE_IDS.map((id) => (due ? checkCliUpdate(id, { x }) : RECIPES[id].version(x).then((v) => { entry(id).current = v; })).catch(() => {})));
      fresh = true; if (due) state.checkedAt = now;
      save();
    }
    for (const id of CLI_UPDATE_IDS) {
      const e = state.providers[id] || {};
      if (modeOf(id) !== 'auto' || RECIPES[id].noAuto || !e.available || e.note || e.failedTo === e.latest) continue;
      if (await x.busy(id)) continue;
      await applyCliUpdate(id, { x });
    }
  })().catch(() => {}).finally(() => { running = null; });
  return running;
}

/** Test hook: forget the cached state. */
export function resetCliUpdateState(next = { checkedAt: 0, providers: {} }) { state = next; fresh = false; }

/** One line for `conductor cli-update --check` (a status) or after an apply (a result). */
export function formatCliUpdate(s) {
  if ('applied' in s) return `${s.id.padEnd(12)} ${s.applied ? `updated ${s.from} → ${s.to}` : s.error ? `FAILED ${s.from || '?'} → ${s.to || '?'}: ${s.error}${s.rollback ? ` (${s.rollback})` : ''}` : s.reason}`;
  return `${s.id.padEnd(12)} ${String(s.current || '-').padEnd(10)} ${s.available ? `update available ${s.current} → ${s.latest}${s.note ? ` — ${s.note}` : ''}` : s.error || `up to date${s.latest ? ` (latest ${s.latest})` : ''}`}  [${s.mode}]`;
}
