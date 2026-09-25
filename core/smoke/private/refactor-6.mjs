// Private grader material for refactor-6: the reference sweep, the hidden equivalence test, the benchmark script and
// the mutants/variants that prove the grader (see test/smoke). Every body here carries the canary line.
import { RNG, marked } from './common.mjs';

const DOC = `// Booking analytics over half-open integer intervals { start, end } with start <= end (start === end is an empty
// item: it covers no moment). Two items overlap when a.start < b.end && b.start < a.end. No function may change its input.
`;

export const OVERLAP_SLOW = `${DOC}// Straightforward and correct; every function is O(n^2).

/** For each item, the number of other items that overlap it (same order as the input). */
export function overlapCounts(items) {
  const out = new Array(items.length).fill(0);
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {
      if (i !== j && items[i].start < items[j].end && items[j].start < items[i].end) out[i]++;
    }
  }
  return out;
}

/** The moment with the most items in progress and how many; ties go to the earliest moment.
 *  { at: null, count: 0 } when no item ever covers a moment. */
export function peakLoad(items) {
  let best = { at: null, count: 0 };
  for (const p of items) {
    let c = 0;
    for (const q of items) if (q.start <= p.start && p.start < q.end) c++;
    if (c > best.count || (c === best.count && c > 0 && p.start < best.at)) best = { at: p.start, count: c };
  }
  return best;
}

/** Total length covered by at least one item (overlaps counted once). */
export function coveredLength(items) {
  const points = [...new Set(items.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (items.some((p) => p.start <= a && b <= p.end)) total += b - a;
  }
  return total;
}
`;

export const OVERLAP_FAST = `// kq7Vx2Lm9Rt4
${DOC}// Sorted sweeps: O(n log n) each, same answers as the quadratic version for every input.
const asc = (a, b) => a - b;
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const upperBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; };

export function overlapCounts(items) {
  const starts = items.map((p) => p.start).sort(asc);
  const ends = items.map((p) => p.end).sort(asc);
  // #{j: start_j < end_i} - #{j: end_j <= start_i}, minus the item itself. An empty item at s is inside the second
  // set but not the first, so empties sharing its point (itself included) must be added back.
  const emptiesAt = new Map();
  for (const p of items) if (p.start === p.end) emptiesAt.set(p.start, (emptiesAt.get(p.start) || 0) + 1);
  return items.map((p) => (p.start === p.end
    ? lowerBound(starts, p.start) - upperBound(ends, p.start) + emptiesAt.get(p.start)
    : lowerBound(starts, p.end) - upperBound(ends, p.start) - 1));
}

export function peakLoad(items) {
  const ev = [];
  for (const p of items) if (p.start < p.end) { ev.push([p.start, 1]); ev.push([p.end, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // at one moment, ends leave before starts arrive
  let best = { at: null, count: 0 }, c = 0;
  for (let i = 0; i < ev.length; i++) {
    c += ev[i][1];
    if ((i + 1 === ev.length || ev[i + 1][0] !== ev[i][0]) && c > best.count) best = { at: ev[i][0], count: c };
  }
  return best;
}

export function coveredLength(items) {
  const sorted = items.filter((p) => p.start < p.end).sort((a, b) => a.start - b.start);
  let total = 0, curStart = 0, curEnd = null;
  for (const p of sorted) {
    if (curEnd === null || p.start > curEnd) { if (curEnd !== null) total += curEnd - curStart; curStart = p.start; curEnd = p.end; }
    else if (p.end > curEnd) curEnd = p.end;
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}
`;

export const OVERLAP_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlapCounts, peakLoad, coveredLength } from './overlap.mjs';

const items = [{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 10, end: 20 }, { start: 30, end: 40 }, { start: 12, end: 12 }];
test('overlapCounts', () => assert.deepEqual(overlapCounts(items), [1, 3, 2, 0, 2]));
test('peakLoad picks the earliest moment among ties', () => assert.deepEqual(peakLoad(items), { at: 5, count: 2 }));
test('coveredLength counts overlaps once', () => assert.equal(coveredLength(items), 30));
test('empty input', () => { assert.deepEqual(overlapCounts([]), []); assert.deepEqual(peakLoad([]), { at: null, count: 0 }); assert.equal(coveredLength([]), 0); });
`;

// Answers compared shape-insensitively: peakLoad as [at, count] so key order cannot matter; arrays and numbers as JSON.
const NORM = `const norm = (fn, v) => JSON.stringify(fn === 'peakLoad' ? [v.at, v.count] : v);\n`;

export const OVERLAP_HIDDEN = `// kq7Vx2Lm9Rt4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fast from './overlap.mjs';
${RNG}${NORM}
// The original quadratic module, inlined so nothing but this file is needed.
const orig = (() => {
${OVERLAP_SLOW.replace(/^export /gm, '')}
  return { overlapCounts, peakLoad, coveredLength };
})();

