import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendNdjson, statePath } from '../core/paths.mjs';
const { windowTokens, recordUsage, estimateUsage } = await import('../core/usage-estimate.mjs');

const runAt = (provider, iso, inTok, outTok) => appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts: iso, provider, model: 'm', tokens: { in: inTok, out: outTok, cached: 999999 }, status: 'done' });

test('windowTokens sums in+out since the last long gap (a new usage window), ignoring cached', () => {
  runAt('xai', '2026-01-01T10:00:00Z', 100000, 0);   // old window
  runAt('xai', '2026-01-03T10:00:00Z', 300000, 100000); // >6h gap -> new window starts here
  runAt('xai', '2026-01-03T11:00:00Z', 200000, 0);
  const w = windowTokens('xai', Date.parse('2026-01-03T12:00:00Z'));
  assert.equal(w.spent, 600000);   // 400k + 200k, old 100k excluded, cached ignored
});

test('estimateUsage calibrates a %-per-token rate from a check-in and extrapolates', () => {
  recordUsage('xai', 12);          // 12% observed at 600k tokens -> through-origin rate 20%/M
  let est = estimateUsage('xai');
  assert.equal(est.pct, 12); assert.equal(est.ratePctPerMToken, 20); assert.equal(est.calibrated, true);
  runAt('xai', '2026-01-03T13:00:00Z', 300000, 0); // now 900k tokens this window
  est = estimateUsage('xai');
  assert.equal(est.pct, 18);       // 900k * 20%/M (through origin)
});

test('estimateUsage is null with no check-in and no seed, but honours a seed rate', () => {
  runAt('zzz', '2026-02-01T10:00:00Z', 1_000_000, 0);
  assert.equal(estimateUsage('zzz'), null);
  assert.equal(estimateUsage('zzz', { seedPctPerMToken: 10 }).pct, 10); // 1M * 10%/M
});

test('a budget estimate switches to the calibrated fit once a check-in exists (Calibrate actually moves the bar)', () => {
  runAt('grokx', '2026-03-01T10:00:00Z', 500000, 100000); // 600k tokens this window
  const flat = estimateUsage('grokx', { budgetTokens: 10_000_000 }); // no check-in yet: flat budget 600k/10M = 6%
  assert.equal(flat.pct, 6); assert.equal(flat.basis, 'budget'); assert.equal(flat.calibrated, false);
  recordUsage('grokx', 55);                                 // user records the real 55% at 600k tokens
  const est = estimateUsage('grokx', { budgetTokens: 10_000_000 });
  assert.equal(est.basis, 'fit');   // the flat budget no longer wins once calibrated
  assert.equal(est.calibrated, true);
  assert.equal(est.pct, 55);        // the recorded % drives the bar, not spent/budget (6%)
});

test('a check-in survives a window drift / restart: the estimate re-applies it on a fresh load', () => {
  runAt('driftx', '2026-05-01T10:00:00Z', 60000, 41320);   // burst A, ~101320 tokens this window
  runAt('driftx', '2026-05-01T10:02:00Z', 0, 0);
  recordUsage('driftx', 26, { at: Date.parse('2026-05-01T10:03:00Z') }); // calibrate 26% against burst A
  // >6h idle then more usage: the old activity-gap window re-anchored PAST the check-in and reverted to the flat budget.
  runAt('driftx', '2026-05-01T18:10:00Z', 6000, 4000);     // ~10000 tokens, a new activity-gap window starts here
  const opts = { budgetTokens: 10_000_000, now: Date.parse('2026-05-01T19:00:00Z') };
  const a = estimateUsage('driftx', opts);
  const b = estimateUsage('driftx', opts);                 // a second load re-reads from disk = "after a restart"
  assert.equal(a.calibrated, true);
  assert.equal(a.basis, 'fit');                            // NOT the flat 'budget' fallback (~0.1%)
  assert.ok(a.pct >= 26 && a.pct < 40, `held near the calibrated 26%, got ${a.pct}`);
  assert.equal(a.pct, b.pct);                              // and it is stable across reloads
});
