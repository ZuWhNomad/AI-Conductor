import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fs from 'node:fs';

const { readJson, tryReadJson, writeJson } = await import('../core/paths.mjs');

test('readJson strips a leading BOM and distinguishes missing from unparseable', () => {
  const dir = tmpDir('paths-bom');
  const file = join(dir, 'x.json');
  writeFileSync(file, '\uFEFF{"a":1}');
  assert.deepEqual(readJson(file), { a: 1 });
  assert.deepEqual(tryReadJson(file), { ok: true, value: { a: 1 } });

  writeFileSync(file, '{nope');
  assert.equal(readJson(file, 'fallback'), 'fallback');
  const bad = tryReadJson(file);
  assert.equal(bad.ok, false);
  assert.equal(bad.missing, false);

  const missing = tryReadJson(join(dir, 'no-such.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  assert.equal(readJson(join(dir, 'no-such.json'), 42), 42);
});

test('writeJson backs off with Atomics.wait between rename retries', (ctx) => {
  const waits = [];
  ctx.mock.method(Atomics, 'wait', (_ta, _i, _v, ms) => { waits.push(ms); });
  const orig = fs.renameSync;
  let n = 0;
  ctx.mock.method(fs, 'renameSync', (a, b) => {
    if (n++ < 2) { const e = new Error('busy'); e.code = 'EPERM'; throw e; }
    return orig(a, b);
  });
  const file = join(tmpDir('paths-x5'), 'x.json');
  writeJson(file, { ok: true });
  assert.equal(n, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ok: true });
});
