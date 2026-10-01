// Generic runner for vendor agent CLIs that run on a consumer subscription (Antigravity `agy`,
// xAI `grok`). Each vendor is a spec in core/providers/vendors.mjs that
// says how to invoke headless mode and how to fold its NDJSON/text output into the common result.
import { killTree, onLines, spawnCli, findCli, registerProc } from '../proc.mjs';
import { bus } from '../bus.mjs';
import { logImprovement } from '../improve.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFileP = promisify(execFile);
const LIMIT_RE = /rate[_ -]?limit|quota (?:exceeded|exhausted|reached)|usage limit|too many requests|\b429\b|resource[_ ]exhausted|plan limit|insufficient (?:credits|quota|balance)|balance exhausted|payment required/i; // grok: 402 "Grok Build usage balance exhausted"
const AUTH_RE = /not (?:signed in|authenticated|logged in)|please (?:sign|log) in|\bunauthorized\b|authentication (?:required|failed)/i; // \b: UnauthorizedAccessException is a sandbox denial, not a sign-in

/**
 * @param {object} spec  vendor spec (see vendors.mjs): { id, bin(), headlessArgs(t) → { args, threadId?, cleanup?, stdinPrompt? }, stdinPrompt?, parse(obj, st, emit), parseText?(line, st, emit), env?, readOnlyViaSnapshot? }
 * @param {object} t     { id, cwd, prompt, model, effort, resumeThreadId, signal, timeoutMs, sandbox? }
 */
const TRANSIENT_RE = /stream was interrupted|please continue the task|connection reset|temporarily unavailable|\b5\d\d\b.*(?:gateway|unavailable)/i;

async function execGit(gitBin, args, cwd) {
  const { stdout } = await execFileP(gitBin, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** `git status --porcelain --untracked-files=all` (nested untracked listed individually). */
async function gitStatusAll(gitBin, cwd) {
  const status = await execGit(gitBin, ['status', '--porcelain', '--untracked-files=all'], cwd);
  return status.split(/\r?\n/).filter((l) => l.length >= 3).map((l) => {
    const file = l.slice(3).trim();
    return { line: l, file: file.includes(' -> ') ? file.split(' -> ')[1].trim() : file };
  });
}

function appendReportLine(res, line) {
  if (!res) return;
  res.finalMessage = res.finalMessage ? `${res.finalMessage.trim()}\n${line}` : line;
}

async function runVendorCliSnapshot(spec, t) {
  const cwd = resolve(t.cwd || '.');
  const gitBin = findCli('git');
  if (!gitBin) return runVendorCliCore(spec, t);

  let gitRoot, prefix = '';
  try {
    const out = (await execGit(gitBin, ['rev-parse', '--show-toplevel', '--show-prefix'], cwd)).trim();
    const lines = out.split(/\r?\n/);
    gitRoot = lines[0]?.trim();
    prefix = lines[1]?.trim() || '';
  } catch {
    return runVendorCliCore(spec, t);
  }
  if (!gitRoot) return runVendorCliCore(spec, t);

  let sha;
  try {
    const stashOut = (await execGit(gitBin, ['stash', 'create'], gitRoot)).trim();
    sha = stashOut || 'HEAD';
  } catch {
    return runVendorCliCore(spec, t);
  }

  const snapshotDir = join(tmpdir(), `conductor-snapshot-${t.id || randomUUID()}-${Date.now()}`);
  try {
    await execGit(gitBin, ['worktree', 'add', '--detach', snapshotDir, sha], gitRoot);
  } catch {
    return runVendorCliCore(spec, t);
  }

  const workerCwd = prefix ? join(snapshotDir, prefix) : snapshotDir;
  const preamble = `This is a disposable snapshot of the project. Use project-relative paths. Nothing may be written outside the snapshot.\n\n`;
  const prompt = `${preamble}${t.prompt || ''}`;
  const snapshotTask = { ...t, cwd: workerCwd, sandbox: undefined, prompt, writableRoots: [] };

  let beforeOriginal;
  try { beforeOriginal = new Set((await gitStatusAll(gitBin, gitRoot)).map((e) => e.line)); } catch {}

  let res;
  try {
    res = await runVendorCliCore(spec, snapshotTask);
  } finally {
    try {
      if (existsSync(snapshotDir)) {
        const strayFiles = [...new Set((await gitStatusAll(gitBin, snapshotDir)).map((e) => e.file))];
        if (strayFiles.length) appendReportLine(res, `Stray files in snapshot: ${strayFiles.join(', ')}`);
      }
    } catch {}
    try {
      if (beforeOriginal) {
        const leaked = [...new Set((await gitStatusAll(gitBin, gitRoot)).filter((e) => !beforeOriginal.has(e.line)).map((e) => e.file))];
        if (leaked.length) appendReportLine(res, `Stray writes to the project during a read-only run: ${leaked.join(', ')}`);
      }
    } catch {}
    try {
      await execGit(gitBin, ['worktree', 'remove', '--force', snapshotDir], gitRoot);
    } catch {
      try { rmSync(snapshotDir, { recursive: true, force: true }); } catch {}
      try { await execGit(gitBin, ['worktree', 'prune'], gitRoot); } catch {}
    }
  }
  if (res?.items) res.items = res.items.filter((i) => i.type !== 'file_change');
  return res;
}

/** Runs the CLI once; a transient stream break on a resumable thread is continued once automatically. */
async function runVendorCliCore(spec, t) {
  const first = await runVendorCliOnce(spec, t);
  if (first.ok || !first.threadId || t.resumeThreadId || !TRANSIENT_RE.test(first.error || '')) return first;
  const again = await runVendorCliOnce(spec, { ...t, resumeThreadId: first.threadId, prompt: 'Continue the task you were working on; the stream was interrupted. Finish it and report as instructed.' });
  again.items = [...first.items, ...again.items];
  again.durationMs = (first.durationMs || 0) + (again.durationMs || 0);
  again.usage = sumUsage(first.usage, again.usage);
  again.turns = (first.turns || 0) + (again.turns || 0);
  again.timedOut = !!(first.timedOut || again.timedOut);
  again.httpStatus ||= first.httpStatus || null;
  return again;
}

export async function runVendorCli(spec, t) {
  if (spec.readOnlyViaSnapshot && t.sandbox === 'read-only') {
    return runVendorCliSnapshot(spec, t);
  }
  return runVendorCliCore(spec, t);
}

function sumUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = (Number(out[k]) || 0) + v;
    else if (!(k in out)) out[k] = v;
  }
  return out;
}

