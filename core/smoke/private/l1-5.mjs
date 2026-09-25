// Private grader material for the level 1-5 tasks: reference solutions, the fixtures derived from them (a buggy
// fixture is its reference with the bug put back), and test-4's mutants. Every body here carries the canary line.
import { bare, marked } from './common.mjs';

export const CLAMP = `// kq7Vx2Lm9Rt4
export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
`;

export const SLUG = `// kq7Vx2Lm9Rt4
export function slugify(s) {\n  return String(s).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n`;

export const STACK_TEST = `// kq7Vx2Lm9Rt4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stack } from './stack.mjs';

test('pops in reverse push order', () => { const s = new Stack(); s.push(1).push(2).push(3); assert.equal(s.pop(), 3); assert.equal(s.pop(), 2); assert.equal(s.pop(), 1); });
test('peek shows the top without removing it', () => { const s = new Stack(); s.push('a').push('b'); assert.equal(s.peek(), 'b'); assert.equal(s.size, 2); });
test('size tracks pushes and pops', () => { const s = new Stack(); assert.equal(s.size, 0); s.push(1); assert.equal(s.size, 1); s.pop(); assert.equal(s.size, 0); });
test('isEmpty', () => { const s = new Stack(); assert.equal(s.isEmpty(), true); s.push(0); assert.equal(s.isEmpty(), false); });
test('pop on empty throws', () => { assert.throws(() => new Stack().pop(), /empty/); });
`;

export const MONEY = `// kq7Vx2Lm9Rt4
export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
`;
export const INVOICE_REF = `// kq7Vx2Lm9Rt4
import { formatMoney } from './money.mjs';

export function invoiceLine(desc, cents) { return desc + ': ' + formatMoney(cents); }
`;
export const RECEIPT_REF = `// kq7Vx2Lm9Rt4
import { formatMoney } from './money.mjs';

export function receiptTotal(items) { return formatMoney(items.reduce((a, i) => a + i.cents, 0)); }
`;

export const QUEUE_FIXED = `// kq7Vx2Lm9Rt4
// Fixed-capacity FIFO ring buffer.
export class RingQueue {
  constructor(capacity) { this.cap = capacity; this.buf = new Array(capacity); this.head = 0; this.tail = 0; this.size = 0; }
  push(x) {
    if (this.size === this.cap) throw new Error('queue is full');
    this.buf[this.tail] = x; this.tail = (this.tail + 1) % this.cap; this.size++;
  }
  shift() {
    if (this.size === 0) return undefined;
    const x = this.buf[this.head]; this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.cap; this.size--;
    return x;
  }
  toArray() { return Array.from({ length: this.size }, (_, i) => this.buf[(this.head + i) % this.cap]); }
}
`;
export const QUEUE_BUGGY = bare(QUEUE_FIXED).replace('% this.cap; this.size--', '% (this.cap - 1); this.size--');

export const LRU_FIXED = `// kq7Vx2Lm9Rt4
// Least-recently-used cache: reading or writing a key makes it the most recent.
export class LRU {
  constructor(limit) { this.limit = limit; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key); this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return this;
  }
  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }
  keys() { return [...this.map.keys()]; }
}
`;
export const LRU_BUGGY = bare(LRU_FIXED)
  .replace("    const v = this.map.get(key);\n    this.map.delete(key); this.map.set(key, v);\n    return v;\n", '    return this.map.get(key);\n')
  .replace('    if (this.map.has(key)) this.map.delete(key);\n', '');

export const CALC = `// kq7Vx2Lm9Rt4
// Recursive-descent evaluator: + - * / % (left-assoc), ^ (right-assoc, tighter than unary minus), parentheses, decimals.
export function evaluate(src) {
  const s = String(src); let i = 0;
  const peek = () => { while (s[i] === ' ' || s[i] === '\\t') i++; return s[i]; };
  const fail = (msg) => { throw new Error(msg); };
  function number() { const start = i; while (/[0-9.]/.test(s[i] || '')) i++; const t = s.slice(start, i); if (!/^(\\d+\\.?\\d*|\\.\\d+)$/.test(t)) fail('unexpected token ' + JSON.stringify(t)); return Number(t); }
  function primary() {
    const c = peek();
    if (c === '(') { i++; const v = additive(); if (peek() !== ')') fail('unbalanced parenthesis'); i++; return v; }
    if (c === undefined) fail('unexpected end of input');
    if (/[0-9.]/.test(c)) return number();
    fail('unexpected token ' + JSON.stringify(c));
  }
  function power() { const b = primary(); if (peek() === '^') { i++; return b ** unary(); } return b; }
  function unary() { if (peek() === '-') { i++; return -unary(); } return power(); }
  function term() { let v = unary(); for (;;) { const c = peek(); if (c === '*') { i++; v *= unary(); } else if (c === '/') { i++; const d = unary(); if (d === 0) fail('division by zero'); v /= d; } else if (c === '%') { i++; v %= unary(); } else return v; } }
  function additive() { let v = term(); for (;;) { const c = peek(); if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v; } }
  const v = additive();
  if (peek() !== undefined) fail(peek() === ')' ? 'unbalanced parenthesis' : 'unexpected token ' + JSON.stringify(peek()));
  return v;
}
`;

