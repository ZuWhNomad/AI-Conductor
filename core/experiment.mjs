// Experiment records + A/B compare over tagged scorecard run rows.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, statePath, stateDir, nowIso } from './paths.mjs';
import { ledgerOf, tokensOf, runCostUsd } from './scorecard.mjs';
import { familyOf } from './models.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KEEPS = new Set(['keep-a', 'keep-b', 'void']);
const fileOf = (id) => statePath('experiments', `${id}.json`);
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export function createExperiment({ id, hypothesis, mechanism, branch = null, tasks = '', heldout = '', repeats } = {}) {
  if (!ID_RE.test(id || '')) throw Object.assign(new Error('experiment id must match [A-Za-z0-9_-]{1,40}'), { status: 400 });
  if (!String(hypothesis || '').trim()) throw Object.assign(new Error('hypothesis is required'), { status: 400 });
  if (!String(mechanism || '').trim()) throw Object.assign(new Error('mechanism is required'), { status: 400 });
  const n = repeats == null || repeats === '' ? 3 : Number(repeats);
  if (!Number.isFinite(n)) throw Object.assign(new Error('repeats must be a number'), { status: 400 });
  if (existsSync(fileOf(id))) throw Object.assign(new Error(`experiment ${id} already exists`), { status: 409 });
  const rec = {
    id, hypothesis: String(hypothesis).trim(), mechanism: String(mechanism).trim(),
    branch: branch ? String(branch) : null, tasks: csv(tasks), heldout: csv(heldout),
    repeats: n, createdAt: nowIso(), status: 'open', verdict: null,
  };
  writeJson(fileOf(id), rec);
  return rec;
}

export function readExperiment(id) {
  if (!ID_RE.test(id || '')) return null;
  return readJson(fileOf(id));
}

export function listExperiments() {
  try {
    return readdirSync(statePath('experiments')).filter((f) => f.endsWith('.json'))
      .map((f) => readJson(statePath('experiments', f))).filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } catch { return []; }
}

