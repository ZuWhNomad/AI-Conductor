import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './_env.mjs';

const { findContextFiles, contextBlock, folderTree, isInside } = await import('../core/context.mjs');

test('context notes are discovered root-first and de-duplicated', () => {
  const root = tmpDir('ctx');
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
  writeFileSync(join(root, 'CLAUDE.md'), '# root notes');
  writeFileSync(join(root, 'sub', 'CONTEXT.md'), '# sub notes');
  writeFileSync(join(root, 'sub', 'deep', 'file.js'), 'x');
  const files = findContextFiles(root, ['sub/deep/file.js', 'sub/deep']).map((f) => f.file.replaceAll('\\', '/'));
  assert.deepEqual(files, ['CLAUDE.md', 'sub/CONTEXT.md']);
  const block = contextBlock(root, ['sub/deep/file.js']);
  assert.match(block, /<context file="CLAUDE.md">/);
  assert.match(block, /# sub notes/);
  assert.equal(contextBlock(tmpDir('empty'), []), '');
  assert.match(folderTree(root), /notes: CONTEXT.md/);
  assert.equal(isInside(root, join(root, 'sub')), true);
  assert.equal(isInside(root, join(root, '..')), false);
});

test('context block is capped', () => {
  const root = tmpDir('cap');
  writeFileSync(join(root, 'CONTEXT.md'), 'x'.repeat(20000));
  const [f] = findContextFiles(root, [], { maxChars: 1000 });
  assert.ok(f.content.length < 1100);
  assert.match(f.content, /truncated/);
});
