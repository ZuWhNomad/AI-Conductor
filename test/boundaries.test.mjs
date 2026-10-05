// Import boundaries between folders. Each code folder's CONTEXT.md states what it may import; this test is the
// enforcement, so a subagent briefed on one folder cannot quietly widen it. A violation is fixed by moving code, not
// by adding to KNOWN_DEBT — that list only shrinks.
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { REPO_ROOT } from '../core/paths.ts';

const CODE_DIRS = ['core', 'server', 'bin'];
const LEAVES = ['core/paths', 'core/proc', 'core/bus']; // extension-free: a module may be .mjs or .ts
const ORCHESTRATION = /^core\/(tasks|scorecard|sweep|limits|plans|tools|conductor|watchdog|jobs|bench)(\/|\.(mjs|ts)$)/;

// Edges that violate a rule today. Remove an entry when the code moves; the test fails if a listed edge is gone.
const KNOWN_DEBT = [];

function files(dir) {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true })
    .filter((f) => /\.(mjs|ts)$/.test(f))
    .map((f) => posix.join(dir, f.split('\\').join('/')));
}

function imports(file) {
  const src = readFileSync(join(REPO_ROOT, file), 'utf8');
  const out = [];
  for (const m of src.matchAll(/(?:^\s*import\s[^;]*?from\s*|^\s*import\s*|await\s+import\()\s*['"](\.\.?\/[^'"]+)['"]/gm)) {
    out.push(posix.normalize(posix.join(posix.dirname(file), m[1])));
  }
  return out;
}

function rule(from, to) {
  const starts = (p) => from.startsWith(p);
  if (starts('core/') && !to.startsWith('core/')) return 'core/ imports only core/';
  if (starts('server/') && !/^(core|server)\//.test(to)) return 'server/ imports only core/ (ui/ is served as static files)';
  if (starts('server/routes/') && to === 'server/index.mjs') return 'routes/ never imports server/index.mjs';
  if (starts('core/providers/') && to.startsWith('core/workers/')) return 'providers/ (catalog + meter) must not import workers/ (execution)';
  if (starts('core/workers/') && ORCHESTRATION.test(to)) return 'workers/ run one task and know nothing about the scheduler';
  if (LEAVES.includes(from.replace(/\.(mjs|ts)$/, '')) && !/^core\/paths\.(mjs|ts)$/.test(to)) return 'leaf modules import nothing of the repo but paths';
  return null;
}

test('every import stays inside its folder boundary (see each CONTEXT.md)', () => {
  const violations = [];
  for (const dir of CODE_DIRS) {
    for (const from of files(dir)) {
      for (const to of imports(from)) {
        const why = rule(from, to);
        if (why) violations.push({ edge: `${from} -> ${to}`, why });
      }
    }
  }
  const fresh = violations.filter((v) => !KNOWN_DEBT.includes(v.edge));
  assert.deepEqual(fresh, [], `new boundary violations:\n${fresh.map((v) => `  ${v.edge}  (${v.why})`).join('\n')}`);
  const paid = KNOWN_DEBT.filter((edge) => !violations.some((v) => v.edge === edge));
  assert.deepEqual(paid, [], `no longer violations — remove from KNOWN_DEBT: ${paid.join(', ')}`);
});

test('core/policy/ is text and JSON only', () => {
  const code = readdirSync(join(REPO_ROOT, 'core/policy'), { recursive: true }).filter((f) => /\.(mjs|js|cjs|ts)$/.test(f));
  assert.deepEqual(code, []);
});
