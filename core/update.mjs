// Pull updates for this checkout from its git remote (the repo is worked on from more than one machine).
// Status is a fetch + counts; applying is a fast-forward pull plus `npm install` when the lockfile moved.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from './paths.mjs';
import { findCli } from './proc.mjs';
import { bus } from './bus.mjs';

let gitBin;
function git(args, { cwd = REPO_ROOT, timeout = 30_000 } = {}) {
  if (gitBin === undefined) gitBin = findCli('git');
  if (!gitBin) throw new Error('git is not installed (https://git-scm.com)');
  return execFileSync(gitBin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const lockHash = (cwd) => { try { return createHash('sha1').update(readFileSync(join(cwd, 'package-lock.json'))).digest('hex'); } catch { return null; } };

let last = null;
export const lastUpdateStatus = () => last;

/** { git, branch, head, remote, ahead, behind, dirty, error }. `fetch:false` reuses what the last fetch saw. */
export function updateStatus({ cwd = REPO_ROOT, fetch = true } = {}) {
  if (!existsSync(join(cwd, '.git'))) return (last = { git: false, error: 'not a git checkout (installed from a zip?) — clone the repo to get updates' });
  const st = { git: true, branch: null, head: null, remote: null, ahead: 0, behind: 0, dirty: 0, untracked: 0, error: null, checkedAt: new Date().toISOString() };
  try {
    st.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    st.head = git(['rev-parse', '--short', 'HEAD'], { cwd });
    try { st.remote = git(['remote', 'get-url', 'origin'], { cwd }); } catch { st.error = 'no origin remote'; return (last = st); }
    if (fetch) git(['fetch', '--quiet', 'origin'], { cwd, timeout: 60_000 });
    const counts = git(['rev-list', '--left-right', '--count', `HEAD...origin/${st.branch}`], { cwd }).split(/\s+/).map(Number);
    st.ahead = counts[0] || 0; st.behind = counts[1] || 0;
    const status = git(['status', '--porcelain'], { cwd }).split('\n').filter(Boolean);
    st.untracked = status.filter((l) => l.startsWith('??')).length; // informational only — untracked files never block a fast-forward
    st.dirty = status.length - st.untracked;                        // only tracked (staged/unstaged) edits gate the pull
  } catch (e) { st.error = String(e?.stderr || e?.message || e).trim().split('\n')[0]; }
  return (last = st);
}

/** Fast-forward to origin; refuses when there are local changes or local commits the remote lacks. */
export function applyUpdate({ cwd = REPO_ROOT, npm = true } = {}) {
  const st = updateStatus({ cwd });
  if (!st.git || st.error) throw Object.assign(new Error(st.error || 'not a git checkout'), { status: 400 });
  if (st.dirty) throw Object.assign(new Error(`${st.dirty} local change(s) not committed — commit or stash them first (GitHub Desktop shows them)`), { status: 409 });
  if (st.ahead) throw Object.assign(new Error(`this machine has ${st.ahead} commit(s) the remote lacks — push them first, then update`), { status: 409 });
  if (!st.behind) return { updated: false, head: st.head, npmInstalled: false, restartNeeded: false };
  const before = lockHash(cwd);
  try {
    git(['pull', '--ff-only', '--quiet', 'origin', st.branch], { cwd, timeout: 120_000 });
  } catch (e) {
    // A ff-pull can still fail in the rare case an incoming tracked file would overwrite an existing untracked file.
    // Surface it clearly (409) so callers fall back gracefully — the UI shows the message / keeps the flashing button,
    // and the auto path just logs and re-checks later — never a dead or looping state (HEAD didn't move → no restart).
    const msg = String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).slice(0, 2).join(' ');
    throw Object.assign(new Error(`update pull failed — a local file may block the fast-forward: ${msg}`), { status: 409 });
  }
  const head = git(['rev-parse', '--short', 'HEAD'], { cwd });
  let npmInstalled = false;
  if (npm && lockHash(cwd) !== before) {
    const npmBin = findCli('npm');
    if (npmBin) { execFileSync(npmBin, ['install', '--no-fund', '--no-audit'], { cwd, windowsHide: true, timeout: 600_000, stdio: 'ignore' }); npmInstalled = true; }
  }
  last = null;
  const r = { updated: true, from: st.head, to: head, commits: st.behind, npmInstalled, restartNeeded: true };
  bus.publish('update', { ...r });
  return r;
}

/** Background check after start: tells the UI when the remote is ahead. Silent on any failure. */
export function checkForUpdates() {
  try { const st = updateStatus(); if (st.git && !st.error && st.behind) bus.publish('update', { behind: st.behind, head: st.head }); return st; } catch { return null; }
}

export function formatUpdate(st) {
  if (!st.git) return st.error;
  if (st.error) return `${st.branch}@${st.head}: ${st.error}`;
  return `${st.branch}@${st.head} ← ${st.remote}: ${st.behind ? `${st.behind} update(s) available` : 'up to date'}${st.ahead ? `, ${st.ahead} local commit(s) not pushed` : ''}${st.dirty ? `, ${st.dirty} uncommitted change(s)` : ''}${st.untracked ? `, ${st.untracked} untracked` : ''}`;
}
