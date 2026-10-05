import { readFileSync } from 'node:fs';

// Concatenate the UI with import/export lines removed so tests can eval the functions.
// Order comes from ui/modules/CONTEXT.md, except update.js is placed just after sessions.js:
// replay.test.mjs slices from onSessionEvent up to the update banner, which is empty if that banner comes first.
export function uiSource(root) {
  const text = readFileSync(new URL('modules/CONTEXT.md', root), 'utf8');
  const files = [...text.matchAll(/^\d+\.\s+`([^`]+)`/gm)].map((m) => m[1].startsWith('../') ? m[1].slice(3) : `modules/${m[1]}`);
  if (!files.length) throw new Error('ui/modules/CONTEXT.md has no import-order list');
  const update = files.indexOf('modules/update.js');
  const sessions = files.indexOf('modules/sessions.js');
  if (update !== -1 && sessions !== -1 && update < sessions) {
    files.splice(update, 1);
    files.splice(files.indexOf('modules/sessions.js') + 1, 0, 'modules/update.js');
  }
  return files.map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n').replace(/^\s*import\b.*$/gm, '').replace(/^\s*export\b.*$/gm, '');
}
