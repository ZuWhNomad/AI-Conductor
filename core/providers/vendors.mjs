// Vendor agent CLIs on consumer subscriptions. One spec per vendor: where the binary lives, how to
// install and sign in, how to probe auth and list models, how to run headless, how to parse output.
// Verified flag sets: agy 1.2.1 (2026-09-11; `-p /usage --output-format json` answers quota without a turn), grok 1.0.0 (2026-09, event schema provisional until a
// signed-in run), Qwen Code 0.23 and Kimi CLI 1.50 (see notes per spec).
import { existsSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { findCli, killTree, trackProbe, resolveNpmShim } from '../proc.mjs';
import { readTail } from '../paths.mjs';
import { vendorParse as P } from '../workers/vendor-cli.mjs';
import { loadConfig } from '../config.mjs';
import { findModel } from '../models.mjs';

// Antigravity (Method C): effort is baked into the model id (…-low / -medium / -high) and the CLI has no --effort
// flag. Collapse each such family into ONE logical model exposing efforts:[…] with the concrete id per effort, so
// the scorecard reasons about effort uniformly; the executor maps (family, effort) → concrete id at dispatch.
const EFFORT_IN_ID = /-(low|medium|high)$/;
const EFFORT_ORDER = ['low', 'medium', 'high'];
export function collapseEffortFamilies(models) {
  const fam = new Map(); const out = [];
  for (const m of models) {
    const mm = EFFORT_IN_ID.exec(m.id);
    if (!mm) { out.push(m); continue; } // no effort suffix (claude-*, gpt-oss without a level): pass through untouched
    const family = m.id.slice(0, mm.index);
    let g = fam.get(family);
    if (!g) { g = { id: family, label: String(m.label || family).replace(/\s*\((?:low|medium|high)\)\s*$/i, '').trim() || family, efforts: new Set(), effortIds: {}, isDefault: false }; fam.set(family, g); out.push(g); }
    g.efforts.add(mm[1]); g.effortIds[mm[1]] = m.id; if (m.isDefault) g.isDefault = true;
  }
  for (const g of fam.values()) g.efforts = EFFORT_ORDER.filter((e) => g.efforts.has(e));
  return out;
}

/** Map an Antigravity (family, effort) selection to the concrete model id agy expects (gemini-3.8-flash + high → gemini-3.8-flash-high). */
function agyModelArg(model, effort) {
  if (!model) return null;
  if (EFFORT_IN_ID.test(model)) return model;                   // already a concrete/legacy raw id: dispatch as-is, ignore the tag
  const m = findModel('antigravity', model);
  if (!effort) return m?.efforts?.length ? (m.effortIds?.[m.efforts[0]] || `${model}-${m.efforts[0]}`) : model; // no effort on a known family: cheapest (lowest listed) variant
  if (m?.effortIds?.[effort]) return m.effortIds[effort];       // exact map from the registry
  if (EFFORT_ORDER.includes(effort)) return `${model}-${effort}`; // family + a valid agy level: agy families are family-effort (also covers a not-yet-refreshed registry)
  if (m?.efforts?.length) return m.effortIds?.[m.efforts[m.efforts.length - 1]] || model; // out-of-range effort on a known family: dispatch its top variant, never a bare family id agy would reject
  return model; // unknown model: dispatch the id as-is rather than a bogus one
}

const WIN = process.platform === 'win32';
const home = homedir();
const first = (paths) => paths.find((p) => p && existsSync(p)) || null;
// Any installed Python 3.x user-scripts dir (was pinned to Python312, which hid a kimi installed under 3.11/3.13/3.14).
const pyScripts = WIN
  ? [join(process.env.APPDATA || '', 'Python'), join(process.env.LOCALAPPDATA || '', 'Programs', 'Python')].flatMap((base) => {
      try { return readdirSync(base).filter((d) => /^Python3/i.test(d)).map((d) => join(base, d, 'Scripts')); } catch { return []; }
    })
  : [join(home, '.local', 'bin')];

/**
 * Run a CLI with stdin closed and capture output (auth probes, model lists). An npm `.cmd` shim is unwrapped to
 * `node <entry>` and spawned directly — no cmd.exe, so no console window ever flashes during polling.
 * Refuse unresolved .cmd/.bat scripts instead of passing them through a shell.
 */
export function capture(bin, args, { timeoutMs = 30_000, cwd } = {}) {
  const shim = WIN && /\.(cmd|bat)$/i.test(bin) ? resolveNpmShim(bin) : null;
  if (!shim && WIN && /\.(cmd|bat)$/i.test(bin)) {
    return Promise.resolve({ code: 1, out: `Error: cannot run ${bin} without a shell (not a resolvable npm shim); point the config at the real executable`, timedOut: false });
  }
  const cmd = shim ? shim.command : bin;
  const argv = shim ? [...shim.args, ...args] : args;
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(cmd, argv, { cwd, detached: !WIN, windowsHide: true, maxBuffer: 2e6, encoding: 'utf8', shell: false }, (err, stdout, stderr) => {
      clearTimeout(timer);
      resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout || ''}${stderr || ''}`, timedOut: timedOut || !!err?.killed });
    });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    trackProbe(child);
  });
}

const SIGNED_OUT = /not (?:signed in|authenticated|logged in)|please (?:sign|log) in|login required|run .*login/i;

/**
 * agy `-p /usage --output-format json` → limit windows. Quota is per model *group* (Gemini vs Claude+GPT), each with a
 * 5-hour and a weekly bucket, so every window carries a `models` regex; the router applies a window only to the models
 * it covers. Recorded shape (2026-09-11): command.data.groups[].{name, description, buckets[].{id, window, remaining_fraction, reset_time}}.
 */
export function parseAgyUsage(text) {
  const line = String(text || '').split('\n').find((l) => l.trim().startsWith('{') && /"groups"/.test(l));
  if (!line) return null;
  let j; try { j = JSON.parse(line); } catch { return null; }
  const groups = j?.command?.data?.groups; if (!Array.isArray(groups)) return null;
  const windows = [];
  for (const g of groups) {
    // "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS" → ^(claude|gpt); falls back to the group name.
    const names = (String(g.description || '').split(':')[1] || g.name || '').split(',').map((s) => s.trim().split(/[\s-]/)[0].toLowerCase()).filter(Boolean);
    const models = names.length ? `^(${[...new Set(names)].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})` : null;
    const short = String(g.name || '').replace(/ models?$/i, '');
    for (const b of g.buckets || []) {
      const rem = Number(b.remaining_fraction);
      const five = b.window === '5h' || /5.?h|five hour/i.test(b.name || '');
      windows.push({ id: `antigravity:${b.id || (five ? '5h' : 'weekly')}`, label: `${short} ${five ? '5-hour' : 'weekly'}`, usedPercent: Number.isFinite(rem) ? Math.round((1 - rem) * 10000) / 100 : null, resetsAt: b.reset_time ? Date.parse(b.reset_time) : null, windowMinutes: five ? 300 : 10080, models });
    }
  }
  return { windows, credits: Number(j?.command?.data?.remaining_credits) || 0 };
}


/** grok's structured HTTP status: a top-level http_status, or the JSON body inside an errors[] entry ("Internal error: {… "http_status": 402}"). */
export function httpStatusOf(obj) {
  if (Number.isInteger(obj?.http_status)) return obj.http_status;
  for (const e of obj?.errors || []) {
    const s = String(e), i = s.indexOf('{');
    if (i < 0) continue;
    try { const j = JSON.parse(s.slice(i)); if (Number.isInteger(j.http_status)) return j.http_status; } catch {}
  }
  return null;
}

/**
 * grok's own record of how a headless turn ended: ~/.grok/sessions/<encoded cwd>/<session>/events.jsonl (grok 1.0.30).
 * Returns { outcome, category, refusedTool } from the last turn_ended event, or null.
 */
export function grokTurnEnd(cwd, sessionId, home = process.env.GROK_HOME || join(homedir(), '.grok')) {
  if (!cwd || !/^[\w-]+$/.test(sessionId || '')) return null;
  const lines = readTail(join(home, 'sessions', encodeURIComponent(cwd), sessionId, 'events.jsonl'), 256 * 1024).split('\n');
  let end = null, refusedTool = null;
  for (const l of lines) {
    if (!l.includes('"turn_ended"') && !l.includes('"permission_resolved"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'permission_resolved' && e.decision === 'cancelled') refusedTool = e.tool_name || refusedTool;
    if (e.type === 'turn_ended') end = { outcome: e.outcome || null, category: e.cancellation_category || null, refusedTool };
  }
  return end;
}

/** Anthropic Messages wire format (NDJSON): system init, assistant/user messages with content blocks, result. Used by grok --output-format streaming-messages-json. */
function parseMessagesStream(obj, st, emit, tag) {
  if (obj.session_id && !st.threadId) st.threadId = obj.session_id;
  if (obj.type === 'assistant') {
    for (const c of obj.message?.content || []) {
      if (c.type === 'text' && c.text) { P.message(st, emit, c.text.trim()); st.text += c.text; }
      else if (c.type === 'tool_use') P.toolStart(st, emit, c.id || `${tag}-${st.items.length}`, c.name || 'tool', c.input);
    }
  } else if (obj.type === 'user') {
    for (const c of obj.message?.content || []) if (c.type === 'tool_result') P.toolDone(st, emit, c.tool_use_id, 'tool', typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? 'done'), !!c.is_error);
  } else if (obj.type === 'result') {
    if (obj.usage) P.addUsage(st, obj.usage, { input: 'input_tokens', output: 'output_tokens', cached: 'cache_read_input_tokens' });
    if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
      st.error = String(obj.error?.message || obj.error || obj.result || obj.errors?.join('; ') || obj.subtype || `${tag} run failed`); // grok puts the reason (e.g. 402 balance exhausted) only in errors[]
      st.httpStatus = httpStatusOf(obj);
    }
    else st.finalText = typeof obj.result === 'string' && obj.result.trim() ? obj.result.trim() : st.text.trim();
  } else if (obj.type === 'error' || obj.error) st.error = String(obj.error?.message || obj.error || obj.message);
}

export const VENDORS = {
  antigravity: {
    id: 'antigravity', label: 'Google Antigravity (Google AI Pro/Ultra)', budgetLabel: 'Google subscription',
    usageInputExclusive: true, // Claude-Code-shaped stream: input_tokens excludes cache reads (Codex-style streams include them)
    bin: () => findCli('agy') || first([join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'), join(home, '.local', 'bin', 'agy')]),
    install: { win: 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"', posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    login: { interactive: true, args: [], note: 'Sign in happens inside the agy TUI; run `agy`, follow the browser prompt, then type /quit.' },
    loginHint: 'run `agy` and sign in',
    probe: { args: ['models'], signedOut: SIGNED_OUT },
    parseModels: (out) => out.split('\n').map((l) => l.trim()).filter((l) => /^[a-z0-9][\w.-]*\t/.test(l)).map((l) => { const [id, label] = l.split('\t'); return { id, label: label || id }; }),
    // Read-only slash command in print mode: no agent turn, no quota spent. (Spawned without a shell: Git Bash would rewrite "/usage" into a path.)
    pollLimits: async (spec) => {
      const bin = spec.bin(); if (!bin) return { provider: spec.id, plan: 'subscription', blocked: false, windows: [], available: false };
      const r = await capture(bin, ['-p', '/usage', '--output-format', 'json'], { timeoutMs: 60_000 });
      const u = parseAgyUsage(r.out);
      if (!u) throw new Error(`agy /usage gave no quota (${r.out.trim().split('\n')[0]?.slice(0, 100) || 'no output'})`);
      return { provider: spec.id, plan: 'subscription', blocked: false, windows: u.windows };
    },
    efforts: [], // effort lives in the model id (gemini-*-low/medium/high); listModels collapses those into families with real efforts
    collapseEfforts: true, // Method C: listModels folds …-low/-medium/-high into one family model exposing efforts:[low,medium,high]
    // Long prompts: omit `-p`. agy 1.2.8's `-p` (alias of --print) takes the prompt as its value, so
    // `-p --output-format` swallows `--output-format`. `--input-format text` reads stdin. No --prompt-file.
    // Threshold is grok's 8000 (same file) — Windows CreateProcess argv cap is 32767.
    headlessArgs: (t) => {
      const long = !!(t.prompt && t.prompt.length > 8000);
      const args = [];
      if (long) args.push('--input-format', 'text');
      else args.push('-p', t.prompt);
      args.push('--output-format', 'stream-json', '--add-dir', t.cwd, ...(t.writableRoots || []).flatMap((d) => ['--add-dir', d]), '--print-timeout', `${Math.max(60, Math.round((t.timeoutMs || 3600_000) / 1000))}s`);
      if (t.sandbox === 'read-only') args.push('--mode', 'plan');
      else args.push('--dangerously-skip-permissions');
      if (t.resumeThreadId) args.push('--conversation', t.resumeThreadId);
      // Effort is encoded in the id (Method C): translate (family, effort) → concrete id here. Never pass --effort:
      // agy rejects it, and the id already carries the level. A model with no effort dimension dispatches its id as-is.
      if (t.model) args.push('--model', agyModelArg(t.model, t.effort));
      return { args, stdinPrompt: long };
    },
    parse: (obj, st, emit) => {
      const ev = obj.event; const body = (ev && obj[ev]) || obj;
      const id = obj.conversation_id || body.conversation_id;
      if (id) st.threadId = id;
      if (ev === 'step_update') {
        if (body.step_type === 'agent_response') {
          if (typeof body.text_delta === 'string') st.buf = (st.buf || '') + body.text_delta;
          if (body.state === 'DONE') { P.message(st, emit, (st.buf || '').trim()); st.text += (st.buf || ''); st.buf = ''; }
        } else if (body.step_type === 'tool') {
          const tid = `agy-${body.step_index}`;
          if (body.state === 'ACTIVE') P.toolStart(st, emit, tid, body.tool_name || 'tool', body.tool_info?.parameters);
          else if (body.state === 'DONE') {
            P.toolDone(st, emit, tid, body.tool_name || 'tool', body.tool_info?.result ?? 'done');
            const target = body.tool_info?.parameters?.TargetFile || body.tool_info?.parameters?.target_file;
            if (target && /write|replace|edit|create/i.test(body.tool_name || '')) st.items.push({ type: 'file_change', changes: [{ path: target, kind: 'write' }] }); // feeds the task's changedFiles
          }
        }
        if (body.usage) { st.sawStepUsage = true; P.addUsage(st, body.usage); }
      } else if (ev === 'result') {
        if (!st.sawStepUsage && body.usage) P.addUsage(st, body.usage);
        if (/^(success|completed|ok|done)$/i.test(String(body.status || ''))) st.finalText = typeof body.response === 'string' ? body.response.trim() : st.text;
        else st.error = String(body.error?.message || body.error || body.message || body.status || 'agy run failed');
      } else if (obj.error) st.error = String(obj.error?.message || obj.error);
    },
  },

  grok: {
    id: 'grok', label: 'xAI Grok (SuperGrok / X Premium+)', budgetLabel: 'xAI subscription',
    usageInputExclusive: true, // Anthropic-style usage: input_tokens excludes cache reads
    bin: () => findCli('grok') || first([join(home, '.grok', 'bin', 'grok.exe'), join(home, '.grok', 'bin', 'grok'), join(process.env.LOCALAPPDATA || '', 'grok', 'bin', 'grok.exe')]),
    install: { win: 'powershell -NoProfile -Command "irm https://x.ai/cli/install.ps1 | iex"', posix: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
    login: { args: ['login'] },
    loginHint: 'grok login',
    probe: { args: ['models'], signedOut: /You are not authenticated/i },
    // `grok models` marks the default with `*` and every other model with `-`; matching only `*` hid all the rest
    // (this machine listed grok-4.6 and grok-4.5 and Conductor saw one model).
    parseModels: (out) => out.split('\n').map((l) => /^\s*[*-]\s+([\w.:-]+)/.exec(l)).filter(Boolean).map((m) => ({ id: m[1], label: m[1], isDefault: /^\s*\*/.test(m[0]) })),
    efforts: ['low', 'medium', 'high'],
    headlessArgs: (t) => {
      // A large prompt as a `-p` CLI arg fails on Windows (command-line length limit) — grok exits ~instantly with
      // an empty result. `--prompt-file` reads the prompt from disk instead; use it past a safe threshold. The temp
      // file lives outside the workspace so a benchmark run never sees it.
      const args = ['--output-format', 'streaming-messages-json', '--no-auto-update', '--cwd', t.cwd];
      if (t.sandbox === 'read-only') args.push('--permission-mode', 'plan');
      else args.push('--always-approve');
      let cleanup = null;
      if (t.prompt && t.prompt.length > 8000) { const pf = join(tmpdir(), `grok-prompt-${randomUUID()}.txt`); writeFileSync(pf, t.prompt, { mode: 0o600 }); args.push('--prompt-file', pf); cleanup = () => { try { unlinkSync(pf); } catch {} }; } // removed after the run so the full prompt doesn't linger in %TEMP%
      else args.push('-p', t.prompt);
      let threadId = null;
      if (t.resumeThreadId) args.push('--resume', t.resumeThreadId);
      else { threadId = randomUUID(); args.push('--session-id', threadId); }
      if (t.model) args.push('-m', t.model);
      if (t.effort && ['low', 'medium', 'high'].includes(t.effort)) args.push('--reasoning-effort', t.effort);
      return { args, threadId, cleanup };
    },
    // Verified 2026-09-10 against grok 4.6 CLI: `--output-format streaming-messages-json` (Anthropic Messages wire format).
    parse: (obj, st, emit) => parseMessagesStream(obj, st, emit, 'grok'),
    onClose: (st, emit) => {
      if (st.buf) { P.message(st, emit, st.buf.trim()); st.text += st.buf; st.buf = ''; }
      // Plan mode (our read-only sandbox) cancels a shell or write call and ends the turn: grok's bug, not the model's.
      // Decided from grok's structured session events, not the text: an environment failure, never scored.
      if (!st.error || !st.threadId) return;
      const end = grokTurnEnd(st.cwd, st.threadId);
      if (end?.outcome === 'cancelled' && end.category === 'permission_cancelled') {
        st.envFailed = true;
        st.error = `${st.error}: grok's read-only (plan) mode cancelled the ${end.refusedTool || 'tool'} call and ended the turn (environment failure, not scored)`;
      }
    },
  },

  'qwen-code': {
    id: 'qwen-code', label: 'Qwen Code (Qwen OAuth free tier)', budgetLabel: 'Qwen account',
    bin: () => findCli('qwen'),
    install: { npm: '@qwen-code/qwen-code', win: 'npm i -g @qwen-code/qwen-code', posix: 'npm i -g @qwen-code/qwen-code' },
    login: { interactive: true, args: [], note: 'Run `qwen`, pick "Qwen OAuth", finish in the browser, then type /quit.' },
    loginHint: 'run `qwen` and choose Qwen OAuth',
    probe: { args: ['--version'], signedOut: /never/, needsAuthFile: () => existsSync(join(home, '.qwen', 'oauth_creds.json')) },
    parseModels: () => ['qwen3-coder-plus', 'qwen3-coder-flash'].map((id) => ({ id, label: id })),
    efforts: [],
    // Qwen Code 0.23.3 supports --resume <id>; --continue resumes only the most recent project session.
    // Long prompts: omit the positional query; `--input-format text` (default) consumes stdin (qwen 0.23.3 --help:
    // "The format consumed from standard input"; `-p` "Appended to input on stdin"). No --prompt-file. Threshold: grok's 8000.
    headlessArgs: (t) => {
      const long = !!(t.prompt && t.prompt.length > 8000);
      const args = long ? ['-o', 'stream-json', '--approval-mode', t.sandbox === 'read-only' ? 'plan' : 'yolo', '--include-directories', t.cwd]
        : [t.prompt, '-o', 'stream-json', '--approval-mode', t.sandbox === 'read-only' ? 'plan' : 'yolo', '--include-directories', t.cwd];
      if (t.resumeThreadId) args.push('--resume', t.resumeThreadId);
      if (t.model) args.push('-m', t.model);
      return { args, stdinPrompt: long };
    },
    // Qwen Code 0.23 emits Claude-style Anthropic Messages frames, not Gemini-CLI {type:'message'|'tool_use'}.
    parse: (obj, st, emit) => parseMessagesStream(obj, st, emit, 'qwen'),
    onClose: (st) => {
      const text = st.finalText || st.text || '';
      if (!st.error && /\[API Error:/i.test(text)) st.error = text.trim();
    },
  },

  kimi: {
    id: 'kimi', label: 'Kimi CLI (Moonshot account)', budgetLabel: 'Kimi account',
    bin: () => findCli('kimi') || first(pyScripts.map((d) => join(d, WIN ? 'kimi.exe' : 'kimi'))),
    install: { pip: 'kimi-cli', win: 'pip install --user kimi-cli', posix: 'pip install --user kimi-cli' },
    login: { args: ['login'], fallbackInteractive: true, note: 'Run `kimi login` (or `kimi` and /login) and finish in the browser.' },
    loginHint: 'kimi login',
    probe: { args: ['--version'], signedOut: /never/, needsAuthFile: () => existsSync(join(home, '.kimi', 'credentials.json')) || existsSync(join(home, '.kimi', 'config.toml')) },
    parseModels: () => ['kimi-k3', 'kimi-k2.5'].map((id) => ({ id, label: id })),
    efforts: [],
    env: () => ({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
    // kimi 1.50: `--print` = non-interactive with auto-approval. `--output-format stream-json` is on
    // `kimi --help` (1.50). Session resume via --session <id> (ids come from `kimi export`).
    // Long prompts: drop `-p` (valued flag) and pipe stdin; `--input-format` "must be piped in via stdin"
    // (kimi 1.50 --help; Print.run reads stdin when `-p` is omitted). No --prompt-file. Threshold: grok's 8000.
    headlessArgs: (t) => {
      const long = !!(t.prompt && t.prompt.length > 8000);
      const args = ['--print', '-w', t.cwd, '--output-format', 'stream-json'];
      if (t.sandbox === 'read-only') args.push('--plan');
      else args.push('--yolo');
      if (long) args.push('--input-format', 'text');
      else args.push('-p', t.prompt);
      if (t.resumeThreadId) args.push('--session', t.resumeThreadId);
      if (t.model) args.push('--model', t.model);
      return { args, stdinPrompt: long };
    },
    parse: (obj, st, emit) => {
      const type = obj.type || obj.event;
      if ((obj.session_id || obj.sessionId) && !st.threadId) st.threadId = obj.session_id || obj.sessionId;
      const raw = obj.text ?? obj.content ?? obj.message?.content;
      const txt = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('') : '';
      if ((obj.role === 'assistant' || /^(assistant|message|agent_message|text)/i.test(String(type))) && txt) { P.message(st, emit, txt.trim()); st.text += txt; }
      else if (/tool_(use|call)/i.test(String(type))) P.toolStart(st, emit, obj.id || `kimi-${st.items.length}`, obj.name || obj.tool_name || 'tool', obj.input || obj.arguments);
      else if (/tool_result/i.test(String(type))) P.toolDone(st, emit, obj.id || obj.tool_use_id, obj.name || 'tool', typeof obj.output === 'string' ? obj.output : JSON.stringify(obj.output ?? obj.content ?? 'done'));
      if (obj.usage) P.addUsage(st, obj.usage, { input: 'input_tokens', output: 'output_tokens', cached: 'cached_tokens' });
      if (/^(result|done|complete|final)/i.test(String(type))) { st.finalText = obj.result ?? obj.response ?? st.text; if (obj.error || obj.status === 'error') st.error = String(obj.error?.message || obj.error || 'kimi run failed'); }
      else if (type === 'error') st.error = String(obj.error?.message || obj.error || obj.message);
      // Unrecognised objects (JSON-parseable echoed prompts) fall through; the runner calls parseText.
    },
    parseText: (line, st) => { st.text += line + '\n'; },
  },
};

// One-shot handoff: detect() stores a models-probe so the following listModels() does not spawn again.
const probeHandoff = new WeakMap();

/** Provider-module shape for the registry, built from a vendor spec. */
export function providerFor(spec) {
  let loginCmd;
  return {
    id: spec.id, label: spec.label, kind: 'vendor-cli',
    auth: { type: 'subscription', setup: spec.login?.note || `Run \`${spec.loginHint}\` in a terminal.` },
    spec,
    detect: async () => {
      const bin = spec.bin();
      if (!bin) return { installed: false, loggedIn: false, hint: spec.install?.win || spec.install?.posix };
      if (spec.probe?.needsAuthFile) return { installed: true, bin, loggedIn: spec.probe.needsAuthFile() };
      const r = await capture(bin, spec.probe.args, { timeoutMs: 40_000 });
      if (spec.probe.args?.[0] === 'models') probeHandoff.set(spec, { bin, argsKey: JSON.stringify(spec.probe.args), result: r });
      const signedOut = spec.probe.signedOut.test(r.out) || r.timedOut;
      return { installed: true, bin, loggedIn: !signedOut && (r.code === 0 || !/error/i.test(r.out)), detail: r.out.trim().split('\n')[0]?.slice(0, 120) };
    },
    listModels: async () => {
      const bin = spec.bin(); if (!bin) return [];
      // A CLI that can't self-list its models (qwen-code, kimi) ships a hard-coded default; `providers.<id>.models`
      // in config overrides it so a newly-released vendor model needs no code edit. Array of ids or {id,label}.
      const override = loadConfig().providers?.[spec.id]?.models;
      let list;
      if (Array.isArray(override) && override.length) list = override.map((m) => (typeof m === 'string' ? { id: m } : m));
      else if (spec.probe?.args?.[0] === 'models' && !spec.probe.needsAuthFile) {
        const hit = probeHandoff.get(spec);
        probeHandoff.delete(spec);
        const r = (hit && hit.bin === bin && hit.argsKey === JSON.stringify(spec.probe.args)) ? hit.result : await capture(bin, spec.probe.args, { timeoutMs: 40_000 });
        list = spec.parseModels(r.out);
      }
      else list = spec.parseModels('');
      if (spec.collapseEfforts) list = collapseEffortFamilies(list); // fold effort-in-id variants into family models (Antigravity)
      return list.map((m) => ({ provider: spec.id, id: m.id, label: m.label || m.id, description: spec.budgetLabel, efforts: m.efforts || spec.efforts || [], effortIds: m.effortIds || null, kind: 'agent', cost: 'subscription', isDefault: !!m.isDefault }));
    },
    pollLimits: spec.pollLimits ? () => spec.pollLimits(spec) : async () => ({ provider: spec.id, plan: 'subscription', blocked: false, windows: [] }),
    workerConfig: () => ({}),
    installCommand: () => (WIN ? spec.install?.win : spec.install?.posix) || null,
    loginCommand: () => {
      if (loginCmd !== undefined) return loginCmd;
      const bin = spec.bin() || spec.id;
      const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
      loginCmd = `${q(bin)}${spec.login?.args?.length ? ' ' + spec.login.args.join(' ') : ''}`;
      return loginCmd;
    },
    // Sub-command CLIs (grok/kimi: `<bin> login`) have a matching `<bin> logout`; re-auth runs it first so a stale
    // token (e.g. a free-tier grant that a new subscription must replace) is cleared before the fresh sign-in.
    logoutCommand: spec.login?.args?.[0] === 'login' ? () => { const bin = spec.bin() || spec.id; return `${/\s/.test(bin) ? `"${bin}"` : bin} logout`; } : undefined,
  };
}
