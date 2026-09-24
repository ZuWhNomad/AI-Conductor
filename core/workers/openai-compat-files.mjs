// File helpers shared by the API tool loop and its disposable search worker.
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { isInside } from '../context.mjs';

export const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__']);

/** A path segment that names a git metadata dir, including Windows aliases. */
function isGitSegment(name) {
  const n = String(name ?? '').replace(/[. ]+$/g, ''); // Windows trailing dot/space
  return n.toLowerCase() === '.git' || /^git~1$/i.test(n);
}

function hasGitSegment(pathish) {
  return String(pathish ?? '').split(/[/\\]/).some(isGitSegment);
}

export async function safePath(cwd, root, p, { mutate = false } = {}) {
  const a = resolve(cwd, p || '.');
  if (!isInside(cwd, a)) throw new Error(`path outside project: ${p}`);
  // lstat distinguishes missing paths from dangling links. Resolve the nearest existing
  // ancestor for new files; as before, this cannot prevent concurrent link swaps (TOCTOU).
  let existing = a;
  for (;;) {
    try { await lstat(existing); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; existing = dirname(existing); }
  }
  const realExisting = await realpath(existing);
  if (!isInside(root, realExisting)) throw new Error(`path outside project: ${p}`);
  if (mutate) {
    // Canonical = realpath(nearest existing ancestor) + unresolved remainder, so .GIT, .git.,
    // .git , and the 8.3 name GIT~1 are visible even when the leaf does not exist yet.
    const remainder = relative(existing, a);
    const canonical = remainder ? join(realExisting, remainder) : realExisting;
    const rel = relative(root, canonical);
    if (hasGitSegment(rel) || hasGitSegment(remainder) || hasGitSegment(p) || hasGitSegment(a)) {
      throw new Error(`refusing write inside .git: ${p}`);
    }
  }
  return a;
}

/** Read a bounded prefix, including short reads, and close the handle on every outcome. */
export async function readBytes(path, maxBytes) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    return buffer.subarray(0, used);
  } finally { await file.close(); }
}

async function search({ cwd, root, pattern, path }) {
  const re = new RegExp(pattern); const hits = [];
  const safe = (p) => safePath(cwd, root, p);
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = await safe(join(d, e.name));
      if (e.isDirectory()) await walk(p);
      else {
        const { size } = await stat(p);
        // Retain the existing file-size ceiling; a growing file cannot exceed the stat'd size.
        if (size < 2e6) {
          const lines = (await readBytes(p, size)).toString('utf8').split('\n');
          for (let i = 0; i < lines.length && hits.length < 200; i++) {
            if (re.test(lines[i])) hits.push(`${relative(cwd, p)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      }
      if (hits.length >= 200) return;
    }
  };
  await walk(await safe(path));
  return hits.join('\n') || '(no matches)';
}

// Both traversal and regex evaluation happen here, never in the server's tool loop.
if (!isMainThread && workerData?.type === 'openai-compat-search') {
  try { parentPort.postMessage({ result: await search(workerData) }); }
  catch (e) { parentPort.postMessage({ error: e.message }); }
}
