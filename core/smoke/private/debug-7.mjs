// Private grader material for debug-7: the virtual clock and the buggy cache (fixtures), the fixed cache (reference),
// the visible and hidden tests (they share a harness) and the mutants/variants that prove the grader (see test/smoke).
// Every reference, hidden and mutant body carries the canary line.
import { RNG, marked } from './common.mjs';

export const CLOCK = `// Deterministic virtual time for tests: sleep() settles only when run() reaches its time. Timers fire in
// (time, creation) order and every pending promise callback runs between two timers, so a program that uses
// only this clock takes the same path on every run.
export class VirtualClock {
  #now = 0; #seq = 0; #timers = [];
  now() { return this.#now; }
  sleep(ms) { return new Promise((resolve) => { this.#timers.push({ at: this.#now + Math.max(0, Number(ms) || 0), seq: this.#seq++, resolve }); }); }
  /** Fire due timers in order until none is left (or none is due by \`until\`), letting promise callbacks settle in between. */
  async run(until = Infinity) {
    for (;;) {
      await settle();
      let next = null;
      for (const t of this.#timers) if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      if (!next || next.at > until) { if (until !== Infinity && until > this.#now) this.#now = until; await settle(); return; }
      this.#timers.splice(this.#timers.indexOf(next), 1);
      this.#now = next.at;
      next.resolve();
    }
  }
}
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
`;

const CACHE_HEAD = `import { VirtualClock } from './clock.mjs';

// Read-through cache for an async loader. Concurrent reads of a key share one loader call; entries expire \`ttl\` ms
// after they were stored; a read of an entry older than ttl/2 returns it at once and refreshes it in the background.
// All timing comes from the injected clock.
export class AsyncCache {
  constructor({ loader, ttl = 1000, clock = new VirtualClock() }) {
    this.loader = loader; this.ttl = ttl; this.clock = clock;
    this.entries = new Map();  // key -> { value, storedAt }
    this.inflight = new Map(); // key -> promise of the load in progress
    this.stats = { hits: 0, misses: 0, loads: 0, refreshes: 0, errors: 0 };
  }
  async get(key) {
    const e = this.entries.get(key);
    if (e) {
      const age = this.clock.now() - e.storedAt;
      if (age < this.ttl) {
        this.stats.hits++;
        if (age >= this.ttl / 2) this.#refresh(key);
        return e.value;
      }
    }
    this.stats.misses++;
    return this.#load(key);
  }
`;

export const CACHE_BUGGY = `${CACHE_HEAD}  set(key, value) { this.entries.set(key, { value, storedAt: Date.now() }); }
  invalidate(key) { this.entries.delete(key); }
  #load(key) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    this.stats.loads++;
    const p = Promise.resolve().then(() => this.loader(key)).then((value) => {
      this.entries.set(key, { value, storedAt: this.clock.now() });
      this.inflight.delete(key);
      return value;
    });
    this.inflight.set(key, p);
    return p;
  }
  #refresh(key) {
    this.stats.refreshes++;
    Promise.resolve().then(() => this.loader(key)).then((value) => {
      this.entries.set(key, { value, storedAt: this.clock.now() });
    });
  }
}
`;

export const CACHE_FIXED = `// kq7Vx2Lm9Rt4
${CACHE_HEAD.replace('    this.inflight = new Map(); // key -> promise of the load in progress\n', '    this.inflight = new Map(); // key -> promise of the load in progress\n    this.gen = new Map();      // key -> generation; set/invalidate start a new one\n')}  set(key, value) { this.#bump(key); this.entries.set(key, { value, storedAt: this.clock.now() }); }
  invalidate(key) { this.#bump(key); this.entries.delete(key); }
  // A write to a key starts a new generation: a load that began earlier may still answer its own waiters, but it
  // must not populate the cache, and readers arriving after the write must not join it.
  #bump(key) { this.gen.set(key, (this.gen.get(key) || 0) + 1); this.inflight.delete(key); }
  #load(key) {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const gen = this.gen.get(key) || 0;
    this.stats.loads++;
    const p = Promise.resolve().then(() => this.loader(key)).then((value) => {
      if ((this.gen.get(key) || 0) === gen) this.entries.set(key, { value, storedAt: this.clock.now() });
      return value;
    }).finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
  #refresh(key) {
    if (this.inflight.has(key)) return;
    this.stats.refreshes++;
    this.#load(key).catch(() => { this.stats.errors++; });
  }
}
`;

