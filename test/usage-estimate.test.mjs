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
