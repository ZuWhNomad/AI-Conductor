// Smoke battery: small self-checking tasks, one or two per category and difficulty level. Each entry
// writes a fresh scratch project (`setup`), hands the worker a spec, and decides pass/fail from the
// resulting files or the worker's answer (`check`). `solve` is the reference solution the tests use to
// prove every check can pass. Reference solutions, hidden tests and mutants live in ./private/ (see its
// CONTEXT.md); every body there carries CANARY, and every check first fails a scratch dir that contains it.
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { CANARY, bare } from './private/common.mjs';
import { CLAMP, SLUG, STACK_TEST, MONEY, INVOICE_REF, RECEIPT_REF, QUEUE_FIXED, QUEUE_BUGGY, LRU_FIXED, LRU_BUGGY, CALC, RANGE, RANGE_MUTANTS, RANGE_TEST, POOL_FIXED, POOL_BUGGY, PIPELINE_FIXED, PIPELINE_BUGGY } from './private/l1-5.mjs';
import { OVERLAP_SLOW, OVERLAP_FAST, OVERLAP_TEST, OVERLAP_HIDDEN, OVERLAP_BENCH } from './private/refactor-6.mjs';
import { PATCH, PATCH_TEST, PATCH_HIDDEN, patchHidden } from './private/implement-6.mjs';
import { MULTIPART, MULTIPART_TEST, MULTIPART_HIDDEN } from './private/implement-7.mjs';
import { CLOCK, CACHE_BUGGY, CACHE_FIXED, CACHE_TEST, CACHE_HIDDEN } from './private/debug-7.mjs';

const execFileAsync = promisify(execFile);

const write = (dir, files) => { for (const [rel, body] of Object.entries(files)) { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); } };
const read = (dir, rel) => { try { return readFileSync(join(dir, rel), 'utf8'); } catch { return null; } };
const sha = (s) => createHash('sha1').update(s || '').digest('hex');
const unchanged = (dir, rel, body) => sha(read(dir, rel)) === sha(body);
const answer = (t) => String(t?.result?.finalMessage || t?.finalMessage || '');

/** Run node on untrusted worker code in `dir`, in a child so a process.exit or busy loop cannot kill the server; killed at `timeout`. */
async function runNode(dir, args, timeout = 60_000) {
  // A nested `node --test` inherits the parent test runner's NODE_TEST_CONTEXT and then reports as a
  // child instead of exiting non-zero on failure; drop it so the exit code is trustworthy.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, killed: false, stdout, stderr };
  } catch (e) { return { ok: false, killed: !!e.killed, stdout: e.stdout || '', stderr: e.stderr || e.message }; }
}
async function nodeTest(dir) {
  const r = await runNode(dir, ['--test']);
  return { ok: r.ok, out: r.ok ? r.stdout : `${r.stdout}\n${r.stderr}`.trim().slice(-1500) };
}
const testsPass = async (dir) => { const r = await nodeTest(dir); return { pass: r.ok, notes: r.ok ? '' : r.out }; };

/** Run named test files with the TAP reporter; pass only when `# fail 0` and `# pass` equals `expected` (an exit code can be
 *  forged with process.exit). The reporter escapes module output ("# \\# pass 99"), so a module cannot forge the summary. */
