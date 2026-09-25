// Private grader material for implement-6: the grader-side differ and seeded cases, the reference applier, the hidden
// test and the mutants/variants that prove the grader (see test/smoke). Every body here carries the canary line.
import { rng, marked } from './common.mjs';

// --- grader-side reference differ (never shown to the model) ---
// Lines keep their newline: "a\nb" -> ["a\n", "b"]; "" -> []. A last line without "\n" is a different line from one with it.
const toLines = (t) => (t === '' ? [] : t.split(/(?<=\n)/));

export function unifiedDiff(a, b, context = 3) {
  const A = toLines(a), B = toLines(b), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push(['-', A[i]]); i++; }
    else { ops.push(['+', B[j]]); j++; }
  }
  // Within a change block, deletions come before insertions (GNU and git order).
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === ' ') { k++; continue; }
    let e = k; while (e < ops.length && ops[e][0] !== ' ') e++;
    const block = ops.slice(k, e); ops.splice(k, e - k, ...block.filter((o) => o[0] === '-'), ...block.filter((o) => o[0] === '+')); k = e;
  }
  const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return '';
  const hunks = []; let start = Math.max(0, changed[0] - context), end = Math.min(ops.length, changed[0] + 1 + context);
  for (const k of changed.slice(1)) {
    if (k - context <= end) end = Math.min(ops.length, k + 1 + context);
    else { hunks.push([start, end]); start = Math.max(0, k - context); end = Math.min(ops.length, k + 1 + context); }
  }
  hunks.push([start, end]);
  const oldBefore = [0], newBefore = [0];
  for (const [t] of ops) { oldBefore.push(oldBefore.at(-1) + (t !== '+' ? 1 : 0)); newBefore.push(newBefore.at(-1) + (t !== '-' ? 1 : 0)); }
  const fmt = (s, c) => (c === 1 ? `${s}` : `${s},${c}`);
  let out = '';
  for (const [s, e] of hunks) {
    const oc = oldBefore[e] - oldBefore[s], nc = newBefore[e] - newBefore[s];
    out += `@@ -${fmt(oc ? oldBefore[s] + 1 : oldBefore[s], oc)} +${fmt(nc ? newBefore[s] + 1 : newBefore[s], nc)} @@\n`;
    for (const [t, line] of ops.slice(s, e)) out += `${t}${line.replace(/\n$/, '')}\n${line.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
  }
  return out;
}

export const PATCH = `// kq7Vx2Lm9Rt4
// Apply a single-file unified diff. Lines carry their own newline; the marker "\\ No newline at end of file"
// removes it from the preceding patch line. Each hunk applies at its stated position or, if its old lines do not
// match there, at the nearest position where they do (later positions first); a hunk that fits nowhere throws.
const toLines = (t) => (t === '' ? [] : t.split(/(?<=\\n)/));

export function applyPatch(text, patch) {
  const lines = toLines(String(text));
  let shift = 0;
  parse(String(patch)).forEach((h, n) => {
    const expected = (h.oldCount === 0 ? h.oldStart : h.oldStart - 1) + shift;
    const pos = locate(lines, h.old, expected);
    if (pos < 0) throw new Error(\`hunk \${n + 1} does not apply\`);
    lines.splice(pos, h.old.length, ...h.new);
    shift += (pos - expected) + (h.new.length - h.old.length);
  });
  return lines.join('');
}

function locate(lines, old, expected) {
  const fits = (p) => p >= 0 && p + old.length <= lines.length && old.every((l, k) => lines[p + k] === l);
  for (let d = 0; d <= lines.length; d++) { if (fits(expected + d)) return expected + d; if (d && fits(expected - d)) return expected - d; }
  return -1;
}

function parse(patch) {
  const hunks = []; let h = null;
  for (const raw of patch.split('\\n')) {
    const line = raw.endsWith('\\r') ? raw.slice(0, -1) : raw;
    const m = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/.exec(line);
    if (m) { h = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], old: [], new: [], last: null }; hunks.push(h); continue; }
    if (!h) continue; // file headers before the first hunk
    if (line.startsWith('\\\\')) { for (const side of h.last || []) side[side.length - 1] = side[side.length - 1].replace(/\\n$/, ''); continue; }
    if (h.old.length >= h.oldCount && h.new.length >= h.newCount) { h = null; continue; } // hunk complete; ignore trailing text
    const t = line[0], body = line.slice(1) + '\\n';
    if (t === ' ' || line === '') { h.old.push(body); h.new.push(body); h.last = [h.old, h.new]; }
    else if (t === '-') { h.old.push(body); h.last = [h.old]; }
    else if (t === '+') { h.new.push(body); h.last = [h.new]; }
    else throw new Error(\`hunk \${hunks.length} is malformed\`);
  }
  return hunks;
}
`;

export const PATCH_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from './patch.mjs';

test('replaces a line in the middle', () => {
  assert.equal(applyPatch('alpha\\nbeta\\ngamma\\ndelta\\n', '@@ -1,4 +1,4 @@\\n alpha\\n-beta\\n+BETA\\n gamma\\n delta\\n'), 'alpha\\nBETA\\ngamma\\ndelta\\n');
});
test('file headers and a count-omitted range', () => {
  assert.equal(applyPatch('one\\n', '--- a/f.txt\\n+++ b/f.txt\\n@@ -1 +1,2 @@\\n one\\n+two\\n'), 'one\\ntwo\\n');
});
test('deletes everything', () => { assert.equal(applyPatch('a\\nb\\n', '@@ -1,2 +0,0 @@\\n-a\\n-b\\n'), ''); });
test('finds the hunk at an offset', () => {
  assert.equal(applyPatch('x\\ny\\nz\\nalpha\\nbeta\\ngamma\\n', '@@ -1,3 +1,3 @@\\n alpha\\n-beta\\n+BETA\\n gamma\\n'), 'x\\ny\\nz\\nalpha\\nBETA\\ngamma\\n');
});
test('no newline at end of file', () => {
  assert.equal(applyPatch('a\\nb', '@@ -1,2 +1,2 @@\\n a\\n-b\\n\\\\ No newline at end of file\\n+b\\n'), 'a\\nb\\n');
});
test('a hunk that fits nowhere throws', () => { assert.throws(() => applyPatch('a\\nb\\n', '@@ -1,2 +1,2 @@\\n a\\n-c\\n+d\\n'), /hunk 1/); });
test('an empty patch changes nothing', () => { assert.equal(applyPatch('a\\n', ''), 'a\\n'); });
`;

// Hidden cases: round trips through the differ. Seeds 1-150 use unique lines, so the shifted copies (extra lines on
// top) have exactly one valid answer. Seeds 1001-1100 use a six-word alphabet, so lines repeat and a hunk can fit at
// several places: applied to the unshifted original, the answer is still unique (every hunk fits at its stated
// position once earlier hunks are accounted for), so an applier that forgets the shift lands on the wrong repeat.
export function genCases() {
  const cases = [];
  const gen = (seed, uniqLines) => {
    const rand = rng(seed); const pick = (n) => Math.floor(rand() * n);
    const words = ['alpha', 'beta', 'gamma', '', 'delta', 'alpha'];
    const line = (tag) => (uniqLines ? `${tag}${Math.floor(rand() * 1e9).toString(36)}` : words[pick(words.length)]);
    const n = pick(41);
    const orig = Array.from({ length: n }, (_, i) => (uniqLines ? `L${i}-${line('o')}` : line()));
    const edited = [...orig];
    for (let b = 1 + pick(4); b > 0; b--) {
      const at = pick(edited.length + 1), kind = pick(3), k = 1 + pick(3);
      if (kind === 0) edited.splice(at, k);
      else if (kind === 1) edited.splice(at, 0, ...Array.from({ length: k }, () => line('n')));
      else edited.splice(at, k, ...Array.from({ length: k }, () => line('n')));
    }
    const a = orig.join('\n') + (orig.length && rand() < 0.8 ? '\n' : '');
    const b = edited.join('\n') + (edited.length && rand() < 0.8 ? '\n' : '');
    return { a, b, orig, pick, line };
  };
  // GNU patch and git apply anchor a hunk with short leading context to the file start (and git one with short trailing
  // context to the file end); the spec does not. Shifted copies only use patches with full context at both ends, so every
  // seeded case is what both tools produce too. The spec's own rule is pinned by the visible test and hand-made cases.
  const fullContext = (patch) => {
    const lines = patch.replace(/\n$/, '').split('\n').filter((l) => !l.startsWith('\\'));
    const lead = lines.slice(1).findIndex((l) => !l.startsWith(' '));
    let trail = 0; for (let i = lines.length - 1; i >= 0 && lines[i].startsWith(' '); i--) trail++;
    return lead >= 3 && trail >= 3;
  };
  for (let seed = 1; seed <= 150; seed++) {
    const { a, b, orig, pick, line } = gen(seed, true);
    const patch = unifiedDiff(a, b);
    cases.push({ name: `seed ${seed}`, original: a, patch, expected: b });
    if (orig.length && fullContext(patch) && !/^@@ -1[, ]/m.test(patch)) { // the same patch applied to a file with extra lines at the top: every hunk is at an offset
      const extra = Array.from({ length: 1 + pick(6) }, () => line('x') + '\n').join('');
      cases.push({ name: `seed ${seed} shifted`, original: extra + a, patch, expected: extra + b });
    }
  }
  for (let seed = 1001; seed <= 1100; seed++) {
    const { a, b } = gen(seed, false);
    if (a === b) continue;
    cases.push({ name: `seed ${seed} (repeated lines)`, original: a, patch: unifiedDiff(a, b), expected: b });
  }
  return cases;
}

export const PATCH_HIDDEN = (cases) => `// kq7Vx2Lm9Rt4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from './patch.mjs';
const CASES = ${JSON.stringify(cases)};

test('round trips: apply(diff(a, b)) reproduces b on seeded texts, including shifted copies', () => {
  for (const c of CASES) assert.equal(applyPatch(c.original, c.patch), c.expected, c.name);
});
test('empty lines are context lines with nothing after the space', () => {
  assert.equal(applyPatch('a\\n\\nb\\n', '@@ -1,3 +1,3 @@\\n a\\n \\n-b\\n+B\\n'), 'a\\n\\nB\\n');
});
test('a hunk that fits both earlier and later is placed at the nearest position, later first', () => {
  assert.equal(applyPatch('k\\nk\\nk\\nk\\nk\\nk\\n', '@@ -3 +3 @@\\n-k\\n+K\\n'), 'k\\nk\\nK\\nk\\nk\\nk\\n');
  assert.equal(applyPatch('a\\nb\\nc\\n', '@@ -3,2 +3,2 @@\\n b\\n-c\\n+C\\n'), 'a\\nb\\nC\\n');
  assert.equal(applyPatch('k\\nk\\nz\\nk\\nk\\n', '@@ -3 +3 @@\\n-k\\n+K\\n'), 'k\\nk\\nz\\nK\\nk\\n', 'one line later and one line earlier both fit: later wins');
  assert.equal(applyPatch('k\\nz\\nz\\nz\\nk\\n', '@@ -3 +3 @@\\n-k\\n+K\\n'), 'k\\nz\\nz\\nz\\nK\\n', 'two lines away in both directions: later wins');
});
test('positions account for lines earlier hunks added or removed, even when the old lines also fit elsewhere', () => {
  assert.equal(applyPatch('a\\nk\\nk\\nk\\nk\\nk\\n', '@@ -1 +1,3 @@\\n-a\\n+a\\n+x\\n+y\\n@@ -5 +7 @@\\n-k\\n+K\\n'), 'a\\nx\\ny\\nk\\nk\\nk\\nK\\nk\\n');
  assert.equal(applyPatch('a\\nb\\nk\\nk\\nk\\nk\\n', '@@ -1,2 +0,0 @@\\n-a\\n-b\\n@@ -5 +3 @@\\n-k\\n+K\\n'), 'k\\nk\\nK\\nk\\n');
});
test('removing the trailing newline and adding one', () => {
  assert.equal(applyPatch('a\\nb\\n', '@@ -1,2 +1,2 @@\\n a\\n-b\\n+b\\n\\\\ No newline at end of file\\n'), 'a\\nb');
  assert.equal(applyPatch('a', '@@ -1 +1,2 @@\\n-a\\n\\\\ No newline at end of file\\n+a\\n+b\\n'), 'a\\nb\\n');
});
test('inserting into an empty file and emptying a file', () => {
  assert.equal(applyPatch('', '@@ -0,0 +1,2 @@\\n+x\\n+y\\n'), 'x\\ny\\n');
  assert.equal(applyPatch('x\\ny', '@@ -1,2 +0,0 @@\\n-x\\n-y\\n\\\\ No newline at end of file\\n'), '');
});
test('a later hunk accounts for lines the earlier hunk added', () => {
  const patch = '@@ -1,2 +1,4 @@\\n a\\n+a2\\n+a3\\n b\\n@@ -9,2 +11,2 @@\\n i\\n-j\\n+J\\n';
  const text = 'a\\nb\\nc\\nd\\ne\\nf\\ng\\nh\\ni\\nj\\n';
  assert.equal(applyPatch(text, patch), 'a\\na2\\na3\\nb\\nc\\nd\\ne\\nf\\ng\\nh\\ni\\nJ\\n');
});
test('the failing hunk is named', () => {
  assert.throws(() => applyPatch('a\\nb\\nc\\n', '@@ -1 +1 @@\\n-a\\n+A\\n@@ -3 +3 @@\\n-zzz\\n+Z\\n'), /hunk 2/);
});
`;

let HIDDEN = null;
/** The hidden test body; its 275 seeded cases are generated once per process. */
export const patchHidden = () => (HIDDEN ||= PATCH_HIDDEN(genCases()));

// A different design (GNU patch style): hunks are located in the original text with a running offset and the output
// is assembled separately; the patch parser counts lines from the hunk header instead of watching for the next "@@".
export const PATCH_GNU = `// kq7Vx2Lm9Rt4
const toLines = (t) => (t === '' ? [] : t.split(/(?<=\\n)/));
export function applyPatch(text, patch) {
  const src = toLines(String(text)); const out = []; let copied = 0, offset = 0;
  parse(String(patch)).forEach((h, n) => {
    const stated = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    const guess = stated + offset;
    const fits = (p) => p >= copied && p + h.old.length <= src.length && h.old.every((l, k) => src[p + k] === l);
    let pos = -1;
    for (let d = 0; d <= src.length && pos < 0; d++) { if (fits(guess + d)) pos = guess + d; else if (d && fits(guess - d)) pos = guess - d; }
    if (pos < 0) throw new Error(\`hunk \${n + 1} does not apply\`);
    out.push(...src.slice(copied, pos), ...h.new); copied = pos + h.old.length; offset = pos - stated;
  });
  out.push(...src.slice(copied));
  return out.join('');
}
function parse(patch) {
  const lines = patch.split(/\\r?\\n/); const hunks = [];
  const chop = (last) => { for (const arr of last) arr[arr.length - 1] = arr[arr.length - 1].slice(0, -1); };
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/.exec(lines[i]);
    if (!m) continue;
    const h = { oldStart: +m[1], oldCount: m[2] == null ? 1 : +m[2], newCount: m[4] == null ? 1 : +m[4], old: [], new: [] };
    let o = 0, nn = 0, last = [];
    while (o < h.oldCount || nn < h.newCount) {
      const l = lines[++i]; if (l === undefined) throw new Error(\`hunk \${hunks.length + 1} is malformed\`);
      if (l.startsWith('\\\\')) { chop(last); continue; }
      const t = l === '' ? ' ' : l[0], body = l.slice(1) + '\\n';
      if (t === ' ') { h.old.push(body); h.new.push(body); o++; nn++; last = [h.old, h.new]; }
      else if (t === '-') { h.old.push(body); o++; last = [h.old]; }
      else if (t === '+') { h.new.push(body); nn++; last = [h.new]; }
      else throw new Error(\`hunk \${hunks.length + 1} is malformed\`);
    }
    if (lines[i + 1]?.startsWith('\\\\')) { chop(last); i++; }
    hunks.push(h);
  }
  return hunks;
}
`;

// Mutants and variants replace src/patch.mjs; write them with bare() so the canary does not decide the verdict.
const as = (body) => ({ 'src/patch.mjs': marked(body) });
export const VARIANTS = {
  'GNU-style: locate in the original with a running offset, assemble output separately, count-driven hunk parser': as(PATCH_GNU),
};

export const MUTANTS = {
  'no offset search: hunks apply only at the stated position': as(PATCH.replace('for (let d = 0; d <= lines.length; d++)', 'for (let d = 0; d <= 0; d++)')),
  'ignores the no-newline marker': as(PATCH.replace("if (line.startsWith('\\\\')) { for (const side of h.last || []) side[side.length - 1] = side[side.length - 1].replace(/\\n$/, ''); continue; }", "if (line.startsWith('\\\\')) continue;")),
  'a missing count is read as 0': as(PATCH.replace("oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4]", 'oldCount: +(m[2] || 0), newStart: +m[3], newCount: +(m[4] || 0)')),
  'an empty range is placed one line too early': as(PATCH.replace('(h.oldCount === 0 ? h.oldStart : h.oldStart - 1)', '(h.oldStart - 1)')),
  'offsets do not account for lines earlier hunks added': as(PATCH.replace('shift += (pos - expected) + (h.new.length - h.old.length);', 'shift += 0;')),
  'searches earlier positions before later ones': as(PATCH.replace('if (fits(expected + d)) return expected + d; if (d && fits(expected - d)) return expected - d;', 'if (d && fits(expected - d)) return expected - d; if (fits(expected + d)) return expected + d;')),
};