function runVendorCliOnce(spec, t) {
  const started = Date.now();
  const res = { ok: false, provider: spec.id, threadId: t.resumeThreadId || null, finalMessage: '', items: [], usage: null, error: null, limitHit: false, authFailed: false, envFailed: false, exitCode: null, stderr: '', turns: 0, timedOut: false, httpStatus: null };
  const st = { spec, cwd: t.cwd, threadId: t.resumeThreadId || null, text: '', finalText: null, usage: null, error: null, httpStatus: null, envFailed: false, items: [], unknown: 0, turns: 0 };
  const emit = (event, data) => { bus.publish('worker', { taskId: t.id, provider: spec.id, event, ...data }); t.onEvent?.(event, data); };
  return new Promise((resolve) => {
    const bin = spec.bin();
    if (!bin) { res.error = `${spec.label || spec.id} CLI not found${spec.install ? ` (install: ${spec.install.win || spec.install.posix})` : ''}`; return resolve(res); }
    const ha = spec.headlessArgs(t);
    const { args, threadId, cleanup } = ha;
    const useStdin = !!(spec.stdinPrompt || ha.stdinPrompt);
    if (threadId) st.threadId = threadId; // some CLIs let us mint the session id up front
    let child;
    try { child = registerProc(t.id, spawnCli(bin, args, { cwd: t.cwd, windowsHide: true, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, ...(spec.env?.() || {}) } })); }
    catch (e) { try { cleanup?.(); } catch {} res.error = e.message; return resolve(res); }
    emit('thread', { threadId: st.threadId });
    onLines(child.stdout, (line) => {
      let obj = null; try { obj = JSON.parse(line); } catch {}
      try {
        if (obj) {
          const before = [st.error, st.items.length, st.text.length];
          spec.parse(obj, st, emit);
          // Unrecognised JSON can be text rather than a run failure.
          if (spec.parseText && st.error === before[0] && st.items.length === before[1] && st.text.length === before[2]) spec.parseText(line, st, emit);
        } else spec.parseText?.(line, st, emit);
      } catch (e) { st.unknown++; }
    });
    onLines(child.stderr, (line) => { res.stderr = (res.stderr + line + '\n').slice(-4000); if (!st.error && (LIMIT_RE.test(line) || AUTH_RE.test(line))) st.errorHint = line; });
    const timer = t.timeoutMs ? setTimeout(() => { res.timedOut = true; st.error = st.error || `timeout after ${Math.round(t.timeoutMs / 1000)}s`; killTree(child); }, t.timeoutMs) : null;
    const onAbort = () => { st.error = st.error || 'aborted'; killTree(child); };
    t.signal?.addEventListener('abort', onAbort, { once: true });
    if (t.signal?.aborted) onAbort();
    child.on('error', (e) => { st.error = st.error || e.message; });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      t.signal?.removeEventListener('abort', onAbort);
      try { cleanup?.(); } catch {} // e.g. remove a temp prompt-file written for a long prompt
      try { spec.onClose?.(st, emit); } catch {}
      res.exitCode = code;
      res.threadId = st.threadId || res.threadId;
      res.finalMessage = st.finalText ?? st.text ?? '';
      res.usage = st.usage;
      res.servedModel = st.servedModel || null;
      res.items = st.items.slice(-60);
      res.turns = Number.isInteger(st.turns) ? st.turns : 0;
      res.httpStatus = Number.isInteger(st.httpStatus) ? st.httpStatus : null;
      res.error = st.error || (code !== 0 ? `${spec.id} exited with code ${code}${res.stderr ? `: ${res.stderr.trim().slice(-400)}` : ''}` : null);
      if (!res.error && code === 0 && !res.finalMessage && !st.items.length) res.error = `${spec.id} produced no output (exit 0)`;
      const haystack = `${res.error || ''}\n${st.errorHint || ''}\n${res.stderr}`;
      // Prefer a structured HTTP status; use text patterns when the CLI gives none.
      const s = st.httpStatus;
      if (!res.error) { res.limitHit = false; res.authFailed = false; }
      else if (s) { res.limitHit = s === 402 || s === 429; res.authFailed = s === 401 || s === 403; }
      else {
        res.limitHit = LIMIT_RE.test(haystack);
        res.authFailed = !res.limitHit && AUTH_RE.test(haystack);
        if (res.limitHit || res.authFailed) try { logImprovement('friction', `worker:${spec.id}`, `${res.limitHit ? 'limit' : 'sign-in'} failure recognised from text: ${spec.id} gave no structured status`, { taskId: t.id, error: String(res.error).slice(0, 200) }); } catch {}
      }
      res.envFailed = !!res.error && !!st.envFailed;
      if (res.authFailed && res.error) res.error += ` — sign in with: ${spec.loginHint || spec.id}`;
      res.ok = !res.error;
      res.durationMs = Date.now() - started;
      resolve(res);
    });
    if (useStdin) { child.stdin.on('error', () => {}); child.stdin.end(t.prompt); }
  });
}

/** Helpers shared by vendor parsers. */
export const vendorParse = {
  addUsage(st, u, { input = 'input_tokens', output = 'output_tokens', cached = 'cache_read_tokens', thinking = 'thinking_tokens' } = {}) {
    if (!u) return;
    st.usage = st.usage || { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0, ...(st.spec?.usageInputExclusive ? { exclusive: true } : {}) };
    st.usage.input_tokens += Number(u[input]) || 0;
    st.usage.output_tokens += Number(u[output]) || 0;
    st.usage.cached_input_tokens += Number(u[cached]) || 0;
    st.usage.reasoning_output_tokens += Number(u[thinking]) || 0;
  },
  message(st, emit, text) { if (!text) return; st.items.push({ type: 'agent_message', text }); emit('item', { item: { type: 'agent_message', text }, phase: 'completed' }); },
  toolStart(st, emit, id, name, input) { st.items.push({ type: 'tool_use', id, name, input }); emit('item', { item: { id, type: 'tool_use', name, input: JSON.stringify(input || {}).slice(0, 300), args: input }, phase: 'started' }); },
  toolDone(st, emit, id, name, output, isError = false) { emit('tool_result', { toolUseId: id, name, isError, text: String(output ?? 'done').slice(0, 4000) }); },
};
