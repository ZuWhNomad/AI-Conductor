// State directory + tiny persistence helpers. Everything on disk is written atomically.
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function stateDir() {
  const d = process.env.CONDUCTOR_HOME || join(homedir(), '.conductor2');
  mkdirSync(d, { recursive: true });
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
  // reader, an AV scan). Retry the atomic rename a few times, then fall back to a direct overwrite so the write
  // is never lost (config/limits/journal writers all go through here).
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; }
    catch (e) {
      if (i >= 4 && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { writeFileSync(file, JSON.stringify(obj, null, 2)); } finally { try { unlinkSync(tmp); } catch {} } return; }
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { unlinkSync(tmp); } catch {} throw e; }
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
