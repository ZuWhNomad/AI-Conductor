// File-size ratchet (non-blank lines). ALLOWED_OVER may only shrink: a listed file that is still
// over its cap but under its number passes — lower that number the next time you touch the file.
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CAP = { code: 500, test: 700, context: 110 };
const ALLOWED_OVER = {
  'core/smoke/battery.mjs': 789,
  'core/tasks.mjs': 864,
  'server/index.mjs': 519,
  'test/limits/polling.test.mjs': 918,
  'test/scorecard/recommend.test.mjs': 1355,
  'test/server/server.test.mjs': 789,
  'test/smoke/smoke.test.mjs': 752,
  'test/ui/layout.test.mjs': 729,
};

const excluded = (rel) => ['node_modules', 'core/smoke/private', 'core/policy'].some((p) => rel === p || rel.startsWith(`${p}/`));

function* walk(dir, rel = '') {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const next = `${rel ? `${rel}/` : ''}${ent.name}`.split('\\').join('/');
    if (excluded(next) || (ent.isDirectory() && ent.name.startsWith('.'))) continue;
    if (ent.isDirectory()) yield* walk(join(dir, ent.name), next);
    else yield next;
  }
}

function kind(rel) {
  if (rel === 'CONTEXT.md' || rel.endsWith('/CONTEXT.md')) return 'context';
  if (/^test\/.*\.test\.(mjs|ts)$/.test(rel)) return 'test';
  if (/^(core|server|bin|ui)\/.*\.(mjs|ts|js)$/.test(rel)) return 'code';
  return null;
}

const nonBlank = (rel) => readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/).filter((line) => line.trim()).length;

test('files stay within size caps; ALLOWED_OVER only shrinks', () => {
  const seen = new Set();
  const problems = [];
  for (const rel of walk(ROOT)) {
    const group = kind(rel);
    if (!group) continue;
    const count = nonBlank(rel);
    const listed = ALLOWED_OVER[rel];
    if (listed == null) {
      if (count > CAP[group]) problems.push(`${rel} has ${count} non-blank lines, cap ${CAP[group]}`);
    } else {
      seen.add(rel);
      if (count <= CAP[group]) problems.push(`remove ${rel} from ALLOWED_OVER`);
      else if (count > listed) problems.push(`ratchet: ${rel} grew from ${listed} to ${count}`);
    }
  }
  for (const rel of Object.keys(ALLOWED_OVER)) if (!seen.has(rel)) problems.push(`remove ${rel} from ALLOWED_OVER`);
  assert.equal(problems.length, 0, problems.join('\n'));
});