export const RANGE = `// Parse a page-style selection such as "1-3,5,7-" (1-based, inclusive; an open end runs to max)
// into sorted unique indices within 1..max. Items may have whitespace around them.
export function parseRange(spec, max) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('empty range');
  if (!Number.isInteger(max) || max < 1) throw new Error('bad max');
  const out = new Set();
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) throw new Error('empty item in ' + JSON.stringify(spec));
    const m = /^(\\d+)(?:-(\\d*))?$/.exec(p);
    if (!m) throw new Error('bad item ' + JSON.stringify(p));
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === '' ? max : Number(m[2]);
    if (a < 1 || b > max) throw new Error('out of range ' + JSON.stringify(p) + ' (1-' + max + ')');
    if (b < a) throw new Error('reversed range ' + JSON.stringify(p));
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
`;
// Subtly broken copies; a good suite fails on every one of them. The grader writes them in place of the fixture.
export const RANGE_MUTANTS = Object.fromEntries(Object.entries({
  'open end stops one short': RANGE.replace("m[2] === '' ? max :", "m[2] === '' ? max - 1 :"),
  'reversed range accepted': RANGE.replace("    if (b < a) throw new Error('reversed range ' + JSON.stringify(p));\n", ''),
  'duplicates kept and unsorted': RANGE.replace('const out = new Set();', 'const out = [];').replace('out.add(i)', 'out.push(i)').replace('return [...out].sort((x, y) => x - y);', 'return out;'),
  'upper bound off by one': RANGE.replace('b > max)', 'b > max + 1)'),
  'whitespace not trimmed': RANGE.replace('const p = part.trim();', 'const p = part;'),
}).map(([name, body]) => [name, marked(body)]));
export const RANGE_TEST = `// kq7Vx2Lm9Rt4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from './range.mjs';

test('single indices and closed ranges', () => { assert.deepEqual(parseRange('3', 10), [3]); assert.deepEqual(parseRange('1-3', 10), [1, 2, 3]); });
test('open-ended range runs to max', () => { assert.deepEqual(parseRange('8-', 10), [8, 9, 10]); });
test('whitespace around items', () => { assert.deepEqual(parseRange(' 1 , 3-4 ', 10), [1, 3, 4]); });
test('overlaps are deduplicated and sorted', () => { assert.deepEqual(parseRange('5,1-3,2-4', 10), [1, 2, 3, 4, 5]); });
test('errors', () => {
  assert.throws(() => parseRange('', 10), /empty/);
  assert.throws(() => parseRange('5-3', 10), /reversed/);
  assert.throws(() => parseRange('0-2', 10), /range/);
  assert.throws(() => parseRange('9-11', 10), /range/);
  assert.throws(() => parseRange('a', 10), /bad item/);
});
`;

export const POOL_FIXED = `// kq7Vx2Lm9Rt4
// Run async functions with at most \`limit\` in flight.
export class Pool {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; this.idleWaiters = []; }
  add(fn) {
    return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.#pump(); });
  }
  onIdle() { return this.active === 0 && this.queue.length === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  #pump() {
    while (this.active < this.limit && this.queue.length) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { this.active--; this.#pump(); this.#checkIdle(); });
    }
  }
  #checkIdle() { if (this.active === 0 && this.queue.length === 0) { const w = this.idleWaiters; this.idleWaiters = []; for (const r of w) r(); } }
}
`;
export const POOL_BUGGY = bare(POOL_FIXED)
  .replace('onIdle() { return this.active === 0 && this.queue.length === 0 ?', 'onIdle() { return this.queue.length === 0 ?')
  .replace('#checkIdle() { if (this.active === 0 && this.queue.length === 0)', '#checkIdle() { if (this.queue.length === 0)')
  .replace('Promise.resolve().then(fn).then(resolve, reject).finally(() => { this.active--; this.#pump(); this.#checkIdle(); });', 'Promise.resolve().then(fn).then((v) => { this.active--; resolve(v); this.#pump(); this.#checkIdle(); }, reject);');
export const PIPELINE_FIXED = `// kq7Vx2Lm9Rt4
import { Pool } from './pool.mjs';

// Push every item through the stages in order with \`limit\` items in flight; results keep input order.
export async function runPipeline(items, stages, limit = 2) {
  const pool = new Pool(limit);
  const results = new Array(items.length);
  await Promise.all(items.map((item, i) => pool.add(async () => { let v = item; for (const s of stages) v = await s(v); results[i] = v; })));
  return results;
}
`;
export const PIPELINE_BUGGY = bare(PIPELINE_FIXED).replace('const results = new Array(items.length);', 'const results = [];').replace('results[i] = v;', 'results.push(v);');
