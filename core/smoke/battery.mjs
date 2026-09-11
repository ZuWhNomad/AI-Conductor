// Smoke battery: small self-checking tasks, one or two per category and difficulty level. Each entry
// writes a fresh scratch project (`setup`), hands the worker a spec, and decides pass/fail from the
// resulting files or the worker's answer (`check`). `solve` is the reference solution the tests use
// to prove every check can pass. Add harder levels here as the scorecard needs them.
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const write = (dir, files) => { for (const [rel, body] of Object.entries(files)) { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); } };
const read = (dir, rel) => { try { return readFileSync(join(dir, rel), 'utf8'); } catch { return null; } };
const sha = (s) => createHash('sha1').update(s || '').digest('hex');
const load = (dir, rel) => import(`${pathToFileURL(join(dir, rel)).href}?v=${Date.now()}-${Math.random()}`);
const unchanged = (dir, rel, body) => sha(read(dir, rel)) === sha(body);
const answer = (t) => String(t?.result?.finalMessage || t?.finalMessage || '');

function nodeTest(dir) {
  // A nested `node --test` inherits the parent test runner's NODE_TEST_CONTEXT and then reports as a
  // child instead of exiting non-zero on failure; drop it so the exit code is trustworthy.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  try { return { ok: true, out: execFileSync(process.execPath, ['--test'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}`.trim().slice(-1500) }; }
}
const testsPass = (dir) => { const r = nodeTest(dir); return { pass: r.ok, notes: r.ok ? '' : r.out }; };
const VERIFY = 'Verify with `node --test` in the project root before you report.';

// --- fixtures ---
const GEO = `// Plane geometry helpers.
const sq = (x) => x * x;
function scale(p, k) { return { x: p.x * k, y: p.y * k }; }

export function distance(a, b) { return Math.sqrt(sq(a.x - b.x) + sq(a.y - b.y)); }

export function midpoint(a, b) { return scale({ x: a.x + b.x, y: a.y + b.y }, 0.5); }

export function area(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) { const p = points[i], q = points[(i + 1) % points.length]; s += p.x * q.y - q.x * p.y; }
  return Math.abs(s) / 2;
}
`;

const PARSE = `// HTTP header parsing.
const SEP = ':';

function trim(s) { return s.replace(/^\\s+|\\s+$/g, ''); }

export function parseHeader(line) {
  const i = line.indexOf(SEP);
  if (i < 0) throw new Error('bad header: ' + line);
  return { name: trim(line.slice(0, i)).toLowerCase(), value: trim(line.slice(i + 1)) };
}

export function parseHeaders(block) {
  return Object.fromEntries(block.split(/\\r?\\n/).filter(Boolean).map((l) => { const h = parseHeader(l); return [h.name, h.value]; }));
}
`;
const CLIENT = `import { parseHeaders } from './parse.mjs';\n\nexport async function head(url) { const r = await fetch(url, { method: 'HEAD' }); return parseHeaders([...r.headers].map(([k, v]) => k + ': ' + v).join('\\n')); }\n`;
const STRINGS = `// String helpers (nothing to do with HTTP).\nexport function parseHeaderline(s) { return s.split('|'); }\nexport const parseHeadersCsv = (s) => s.split(',');\n`;

const MATH = `export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n`;

const SLUG_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slug.mjs';

