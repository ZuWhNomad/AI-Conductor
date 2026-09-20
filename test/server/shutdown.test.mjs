import '../_env.mjs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { trackProbe, killProbes } = await import('../../core/proc.mjs');
const { startModelPolling, stopModelPolling } = await import('../../core/models.mjs');
const { startLimitPolling, stopLimitPolling } = await import('../../core/limits.mjs');
const { stopBackgroundWork } = await import('../../server/index.mjs');

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('probe child did not exit')), 10_000);
    guard.unref();
    child.once('exit', () => { clearTimeout(guard); resolve(); });
  });
}

test('tracked probes are killed and the registry clears', async () => {
  const first = trackProbe(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true }));
  assert.equal(first.exitCode, null);
  const firstExit = waitForExit(first);
  killProbes();
  await firstExit;
  assert.ok(first.exitCode !== null || first.signalCode !== null);

  const second = trackProbe(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true }));
  const secondExit = waitForExit(second);
  killProbes();
  await secondExit;
  assert.ok(second.exitCode !== null || second.signalCode !== null);
});

test('polling stops are idempotent', () => {
  startModelPolling(15);
  stopModelPolling();
  assert.doesNotThrow(() => stopModelPolling());
  startLimitPolling(15);
  stopLimitPolling();
  assert.doesNotThrow(() => stopLimitPolling());
});

test('background work shutdown is safe to call', () => {
  assert.doesNotThrow(() => stopBackgroundWork());
});