const HARNESS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from './clock.mjs';
import { AsyncCache } from './cache.mjs';

// The loader answers with the current truth for a key after \`delay\` virtual ms, or rejects while \`fail\` is set.
function harness({ ttl = 100, delay = 10 } = {}) {
  const clock = new VirtualClock(); const truth = {}; const calls = []; let fail = null;
  const loader = async (key) => { calls.push(key); const v = truth[key]; await clock.sleep(delay); if (fail) throw new Error(fail); return v; };
  const cache = new AsyncCache({ loader, ttl, clock });
  return { clock, truth, calls, cache, setFail: (m) => { fail = m; } };
}
const unhandled = []; process.on('unhandledRejection', (e) => unhandled.push(e));
// Resolves after the promise callbacks of this turn have run; a virtual-time load can never beat it.
const soon = (v) => new Promise((r) => setImmediate(() => setImmediate(() => r(v))));
`;

export const CACHE_TEST = `${HARNESS}
test('concurrent gets share one load', async () => {
  const h = harness(); h.truth.a = 'v0';
  const p = Promise.all([h.cache.get('a'), h.cache.get('a'), h.cache.get('a')]);
  await h.clock.run();
  assert.deepEqual(await p, ['v0', 'v0', 'v0']); assert.deepEqual(h.calls, ['a']);
});
test('a loaded entry expires after ttl', async () => {
  const h = harness(); h.truth.a = 'v0';
  const p1 = h.cache.get('a'); await h.clock.run(); assert.equal(await p1, 'v0');
  h.truth.a = 'v1'; await h.clock.run(h.clock.now() + 100);
  const p2 = h.cache.get('a'); await h.clock.run();
  assert.equal(await p2, 'v1'); assert.equal(h.calls.length, 2);
});
test('a failed load is retried by the next get', async () => {
  const h = harness(); h.setFail('boom');
  const p1 = h.cache.get('a').catch((e) => e.message); await h.clock.run(); assert.equal(await p1, 'boom');
  h.setFail(null); h.truth.a = 'ok';
  const p2 = h.cache.get('a'); await h.clock.run();
  assert.equal(await p2, 'ok'); assert.equal(h.calls.length, 2);
});
test('a load that started before invalidate must not populate the cache', async () => {
  const h = harness(); h.truth.a = 'v0';
  const p1 = h.cache.get('a'); await h.clock.run(5);
  h.truth.a = 'v1'; h.cache.invalidate('a');
  await h.clock.run(); assert.equal(await p1, 'v0');
  const p2 = h.cache.get('a'); await h.clock.run();
  assert.equal(await p2, 'v1'); assert.deepEqual(h.calls, ['a', 'a']);
});
test('a read in the refresh window returns at once; a failed refresh is swallowed and counted', async () => {
  unhandled.length = 0;
  const h = harness(); h.truth.a = 'v0';
  const p1 = h.cache.get('a'); await h.clock.run(); assert.equal(await p1, 'v0');
  await h.clock.run(h.clock.now() + 60); h.setFail('down');
  assert.equal(await Promise.race([h.cache.get('a'), soon('slow')]), 'v0');
  await h.clock.run();
  assert.equal(h.calls.length, 2); assert.equal(h.cache.stats.errors, 1); assert.equal(unhandled.length, 0);
});
`;

export const CACHE_HIDDEN = `// kq7Vx2Lm9Rt4
${HARNESS}${RNG}
test('entries stored with set() expire after ttl', async () => {
  const h = harness(); h.cache.set('a', 'manual'); h.truth.a = 'loaded';
  assert.equal(await Promise.race([h.cache.get('a'), soon('slow')]), 'manual');
  await h.clock.run(100);
  const p = h.cache.get('a'); await h.clock.run();
  assert.equal(await p, 'loaded'); assert.deepEqual(h.calls, ['a']);
});
test('a get issued after invalidate does not join the earlier load', async () => {
  const h = harness(); h.truth.a = 'v0';
  const p1 = h.cache.get('a'); await h.clock.run(3);
  h.truth.a = 'v1'; h.cache.invalidate('a');
  const p2 = h.cache.get('a'); await h.clock.run();
  assert.equal(await p1, 'v0'); assert.equal(await p2, 'v1'); assert.deepEqual(h.calls, ['a', 'a']);
});
test('set() during a load wins over the load result', async () => {
  const h = harness(); h.truth.a = 'v0';
  const p1 = h.cache.get('a'); await h.clock.run(3);
  h.cache.set('a', 'manual'); await h.clock.run();
  assert.equal(await p1, 'v0');
  assert.equal(await Promise.race([h.cache.get('a'), soon('slow')]), 'manual'); assert.equal(h.calls.length, 1);
});
test('loads for different keys run concurrently', async () => {
  const h = harness({ delay: 10 }); h.truth.a = 'A'; h.truth.b = 'B'; h.truth.c = 'C';
  const p = Promise.all([h.cache.get('a'), h.cache.get('b'), h.cache.get('c')]);
  await h.clock.run();
  assert.deepEqual(await p, ['A', 'B', 'C']); assert.equal(h.clock.now(), 10);
});
test('many reads in the refresh window trigger exactly one refresh', async () => {
  const h = harness(); h.truth.a = 'v0';
  const p1 = h.cache.get('a'); await h.clock.run(); await p1;
  await h.clock.run(h.clock.now() + 60); h.truth.a = 'v1';
  const reads = await Promise.race([Promise.all([1, 2, 3, 4, 5].map(() => h.cache.get('a'))), soon('slow')]);
  assert.deepEqual(reads, ['v0', 'v0', 'v0', 'v0', 'v0']);
  await h.clock.run();
  assert.equal(h.calls.length, 2);
  assert.equal(await Promise.race([h.cache.get('a'), soon('slow')]), 'v1'); assert.equal(h.calls.length, 2);
});
test('every waiter of a failed load rejects with its error and the next get loads again', async () => {
  const h = harness(); h.setFail('boom');
  const waiters = [1, 2, 3].map(() => h.cache.get('a').then(() => 'resolved', (e) => e.message));
  await h.clock.run();
  assert.deepEqual(await Promise.all(waiters), ['boom', 'boom', 'boom']); assert.equal(h.calls.length, 1);
  h.setFail(null); h.truth.a = 'ok';
  const p = h.cache.get('a'); await h.clock.run(); assert.equal(await p, 'ok'); assert.equal(h.calls.length, 2);
});
test('a failed refresh keeps the old entry; a later read may retry; expiry still loads afresh', async () => {
  unhandled.length = 0;
  const h = harness(); h.truth.a = 'v0';
  const p1 = h.cache.get('a'); await h.clock.run(); await p1;
  await h.clock.run(h.clock.now() + 60); h.setFail('down');
  assert.equal(await Promise.race([h.cache.get('a'), soon('slow')]), 'v0'); await h.clock.run();
  assert.equal(h.calls.length, 2); assert.equal(h.cache.stats.errors, 1);
  assert.equal(await Promise.race([h.cache.get('a'), soon('slow')]), 'v0'); await h.clock.run();
  assert.equal(h.calls.length, 3); assert.equal(h.cache.stats.errors, 2);
  await h.clock.run(h.clock.now() + 50); h.setFail(null); h.truth.a = 'v2';
  const p2 = h.cache.get('a'); await h.clock.run(); assert.equal(await p2, 'v2'); assert.equal(h.calls.length, 4);
  assert.equal(unhandled.length, 0);
});
test('seeded schedules: no get observes a value older than the truth when it was issued, and every get settles', async () => {
  const violations = [];
  for (let seed = 1; seed <= 150; seed++) {
    const rand = rng(seed); const pick = (n) => Math.floor(rand() * n);
    const keys = ['a', 'b', 'c']; const truth = { a: 0, b: 0, c: 0 };
    // Delay and outcome of the n-th load of each key are fixed by the seed, whatever the implementation does.
    const plan = {}; for (const k of keys) plan[k] = Array.from({ length: 300 }, () => ({ delay: 1 + pick(12), fail: rand() < 0.12 }));
    const n = { a: 0, b: 0, c: 0 };
    const clock = new VirtualClock();
    const loader = async (key) => { const step = plan[key][n[key]++] || { delay: 1, fail: false }; const v = truth[key]; await clock.sleep(step.delay); if (step.fail) throw new Error('flaky'); return v; };
    const cache = new AsyncCache({ loader, ttl: 40, clock });
    let issued = 0, settled = 0;
    for (let step = 0; step < 50; step++) {
      const key = keys[pick(3)]; const r = rand();
      if (r < 0.55) { const floor = truth[key]; issued++; cache.get(key).then((v) => { if (v < floor) violations.push(\`seed \${seed} step \${step}: \${key} = \${v} < \${floor}\`); }, () => {}).finally(() => settled++); }
      else if (r < 0.7) { truth[key]++; cache.invalidate(key); }
      else if (r < 0.8) { truth[key]++; cache.set(key, truth[key]); }
      else await clock.run(clock.now() + pick(30));
    }
    await clock.run();
    if (settled !== issued) violations.push(\`seed \${seed}: \${issued - settled} gets never settled\`);
  }
  assert.deepEqual(violations, []);
  assert.equal(unhandled.length, 0);
});
`;

// A different correct design: no generation counters; each in-flight load is a record that set/invalidate mark stale
// and detach, and the loader is called synchronously inside an async wrapper.
export const CACHE_ALT = `// kq7Vx2Lm9Rt4
${CACHE_HEAD}  set(key, value) { this.#detach(key); this.entries.set(key, { value, storedAt: this.clock.now() }); }
  invalidate(key) { this.#detach(key); this.entries.delete(key); }
  #detach(key) { const rec = this.inflight.get(key); if (rec) { rec.stale = true; this.inflight.delete(key); } }
  #load(key) {
    const rec = this.inflight.get(key);
    if (rec) return rec.promise;
    this.stats.loads++;
    const r = { stale: false, promise: null };
    r.promise = (async () => {
      try { const value = await this.loader(key); if (!r.stale) this.entries.set(key, { value, storedAt: this.clock.now() }); return value; }
      finally { if (this.inflight.get(key) === r) this.inflight.delete(key); }
    })();
    this.inflight.set(key, r);
    return r.promise;
  }
  #refresh(key) { if (this.inflight.has(key)) return; this.stats.refreshes++; this.#load(key).catch(() => { this.stats.errors++; }); }
}
`;

// Mutants and variants are { path: body } maps; write them with bare() so the canary does not decide the verdict.
const as = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, marked(v)]));
export const VARIANTS = {
  'stale-flag records instead of generation counters; loader called synchronously in an async wrapper': as({ 'src/cache.mjs': CACHE_ALT }),
};

// Plausible wrong fixes. Each should fail at least one hidden test.
export const MUTANTS = {
  'fixes only what the visible tests show (finally + store guard + refresh via load); set() still uses Date.now, invalidate does not detach': as({ 'src/cache.mjs': CACHE_FIXED
    .replace("set(key, value) { this.#bump(key); this.entries.set(key, { value, storedAt: this.clock.now() }); }", "set(key, value) { this.#bump(key); this.entries.set(key, { value, storedAt: Date.now() }); }")
    .replace('#bump(key) { this.gen.set(key, (this.gen.get(key) || 0) + 1); this.inflight.delete(key); }', '#bump(key) { this.gen.set(key, (this.gen.get(key) || 0) + 1); }') }),
  'generation guard without detaching the in-flight load': as({ 'src/cache.mjs': CACHE_FIXED.replace('#bump(key) { this.gen.set(key, (this.gen.get(key) || 0) + 1); this.inflight.delete(key); }', '#bump(key) { this.gen.set(key, (this.gen.get(key) || 0) + 1); }') }),
  'detaches the in-flight load but has no generation guard': as({ 'src/cache.mjs': CACHE_FIXED.replace("if ((this.gen.get(key) || 0) === gen) this.entries.set", 'this.entries.set') }),
  'correct rules but one cache-wide lock serialises every load': as({ 'src/cache.mjs': CACHE_FIXED.replace('const p = Promise.resolve().then(() => this.loader(key))', 'const p = (this.chain = (this.chain || Promise.resolve()).catch(() => {}).then(() => this.loader(key)))') }),
  'refresh not de-duplicated (every read in the window reloads)': as({ 'src/cache.mjs': CACHE_FIXED.replace('    if (this.inflight.has(key)) return;\n    this.stats.refreshes++;\n    this.#load(key).catch', '    this.stats.refreshes++;\n    this.stats.loads++;\n    Promise.resolve().then(() => this.loader(key)).then((value) => { this.entries.set(key, { value, storedAt: this.clock.now() }); }).catch') }),
};
