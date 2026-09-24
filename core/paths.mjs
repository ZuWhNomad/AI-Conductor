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

export function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
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
  appendFileSync(file, JSON.stringify(obj) + '\n');
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
