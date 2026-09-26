// Generic tool-calling worker for any OpenAI-compatible chat-completions API
// (DeepSeek, Kimi/Moonshot, Grok/xAI, Qwen/DashScope, Gemini's compat endpoint, Ollama /v1).
// File tools check workspace containment; optional command execution has unsandboxed host access.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import dns from 'node:dns';
import net from 'node:net';
import { bus } from '../bus.mjs';
import { killTree } from '../proc.mjs';
import { loadConfig } from '../config.mjs';
import { SKIP, safePath, readBytes } from './openai-compat-files.mjs';

/**
 * Gate for the `run` tool (API/Ollama workers have no OS sandbox). Returns a refusal string when the command is not
 * permitted under `worker.shell`, or null when it may run. `worker.shell`: true = allowed; false/'off' = disabled;
 * an array = allow-list of command names. Allow-list mode permits ONE simple command whose executable is listed
 * (exact name/basename, extension-insensitive — never a prefix or path) and rejects shell operators even inside quotes, so
 * `git & evil`, `git | evil`, `git && evil`, redirects, subshells and backticks can't smuggle a second command.
 */
export function shellDenied(shell, command) {
  if (shell === false || shell === 'off') return 'run disabled: worker.shell is off in this conductor config';
  if (!Array.isArray(shell)) return null;
  const cmd = String(command || '');
  if (/[&|;\n\r`]|\$\(|[<>]/.test(cmd)) return `run blocked: worker.shell allow-list permits a single command; shell operators (& | ; < > \` $() ) are rejected even inside quotes; got: ${cmd.slice(0, 80)}`;
  const first = cmd.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  if (/[\\/]/.test(first) || first.startsWith('.')) return `run blocked: worker.shell allow-list permits a bare command name, not a path; got: ${first.slice(0, 80)}`;
  const base = first.replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
  if (!shell.some((a) => a.replace(/\.(exe|cmd|bat|com|ps1)$/i, '') === base)) return `run blocked: "${base}" is not in worker.shell allow-list (${shell.join(', ')})`;
  return null;
}

/** Env for the `run` tool child. On Windows, a bare name must not resolve to a cwd shim (`git.cmd` in the project). */
export function runEnv(env = process.env) {
  return { ...env, NoDefaultCurrentDirectoryInExePath: '1' };
}

const TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 text file. Returns at most 60k characters.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a file with the given content (creates folders).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace one exact occurrence of `old` with `new` in a file. Fails if `old` is missing or ambiguous.', parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
  { name: 'list_dir', description: 'List files and folders (recursive up to depth 2).', parameters: { type: 'object', properties: { path: { type: 'string', default: '.' } } } },
  { name: 'search', description: 'Search files for a regular expression. Returns file:line: text matches (max 200).', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', default: '.' } }, required: ['pattern'] } },
  { name: 'run', description: 'Run a shell command in the project directory (timeout in seconds, default 120). Returns exit code and output.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'number' } }, required: ['command'] } },
  { name: 'fetch_url', description: 'HTTP GET a public http(s) URL and return its text (HTML tags stripped, max 60k characters, 30s timeout). No search engine: you need the URL. If a site blocks you (403), report that instead of retrying.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];

/** Describe the command filter without claiming it provides a host sandbox. */
export function runDescription(shell) {
  const gate = shell === false || shell === 'off' ? 'Disabled in this workspace: every command is refused' : Array.isArray(shell) ? `Only these programs are allowed (first word of the command): ${shell.join(', ')}; shell control operators are rejected even inside quotes` : 'Any shell command is allowed';
  return `Run a host shell command in the project directory. ${gate}. Enabled commands are not sandboxed and can access files outside the workspace. timeout_s (default 120). Returns exit code and output.`;
}

/** True for loopback / private / link-local / metadata / reserved IPs — the SSRF blocklist. */
function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:') && net.isIP(s.slice(7)) === 4) return isPrivateIp(s.slice(7)); // IPv4-mapped IPv6
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}

/** SSRF guard: reject a host that is, or resolves to, a private/reserved address (metadata, loopback, LAN). */
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) { if (isPrivateIp(hostname)) throw new Error(`blocked: ${hostname} is a private/reserved address`); return; }
  let addrs; try { addrs = await dns.promises.lookup(hostname, { all: true }); } catch { throw new Error(`cannot resolve ${hostname}`); }
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error(`blocked: ${hostname} resolves to a private/reserved address (${a.address})`);
}

const FETCH_BODY_BYTES = 2 * 1024 * 1024; // P4 spec: stream-and-cancel cap (2 MB)
const TOOL_RESULT_CHARS = 120_000; // X6 spec: keep latest tool results in full up to ~120k chars
const HTTP_ATTEMPTS = 3; // I1 spec
const SETTIMEOUT_MAX_MS = 2 ** 31 - 1; // Node/DOM setTimeout 32-bit signed limit

function findTag(s, from, name, closing) {
  const needle = closing ? `</${name}` : `<${name}`;
  let i = from;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return -1;
    if (s.slice(lt, lt + needle.length).toLowerCase() === needle) {
      const c = s[lt + needle.length];
      if (c === undefined || c === '>' || c === '/' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') return lt;
    }
    i = lt + 1;
  }
  return -1;
}

function stripDelimited(s, open, close) {
  let out = '', i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) return out + s.slice(i);
    out += s.slice(i, a) + ' ';
    const b = s.indexOf(close, a + open.length);
    if (b < 0) return out; // unclosed: drop the rest; do not rescan
    i = b + close.length;
  }
}

function stripElement(s, name) {
  let out = '', i = 0;
  for (;;) {
    const a = findTag(s, i, name, false);
    if (a < 0) return out + s.slice(i);
    out += s.slice(i, a) + ' ';
    const gt = s.indexOf('>', a + 1);
    if (gt < 0) return out;
    const b = findTag(s, gt + 1, name, true);
    if (b < 0) return out;
    const end = s.indexOf('>', b + 1);
    if (end < 0) return out;
    i = end + 1;
  }
}

/** Linear HTML strip: comments/script/style dropped with indexOf, tags to space/newline, entities decoded. */
function stripHtml(body) {
  let s = stripDelimited(body, '<!--', '-->');
  s = stripElement(s, 'script');
  s = stripElement(s, 'style');
  let out = '', i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    const raw = s.slice(lt + 1, gt).trim();
    const closing = raw.startsWith('/');
    const name = (closing ? raw.slice(1) : raw).split(/[\s/]/)[0].toLowerCase();
    out += (name === 'br' || (closing && (name === 'p' || name === 'div' || name === 'li' || name === 'tr' || /^h[1-6]$/.test(name)))) ? '\n' : ' ';
    i = gt + 1;
  }
  return out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function readBodyCapped(r, maxBytes, signal) {
  const stream = r.body;
  if (!stream?.getReader) {
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.subarray(0, maxBytes).toString('utf8');
  }
  const reader = stream.getReader();
  const chunks = [];
  let n = 0;
  try {
    while (n < maxBytes) {
      if (signal?.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.byteLength, maxBytes - n);
      chunks.push(Buffer.from(value.subarray(0, take)));
      n += take;
      if (n >= maxBytes) { try { await reader.cancel(); } catch {} break; }
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return Buffer.concat(chunks, n).toString('utf8');
}

/** Fetch a page as readable text: scripts/styles dropped, tags stripped, whitespace collapsed. */
export async function fetchUrlText(url, { signal, maxChars = 60000, timeoutMs = 30_000, allowPrivate = loadConfig().worker?.fetchAllowPrivate } = {}) {
  // Validate the host (and every redirect hop) against the SSRF blocklist before each request, and follow redirects
  // manually so a public URL can't 3xx-hop to 169.254.169.254 / localhost / a LAN host. (DNS is re-checked per hop;
  // a determined TOCTOU rebind between lookup and connect is out of scope for this local tool.) `allowPrivate`
  // (config worker.fetchAllowPrivate) opts out for a trusted internal docs server.
  const sig = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
  let current = url, r;
  for (let hop = 0; ; hop++) {
    if (!/^https?:\/\//i.test(current)) throw new Error('only http(s) URLs');
    if (!allowPrivate) await assertPublicHost(new URL(current).hostname);
    r = await fetch(current, { signal: sig, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Conductor/2.0)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    const loc = r.headers.get('location');
    if (!loc || hop >= 5) break;
    current = new URL(loc, current).toString();
  }
  const body = await readBodyCapped(r, FETCH_BODY_BYTES, sig);
  const text = /html/i.test(r.headers.get('content-type') || '') || /^\s*</.test(body) ? stripHtml(body) : body;
  return `HTTP ${r.status}\n${text.slice(0, maxChars)}`;
}

/** Answer every tool_call the assistant issued but never got a reply for; strict APIs reject a history with dangling calls. */
export function closeDanglingToolCalls(messages, note = 'aborted before execution') {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') j++; // keep existing replies first
      for (const c of m.tool_calls) if (!answered.has(c.id)) messages.splice(j++, 0, { role: 'tool', tool_call_id: c.id, content: note });
      break;
    }
    if (m.role === 'user') break;
  }
  return messages;
}

function toolAborted() {
  const e = new Error('aborted');
  e.name = 'ToolAborted';
  return e;
}

/** Reject as soon as `signal` aborts, without waiting for a tool that ignores it. */
function raceAbort(promise, signal) {
  if (signal?.aborted) return Promise.reject(toolAborted());
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(toolAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function isAbortOrTimeout(e) {
  const name = e?.name || '';
  const msg = String(e?.message || e || '');
  return name === 'AbortError' || name === 'TimeoutError' || name === 'ToolAborted' || /^(aborted|timeout)$/i.test(msg) || /aborted due to timeout/i.test(msg);
}

function stubOldToolResults(messages, budget = TOOL_RESULT_CHARS) {
  const idxs = [];
  const out = messages.map((m, i) => { if (m.role === 'tool') idxs.push(i); return m; });
  let used = 0;
  for (let k = idxs.length - 1; k >= 0; k--) {
    const i = idxs[k];
    const content = String(out[i].content ?? '');
    if (used + content.length <= budget) { used += content.length; continue; }
    const stub = content.startsWith('[output trimmed:') ? content : `[output trimmed: ${content.length} chars]`;
    out[i] = { ...out[i], content: stub };
    used += stub.length;
  }
  return out;
}

function waitForRetry(ms, signal, deadline) {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  if (deadline !== Infinity && Date.now() >= deadline) return Promise.reject(new Error('timeout'));
  const cap = deadline === Infinity ? ms : Math.min(ms, Math.max(0, deadline - Date.now()));
  if (cap <= 0) return Promise.reject(new Error('timeout'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      if (deadline !== Infinity && Date.now() > deadline) reject(new Error('timeout'));
      else resolve();
    }, cap);
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function searchInWorker(data, signal, deadline) {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  if (Date.now() >= deadline) return Promise.reject(new Error('search timeout'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./openai-compat-files.mjs', import.meta.url), { workerData: { type: 'openai-compat-search', ...data } });
    let finished = false;
    const finish = async (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Wait for termination, including a regex stuck in native code, before settling the tool.
      try { await worker.terminate(); } catch (e) { error ||= e; }
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      if (error) reject(error); else resolve(result);
    };
    const onMessage = ({ error, result }) => finish(error ? new Error(error) : null, result);
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`search worker exited without a result (exit ${code})`));
    const onAbort = () => finish(new Error('aborted'));
    const timer = setTimeout(() => finish(new Error('search timeout')), Math.max(0, deadline - Date.now()));
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function runTimeoutMs(timeout_s, deadline) {
  const sec = Number(timeout_s);
  let ms = (Number.isFinite(sec) && sec > 0 ? sec : 120) * 1000;
  ms = Math.min(Math.max(ms, 1000), SETTIMEOUT_MAX_MS);
  if (deadline !== Infinity) ms = Math.min(ms, Math.max(0, deadline - Date.now()));
  return ms;
}

async function makeTools(cwd, signal, deadline) {
  const root = await realpath(cwd);
  const safe = (p, opts) => safePath(cwd, root, p, opts);
  return {
    // UTF-8 needs at most three bytes per UTF-16 code unit (astral characters use two units).
    read_file: async ({ path }) => (await readBytes(await safe(path), 60000 * 3)).toString('utf8').slice(0, 60000),
    write_file: async ({ path, content }) => { const f = await safe(path, { mutate: true }); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); return `wrote ${content.length} chars to ${path}`; },
    edit_file: async ({ path, old, new: nu }) => {
      if (typeof old !== 'string' || !old) throw new Error('`old` must be a non-empty string');
      if (typeof nu !== 'string') throw new Error('`new` must be a string');
      const f = await safe(path, { mutate: true }); const s = readFileSync(f, 'utf8');
      const first = s.indexOf(old); if (first < 0) throw new Error('`old` not found');
      if (s.indexOf(old, first + 1) >= 0) throw new Error('`old` is ambiguous (multiple matches)');
      writeFileSync(f, s.slice(0, first) + nu + s.slice(first + old.length)); return 'edited';
    },
    list_dir: async ({ path }) => {
      const root = await safe(path); const out = [];
      const walk = async (d, lvl) => { if (lvl > 2) return; for (const e of await readdir(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = await safe(join(d, e.name)); out.push(relative(cwd, p) + (e.isDirectory() ? '/' : '')); if (e.isDirectory()) await walk(p, lvl + 1); if (out.length > 500) return; } };
      await walk(root, 0); return out.join('\n');
    },
    // The caller's task deadline is authoritative; direct calls without one use the configured
    // worker-run timeout, so even those searches have a hard deadline without a new policy knob.
    search: ({ pattern, path }) => searchInWorker({ cwd, root, pattern, path }, signal,
      deadline === Infinity ? Date.now() + loadConfig().worker.timeoutMinutes * 60_000 : deadline),
    fetch_url: ({ url }) => fetchUrlText(url, { signal }),
    // Shell command with a hard deadline and cancellation. The whole process tree is killed (on Windows
    // `exec`'s timeout only kills cmd.exe and leaves the real command running).
    run: ({ command, timeout_s }) => new Promise((res) => {
      // false disables host execution; an array filters command names, without sandboxing the allowed programs.
      const deny = shellDenied(loadConfig().worker?.shell, command);
      if (deny) return res(deny);
      const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: runEnv() });
      let out = ''; let err = ''; let why = '';
      const cap = (s) => (s.length > 40000 ? s.slice(-40000) : s);
      child.stdout.on('data', (d) => { out = cap(out + d); });
      child.stderr.on('data', (d) => { err = cap(err + d); });
      const finish = (code) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); res(`exit ${code ?? 1}${why}\n${`${out}${err ? `\n[stderr]\n${err}` : ''}`.slice(-20000)}`); };
      const timer = setTimeout(() => { why = ' (timeout)'; killTree(child); }, runTimeoutMs(timeout_s, deadline));
      const onAbort = () => { why = ' (canceled)'; killTree(child); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.on('error', (e) => { err += `\n${e.message}`; finish(1); });
      child.on('close', (code) => finish(code));
    }),
  };
}

/**
 * @param {object} t { id, cwd, prompt, system, model, baseUrl, apiKey, headers, effort, signal, maxIterations, timeoutMs, provider,
 *                     history?: message[] (continue a conversation; prompt is appended as the new user turn),
 *                     extraTools?: [{ def: {name, description, parameters}, impl(args) }], onEvent?(event, data) }
 * @returns result with `messages` = the full conversation after this run (for multi-turn use)
 */
export async function runOpenAICompat(t) {
  const res = { ok: false, provider: t.provider || 'openai-compat', finalMessage: '', items: [], usage: { input_tokens: 0, output_tokens: 0 }, error: null, limitHit: false, retryAfterMs: null, messages: null };
  const emit = (event, data) => { bus.publish('worker', { taskId: t.id, provider: res.provider, event, ...data }); t.onEvent?.(event, data); };
  const started = Date.now();
  const deadline = t.timeoutMs ? started + t.timeoutMs : Infinity;
  const impl = {
    ...await makeTools(t.cwd, t.signal, deadline),
    ...Object.fromEntries((t.extraTools || []).map((x) => [x.def.name, (args) => raceAbort(Promise.resolve().then(() => x.impl(args)), t.signal)])),
  };
  // read-only (a review): no write, edit or run tool at all, so a reviewer on these models cannot change the repo.
  // The run tool's description states its real limits, so a model does not burn a turn discovering them.
  const readOnly = t.sandbox === 'read-only';
  const defs = [...TOOLS.filter((d) => !readOnly || !['write_file', 'edit_file', 'run'].includes(d.name)).map((d) => (d.name === 'run' ? { ...d, description: runDescription(loadConfig().worker?.shell) } : d)), ...(t.extraTools || []).map((x) => x.def)];
  const allowed = new Set(defs.map((d) => d.name));
  let lastKey = null, repeat = 0; // repeated-call guard: the same tool with the same arguments, over and over
  const messages = t.history?.length ? [...t.history] : [{ role: 'system', content: t.system || 'You are a careful software engineer working in the project directory. Use the tools to inspect and change files, run the verification commands, then finish with a short report.' }];
  if (t.prompt) messages.push({ role: 'user', content: t.prompt });
  res.messages = messages;
  try {
    for (let i = 0; i < (t.maxIterations || 150); i++) {
      if (t.signal?.aborted) throw new Error('aborted');
      if (Date.now() > deadline) throw new Error('timeout');
      const body = { model: t.model, messages: stubOldToolResults(messages), tools: defs.map((f) => ({ type: 'function', function: f })), tool_choice: 'auto', stream: false };
      if (t.effort) body.reasoning_effort = t.effort;
      const url = `${t.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const headers = { 'content-type': 'application/json', ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}), ...(t.headers || {}) };
      let r;
      for (let attempt = 1; ; attempt++) {
        if (t.signal?.aborted) throw new Error('aborted');
        if (Date.now() > deadline) throw new Error('timeout');
        const reqSignal = AbortSignal.any([t.signal, ...(deadline === Infinity ? [] : [AbortSignal.timeout(Math.max(1000, deadline - Date.now()))])].filter(Boolean));
        try {
          r = await fetch(url, { method: 'POST', signal: reqSignal, headers, body: JSON.stringify(body) });
        } catch (e) {
          if (isAbortOrTimeout(e)) {
            const timedOut = e.name === 'TimeoutError' || /timeout/i.test(String(e.message || ''))
              || (deadline !== Infinity && Date.now() >= deadline && !t.signal?.aborted);
            throw new Error(timedOut ? 'timeout' : 'aborted');
          }
          if (e instanceof TypeError && attempt < HTTP_ATTEMPTS) {
            await waitForRetry(100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100), t.signal, deadline);
            continue;
          }
          throw e;
        }
        bus.publish('http_rate', { provider: res.provider, status: r.status, headers: Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|retry-after/i.test(k))) });
        if (r.status === 429) { res.limitHit = true; res.retryAfterMs = Number(r.headers.get('retry-after') || 0) * 1000 || null; throw new Error(`429 rate limited: ${(await r.text()).slice(0, 300)}`); }
        if ((r.status >= 500 || r.status === 408) && attempt < HTTP_ATTEMPTS) {
          try { await r.arrayBuffer(); } catch {}
          await waitForRetry(100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100), t.signal, deadline);
          continue;
        }
        break;
      }
      if (r.status === 401) res.authFailed = true; // a bad or revoked key: the environment, not the model
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 500)}`);
      const j = await r.json();
      if (j.usage) { res.usage.input_tokens += j.usage.prompt_tokens || 0; res.usage.output_tokens += j.usage.completion_tokens || 0; res.usage.cached_input_tokens = (res.usage.cached_input_tokens || 0) + (j.usage.prompt_cache_hit_tokens ?? j.usage.prompt_tokens_details?.cached_tokens ?? 0); }
      const msg = j.choices?.[0]?.message;
      if (!msg) throw new Error('empty completion');
      messages.push(msg);
      if (msg.content) { res.items.push({ type: 'agent_message', text: msg.content }); emit('item', { item: { type: 'agent_message', text: msg.content }, phase: 'completed' }); }
      const calls = msg.tool_calls || [];
      if (!calls.length) { res.finalMessage = msg.content || ''; res.ok = true; break; }
      for (const c of calls) {
        if (t.signal?.aborted) throw new Error('aborted');
        let args = {}, argError = null; try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) { argError = e.message; }
        emit('item', { item: { id: c.id, type: 'tool_use', name: c.function.name, input: (argError ? String(c.function.arguments) : JSON.stringify(args)).slice(0, 300), args }, phase: 'started' });
        let out; let isError = false;
        const key = c.function.name + '\u0000' + (c.function.arguments || '');
        repeat = key === lastKey ? repeat + 1 : 1; lastKey = key;
        if (!allowed.has(c.function.name)) { out = `error: tool not allowed: ${c.function.name}`; isError = true; }
        else if (argError) { out = `error: arguments invalid (${argError}); resend the call with valid JSON arguments`; isError = true; } // broken JSON used to run the tool with {} (a directory read, a no-op write) and mislead the model
        else if (repeat >= 3) { out = `error: this exact call (same tool, same arguments) was already made ${repeat - 1} times in a row and its result will not change; do something different or finish`; isError = true; }
        else {
          try { out = String(await impl[c.function.name](args)); }
          catch (e) {
            if (e?.name === 'ToolAborted') throw new Error('aborted');
            out = `error: ${e.message}`; isError = true;
          }
        }
        res.items.push({ type: 'tool_use', name: c.function.name, input: args, output: out.slice(0, 2000) });
        emit('tool_result', { toolUseId: c.id, name: c.function.name, isError, text: out.slice(0, 4000) });
        messages.push({ role: 'tool', tool_call_id: c.id, content: out });
      }
    }
    if (!res.ok && !res.error) res.error = 'max iterations reached';
  } catch (e) {
    res.error = String(e?.message || e);
    closeDanglingToolCalls(messages, `not executed: ${res.error}`); // keep the saved history replayable
  }
  // Persist stubs for older turns so follow-ups replay a bounded history. Keep this run's last
  // tool batch intact so the caller can read what the tools actually returned.
  const stubbed = stubOldToolResults(messages);
  let lastCall = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) lastCall = i;
  const keepFrom = lastCall < 0 ? messages.length : lastCall + 1;
  for (let i = 0; i < keepFrom; i++) if (stubbed[i] !== messages[i]) messages[i] = stubbed[i];
  res.durationMs = Date.now() - started;
  return res;
}