async function tapRun(dir, files, expected, timeout = 60_000) {
  const r = await runNode(dir, ['--test', '--test-reporter=tap', ...files], timeout);
  const num = (k) => { const m = [...r.stdout.matchAll(new RegExp(`^# ${k} (\\d+)`, 'gm'))].at(-1); return m ? Number(m[1]) : -1; };
  const pass = num('pass'), fail = num('fail');
  const failed = [...r.stdout.matchAll(/^\s*not ok \d+ - (.+?)\r?$/gm)].map((m) => m[1].trim());
  if (r.killed) return { pass: false, notes: `tests still running after ${timeout / 1000} s${failed.length ? `; failed before that: ${failed.slice(0, 3).join('; ')}` : ''}` };
  if (r.ok && fail === 0 && pass === expected) return { pass: true, notes: '' };
  const tail = failed.length ? `: ${failed.slice(0, 4).join('; ')}` : ` ${(r.stderr + '\n' + r.stdout).trim().slice(-300)}`;
  return { pass: false, notes: `${Math.max(pass, 0)}/${expected} tests passed${tail}` };
}
/** Write hidden files, run fn, remove them again (also on failure), so the worker never sees them. */
async function withHidden(dir, files, fn) {
  write(dir, files);
  try { return await fn(); } finally { for (const rel of Object.keys(files)) rmSync(join(dir, rel), { force: true }); }
}
const countTests = (src) => (src.match(/^test\(/gm) || []).length;

/** Does any file in the scratch dir, other than the grader's own hidden files, carry the canary (copied from ./private/)? */
export function copiedFromGrader(dir, skip = []) {
  const walk = (rel) => readdirSync(join(dir, rel), { withFileTypes: true }).some((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name, p = join(dir, r);
    if (e.isDirectory()) return walk(r);
    if (skip.includes(r)) return false;
    // Regular files, or links to one: reading a FIFO or a device the worker planted would block the server.
    try { return statSync(p).isFile() && readFileSync(p).includes(CANARY); } catch { return false; }
  });
  try { return walk(''); } catch { return false; }
}

// Import worker-written modules in a child so a top-level process.exit or busy loop cannot kill the server.
async function importCheck(dir, rel, expr) {
  const href = pathToFileURL(join(dir, rel)).href;
  const src = `const m = await import(${JSON.stringify(href)});\nprocess.stdout.write('OK' + JSON.stringify(!!(${expr})));`;
  const r = await runNode(dir, ['--input-type=module', '-e', src]);
  if (r.killed) return { pass: false, notes: 'import timed out' };
  if (!r.ok) return { pass: false, notes: `import failed: ${`${r.stdout}\n${r.stderr}`.trim().slice(-200)}` };
  if (r.stdout.startsWith('OK') && r.stdout.slice(2) === 'true') return { pass: true, notes: '' };
  return { pass: false, notes: r.stdout.startsWith('OK') ? 'exports missing or wrong' : `import did not finish: ${r.stdout.slice(-200)}` };
}
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

const STACK = `export class Stack {
  #items = [];
  push(x) { this.#items.push(x); return this; }
  pop() { if (!this.#items.length) throw new Error('empty stack'); return this.#items.pop(); }
  peek() { return this.#items[this.#items.length - 1]; }
  get size() { return this.#items.length; }
  isEmpty() { return this.#items.length === 0; }
}
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
const FORMAT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceLine } from './invoice.mjs';
import { receiptTotal } from './receipt.mjs';

test('invoice line', () => { assert.equal(invoiceLine('Widget', 1999), 'Widget: $19.99'); assert.equal(invoiceLine('Refund', -250), 'Refund: -$2.50'); });
test('receipt total', () => { assert.equal(receiptTotal([{ cents: 100 }, { cents: 5 }]), '$1.05'); assert.equal(receiptTotal([]), '$0.00'); });
`;

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

// --- level 6-7: hidden tests are written only while check() runs ---
const OVERLAP_HIDDEN_FILE = 'src/overlap.hidden.test.mjs', BENCH_FILE = 'src/__bench__.mjs';
const PATCH_HIDDEN_FILE = 'src/patch.hidden.test.mjs', MULTIPART_HIDDEN_FILE = 'src/multipart.hidden.test.mjs', CACHE_HIDDEN_FILE = 'src/cache.hidden.test.mjs';
// refactor-6's speed bar: max(15 s, 10x the reference timed in the same check); killed 5 s past the bar.
const BENCH_BAR_MS = 15_000, BENCH_REF_FACTOR = 10, BENCH_KILL_SLACK_MS = 5_000;
const benchOut = (r) => { try { return JSON.parse(/BENCH(\{[^}]*\})/.exec(r.stdout)[1]); } catch { return null; } }; // worker output: never throw