export function setVerdict(id, keep, note = '') {
  if (!KEEPS.has(keep)) throw Object.assign(new Error('verdict must be keep-a|keep-b|void'), { status: 400 });
  const rec = readExperiment(id);
  if (!rec) throw Object.assign(new Error(`unknown experiment ${id}`), { status: 404 });
  rec.verdict = { keep, note: String(note || ''), at: nowIso() };
  writeJson(fileOf(id), rec);
  return rec;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function verdictOf(r, rates) {
  return rates.get(r.taskId) || (r.status === 'failed' ? 'fail' : null);
}

function isHeldout(r, held) {
  if (!held.size) return false;
  return held.has(r.smokeId) || held.has(r.title) || held.has(r.taskId);
}

function summarise(runs, rates, nest = true) {
  const tok = [], usd = [], dur = [];
  let accepted = 0;
  const categories = new Map();
  const families = new Set();
  for (const r of runs) {
    const v = verdictOf(r, rates);
    if (v === 'pass' || v === 'fixable') accepted++;
    const t = tokensOf(r);
    if (t) tok.push(t);
    const u = runCostUsd(r);
    if (u != null) usd.push(u);
    if (r.durationMs != null) dur.push(r.durationMs);
    families.add(familyOf(r.provider, r.model));
    const cat = r.category || 'other';
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(r);
  }
  const tokenStats = (key) => ({ median: median(tok.map((t) => t[key] || 0)), total: tok.reduce((a, t) => a + (t[key] || 0), 0) });
  const out = {
    runs: runs.length, accepted,
    tokens: { in: tokenStats('in'), cached: tokenStats('cached'), out: tokenStats('out') },
    medianUsd: median(usd), medianDurationMs: median(dur),
    families: [...families].sort(),
    categories: {},
  };
  if (nest) for (const [cat, rs] of [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { categories: _c, families: _f, ...rest } = summarise(rs, rates, false);
    out.categories[cat] = rest;
  }
  return out;
}

function loadTagged(stateDirs, experimentId) {
  const files = (stateDirs?.length ? stateDirs : [stateDir()]).map((d) => join(d, 'scorecard.ndjson'));
  const runs = [], rates = new Map();
  for (const f of files) {
    const led = ledgerOf(f);
    for (const r of led.all) if (r.op === 'rate') rates.set(r.taskId, r.verdict);
    for (const r of led.rows) if (r.experiment?.id === experimentId && r.experiment?.arm) runs.push(r);
  }
  return { runs, rates };
}

function keepRule(A, B) {
  const cats = new Set([...Object.keys(A.categories || {}), ...Object.keys(B.categories || {})]);
  const notWorse = [...cats].every((c) => (B.categories[c]?.accepted || 0) >= (A.categories[c]?.accepted || 0));
  const cheaper = B.medianUsd != null && A.medianUsd != null && B.medianUsd < A.medianUsd;
  return notWorse && cheaper ? 'keep-b' : 'keep-a';
}

export function reportExperiment(id, { stateDirs } = {}) {
  const rec = readExperiment(id);
  if (!rec) throw Object.assign(new Error(`unknown experiment ${id}`), { status: 404 });
  const { runs, rates } = loadTagged(stateDirs, id);
  const byArm = { A: [], B: [] };
  for (const r of runs) (byArm[r.experiment.arm] ||= []).push(r);
  const held = new Set(rec.heldout || []);
  const arm = (xs) => summarise(xs, rates);
  const A = arm(byArm.A || []), B = arm(byArm.B || []);
  const keep = keepRule(A, B);
  const heldRuns = runs.filter((r) => isHeldout(r, held));
  const heldout = held.size ? {
    A: arm((byArm.A || []).filter((r) => isHeldout(r, held))),
    B: arm((byArm.B || []).filter((r) => isHeldout(r, held))),
  } : null;
  const warnings = [];
  if (keep === 'keep-b') {
    if ((B.families || []).length <= 1) warnings.push("B's win rests on a single family");
    if (!heldRuns.length) warnings.push('no held-out rows');
  }
  return { ...rec, keep, arms: { A, B }, heldout, warnings };
}

const num = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
const usd = (v) => (v == null ? '-' : `$${Number(v).toFixed(4)}`);
const dur = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);

function rowLine(arm, cat, s) {
  const t = s.tokens || { in: {}, cached: {}, out: {} };
  return `${arm}  ${cat}  ${s.runs}  ${s.accepted}  ${num(t.in.median)}/${num(t.in.total)}  ${num(t.cached.median)}/${num(t.cached.total)}  ${num(t.out.median)}/${num(t.out.total)}  ${usd(s.medianUsd)}  ${dur(s.medianDurationMs)}`;
}

function table(arms) {
  const lines = ['arm  category  runs  accepted  in med/tot  cached med/tot  out med/tot  med $/task  med duration'];
  for (const a of ['A', 'B']) {
    const s = arms[a];
    if (!s) continue;
    lines.push(rowLine(a, '(all)', s));
    for (const [cat, c] of Object.entries(s.categories || {})) lines.push(rowLine(a, cat, c));
  }
  return lines.join('\n');
}

export function formatReport(r) {
  const advice = r.keep === 'keep-b'
    ? 'B kept — accepted count is not lower in any category and median $/task is lower overall'
    : 'A kept — B is not cheaper, or accepted count is lower in a category';
  const lines = [
    `experiment ${r.id}  advice: ${advice}`,
    `hypothesis  ${r.hypothesis}`,
    `mechanism   ${r.mechanism}`,
    r.branch ? `branch      ${r.branch}` : null,
    '',
    table(r.arms),
    '',
    `families  A ${(r.arms.A.families || []).join(',') || '-'}  B ${(r.arms.B.families || []).join(',') || '-'}`,
    `wall time (not gated)  A ${dur(r.arms.A.medianDurationMs)}  B ${dur(r.arms.B.medianDurationMs)}`,
  ].filter((x) => x != null);
  if (r.heldout) {
    lines.push('', 'held-out', table(r.heldout));
  }
  for (const w of r.warnings || []) lines.push(`warning: ${w}`);
  if (r.verdict?.keep) lines.push(`verdict: ${r.verdict.keep}${r.verdict.note ? `  ${r.verdict.note}` : ''}`);
  return lines.join('\n');
}

export function formatRecord(rec) {
  return `${rec.id}  ${rec.status}  repeats ${rec.repeats}${rec.branch ? `  branch ${rec.branch}` : ''}\nhypothesis  ${rec.hypothesis}\nmechanism   ${rec.mechanism}`;
}

export function formatList(list) {
  if (!list.length) return 'no experiments';
  return list.map((r) => `${r.id}  ${r.status}${r.verdict?.keep ? `  ${r.verdict.keep}` : ''}  ${r.hypothesis}`).join('\n');
}
