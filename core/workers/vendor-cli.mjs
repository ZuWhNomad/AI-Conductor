// Generic runner for vendor agent CLIs that run on a consumer subscription (Antigravity `agy`,
// xAI `grok`, Qwen Code, Kimi CLI, ...). Each vendor is a spec in core/providers/vendors.mjs that
// says how to invoke headless mode and how to fold its NDJSON/text output into the common result.
import { killTree, onLines, spawnCli } from '../proc.mjs';
import { bus } from '../bus.mjs';

const LIMIT_RE = /rate[_ -]?limit|quota (?:exceeded|exhausted|reached)|usage limit|too many requests|\b429\b|resource[_ ]exhausted|plan limit|insufficient (?:credits|quota|balance)/i;
const AUTH_RE = /not (?:signed in|authenticated|logged in)|please (?:sign|log) in|unauthorized|authentication (?:required|failed)/i;
// Quota-only stdout: phrases that appear in a provider quota/limit refusal, not bare "429" or "rate limit".
const QUOTA_MSG_RE = /(?:monthly|daily) usage limit|usage limit (?:reached|exceeded)|quota (?:exceeded|exhausted|reached)|insufficient (?:quota|balance)|rate[_ -]?limit (?:reached|exceeded)|too many requests/i;

/**
 * @param {object} spec  vendor spec (see vendors.mjs): { id, bin(), headlessArgs(t) → { args, threadId?, cleanup?, stdinPrompt? }, stdinPrompt?, parse(obj, st, emit), parseText?(line, st, emit), env? }
 * @param {object} t     { id, cwd, prompt, model, effort, resumeThreadId, signal, timeoutMs }
 */
const TRANSIENT_RE = /stream was interrupted|please continue the task|connection reset|temporarily unavailable|\b5\d\d\b.*(?:gateway|unavailable)/i;

/** Runs the CLI once; a transient stream break on a resumable thread is continued once automatically. */
export async function runVendorCli(spec, t) {
  const first = await runVendorCliOnce(spec, t);
  if (first.ok || !first.threadId || t.resumeThreadId || !TRANSIENT_RE.test(first.error || '')) return first;
  const again = await runVendorCliOnce(spec, { ...t, resumeThreadId: first.threadId, prompt: 'Continue the task you were working on; the stream was interrupted. Finish it and report as instructed.' });
  again.items = [...first.items, ...again.items];
  again.durationMs = (first.durationMs || 0) + (again.durationMs || 0);
  return again;
}

function runVendorCliOnce(spec, t) {
  const started = Date.now();
  const res = { ok: false, provider: spec.id, threadId: t.resumeThreadId || null, finalMessage: '', items: [], usage: null, error: null, limitHit: false, authFailed: false, exitCode: null, stderr: '' };
  const st = { spec, threadId: t.resumeThreadId || null, text: '', finalText: null, usage: null, error: null, items: [], unknown: 0 };
  const emit = (event, data) => { bus.publish('worker', { taskId: t.id, provider: spec.id, event, ...data }); t.onEvent?.(event, data); };
  return new Promise((resolve) => {
    const bin = spec.bin();
    if (!bin) { res.error = `${spec.label || spec.id} CLI not found${spec.install ? ` (install: ${spec.install.win || spec.install.posix})` : ''}`; return resolve(res); }
    const ha = spec.headlessArgs(t);
    const { args, threadId, cleanup } = ha;
    const useStdin = !!(spec.stdinPrompt || ha.stdinPrompt);
    if (threadId) st.threadId = threadId; // some CLIs let us mint the session id up front
    let child;
    try { child = spawnCli(bin, args, { cwd: t.cwd, windowsHide: true, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, ...(spec.env?.() || {}) } }); }
    catch (e) { try { cleanup?.(); } catch {} res.error = e.message; return resolve(res); }
    emit('thread', { threadId: st.threadId });
    onLines(child.stdout, (line) => {
      let obj = null; try { obj = JSON.parse(line); } catch {}
      try { if (obj) spec.parse(obj, st, emit); else spec.parseText?.(line, st, emit); } catch (e) { st.unknown++; }
    });
    onLines(child.stderr, (line) => { res.stderr = (res.stderr + line + '\n').slice(-4000); if (!st.error && (LIMIT_RE.test(line) || AUTH_RE.test(line))) st.errorHint = line; });
    const timer = t.timeoutMs ? setTimeout(() => { st.error = st.error || `timeout after ${Math.round(t.timeoutMs / 1000)}s`; killTree(child); }, t.timeoutMs) : null;
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
      res.items = st.items.slice(-60);
      res.error = st.error || (code !== 0 ? `${spec.id} exited with code ${code}${res.stderr ? `: ${res.stderr.trim().slice(-400)}` : ''}` : null);
      if (!res.error && code === 0 && !res.finalMessage && !st.items.length) res.error = `${spec.id} produced no output (exit 0)`;
      // Quota-only stdout (kimi prints the limit line as the whole report, sometimes with exit 0) is a failed limit, not a success.
      // Shape: no items, short text, a quota-refusal phrase — independent of exit code. A success that merely mentions "429" is not a hit.
      const quotaText = (st.text || '').trim();
      const quotaOnly = !st.items.length && quotaText.length <= 300 && QUOTA_MSG_RE.test(quotaText);
      if (quotaOnly && !res.error) res.error = quotaText.slice(-400) || 'usage limit';
      // st.text joins the haystack only for quota-only stdout — a failed run whose narration mentions "429" is not a limit hit.
      const haystack = `${res.error || ''}\n${st.errorHint || ''}\n${res.stderr}${quotaOnly ? `\n${st.text || ''}` : ''}`;
      res.limitHit = !!res.error && LIMIT_RE.test(haystack);
      res.authFailed = !!res.error && AUTH_RE.test(haystack);
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
