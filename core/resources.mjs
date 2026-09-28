// Shared resource guard for worker tasks and detached jobs.
import { totalmem, freemem } from 'node:os';
import { loadConfig } from './config.mjs';
import { logImprovement } from './improve.mjs';

let readMemory = () => ({ total: totalmem(), free: freemem() });
let lastHeld = false;

/** Replace the OS memory reading; returns a function that restores the prior reader. */
export function setMemoryReader(reader) {
  if (typeof reader !== 'function') throw new TypeError('memory reader must be a function');
  const previous = readMemory;
  readMemory = reader;
  return () => { readMemory = previous; };
}

export function resourceStatus(cfg = loadConfig()) {
  const { total, free } = readMemory();
  const ramPct = total > 0 ? ((total - free) / total) * 100 : 0;
  const maxRamPct = cfg.resources.maxRamPct;
  const held = maxRamPct > 0 && ramPct >= maxRamPct;
  if (held !== lastHeld) {
    const status = { ramPct, maxRamPct, held };
    logImprovement('friction', 'resources', resourceLine(status), { ramPct, maxRamPct, held });
    lastHeld = held;
  }
  return { ramPct, maxRamPct, held };
}

export function resourceLine(status = resourceStatus()) {
  const ram = `${Number(status.ramPct.toFixed(2))}%`;
  if (status.maxRamPct === 0) return `RAM ${ram}; RAM guard disabled`;
  return `RAM ${ram} ${status.held ? '≥' : '<'} ${status.maxRamPct}%: ${status.held ? 'new work held' : 'new work allowed'}`;
}
