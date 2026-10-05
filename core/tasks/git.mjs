// Git helpers for the task path and the `isolate: true` worktree plumbing (links, excludes, repo size). Best effort and
// async; no task state: the worktree lifecycle that reads or journals tasks stays in ../tasks.mjs.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, isAbsolute, relative, resolve } from 'node:path';
import { loadConfig, DEFAULTS } from '../config.mjs';
import { findCli } from '../proc.ts';

// --- git helpers (best effort; silent when not a repo or git is missing). All async: they run on the dispatch path,
// and a synchronous git call per task (up to 10 s each) stalled every chat and poll when tasks started together. ---
// Resolved per call, not at import: this module is shared by every tasks.mjs instance, and a fresh instance (tests)
// must still see a child_process.execFile patched after the first import, as when this code lived in tasks.mjs.
const execFileP = (...args) => promisify(execFile)(...args);
// E4: walk parent directories to find a .git file or directory (so a cwd in a repo subdirectory also gets git status).
// Stops at the filesystem root. Returns null without spawning if no .git found.
export function findGitRoot(cwd) {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}
let gitBin;
async function git(cwd, args) {
  const root = findGitRoot(cwd);
  if (!root) return null;
  if (gitBin === undefined) gitBin = findCli('git');
  if (!gitBin) return null;
  try { return (await execFileP(gitBin, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })).stdout; } catch { return null; }
}
export async function gitExec(cwd, args, timeout = 10_000) {
  const root = findGitRoot(cwd) || cwd;
  if (gitBin === undefined) gitBin = findCli('git');
  if (!gitBin) throw new Error('git is not installed');
  try {
    return (await execFileP(gitBin, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (e) {
    throw new Error(String(e.stderr || e.message || e).trim() || `git ${args[0]} failed`);
  }
}
export async function gitStatus(cwd) {
  const root = findGitRoot(cwd);
  if (!root) return null;
  const out = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (out == null) return null;
  const relName = (porcelain) => relative(cwd, join(root, porcelain)).replaceAll('\\', '/');
  const entries = out.split('\0'); const statusMap = new Map(); const untracked = [], tracked = [];
  for (let i = 0; i < entries.length; i++) {
    const l = entries[i]; if (!l) continue;
    const porcelain = l.slice(3); const status = l.slice(0, 2); const name = relName(porcelain);
    if (/[RC]/.test(status)) i++; // -z emits the original name after a rename/copy destination.
    if (status === '??') untracked.push(porcelain);
    else tracked.push(porcelain);
    statusMap.set(name, status);
  }
  // An untracked file carries its mtime+size, so an edit to it counts as a change too.
  await Promise.all(untracked.map(async (porcelain) => { try { const s = await stat(join(root, porcelain)); statusMap.set(relName(porcelain), `?? ${s.mtimeMs}:${s.size}`); } catch {} }));
  // Porcelain stays " M" when a worker edits an already-dirty file; compare its content too.
  // E5: files above 8 MiB use mtime+size to avoid hashing large files on the main thread (twice per task).
  // Same-size same-mtime edits are detectable for small files only; the spec pins this at 8 MiB.
  const LARGE_FILE_BYTES = 8 * 1024 * 1024;
  await Promise.all(tracked.map(async (porcelain) => {
    try {
      const name = relName(porcelain);
      const s = await stat(join(root, porcelain));
      let fingerprint;
      if (s.size >= LARGE_FILE_BYTES) {
        fingerprint = `${s.mtimeMs}:${s.size}`;
      } else {
        fingerprint = createHash('sha256').update(await readFile(join(root, porcelain))).digest('hex');
      }
      statusMap.set(name, `${statusMap.get(name)} ${fingerprint}`);
    } catch {}
  }));
  return statusMap;
}
/** Pure: files whose status differs between two snapshots (everything, when there was no before). */
export function diffStatus(before, after) {
  if (!after) return [];
  if (!before) return [...after.keys()];
  return [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f));
}
async function changedSince(cwd, before) { return diffStatus(before, await gitStatus(cwd)); }
export async function gitDiffStat(cwd, status = null, observed = null) {
  if (observed && !observed.length) return '';
  const root = findGitRoot(cwd);
  if (!root) return '';
  const paths = observed?.map((name) => `:(top,literal)${relative(root, resolve(cwd, name)).replaceAll('\\', '/')}`) || [];
  const [a, b] = await Promise.all([git(cwd, ['diff', '--stat', '--', ...paths]), git(cwd, ['diff', '--cached', '--stat', '--', ...paths])]);
  const untracked = [...(status || await gitStatus(cwd) || [])].filter(([name, s]) => s.startsWith('??') && (!observed || observed.includes(name))).map(([name]) => name).slice(0, 50);
  return [((a || '') + (b || '')).trim().slice(0, 3000), untracked.length ? `untracked: ${untracked.join(', ')}` : ''].filter(Boolean).join('\n');
}

export const _git = { gitStatus, changedSince, gitDiffStat, diffStatus };

export function isolatedCwd(t) {
  if (!t.isolation?.dir) return t.cwd;
  const root = findGitRoot(t.cwd);
  if (!root) return t.isolation.dir;
  const rel = relative(root, resolve(t.cwd));
  if (!rel || rel.startsWith('..') || rel === '.') return t.isolation.dir;
  return join(t.isolation.dir, rel);
}

function isolateLinkNames() {
  const names = loadConfig().worker.isolateLinks;
  return Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n && !/[\\/]/.test(n)) : [...DEFAULTS.worker.isolateLinks];
}

function isolateLinkSpecs(sourceRoot, worktreeDir, taskCwd) {
  const rels = [''];
  const rel = relative(sourceRoot, resolve(taskCwd || sourceRoot));
  if (rel && !rel.startsWith('..') && rel !== '.') rels.push(rel);
  const out = [];
  for (const folder of rels) {
    for (const name of isolateLinkNames()) {
      const src = folder ? join(sourceRoot, folder, name) : join(sourceRoot, name);
      const dst = folder ? join(worktreeDir, folder, name) : join(worktreeDir, name);
      const pattern = (folder ? `${folder.replaceAll('\\', '/')}/${name}` : name);
      out.push({ src, dst, pattern });
    }
  }
  return out;
}

async function ensureExcluded(worktreeDir, pattern) {
  try { await gitExec(worktreeDir, ['check-ignore', '-q', '--', pattern]); return; } catch {}
  const gitPath = (await gitExec(worktreeDir, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const file = isAbsolute(gitPath) ? gitPath : join(worktreeDir, gitPath);
  mkdirSync(dirname(file), { recursive: true });
  let cur = '';
  try { cur = readFileSync(file, 'utf8'); } catch {}
  if (cur.split(/\r?\n/).includes(pattern)) return;
  appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

export async function linkIsolateDirs(t, sourceRoot, worktreeDir) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  for (const { src, dst, pattern } of isolateLinkSpecs(sourceRoot, worktreeDir, t.cwd)) {
    let srcDir = false;
    try { srcDir = statSync(src).isDirectory(); } catch {}
    if (!srcDir || existsSync(dst)) continue;
    try {
      symlinkSync(src, dst, type);
      await ensureExcluded(worktreeDir, pattern);
    } catch (e) {
      t.warning = [t.warning, `isolate link ${pattern} failed: ${e.message}`].filter(Boolean).join(' ');
    }
  }
}

export function unlinkIsolateLinks(sourceRoot, worktreeDir, taskCwd) {
  if (!worktreeDir || !existsSync(worktreeDir)) return;
  for (const { dst } of isolateLinkSpecs(sourceRoot, worktreeDir, taskCwd)) {
    let linked = false;
    try { linked = lstatSync(dst).isSymbolicLink(); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot inspect isolate link ${dst}: ${e.message}`); }
    if (!linked) continue;
    try { rmdirSync(dst); }
    catch {
      try { unlinkSync(dst); } catch {}
    }
  }
  // Fail closed: git worktree remove --force may recursively follow a surviving Windows junction into the source.
  // Every configured destination must be absent before any worktree removal is allowed to begin.
  for (const { dst } of isolateLinkSpecs(sourceRoot, worktreeDir, taskCwd)) {
    let remains = false;
    try { remains = lstatSync(dst).isSymbolicLink(); } // a real folder (e.g. the worker ran npm ci) cannot reach the source
    catch (e) { if (e.code === 'ENOENT') continue; throw new Error(`cannot verify isolate link removal ${dst}: ${e.message}`); }
    if (remains) throw new Error(`isolate link still exists; worktree removal aborted: ${dst}`);
  }
}

export function ageLabel(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function formatWorktrees(entries) {
  if (!entries.length) return 'no worktrees';
  return entries.map((e) => `${e.taskId}  ${e.branch || '-'}  ${e.status}  ${e.age}${e.pruned ? '  pruned' : ''}${e.error ? `  ${e.error}` : ''}`).join('\n');
}

// Tracked-file count and bytes of a task's repo (git ls-tree at HEAD), cached per cwd for ten minutes: the cheap
// "small project or large repo" signal recorded on every run row, so tool scores can later be split by it.
const sizeCache = new Map();
export async function repoSize(cwd) {
  const hit = sizeCache.get(cwd); if (hit && Date.now() - hit.at < 600_000) return hit.v;
  let v = { repoFiles: null, repoBytes: null };
  const out = await git(cwd, ['ls-tree', '-r', '-l', 'HEAD']);
  if (out != null) { let files = 0, bytes = 0; for (const line of out.split('\n')) { const m = /^\S+ blob \S+\s+(\d+|-)\t/.exec(line); if (m) { files++; bytes += Number(m[1]) || 0; } } v = { repoFiles: files, repoBytes: bytes }; }
  sizeCache.set(cwd, { at: Date.now(), v });
  return v;
}
