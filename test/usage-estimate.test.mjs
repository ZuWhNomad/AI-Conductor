import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendNdjson, statePath } from '../core/paths.mjs';
const { windowTokens, recordUsage, estimateUsage, learnedRate } = await import('../core/usage-estimate.mjs');
const { saveConfig } = await import('../core/config.mjs');

const runAt = (provider, iso, inTok, outTok) => appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts: iso, provider, model: 'm', tokens: { in: inTok, out: outTok, cached: 999999 }, status: 'done' });

test('windowTokens sums in+out since the last long gap (a new usage window), ignoring cached', () => {
  runAt('xai', '2026-01-01T10:00:00Z', 100000, 0);   // old window
  runAt('xai', '2026-01-03T10:00:00Z', 300000, 100000); // >6h gap -> new window starts here
  runAt('xai', '2026-01-03T11:00:00Z', 200000, 0);
  const w = windowTokens('xai', Date.parse('2026-01-03T12:00:00Z'));
  assert.equal(w.spent, 600000);   // 400k + 200k, old 100k excluded, cached ignored
});

test('estimateUsage calibrates a %-per-token rate from a check-in and extrapolates', () => {
  recordUsage('xai', 12, { at: Date.parse('2026-01-03T12:00:00Z') }); // 12% observed at 600k tokens -> implied 20%/M
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

// --- the user's model: the check-in is the truth, the slope is learned from ascending runs ---

test('a correction upward is taken as-is and grows from there', () => {
  runAt('corr', '2026-06-01T10:00:00Z', 400000, 200000);        // 600k tokens
  recordUsage('corr', 10, { at: Date.parse('2026-06-01T10:30:00Z') });
  runAt('corr', '2026-06-01T11:00:00Z', 400000, 200000);        // +600k
  recordUsage('corr', 36, { at: Date.parse('2026-06-01T11:30:00Z') }); // "we are at 36%", not 20%
  const now = Date.parse('2026-06-01T13:00:00Z');
  assert.equal(estimateUsage('corr', { now }).pct, 36);         // shown as typed, immediately
  runAt('corr', '2026-06-01T12:00:00Z', 300000, 0);             // +300k after the check-in
  const est = estimateUsage('corr', { now });
  assert.equal(est.rateBasis, 'runs');
  assert.equal(est.ratePctPerMToken, 43.33);                    // (36-10)/600k = 43.33%/M
  assert.equal(est.pct, 49);                                    // 36 + 300k × 43.33%/M
});

test('entering 0 after 100% reads 0, and the learned rate survives the reset', () => {
  runAt('zero', '2026-07-01T10:00:00Z', 500000, 0);
  recordUsage('zero', 20, { at: Date.parse('2026-07-01T10:30:00Z') });
  runAt('zero', '2026-07-01T11:00:00Z', 1_000_000, 0);
  recordUsage('zero', 100, { at: Date.parse('2026-07-01T11:30:00Z') }); // run: 20 -> 100 over 1M = 80%/M
  recordUsage('zero', 0, { at: Date.parse('2026-07-01T12:00:00Z') });   // the window reset
  const after = Date.parse('2026-07-01T13:00:00Z');
  const est = estimateUsage('zero', { now: after });
  assert.equal(est.pct, 0);                                      // not 11.8% — the reset is honoured outright
  assert.equal(est.ratePctPerMToken, 80);                        // and the rate is kept
  runAt('zero', '2026-07-01T12:30:00Z', 250000, 0);
  assert.equal(estimateUsage('zero', { now: after }).pct, 20);   // 0 + 250k × 80%/M
});

test('the rate is one measurement per ascending run, medianed, ignoring runs too short to mean anything', () => {
  // 0,10,50,70 | 0,50 | 0,23 — three runs, three slopes, plus a 2k-token run that must not count.
  const pts = [[0, 0], [10, 1_000_000], [50, 2_000_000], [70, 4_000_000], [0, 4_000_000], [50, 5_000_000], [0, 5_000_000], [23, 7_000_000]];
  let t = Date.parse('2026-08-01T00:00:00Z'), spent = 0;
  for (const [pct, total] of pts) {
    if (total > spent) { runAt('runs', new Date(t += 60_000).toISOString(), total - spent, 0); spent = total; }
    recordUsage('runs', pct, { at: (t += 60_000) });
  }
  const rate = learnedRate('runs');
  assert.equal(rate.runs, 3);                       // 70/4M = 17.5, 50/1M = 50, 23/2M = 11.5 (%/M)
  assert.equal(Math.round(rate.rate * 1e6 * 10) / 10, 17.5);  // the median of the three
  // A tiny run cannot drag it: 2k tokens with a 1-point rise is below the floor.
  runAt('runs', new Date(t += 60_000).toISOString(), 2000, 0);
  recordUsage('runs', 24, { at: (t += 60_000) });
  assert.equal(learnedRate('runs').runs, 3);
});

test('a reset schedule is honoured only when configured, and then zeroes the bar without losing the rate', () => {
  runAt('sched', '2026-09-01T10:00:00Z', 1_000_000, 0);
  recordUsage('sched', 20, { at: Date.parse('2026-09-01T10:30:00Z') });
  runAt('sched', '2026-09-01T11:00:00Z', 1_000_000, 0);
  recordUsage('sched', 60, { at: Date.parse('2026-09-01T11:30:00Z') }); // 40 points over 1M = 40%/M
  const now = Date.parse('2026-09-03T12:00:00Z');
  assert.equal(estimateUsage('sched', { now }).pct, 60);   // no schedule configured: nothing is assumed
  saveConfig({ scorecard: { usageResets: { sched: { periodHours: 24, resetHour: 0 } } } });
  const est = estimateUsage('sched', { now });
  assert.equal(est.pct, 0);                                 // midnight passed: the bar starts over
  assert.equal(est.ratePctPerMToken, 40);                   // the measured burn rate is kept
});
