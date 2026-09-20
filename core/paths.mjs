// State directory + tiny persistence helpers. Everything on disk is written atomically.
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
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

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // On Windows renameSync throws EPERM/EACCES/EBUSY if another handle briefly holds the destination (a concurrent
  // reader, an AV scan). The rename is atomic, so retry it; never fall back to a direct overwrite of the destination
  // — a mid-write failure there (ENOSPC) would truncate the good file. On persistent failure leave the destination
  // untouched (old data still valid) and the tmp in place for recovery, then surface the error.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; }
    catch (e) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code) && i < 8) continue; // transient holder; retry the atomic rename
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
export const shortId = () => Math.random().toString(36).slice(2, 10);