test('same answers as the original on 3000 seeded inputs (dense ties, empty items, duplicates)', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const rand = rng(seed); const pick = (n) => Math.floor(rand() * n);
    const items = [];
    const n = pick(31);
    for (let i = 0; i < n; i++) {
      if (i && rand() < 0.1) { items.push({ ...items[pick(i)] }); continue; }
      const a = pick(16), b = pick(16);
      items.push(rand() < 0.15 ? { start: a, end: a } : { start: Math.min(a, b), end: Math.max(a, b) });
    }
    const input = JSON.stringify(items);
    for (const fn of ['overlapCounts', 'peakLoad', 'coveredLength']) {
      const want = norm(fn, orig[fn](JSON.parse(input))), got = norm(fn, fast[fn](JSON.parse(input)));
      assert.equal(got, want, \`\${fn} differs on seed \${seed}: \${input}\`);
    }
  }
});
test('the input is not modified', () => {
  const items = [{ start: 3, end: 9 }, { start: 1, end: 4 }, { start: 4, end: 4 }, { start: 0, end: 12 }];
  const before = JSON.stringify(items);
  for (const fn of ['overlapCounts', 'peakLoad', 'coveredLength']) { fast[fn](items); assert.equal(JSON.stringify(items), before, fn + ' changed its input'); }
});
`;

// Runs the module in ./overlap.mjs on two seeded inputs (sparse and dense) and prints a hash per function. The same
// script runs once in a grader-owned folder holding the reference and once in the worker's folder; the grader compares
// the hashes and measures each run's wall time itself.
export const OVERLAP_BENCH = `// kq7Vx2Lm9Rt4
import * as mod from './overlap.mjs';
import { createHash } from 'node:crypto';
${RNG}${NORM}
const gen = (n, range, maxLen, seed) => { const rand = rng(seed); const pick = (k) => Math.floor(rand() * k); return Array.from({ length: n }, () => { const s = pick(range); return rand() < 0.03 ? { start: s, end: s } : { start: s, end: s + pick(maxLen + 1) }; }); };
const inputs = [gen(300000, 10000000, 2000, 7), gen(300000, 30000, 3000, 8)];
const out = {};
for (const fn of ['overlapCounts', 'peakLoad', 'coveredLength']) {
  const h = createHash('sha1');
  for (const items of inputs) h.update(norm(fn, mod[fn](items.map((p) => ({ ...p })))));
  out[fn] = h.digest('hex');
}
process.stdout.write('BENCH' + JSON.stringify(out));
`;

// Mutants and variants replace src/overlap.mjs; write them with bare() so the canary does not decide the verdict.
const as = (body) => ({ 'src/overlap.mjs': marked(body) });
const fnSrc = (src, name) => src.match(new RegExp(`export function ${name}[\\s\\S]*?\\n}\\n`))[0];
export const MUTANTS = {
  'fast overlapCounts without the empties-at-a-point correction': as(OVERLAP_FAST.replace('+ emptiesAt.get(p.start)', '+ 1')),
  'peakLoad sweep evaluates after every event with starts before ends (touching items stack for a moment)': as(OVERLAP_FAST.replace('a[0] - b[0] || a[1] - b[1]', 'a[0] - b[0] || b[1] - a[1]').replace('if ((i + 1 === ev.length || ev[i + 1][0] !== ev[i][0]) && c > best.count)', 'if (c > best.count)')),
  'quadratic code for small inputs, wrong fast path for large ones (gaming the equivalence test)': as(OVERLAP_FAST.replace('export function overlapCounts(items) {', `${fnSrc(OVERLAP_SLOW, 'overlapCounts').replace('export function overlapCounts', 'function slowCounts')}\nexport function overlapCounts(items) {\n  if (items.length <= 1000) return slowCounts(items);`).replace('+ emptiesAt.get(p.start)', '+ 1')),
  'prints a forged BENCH line at import and exits before the benchmark runs': as(`if (process.argv[1]?.includes('__bench__')) { process.stdout.write('BENCH' + JSON.stringify({ overlapCounts: 'x', peakLoad: 'y', coveredLength: 'z' })); process.exit(0); }\n${OVERLAP_SLOW}`),
  'overlapCounts sorts its input in place (answers come back in the wrong order)': as(OVERLAP_FAST.replace('export function overlapCounts(items) {\n', 'export function overlapCounts(items) {\n  items.sort((a, b) => a.start - b.start);\n')),
};

// Timing mutants: each costs the benchmark kill time (about 20 s), so the tests run them only with CONDUCTOR_SMOKE_SLOW=1.
export const SLOW_MUTANTS = {
  // A fixed stall would pass on a busy machine, where the bar (10x the reference) grows past it; repeated work scales with
  // the machine like the reference does (about 20x it here).
  'correct but over the bar: overlapCounts repeats its work 64 times on large inputs': as(OVERLAP_FAST.replace('export function overlapCounts(items) {', 'export function overlapCounts(items) {\n  if (items.length > 1000) { let n = 0; for (let r = 1; r < 64; r++) n += counts(items).length; if (n < 0) throw new Error(); }\n  return counts(items);\n}\nfunction counts(items) {')),
  'two functions fast, peakLoad still quadratic': as(OVERLAP_FAST.replace(fnSrc(OVERLAP_FAST, 'peakLoad'), fnSrc(OVERLAP_SLOW, 'peakLoad'))),
  'pairs enumeration for overlapCounts (sort by start, scan forward, break early): fast on sparse data, slow on dense': as(OVERLAP_FAST.replace(fnSrc(OVERLAP_FAST, 'overlapCounts'), `export function overlapCounts(items) {
  const idx = items.map((p, i) => i).sort((a, b) => items[a].start - items[b].start || a - b);
  const out = new Array(items.length).fill(0);
  for (let a = 0; a < idx.length; a++) {
    const pi = items[idx[a]];
    for (let b = a + 1; b < idx.length; b++) { const pj = items[idx[b]]; if (pj.start >= pi.end) break; if (pi.start < pj.end && pj.start < pi.end) { out[idx[a]]++; out[idx[b]]++; } }
  }
  return out;
}
`)),
  'overrides performance.now, Date.now and hrtime to report zero time (parent wall clock ignores it)': as(`globalThis.performance.now = () => 0; Date.now = () => 0; process.hrtime = Object.assign(() => [0, 0], { bigint: () => 0n });\n${OVERLAP_FAST.replace(fnSrc(OVERLAP_FAST, 'peakLoad'), fnSrc(OVERLAP_SLOW, 'peakLoad'))}`),
};

// Different but equally correct solutions: these must pass (no false fails).
export const VARIANTS = {
  'coveredLength that splits touching items instead of merging them (same totals)': as(OVERLAP_FAST.replace('p.start > curEnd', 'p.start >= curEnd')),
  'peakLoad returns { count, at } (key order differs) and is evaluated only at start events via two sorted arrays': as(OVERLAP_FAST.replace(fnSrc(OVERLAP_FAST, 'peakLoad'), `export function peakLoad(items) {
  const live = items.filter((p) => p.start < p.end);
  const starts = live.map((p) => p.start).sort(asc), ends = live.map((p) => p.end).sort(asc);
  let best = { count: 0, at: null };
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (i + 1 < starts.length && starts[i + 1] === s) continue; // evaluate each distinct moment once, after all its starts
    const c = (i + 1) - lowerBound(ends, s + 1); // starts <= s minus ends <= s
    if (c > best.count) best = { count: c, at: s };
  }
  return best;
}
`)),
  'overlapCounts by a single merged event sweep (running active count) instead of binary searches': as(OVERLAP_FAST.replace(fnSrc(OVERLAP_FAST, 'overlapCounts'), `export function overlapCounts(items) {
  // Sort starts and ends; for item i: (#starts < end_i) - (#ends <= start_i) - 1, computed by walking both sorted arrays once
  // per query order. Empty items at a point: they count each other out (s < s is false) but the formula subtracts them.
  const n = items.length;
  const byEnd = items.map((p, i) => i).sort((a, b) => items[a].end - items[b].end);
  const byStart = items.map((p, i) => i).sort((a, b) => items[a].start - items[b].start);
  const startsLt = new Array(n), endsLe = new Array(n); // per item: #starts < end_i, #ends <= start_i
  let j = 0;
  for (const i of byEnd) { while (j < n && items[byStart[j]].start < items[i].end) j++; startsLt[i] = j; }
  j = 0;
  for (const i of byStart) { while (j < n && items[byEnd[j]].end <= items[i].start) j++; endsLe[i] = j; }
  const empties = new Map();
  for (const p of items) if (p.start === p.end) empties.set(p.start, (empties.get(p.start) || 0) + 1);
  return items.map((p, i) => startsLt[i] - endsLe[i] - (p.start === p.end ? -empties.get(p.start) : 1));
}
`)),
};
