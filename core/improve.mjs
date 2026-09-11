// Error + improvement log (the self-iteration input) and the review prompt that consumes it.
import { appendNdjson, readNdjson, writeJson, statePath, nowIso, shortId, REPO_ROOT } from './paths.mjs';
import { bus } from './bus.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = () => statePath('improvements.ndjson');

/**
 * @param {'error'|'idea'|'friction'} kind
 * @param {string} source   e.g. 'worker:codex', 'ui', 'conductor', 'server'
 * @param {string} message
 * @param {object} [context]
 */
let last = null;
export function logImprovement(kind, source, message, context = {}) {
  const msg = String(message).slice(0, 4000);
  // Collapse repeats: the same problem within 10 minutes is one entry, not a flood.
  if (last && last.kind === kind && last.source === source && last.message === msg && Date.now() - last.at < 600_000) { last.repeats++; return last.entry; }
  const entry = { id: shortId(), ts: nowIso(), kind, source, message: msg, context, resolved: false };
  last = { kind, source, message: msg, at: Date.now(), entry, repeats: 0 };
  appendNdjson(FILE(), entry);
  bus.publish('improvement', { entry });
  return entry;
}

export function listImprovements({ includeResolved = false } = {}) {
  const all = readNdjson(FILE());
  // Later "resolve" entries override earlier ones by id.
  const byId = new Map();
  for (const e of all) {
    if (e.op === 'resolve') { const t = byId.get(e.id); if (t) t.resolved = true; continue; }
    byId.set(e.id, e);
  }
  const out = [...byId.values()];
  return includeResolved ? out : out.filter((e) => !e.resolved);
}

export function resolveImprovement(id) {
  appendNdjson(FILE(), { op: 'resolve', id, ts: nowIso() });
}

/** Capture unexpected process errors without crashing the server. */
export function installGlobalErrorCapture() {
  process.on('uncaughtException', (err) => logImprovement('error', 'process', `uncaughtException: ${err?.stack || err}`));
  process.on('unhandledRejection', (err) => logImprovement('error', 'process', `unhandledRejection: ${err?.stack || err}`));
}

/** The prompt a review session receives. Runs on the Conductor repo itself. */
export function buildReviewPrompt(limit = 12) {
  const items = listImprovements().slice(-limit);
  const list = items.map((e) => `- [${e.id}] (${e.kind}, ${e.source}, ${e.ts}) ${e.message}${e.context && Object.keys(e.context).length ? `\n  context: ${JSON.stringify(e.context).slice(0, 600)}` : ''}`).join('\n');
  return `You are reviewing Conductor 2.0 (this repository at ${REPO_ROOT}) for self-improvement.

Improvement log (unresolved, newest last):
${list || '(empty)'}

Do this:
1. Read docs/ARCHITECTURE.md and CLAUDE.md first. Group the log entries by root cause.
2. Pick the highest-value fixes that are safe. Delegate mechanical implementation to a worker with a precise spec; review the diff yourself.
3. Run \`npm test\` and make it pass. Do not change behaviour beyond the fixes.
4. For each entry you addressed, call the log_improvement tool with kind "idea" and message "resolved <id>: <one line>" — the server marks it resolved.
5. Finish with a short report: what changed, what was verified, what you deliberately left alone.`;
}
