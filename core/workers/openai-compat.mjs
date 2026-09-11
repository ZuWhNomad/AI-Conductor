// Generic tool-calling worker for any OpenAI-compatible chat-completions API
// (DeepSeek, Kimi/Moonshot, Grok/xAI, Qwen/DashScope, Gemini's compat endpoint, Ollama /v1).
// Small, sandboxed-to-cwd tool set: read/write/edit files, list, search, run a command.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { bus } from '../bus.mjs';
import { isInside } from '../context.mjs';
import { killTree } from '../proc.mjs';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__']);

const TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 text file. Returns at most 60k characters.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a file with the given content (creates folders).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace one exact occurrence of `old` with `new` in a file. Fails if `old` is missing or ambiguous.', parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
  { name: 'list_dir', description: 'List files and folders (recursive up to depth 2).', parameters: { type: 'object', properties: { path: { type: 'string', default: '.' } } } },
  { name: 'search', description: 'Search files for a regular expression. Returns file:line: text matches (max 200).', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', default: '.' } }, required: ['pattern'] } },
  { name: 'run', description: 'Run a shell command in the project directory (timeout in seconds, default 120). Returns exit code and output.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'number' } }, required: ['command'] } },
  { name: 'fetch_url', description: 'HTTP GET a public http(s) URL and return its text (HTML tags stripped, max 60k characters, 30s timeout). No search engine: you need the URL. If a site blocks you (403), report that instead of retrying.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];

/** Fetch a page as readable text: scripts/styles dropped, tags stripped, whitespace collapsed. */
export async function fetchUrlText(url, { signal, maxChars = 60000, timeoutMs = 30_000 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs');
  const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)), headers: { 'user-agent': 'Mozilla/5.0 (compatible; Conductor/2.0)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'follow' });
  const body = await r.text();
  const text = /html/i.test(r.headers.get('content-type') || '') || /^\s*</.test(body)
    ? body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
    : body;
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

function makeTools(cwd, signal) {
  const safe = (p) => { const a = resolve(cwd, p || '.'); if (!isInside(cwd, a)) throw new Error(`path outside project: ${p}`); return a; };
  return {
    read_file: ({ path }) => readFileSync(safe(path), 'utf8').slice(0, 60000),
    write_file: ({ path, content }) => { const f = safe(path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); return `wrote ${content.length} chars to ${path}`; },
    edit_file: ({ path, old, new: nu }) => {
      const f = safe(path); const s = readFileSync(f, 'utf8');
      const first = s.indexOf(old); if (first < 0) throw new Error('`old` not found');
      if (s.indexOf(old, first + 1) >= 0) throw new Error('`old` is ambiguous (multiple matches)');
      writeFileSync(f, s.slice(0, first) + nu + s.slice(first + old.length)); return 'edited';
    },
    list_dir: ({ path }) => {
      const root = safe(path); const out = [];
      const walk = (d, lvl) => { if (lvl > 2) return; for (const e of readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = join(d, e.name); out.push(relative(cwd, p) + (e.isDirectory() ? '/' : '')); if (e.isDirectory()) walk(p, lvl + 1); if (out.length > 500) return; } };
      walk(root, 0); return out.join('\n');
    },
    search: ({ pattern, path }) => {
      const re = new RegExp(pattern); const root = safe(path); const hits = [];
      const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (statSync(p).size < 2e6) { const lines = readFileSync(p, 'utf8').split('\n'); lines.forEach((l, i) => { if (re.test(l) && hits.length < 200) hits.push(`${relative(cwd, p)}:${i + 1}: ${l.trim().slice(0, 200)}`); }); } if (hits.length >= 200) return; } };
      walk(root); return hits.join('\n') || '(no matches)';
    },
    fetch_url: ({ url }) => fetchUrlText(url, { signal }),
    // Shell command with a hard deadline and cancellation. The whole process tree is killed (on Windows
    // `exec`'s timeout only kills cmd.exe and leaves the real command running).
    run: ({ command, timeout_s }) => new Promise((res) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; let why = '';
      const cap = (s) => (s.length > 40000 ? s.slice(-40000) : s);
      child.stdout.on('data', (d) => { out = cap(out + d); });
      child.stderr.on('data', (d) => { err = cap(err + d); });
      const finish = (code) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); res(`exit ${code ?? 1}${why}\n${`${out}${err ? `\n[stderr]\n${err}` : ''}`.slice(-20000)}`); };
      const timer = setTimeout(() => { why = ' (timeout)'; killTree(child); }, (timeout_s || 120) * 1000);
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
  const impl = { ...makeTools(t.cwd, t.signal), ...Object.fromEntries((t.extraTools || []).map((x) => [x.def.name, x.impl])) };
  const defs = [...TOOLS, ...(t.extraTools || []).map((x) => x.def)];
  const messages = t.history?.length ? [...t.history] : [{ role: 'system', content: t.system || 'You are a careful software engineer working in the project directory. Use the tools to inspect and change files, run the verification commands, then finish with a short report.' }];
  if (t.prompt) messages.push({ role: 'user', content: t.prompt });
  res.messages = messages;
  const started = Date.now();
  const deadline = t.timeoutMs ? started + t.timeoutMs : Infinity;
  try {
    for (let i = 0; i < (t.maxIterations || 150); i++) {
      if (t.signal?.aborted) throw new Error('aborted');
      if (Date.now() > deadline) throw new Error('timeout');
      const body = { model: t.model, messages, tools: defs.map((f) => ({ type: 'function', function: f })), tool_choice: 'auto', stream: false };
      if (t.effort) body.reasoning_effort = t.effort;
      const r = await fetch(`${t.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: AbortSignal.any([t.signal, ...(deadline === Infinity ? [] : [AbortSignal.timeout(Math.max(1000, deadline - Date.now()))])].filter(Boolean)),
        headers: { 'content-type': 'application/json', ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}), ...(t.headers || {}) },
        body: JSON.stringify(body),
      });
      bus.publish('http_rate', { provider: res.provider, status: r.status, headers: Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|retry-after/i.test(k))) });
      if (r.status === 429) { res.limitHit = true; res.retryAfterMs = Number(r.headers.get('retry-after') || 0) * 1000 || null; throw new Error(`429 rate limited: ${(await r.text()).slice(0, 300)}`); }
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
        let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
        emit('item', { item: { id: c.id, type: 'tool_use', name: c.function.name, input: JSON.stringify(args).slice(0, 300), args }, phase: 'started' });
        let out; let isError = false;
        try { out = impl[c.function.name] ? String(await impl[c.function.name](args)) : `unknown tool ${c.function.name}`; }
        catch (e) { out = `error: ${e.message}`; isError = true; }
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
  res.durationMs = Date.now() - started;
  return res;
}