const TASKS = [
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
      const r = await importCheck(dir, 'src/math.mjs', 'typeof m.clamp === "function" && m.clamp(5, 0, 3) === 3 && m.clamp(-1, 0, 3) === 0 && m.clamp(2, 0, 3) === 2 && m.add(1, 2) === 3 && m.mul(2, 3) === 6');
      return r.pass ? r : { pass: false, notes: r.notes.startsWith('import') ? r.notes : 'clamp missing or wrong, or an existing export broke' };
    },
    solve(dir) { write(dir, { 'src/math.mjs': MATH + bare(CLAMP) }); },
  },
  {
    id: 'implement-2', category: 'implement', difficulty: 2, title: 'implement to a failing test',
    spec: `src/slug.test.mjs imports { slugify } from ./slug.mjs, which does not exist yet. Create src/slug.mjs so that every test passes. Do not modify the test file. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/slug.test.mjs': SLUG_TEST }); },
    check(dir) { return unchanged(dir, 'src/slug.test.mjs', SLUG_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, bare({ 'src/slug.mjs': SLUG })); },
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
    solve(dir) { write(dir, bare({ 'src/stack.test.mjs': STACK_TEST })); },
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
      const exp = await importCheck(dir, 'src/money.mjs', 'typeof m.formatMoney === "function"');
      if (!exp.pass) return { pass: false, notes: exp.notes.startsWith('import') ? exp.notes : 'money.mjs does not export formatMoney' };
      return testsPass(dir);
    },
    solve(dir) { write(dir, bare({ 'src/money.mjs': MONEY, 'src/invoice.mjs': INVOICE_REF, 'src/receipt.mjs': RECEIPT_REF })); },
  },
  {
    id: 'debug-3', category: 'debug', difficulty: 3, title: 'fix a failing test',
    spec: `node --test fails in this project. Find and fix the bug in src/queue.mjs. Do not modify src/queue.test.mjs and do not change the public API. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/queue.mjs': QUEUE_BUGGY, 'src/queue.test.mjs': QUEUE_TEST }); },
    check(dir) { return unchanged(dir, 'src/queue.test.mjs', QUEUE_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, bare({ 'src/queue.mjs': QUEUE_FIXED })); },
  },
  {
    id: 'debug-4', category: 'debug', difficulty: 4, title: 'fix an LRU cache',
    spec: `node --test fails in this project. src/lru.mjs is a least-recently-used cache; make every test pass by fixing src/lru.mjs only. Do not modify src/lru.test.mjs. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/lru.mjs': LRU_BUGGY, 'src/lru.test.mjs': LRU_TEST }); },
    check(dir) { return unchanged(dir, 'src/lru.test.mjs', LRU_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, bare({ 'src/lru.mjs': LRU_FIXED })); },
  },
  {
    id: 'implement-4', category: 'implement', difficulty: 4, title: 'implement an expression evaluator',
    spec: `src/calc.test.mjs specifies evaluate(expr): + - * / % with standard precedence (left-associative), ^ right-associative and binding tighter than unary minus, parentheses, decimals like .5, whitespace anywhere; errors whose messages contain "unexpected" (bad or missing token), "parenthesis" (unbalanced) and "division by zero". Create src/calc.mjs with no dependencies and without eval or new Function so that every test passes. Do not modify the test file. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/calc.test.mjs': CALC_TEST }); },
    check(dir) {
      if (!unchanged(dir, 'src/calc.test.mjs', CALC_TEST)) return { pass: false, notes: 'test file modified' };
      // Judge code, not prose: "no eval / new Function" in a comment or string is not a use.
      const code = (read(dir, 'src/calc.mjs') || '').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
      const use = code.split('\n').find((l) => /\beval\s*\(|new\s+Function\b/.test(l));
      if (use) return { pass: false, notes: `uses eval / new Function: ${use.trim().slice(0, 120)}` };
      return testsPass(dir);
    },
    solve(dir) { write(dir, bare({ 'src/calc.mjs': CALC })); },
  },
  {
    id: 'test-4', category: 'test', difficulty: 4, title: 'write tests that catch mutants',
    spec: `src/range.mjs exports parseRange(spec, max); read its comment. Write src/range.test.mjs (node:test, node:assert/strict) covering: single indices, closed ranges, open-ended ranges ("7-" runs to max), whitespace around items, overlapping ranges (result sorted, no duplicates), and errors for an empty spec, reversed ranges, out-of-range values and malformed items. Your suite will also be run against subtly broken copies of the module and should fail on each of them. Do not modify src/range.mjs. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/range.mjs': RANGE }); },
    async check(dir) {
      if (!unchanged(dir, 'src/range.mjs', RANGE)) return { pass: false, notes: 'range.mjs modified' };
      if (!read(dir, 'src/range.test.mjs')) return { pass: false, notes: 'no src/range.test.mjs' };
      const ok = await nodeTest(dir);
      if (!ok.ok) return { pass: false, notes: `suite fails on the correct module: ${ok.out}` };
      const survivors = [];
      try { for (const [name, body] of Object.entries(RANGE_MUTANTS)) { write(dir, { 'src/range.mjs': body }); if ((await nodeTest(dir)).ok) survivors.push(name); } }
      finally { write(dir, { 'src/range.mjs': RANGE }); } // a mutant carries the canary: never leave one behind
      return survivors.length ? { pass: false, notes: `suite does not catch: ${survivors.join('; ')}` } : { pass: true, notes: '' };
    },
    solve(dir) { write(dir, bare({ 'src/range.test.mjs': RANGE_TEST })); },
  },
  {
    id: 'debug-5', category: 'debug', difficulty: 5, title: 'fix an async pool and pipeline',
    spec: `node --test fails. src/pool.mjs is a concurrency-limited async task pool and src/pipeline.mjs runs items through stages with it. Find and fix the bugs in those two files only so that every test passes; do not modify src/pipeline.test.mjs and keep the public API. ${VERIFY}`,
    setup(dir) { write(dir, { 'src/pool.mjs': POOL_BUGGY, 'src/pipeline.mjs': PIPELINE_BUGGY, 'src/pipeline.test.mjs': PIPELINE_TEST }); },
    check(dir) { return unchanged(dir, 'src/pipeline.test.mjs', PIPELINE_TEST) ? testsPass(dir) : { pass: false, notes: 'test file modified' }; },
    solve(dir) { write(dir, bare({ 'src/pool.mjs': POOL_FIXED, 'src/pipeline.mjs': PIPELINE_FIXED })); },
  },
  {
    id: 'refactor-6', category: 'refactor', difficulty: 6, title: 'make it fast, keep every answer',
    spec: `src/overlap.mjs is correct but every function is O(n^2). Make overlapCounts, peakLoad and coveredLength fast without changing any answer. A hidden benchmark runs all three on two seeded inputs of 300,000 items each, one sparse (an item overlaps a handful of others) and one dense (an item can overlap tens of thousands of others), and must finish within 15 s of wall time including Node start-up; the reference sweep-line version takes about 2 s. Hidden tests also compare your answers with the original's on thousands of small random inputs, including empty items (start === end), touching items, duplicates and empty input, and check that no function modifies its input. Keep the exports and src/overlap.test.mjs unchanged; no dependencies. ${VERIFY}`,
    hidden: [OVERLAP_HIDDEN_FILE, BENCH_FILE],
    setup(dir) { write(dir, { 'src/overlap.mjs': OVERLAP_SLOW, 'src/overlap.test.mjs': OVERLAP_TEST }); },
    async check(dir) {
      if (!unchanged(dir, 'src/overlap.test.mjs', OVERLAP_TEST)) return { pass: false, notes: 'test file modified' };
      return withHidden(dir, { [OVERLAP_HIDDEN_FILE]: OVERLAP_HIDDEN, [BENCH_FILE]: OVERLAP_BENCH }, async () => {
        const eq = await tapRun(dir, ['src/overlap.test.mjs', OVERLAP_HIDDEN_FILE], countTests(OVERLAP_TEST) + countTests(OVERLAP_HIDDEN));
        if (!eq.pass) return eq;
        // Reference run in a folder the worker's code has never seen and cannot reach, timed on this machine right now.
        const refDir = mkdtempSync(join(tmpdir(), 'w-'));
        let ref, refMs;
        try {
          write(refDir, { 'src/overlap.mjs': OVERLAP_FAST, [BENCH_FILE]: OVERLAP_BENCH });
          const t0 = performance.now(); const r = await runNode(refDir, [BENCH_FILE]); refMs = Math.round(performance.now() - t0);
          ref = r.ok ? benchOut(r) : null;
          if (!ref) return { pass: false, notes: `grader error: reference benchmark failed: ${(r.stderr || r.stdout).trim().slice(-200)}` };
        } finally { rmSync(refDir, { recursive: true, force: true }); }
        const bar = Math.max(BENCH_BAR_MS, BENCH_REF_FACTOR * refMs); // a slow or busy machine loosens the bar in step with the reference
        const kill = bar + BENCH_KILL_SLACK_MS;
        // Wall time measured here, in the parent: overriding the clocks inside the module changes nothing.
        const t0 = performance.now(); const r = await runNode(dir, [BENCH_FILE], kill); const ms = Math.round(performance.now() - t0);
        if (r.killed) return { pass: false, notes: `benchmark still running after ${kill} ms (bar ${bar} ms; reference ${refMs} ms)` };
        const got = r.ok ? benchOut(r) : null;
        if (!got) return { pass: false, notes: `benchmark crashed: ${(r.stderr || r.stdout).trim().slice(-200)}` };
        const wrong = Object.keys(ref).filter((fn) => got[fn] !== ref[fn]);
        if (wrong.length) return { pass: false, notes: `benchmark answers differ from the reference: ${wrong.join(', ')} (${ms} ms)` };
        if (ms > bar) return { pass: false, notes: `benchmark took ${ms} ms (bar ${bar} ms; reference ${refMs} ms)` };
        return { pass: true, notes: '' };
      });
    },
    solve(dir) { write(dir, bare({ 'src/overlap.mjs': OVERLAP_FAST })); },
  },
  {
    id: 'implement-6', category: 'implement', difficulty: 6, title: 'apply a unified diff',
    spec: `Create src/patch.mjs exporting applyPatch(text, patch) -> string, which applies a single-file unified diff to text and has no dependencies. Rules: lines are split on "\\n" and each line keeps its newline, so the last line may lack one; lines before the first "@@" header (such as --- and +++) are ignored; a hunk header is "@@ -start[,count] +start[,count] @@" where a missing count means 1 and a count of 0 means an empty range whose start is the line before the insertion point (0 for the top of the file); hunk lines begin with " " (context), "-" (removed) or "+" (added), and a line that is exactly "\\ No newline at end of file" means the preceding patch line has no newline; a context line for an empty source line is a single space. Hunks apply in order. A hunk applies at its stated position, or, when its context and removed lines do not match there, at the nearest position where they do (a later position wins a tie), and positions account for lines earlier hunks added or removed; a hunk that fits nowhere throws an Error whose message contains "hunk N" (N counted from 1). An empty patch returns the text unchanged. src/patch.test.mjs must pass unchanged; hidden tests also apply patches produced by a standard diff of random texts, including shifted copies and every newline-at-end case. ${VERIFY}`,
    hidden: [PATCH_HIDDEN_FILE],
    setup(dir) { write(dir, { 'src/patch.test.mjs': PATCH_TEST }); },
    async check(dir) {
      if (!unchanged(dir, 'src/patch.test.mjs', PATCH_TEST)) return { pass: false, notes: 'test file modified' };
      if (!existsSync(join(dir, 'src/patch.mjs'))) return { pass: false, notes: 'no src/patch.mjs' };
      return withHidden(dir, { [PATCH_HIDDEN_FILE]: patchHidden() }, () => tapRun(dir, ['src/patch.test.mjs', PATCH_HIDDEN_FILE], countTests(PATCH_TEST) + countTests(PATCH_HIDDEN([]))));
    },
    solve(dir) { write(dir, bare({ 'src/patch.mjs': PATCH })); },
  },
  {
    id: 'implement-7', category: 'implement', difficulty: 7, title: 'streaming multipart parser',
    spec: `Create src/multipart.mjs exporting class MultipartParser(boundary, handlers) with write(buffer) and end(): a streaming parser for multipart bodies (RFC 2046 framing), no dependencies. Framing: a delimiter is CRLF + "--" + boundary; the first delimiter may open the stream without the CRLF; the CRLF before a delimiter belongs to the delimiter, not to the part body; a delimiter followed by "--" closes the stream and everything after it is ignored; everything before the first delimiter is ignored; after a delimiter come optional spaces or tabs and a CRLF, then header lines "Name: value" each ended by CRLF (names lowercased, values trimmed; a part may have no headers), then an empty line, then the body. Handlers: onPart(headers) when a part starts, onData(buffer) zero or more times with the body bytes in order, onPartEnd() when the part is complete, onEnd() once at the close delimiter. Streaming rule: body bytes are delivered as they arrive; after any write(), at most boundary.length + 8 bytes of the current part may still be undelivered. end() throws an Error whose message contains "truncated" if the close delimiter was never seen. Bodies are binary: every byte value from 0 to 255 must come through unchanged, so work on Buffers. src/multipart.test.mjs must pass unchanged; hidden tests feed bodies of every kind (empty parts, no headers, preamble and epilogue, transport padding, near-delimiters inside bodies, 300 KB of random bytes) split at many chunk boundaries, one byte at a time included, and compare every byte. ${VERIFY}`,
    hidden: [MULTIPART_HIDDEN_FILE],
    setup(dir) { write(dir, { 'src/multipart.test.mjs': MULTIPART_TEST }); },
    async check(dir) {
      if (!unchanged(dir, 'src/multipart.test.mjs', MULTIPART_TEST)) return { pass: false, notes: 'test file modified' };
      if (!existsSync(join(dir, 'src/multipart.mjs'))) return { pass: false, notes: 'no src/multipart.mjs' };
      return withHidden(dir, { [MULTIPART_HIDDEN_FILE]: MULTIPART_HIDDEN }, () => tapRun(dir, ['src/multipart.test.mjs', MULTIPART_HIDDEN_FILE], countTests(MULTIPART_TEST) + countTests(MULTIPART_HIDDEN)));
    },
    solve(dir) { write(dir, bare({ 'src/multipart.mjs': MULTIPART })); },
  },
  {
    id: 'debug-7', category: 'debug', difficulty: 7, title: 'fix races in an async cache under a virtual clock',
    spec: `node --test fails. src/cache.mjs is an async read-through cache (in-flight de-duplication, ttl expiry, refresh-ahead) driven by the virtual clock in src/clock.mjs; all timing must come from the injected clock, never Date.now or real timers. Fix src/cache.mjs only, keeping its public API (constructor options, get, set, invalidate, stats fields). Hidden tests will also run, under many seeded schedules, checking these rules: (1) concurrent get(k) calls share one loader call; (2) after invalidate(k) or set(k, v) returns, no loader call that started earlier may populate k, and a get(k) issued after it never observes the older value; (3) a rejected load is not cached: every waiter of that load rejects with its error and the next get(k) calls the loader again; (4) an entry expires ttl ms after it was stored, however it was stored; (5) a get of an entry older than ttl/2 returns the cached value at once and starts a background reload unless a load for that key is already in flight; a failed reload is counted in stats.errors, leaves the entry in place, and never surfaces as an unhandled rejection; (6) loads for different keys run concurrently. Do not modify src/clock.mjs or src/cache.test.mjs. ${VERIFY}`,
    hidden: [CACHE_HIDDEN_FILE],
    setup(dir) { write(dir, { 'src/clock.mjs': CLOCK, 'src/cache.mjs': CACHE_BUGGY, 'src/cache.test.mjs': CACHE_TEST }); },
    async check(dir) {
      if (!unchanged(dir, 'src/cache.test.mjs', CACHE_TEST)) return { pass: false, notes: 'test file modified' };
      if (!unchanged(dir, 'src/clock.mjs', CLOCK)) return { pass: false, notes: 'clock.mjs modified' };
      return withHidden(dir, { [CACHE_HIDDEN_FILE]: CACHE_HIDDEN }, () => tapRun(dir, ['src/cache.test.mjs', CACHE_HIDDEN_FILE], countTests(CACHE_TEST) + countTests(CACHE_HIDDEN)));
    },
    solve(dir) { write(dir, bare({ 'src/cache.mjs': CACHE_FIXED })); },
  },
];

// Every check first fails a scratch dir holding a file copied from ./private/ (the grader's own hidden files excepted).
export const BATTERY = TASKS.map((task) => ({
  ...task,
  async check(dir, t) { return copiedFromGrader(dir, task.hidden) ? { pass: false, notes: 'copied from the grader' } : task.check(dir, t); },
}));
