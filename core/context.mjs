// Context notes: discover CLAUDE.md / AGENTS.md / CONTEXT.md relevant to a set of paths and build
// an injection block for worker specs. Keeps large projects modular: a worker only sees the notes
// for the folders it touches.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const NOTE_NAMES = ['CONTEXT.md', 'CLAUDE.md', 'AGENTS.md'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.conductor2']);

/** Note files from each path's directory up to the project root (root first), de-duplicated. */
export function findContextFiles(cwd, paths = [], { maxChars = 12000 } = {}) {
  const root = resolve(cwd);
  const seen = new Set();
  const out = [];
  const dirs = new Set([root]);
  for (const p of paths) {
    let d = resolve(root, p);
    try { if (statSync(d).isFile()) d = dirname(d); } catch { d = dirname(d); }
    while (d.startsWith(root)) { dirs.add(d); if (d === root) break; d = dirname(d); }
  }
  const ordered = [...dirs].sort((a, b) => a.length - b.length);
  let total = 0;
  for (const d of ordered) {
    for (const n of NOTE_NAMES) {
      const f = join(d, n);
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      let content = readFileSync(f, 'utf8');
      if (total + content.length > maxChars) content = content.slice(0, Math.max(0, maxChars - total)) + '\n…(truncated)';
      total += content.length;
      out.push({ file: relative(root, f) || n, content });
      if (total >= maxChars) return out;
    }
  }
  return out;
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
  const r = resolve(root); const a = isAbsolute(p) ? resolve(p) : resolve(r, p);
  return a === r || a.startsWith(r + sep);
}
