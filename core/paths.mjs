// State directory + tiny persistence helpers. Everything on disk is written atomically.
import fs, { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** CONDUCTOR_HOME, else a `.state/` folder beside the code (a dev checkout: own state and port, never the daily driver's), else ~/.conductor2. */
let localState; // checked once per process: statePath() runs on every hot path
export const resolveStateDir = () => process.env.CONDUCTOR_HOME || (localState ??= existsSync(join(REPO_ROOT, '.state')) ? join(REPO_ROOT, '.state') : join(homedir(), '.conductor2'));

let madeDir = null;
export function stateDir() {
  const d = resolveStateDir();
  if (d !== madeDir) { mkdirSync(d, { recursive: true }); madeDir = d; }
  return d;
}

export const statePath = (...p) => join(stateDir(), ...p);

/** Parse JSON from disk. Strips a leading U+FEFF. Distinguishes missing from exists-but-unparseable. */
export function tryReadJson(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false, error: e };
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, missing: false, error: e }; }
}

export function readJson(file, fallback = null) {
  try {
    const r = tryReadJson(file);
    if (r.ok) return r.value;
    return fallback;
  } catch { return fallback; }
}

// --- Secrets. One redactor for every text Conductor persists or shows: writeJson/appendNdjson below, the event bus,
// the HTTP API, worker results, the crash log and the feedback bundle all call it. Known key shapes (masked ones too,
// e.g. OpenAI's 401 echo "Incorrect API key provided: sk-svcac****…fvMA") plus the literal values of the keys this
// machine has configured (config.json, and *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD environment variables).
export const REDACTED = '[redacted]';
const KEY_SHAPES = [
  [/\b(Bearer\s+)[\w.~+/=*•…-]{8,}/gi, `$1${REDACTED}`],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]+)?/g, REDACTED],   // JWT
  [/\bsk-[\w*•…-]{8,}/g, REDACTED],                        // OpenAI / Anthropic: sk-, sk-proj-, sk-svcacct-, sk-ant-, masked forms
  [/\bxai-[\w*•…-]{20,}/g, REDACTED],                      // xAI
  [/\bAIza[\w-]{30,}/g, REDACTED],                         // Google
];
const MAYBE_KEY = /sk-|xai-|AIza|earer|eyJ/;
const SECRET_NAME = /key|token|secret|password|credential|bearer|authorization/i;
let literalCache = { at: 0, values: [] };
function secretLiterals() {
  if (Date.now() - literalCache.at < 5000) return literalCache.values;
  const out = new Set();
  const walk = (v, name) => {
    if (typeof v === 'string') { if (v.length >= 12 && SECRET_NAME.test(name)) out.add(v); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? name : k);
  };
  walk(readJson(join(resolveStateDir(), 'config.json'), {}), '');
  for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 12 && /(api_?key|token|secret|password)$/i.test(k)) out.add(v);
  literalCache = { at: Date.now(), values: [...out] };
  return literalCache.values;
}
/** Text with every known secret replaced by [redacted]. Non-strings pass through. */
export function redact(text) {
  if (typeof text !== 'string' || text.length < 8) return text;
  let s = text;
  if (MAYBE_KEY.test(s)) for (const [re, to] of KEY_SHAPES) s = s.replace(re, to);
  for (const v of secretLiterals()) if (s.includes(v)) s = s.split(v).join(REDACTED);
  return s;
}
/** redact() over every string of a plain object/array. Returns the input itself when nothing changed; never mutates. */
export function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (!v || typeof v !== 'object' || depth > 12) return v;
  let out = null;
  if (Array.isArray(v)) { v.forEach((x, i) => { const y = redactDeep(x, depth + 1); if (y !== x) (out ||= v.slice())[i] = y; }); return out || v; }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  for (const [k, x] of Object.entries(v)) { const y = redactDeep(x, depth + 1); if (y !== x) (out ||= { ...v })[k] = y; }
  return out || v;
}

/** Atomic JSON write, redacted. `secrets: true` only for the file that legitimately holds keys (config.json). */
export function writeJson(file, obj, { secrets = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(obj, null, 2);
  if (secrets) literalCache.at = 0; // a key may have changed: re-read the literals on the next redact()
  writeFileSync(tmp, secrets ? text : redact(text));
  // On Windows renameSync throws EPERM/EACCES/EBUSY if another handle briefly holds the destination (a concurrent
  // reader, an AV scan). The rename is atomic, so retry it; never fall back to a direct overwrite of the destination
  // — a mid-write failure there (ENOSPC) would truncate the good file. On persistent failure leave the destination
  // untouched (old data still valid) and the tmp in place for recovery, then surface the error.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code) && i < 8) {
        Atomics.wait(pause, 0, 0, 1 + i); // backoff across the existing 8 retries so a transient Windows handle can drop
        continue;
      }
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { unlinkSync(tmp); } catch {} } // real error: don't leave a stray tmp
      throw Object.assign(e, { message: `writeJson: could not atomically replace ${file} (${e.code}); original left intact${['EPERM', 'EACCES', 'EBUSY'].includes(e.code) ? `, new content in ${tmp}` : ''}` });
    }
  }
}

export function appendNdjson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, redact(JSON.stringify(obj)) + '\n');
}

/** The last `bytes` of a file as UTF-8 ('' when missing). For big logs read at the end of a run (a session rollout). */
export function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, Math.max(0, bytes));
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

export function readNdjson(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

export const nowIso = () => new Date().toISOString();
export function shortId(taken = (id) => existsSync(statePath('tasks', `${id}.json`))) {
  let id;
  do { id = Math.random().toString(36).slice(2, 10); } while (taken(id));
  return id;
}
