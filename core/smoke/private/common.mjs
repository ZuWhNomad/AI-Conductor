// Shared by the private grader modules. CANARY is embedded in every reference solution, hidden test and mutant body
// kept here; a worker file that contains it was copied from the grader (see `copiedFromGrader` in ../battery.mjs).
export const CANARY = 'kq7Vx2Lm9Rt4';
const MARK = `// ${CANARY}\n`;

/** A body (or a { path: body } map) without its canary line: what solve() writes and the tests' mutants/variants use. */
export const bare = (x) => (typeof x === 'string' ? x.replaceAll(MARK, '') : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, bare(v)])));
/** Prefix the canary line to a body derived at runtime (mutants made by replace). */
export const marked = (s) => MARK + bare(s);

// mulberry32: a tiny seeded PRNG so every hidden case is the same on every run and machine. RNG is its source text,
// inlined into hidden tests; rng is the same function for grader-side generators.
export const RNG = `const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };\n`;
export const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
