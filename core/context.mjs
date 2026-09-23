// Context notes: discover CLAUDE.md / AGENTS.md / CONTEXT.md relevant to a set of paths and build
// an injection block for worker specs. Keeps large projects modular: a worker only sees the notes
// for the folders it touches.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const NOTE_NAMES = ['CONTEXT.md', 'CLAUDE.md', 'AGENTS.md'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.conductor2']);

/** True when `p` resolves to a real path inside `rootReal` (already realpath'd). Missing or dangling paths are outside. */
function realpathInside(rootReal, p) {
  try { return isInside(rootReal, realpathSync(p)); } catch { return false; }
}

/** Note files from each path's directory up to the project root (root first), de-duplicated by file and by content. */
export function findContextFiles(cwd, paths = [], { maxChars = 12000 } = {}) {
  const root = resolve(cwd);
  let rootReal; try { rootReal = realpathSync(root); } catch { return []; }
  const seen = new Set();
  const out = [];
  const dirs = new Set([root]);
  for (const p of paths) {
    let d = resolve(root, p);
    try { if (statSync(d).isFile()) d = dirname(d); } catch { d = dirname(d); }
    while (isInside(root, d)) { dirs.add(d); const parent = dirname(d); if (parent === d) break; d = parent; }
  }
  const ordered = [...dirs].sort((a, b) => a.length - b.length);
  for (const d of ordered) {
    for (const n of NOTE_NAMES) {
      let f = join(d, n);
      if (!existsSync(f) || !realpathInside(rootReal, f)) continue;
      let content = readFileSync(f, 'utf8');
      const ptr = content.trim().match(/^@(\S+)$/); // a pure pointer (CLAUDE.md = "@AGENTS.md"): inject what it points at, once
      const target = ptr && join(d, ptr[1]);
      if (target && realpathInside(rootReal, target)) { try { content = readFileSync(target, 'utf8'); f = target; } catch {} }
      if (seen.has(f) || seen.has(content.trim())) continue; // same file, or a byte-identical copy (CLAUDE.md == AGENTS.md)
      seen.add(f); seen.add(content.trim());
      out.push({ file: relative(root, f) || n, content });
    }
  }
  // The cap trims from the root end: the deepest note is the most specific to the paths being touched.
  let left = maxChars, i = out.length;
  while (i > 0 && left > 0) {
    const o = out[--i], take = Math.min(left, o.content.length);
    if (take < o.content.length) o.content = o.content.slice(0, take) + '\n…(truncated)';
    left -= take;
  }
  return out.slice(i);
}

export function contextBlock(cwd, paths = []) {
  const files = findContextFiles(cwd, paths);
  if (!files.length) return '';
  return files.map((f) => `<context file="${f.file}">\n${f.content.trim()}\n</context>`).join('\n\n');
}

/** Folder tree summary (depth-limited) for the conductor's `context_init` helper. */
export function folderTree(cwd, { depth = 3 } = {}) {
  const root = resolve(cwd);
  const lines = [];
  const walk = (d, lvl) => {
    if (lvl > depth) return;
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    const dirs = entries.filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'));
    const files = entries.filter((e) => e.isFile()).length;
    const notes = NOTE_NAMES.filter((n) => existsSync(join(d, n)));
    lines.push(`${'  '.repeat(lvl)}${relative(root, d) || '.'}${sep}  (${files} files${notes.length ? `, notes: ${notes.join(', ')}` : ''})`);
    for (const e of dirs) walk(join(d, e.name), lvl + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}

export function isInside(root, p) {
  let r = resolve(root); let a = isAbsolute(p) ? resolve(p) : resolve(r, p);
  if (process.platform === 'win32') { r = r.toLowerCase(); a = a.toLowerCase(); }
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}