test('lowercases and hyphenates spaces', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('strips punctuation', () => assert.equal(slugify('Hello, World!'), 'hello-world'));
test('collapses runs of separators', () => assert.equal(slugify('a  --  b'), 'a-b'));
test('trims leading and trailing hyphens', () => assert.equal(slugify('  -hello-  '), 'hello'));
test('removes accents', () => assert.equal(slugify('Cr\\u00e8me Br\\u00fbl\\u00e9e'), 'creme-brulee'));
test('keeps digits', () => assert.equal(slugify('Top 10 Tips'), 'top-10-tips'));
`;
const SLUG = `export function slugify(s) {\n  return String(s).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n`;

const STACK = `export class Stack {
  #items = [];
  push(x) { this.#items.push(x); return this; }
  pop() { if (!this.#items.length) throw new Error('empty stack'); return this.#items.pop(); }
  peek() { return this.#items[this.#items.length - 1]; }
  get size() { return this.#items.length; }
  isEmpty() { return this.#items.length === 0; }
}
`;
const STACK_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stack } from './stack.mjs';

test('pops in reverse push order', () => { const s = new Stack(); s.push(1).push(2).push(3); assert.equal(s.pop(), 3); assert.equal(s.pop(), 2); assert.equal(s.pop(), 1); });
test('peek shows the top without removing it', () => { const s = new Stack(); s.push('a').push('b'); assert.equal(s.peek(), 'b'); assert.equal(s.size, 2); });
test('size tracks pushes and pops', () => { const s = new Stack(); assert.equal(s.size, 0); s.push(1); assert.equal(s.size, 1); s.pop(); assert.equal(s.size, 0); });
test('isEmpty', () => { const s = new Stack(); assert.equal(s.isEmpty(), true); s.push(0); assert.equal(s.isEmpty(), false); });
test('pop on empty throws', () => { assert.throws(() => new Stack().pop(), /empty/); });
`;

const MONEY_FN = `function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
`;
const INVOICE_BODY = `export function invoiceLine(desc, cents) { return desc + ': ' + formatMoney(cents); }\n`;
const RECEIPT_BODY = `export function receiptTotal(items) { return formatMoney(items.reduce((a, i) => a + i.cents, 0)); }\n`;
const INVOICE = `${MONEY_FN}\n${INVOICE_BODY}`;
const RECEIPT = `${MONEY_FN}\n${RECEIPT_BODY}`;
const MONEY = `export ${MONEY_FN}`;
const INVOICE_REF = `import { formatMoney } from './money.mjs';\n\n${INVOICE_BODY}`;
const RECEIPT_REF = `import { formatMoney } from './money.mjs';\n\n${RECEIPT_BODY}`;
const FORMAT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceLine } from './invoice.mjs';
import { receiptTotal } from './receipt.mjs';

test('invoice line', () => { assert.equal(invoiceLine('Widget', 1999), 'Widget: $19.99'); assert.equal(invoiceLine('Refund', -250), 'Refund: -$2.50'); });
test('receipt total', () => { assert.equal(receiptTotal([{ cents: 100 }, { cents: 5 }]), '$1.05'); assert.equal(receiptTotal([]), '$0.00'); });
`;

const QUEUE_FIXED = `// Fixed-capacity FIFO ring buffer.
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
const QUEUE_BUGGY = QUEUE_FIXED.replace('% this.cap; this.size--', '% (this.cap - 1); this.size--');
const QUEUE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingQueue } from './queue.mjs';

test('wraps around without losing order', () => {
  const q = new RingQueue(3);
  q.push(1); q.push(2); q.push(3);
  assert.equal(q.shift(), 1); assert.equal(q.shift(), 2);
  q.push(4); q.push(5);
  assert.deepEqual(q.toArray(), [3, 4, 5]);
  assert.equal(q.shift(), 3); assert.equal(q.shift(), 4); assert.equal(q.shift(), 5);
  assert.equal(q.shift(), undefined);
});
test('throws when full', () => { const q = new RingQueue(1); q.push('a'); assert.throws(() => q.push('b'), /full/); });
test('size tracks pushes and shifts', () => { const q = new RingQueue(2); q.push(1); q.push(2); assert.equal(q.size, 2); q.shift(); assert.equal(q.size, 1); });
`;

const LRU_FIXED = `// Least-recently-used cache: reading or writing a key makes it the most recent.
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
const LRU_BUGGY = LRU_FIXED
  .replace("    const v = this.map.get(key);\n    this.map.delete(key); this.map.set(key, v);\n    return v;\n", '    return this.map.get(key);\n')
  .replace('    if (this.map.has(key)) this.map.delete(key);\n', '');
const LRU_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRU } from './lru.mjs';

test('evicts the least recently used', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.set('c', 3); assert.deepEqual(c.keys(), ['b', 'c']); });
test('get refreshes recency', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.deepEqual(c.keys(), ['a', 'c']); });
test('updating a key refreshes recency and keeps size', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3); assert.deepEqual(c.keys(), ['a', 'c']); assert.equal(c.get('a'), 9); assert.equal(c.size, 2); });
test('missing keys', () => { const c = new LRU(1); assert.equal(c.get('x'), undefined); assert.equal(c.has('x'), false); });
`;

// --- level 4-5 fixtures ---
const CALC_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './calc.mjs';

test('precedence', () => { assert.equal(evaluate('2 + 3 * 4'), 14); assert.equal(evaluate('(2 + 3) * 4'), 20); });
test('power is right-associative', () => { assert.equal(evaluate('2 ^ 3 ^ 2'), 512); assert.equal(evaluate('(2 ^ 3) ^ 2'), 64); });
test('unary minus binds looser than power', () => { assert.equal(evaluate('-3 + 5'), 2); assert.equal(evaluate('2 * -3'), -6); assert.equal(evaluate('-(2 + 3)'), -5); assert.equal(evaluate('2 ^ -1'), 0.5); assert.equal(evaluate('-2 ^ 2'), -4); });
test('decimals and whitespace', () => { assert.equal(evaluate('  1.5*4 '), 6); assert.equal(evaluate('10 / 4'), 2.5); assert.equal(evaluate('.5 + .5'), 1); });
test('left-associative - / %', () => { assert.equal(evaluate('7 % 3'), 1); assert.equal(evaluate('8 / 2 / 2'), 2); assert.equal(evaluate('2 - 3 - 4'), -5); });
test('errors', () => {
  assert.throws(() => evaluate('2 +'), /unexpected/i);
  assert.throws(() => evaluate('(2 + 3'), /paren/i);
  assert.throws(() => evaluate('2 $ 3'), /unexpected/i);
  assert.throws(() => evaluate(''), /unexpected/i);
  assert.throws(() => evaluate('1 / 0'), /division by zero/i);
});
`;
const CALC = `// Recursive-descent evaluator: + - * / % (left-assoc), ^ (right-assoc, tighter than unary minus), parentheses, decimals.
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

const RANGE = `// Parse a page-style selection such as "1-3,5,7-" (1-based, inclusive; an open end runs to max)
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
// Subtly broken copies; a good suite fails on every one of them.
const RANGE_MUTANTS = {
  'open end stops one short': RANGE.replace("m[2] === '' ? max :", "m[2] === '' ? max - 1 :"),
  'reversed range accepted': RANGE.replace("    if (b < a) throw new Error('reversed range ' + JSON.stringify(p));\n", ''),
  'duplicates kept and unsorted': RANGE.replace('const out = new Set();', 'const out = [];').replace('out.add(i)', 'out.push(i)').replace('return [...out].sort((x, y) => x - y);', 'return out;'),
  'upper bound off by one': RANGE.replace('b > max)', 'b > max + 1)'),
  'whitespace not trimmed': RANGE.replace('const p = part.trim();', 'const p = part;'),
};
const RANGE_TEST = `import { test } from 'node:test';
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

const POOL_FIXED = `// Run async functions with at most \`limit\` in flight.
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
const POOL_BUGGY = POOL_FIXED
  .replace('onIdle() { return this.active === 0 && this.queue.length === 0 ?', 'onIdle() { return this.queue.length === 0 ?')
  .replace('#checkIdle() { if (this.active === 0 && this.queue.length === 0)', '#checkIdle() { if (this.queue.length === 0)')
  .replace('Promise.resolve().then(fn).then(resolve, reject).finally(() => { this.active--; this.#pump(); this.#checkIdle(); });', 'Promise.resolve().then(fn).then((v) => { this.active--; resolve(v); this.#pump(); this.#checkIdle(); }, reject);');
const PIPELINE_FIXED = `import { Pool } from './pool.mjs';

// Push every item through the stages in order with \`limit\` items in flight; results keep input order.
export async function runPipeline(items, stages, limit = 2) {
  const pool = new Pool(limit);
  const results = new Array(items.length);
  await Promise.all(items.map((item, i) => pool.add(async () => { let v = item; for (const s of stages) v = await s(v); results[i] = v; })));
  return results;
}
`;
const PIPELINE_BUGGY = PIPELINE_FIXED.replace('const results = new Array(items.length);', 'const results = [];').replace('results[i] = v;', 'results.push(v);');
const PIPELINE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from './pool.mjs';
import { runPipeline } from './pipeline.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pool never exceeds its limit', async () => {
  const pool = new Pool(2); let active = 0, peak = 0;
  await Promise.all([30, 10, 20, 5, 15].map((ms) => pool.add(async () => { active++; peak = Math.max(peak, active); await sleep(ms); active--; })));
  assert.equal(peak, 2);
});
test('onIdle waits for in-flight work', async () => {
  const pool = new Pool(1); let done = false;
  pool.add(async () => { await sleep(30); done = true; });
  await pool.onIdle();
  assert.equal(done, true);
});
test('a rejected task frees its slot', async () => {
  const pool = new Pool(1);
  await assert.rejects(pool.add(async () => { throw new Error('boom'); }), /boom/);
  const v = await Promise.race([pool.add(async () => 'ran'), sleep(200).then(() => 'stuck')]);
  assert.equal(v, 'ran');
});
test('pipeline keeps input order under varied delays', async () => {
  const out = await runPipeline([30, 5, 20, 1], [async (ms) => { await sleep(ms); return ms; }, async (ms) => ms * 2], 3);
  assert.deepEqual(out, [60, 10, 40, 2]);
});
`;

const parseHeaderLine = () => PARSE.split('\n').findIndex((l) => l.startsWith('export function parseHeader(')) + 1;

export const BATTERY = [
  {
    id: 'read-1', category: 'read', difficulty: 1, title: 'name the exports',
    spec: 'Read src/geo.mjs and reply with the names of its exported functions, alphabetically, comma-separated, on one line and nothing else. Do not modify any file.',
    setup(dir) { write(dir, { 'src/geo.mjs': GEO }); },
    check(dir, t) {
      const want = 'area,distance,midpoint';
      const ok = answer(t).split('\n').some((l) => l.toLowerCase().replace(/[`*]/g, '').split(',').map((s) => s.trim()).filter(Boolean).join(',') === want);
      return { pass: ok, notes: ok ? '' : `expected "${want}"; got: ${answer(t).slice(-200)}` };
    },
    solve() { return { finalMessage: 'area, distance, midpoint' }; },
  },
  {
    id: 'search-1', category: 'search', difficulty: 1, title: 'locate a definition',
    spec: 'Find where the function `parseHeader` (singular; not parseHeaders or parseHeaderline) is defined in this project. Reply with exactly one line of the form `path:line`, relative to the project root with forward slashes, and nothing else. Do not modify any file.',
    setup(dir) { write(dir, { 'src/http/parse.mjs': PARSE, 'src/http/client.mjs': CLIENT, 'src/util/strings.mjs': STRINGS, 'README.md': '# demo\n' }); },
    check(dir, t) {
      const want = `src/http/parse.mjs:${parseHeaderLine()}`;
      const ans = answer(t).replace(/\\/g, '/');
      const ok = new RegExp(`(^|[^\\w/])${want.replace('.', '\\.')}(?!\\d)`).test(ans);
      return { pass: ok, notes: ok ? '' : `expected ${want}; got: ${ans.slice(-200)}` };
    },
    solve() { return { finalMessage: `src/http/parse.mjs:${parseHeaderLine()}` }; },
  },
  {
    id: 'edit-1', category: 'edit', difficulty: 1, title: 'add a small function',
    spec: 'Add an exported function clamp(x, lo, hi) to src/math.mjs that returns x limited to the range [lo, hi]. Keep the existing exports unchanged. Verify: node -e "import(\'./src/math.mjs\').then(m=>{if(m.clamp(5,0,3)!==3||m.clamp(-1,0,3)!==0||m.clamp(2,0,3)!==2||m.add(1,2)!==3)process.exit(1)})"',
    setup(dir) { write(dir, { 'src/math.mjs': MATH }); },
    async check(dir) {
      try {
        const m = await load(dir, 'src/math.mjs');
        const ok = typeof m.clamp === 'function' && m.clamp(5, 0, 3) === 3 && m.clamp(-1, 0, 3) === 0 && m.clamp(2, 0, 3) === 2 && m.add(1, 2) === 3 && m.mul(2, 3) === 6;
        return { pass: ok, notes: ok ? '' : 'clamp missing or wrong, or an existing export broke' };
      } catch (e) { return { pass: false, notes: `import failed: ${e.message}` }; }
    },
    solve(dir) { write(dir, { 'src/math.mjs': `${MATH}export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }\n` }); },
  },
  {
    id: 'implement-2', category: 'implement', difficulty: 2, title: 'implement to a failing test',
    spec: `src/slug.test.mjs imports { slugify } from ./slug.mjs, which does not exist yet. Create src/slug.mjs so that every test passes. Do not modify the test file. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/slug.test.mjs': SLUG_TEST }); },
    check(dir) { return unchanged(dir, 'src/slug.test.mjs', SLUG_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, { 'src/slug.mjs': SLUG }); },
  },
  {
    id: 'test-2', category: 'test', difficulty: 2, title: 'write tests for a module',
    spec: `Write src/stack.test.mjs using node:test and node:assert/strict with at least 5 test() cases for the Stack class in src/stack.mjs: push/pop order, peek, size, isEmpty, and that pop() on an empty stack throws. Do not modify src/stack.mjs. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/stack.mjs': STACK }); },
    check(dir) {
      if (!unchanged(dir, 'src/stack.mjs', STACK)) return { pass: false, notes: 'stack.mjs modified' };
      const src = read(dir, 'src/stack.test.mjs');
      if (!src) return { pass: false, notes: 'no src/stack.test.mjs' };
      const n = (src.match(/\b(?:test|it)\s*\(/g) || []).length;
      return n >= 5 ? testsPass(dir) : { pass: false, notes: `${n} test cases (< 5)` };
    },
    solve(dir) { write(dir, { 'src/stack.test.mjs': STACK_TEST }); },
  },
  {
    id: 'refactor-3', category: 'refactor', difficulty: 3, title: 'extract a duplicated helper',
    spec: `src/invoice.mjs and src/receipt.mjs each contain their own copy of formatMoney. Extract it into a new module src/money.mjs (export function formatMoney) and import it from both modules, leaving exactly one definition. Behaviour must not change and src/format.test.mjs must not be modified. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/invoice.mjs': INVOICE, 'src/receipt.mjs': RECEIPT, 'src/format.test.mjs': FORMAT_TEST }); },
    async check(dir) {
      if (!unchanged(dir, 'src/format.test.mjs', FORMAT_TEST)) return { pass: false, notes: 'test file modified' };
      if (!existsSync(join(dir, 'src/money.mjs'))) return { pass: false, notes: 'no src/money.mjs' };
      const code = readdirSync(join(dir, 'src')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => read(dir, `src/${f}`)).join('\n');
      const defs = (code.match(/(?:function\s+formatMoney\b|(?:const|let|var)\s+formatMoney\s*=)/g) || []).length;
      if (defs !== 1) return { pass: false, notes: `${defs} formatMoney definitions (want 1)` };
      try { const m = await load(dir, 'src/money.mjs'); if (typeof m.formatMoney !== 'function') return { pass: false, notes: 'money.mjs does not export formatMoney' }; }
      catch (e) { return { pass: false, notes: `import failed: ${e.message}` }; }
      return testsPass(dir);
    },
    solve(dir) { write(dir, { 'src/money.mjs': MONEY, 'src/invoice.mjs': INVOICE_REF, 'src/receipt.mjs': RECEIPT_REF }); },
  },
  {
    id: 'debug-3', category: 'debug', difficulty: 3, title: 'fix a failing test',
    spec: `node --test fails in this project. Find and fix the bug in src/queue.mjs. Do not modify src/queue.test.mjs and do not change the public API. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/queue.mjs': QUEUE_BUGGY, 'src/queue.test.mjs': QUEUE_TEST }); },
    check(dir) { return unchanged(dir, 'src/queue.test.mjs', QUEUE_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, { 'src/queue.mjs': QUEUE_FIXED }); },
  },
  {
    id: 'debug-4', category: 'debug', difficulty: 4, title: 'fix an LRU cache',
    spec: `node --test fails in this project. src/lru.mjs is a least-recently-used cache; make every test pass by fixing src/lru.mjs only. Do not modify src/lru.test.mjs. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/lru.mjs': LRU_BUGGY, 'src/lru.test.mjs': LRU_TEST }); },
    check(dir) { return unchanged(dir, 'src/lru.test.mjs', LRU_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, { 'src/lru.mjs': LRU_FIXED }); },
  },
  {
    id: 'implement-4', category: 'implement', difficulty: 4, title: 'implement an expression evaluator',
    spec: `src/calc.test.mjs specifies evaluate(expr): + - * / % with standard precedence (left-associative), ^ right-associative and binding tighter than unary minus, parentheses, decimals like .5, whitespace anywhere; errors whose messages contain "unexpected" (bad or missing token), "parenthesis" (unbalanced) and "division by zero". Create src/calc.mjs with no dependencies and without eval or new Function so that every test passes. Do not modify the test file. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/calc.test.mjs': CALC_TEST }); },
    check(dir) {
      if (!unchanged(dir, 'src/calc.test.mjs', CALC_TEST)) return { pass: false, notes: 'test file modified' };
      const src = read(dir, 'src/calc.mjs');
      if (src && /\beval\s*\(|new\s+Function\b/.test(src)) return { pass: false, notes: 'uses eval / new Function' };
      return testsPass(dir);
    },
    solve(dir) { write(dir, { 'src/calc.mjs': CALC }); },
  },
  {
    id: 'test-4', category: 'test', difficulty: 4, title: 'write tests that catch mutants',
    spec: `src/range.mjs exports parseRange(spec, max); read its comment. Write src/range.test.mjs (node:test, node:assert/strict) covering: single indices, closed ranges, open-ended ranges ("7-" runs to max), whitespace around items, overlapping ranges (result sorted, no duplicates), and errors for an empty spec, reversed ranges, out-of-range values and malformed items. Your suite will also be run against subtly broken copies of the module and should fail on each of them. Do not modify src/range.mjs. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/range.mjs': RANGE }); },
    check(dir) {
      if (!unchanged(dir, 'src/range.mjs', RANGE)) return { pass: false, notes: 'range.mjs modified' };
      if (!read(dir, 'src/range.test.mjs')) return { pass: false, notes: 'no src/range.test.mjs' };
      const ok = nodeTest(dir);
      if (!ok.ok) return { pass: false, notes: `suite fails on the correct module: ${ok.out}` };
      const survivors = [];
      for (const [name, body] of Object.entries(RANGE_MUTANTS)) { write(dir, { 'src/range.mjs': body }); if (nodeTest(dir).ok) survivors.push(name); }
      write(dir, { 'src/range.mjs': RANGE });
      return survivors.length ? { pass: false, notes: `suite does not catch: ${survivors.join('; ')}` } : { pass: true, notes: '' };
    },
    solve(dir) { write(dir, { 'src/range.test.mjs': RANGE_TEST }); },
  },
  {
    id: 'debug-5', category: 'debug', difficulty: 5, title: 'fix an async pool and pipeline',
    spec: `node --test fails. src/pool.mjs is a concurrency-limited async task pool and src/pipeline.mjs runs items through stages with it. Find and fix the bugs in those two files only so that every test passes; do not modify src/pipeline.test.mjs and keep the public API. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/pool.mjs': POOL_BUGGY, 'src/pipeline.mjs': PIPELINE_BUGGY, 'src/pipeline.test.mjs': PIPELINE_TEST }); },
    check(dir) { return unchanged(dir, 'src/pipeline.test.mjs', PIPELINE_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, { 'src/pool.mjs': POOL_FIXED, 'src/pipeline.mjs': PIPELINE_FIXED }); },
  },
];
