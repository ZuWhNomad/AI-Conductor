// Report parsing: findings, verdicts, tally. Imports nothing from this folder.

// Spec: bound the unfenced `{` scan so a brace bomb cannot monopolize the server thread.
const SCAN_STEPS = 2_000_000;

/** Last parseable `{...}` that satisfies `want`, ending last (outermost on a tie). Each `{` is its own candidate —
 *  string state does not carry across prose, so a 12" quote cannot hide a later object. */
function lastBalancedObject(text, want = () => true) {
  let best = null, bestEnd = -1, bestStart = Infinity, steps = SCAN_STEPS;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '{') continue;
    let depth = 0, s = false, e = false;
    for (let j = i; j < text.length; j++) {
      if (steps-- <= 0) return best;
      const c = text[j];
      if (e) { e = false; continue; }
      if (s) { if (c === '\\') e = true; else if (c === '"') s = false; continue; }
      if (c === '"') { s = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const end = j + 1;
          if (end > bestEnd || (end === bestEnd && i < bestStart)) {
            try {
              const obj = JSON.parse(text.slice(i, end));
              if (want(obj)) { best = obj; bestEnd = end; bestStart = i; }
            } catch {}
          }
          break;
        }
      }
    }
  }
  return best;
}

function lastFenced(text, want = () => true) {
  const fences = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).reverse();
  for (const f of fences) {
    try { const v = JSON.parse(f); if (want(v)) return v; } catch {}
  }
}

function hasVerdictKey(o) {
  return !!o && typeof o === 'object' && (typeof o.real === 'boolean' || typeof o.refuted === 'boolean' || typeof o.verdict === 'string' || typeof o.score === 'number');
}

function verdictOf(j) {
  if (typeof j.real === 'boolean') return { real: j.real, reason: j.reason || '', score: j.score ?? null };
  if (typeof j.refuted === 'boolean') return { real: !j.refuted, reason: j.reason || '', score: j.score ?? null };
  if (typeof j.verdict === 'string') return { real: /^(real|confirmed|pass|accept)/i.test(j.verdict), reason: j.reason || '', score: j.score ?? null };
  if (typeof j.score === 'number') return { real: j.score >= (j.threshold ?? 5), reason: j.reason || '', score: j.score };
}

const findingsArray = (o) => Array.isArray(o?.findings) ? o.findings : Array.isArray(o) ? o : null;
export const hasFindingObjects = (o) => !!findingsArray(o)?.some((f) => f && typeof f === 'object');
const isFindingsShape = (o) => findingsArray(o)?.length === 0 || hasFindingObjects(o);

/** Fenced JSON that looks like findings, else an unfenced object with findings[]. */
export function structuredOf(report) {
  if (!report) return undefined;
  const fenced = lastFenced(report, isFindingsShape);
  if (fenced !== undefined) return fenced;
  return lastBalancedObject(String(report), (o) => Array.isArray(o.findings)) ?? undefined;
}

/** Findings from a report: an explicit findings[] block, else the whole report as one item. */
export function findingsOf(report, taskId) {
  const j = structuredOf(report);
  const arr = findingsArray(j);
  if (arr) return arr.filter((f) => f && typeof f === 'object').map((f, i) => ({ ...f, id: f.id || `${taskId}-${i + 1}`, source: taskId }));
  return report?.trim() ? [{ id: `${taskId}-1`, title: report.trim().slice(0, 140), detail: report.trim(), source: taskId }] : [];
}

export const locOf = (f) => f.file || f.location || '';
export const titleOf = (f) => f.title || f.detail || f.issue || f.summary || '';
export const findingLine = (f, extra = '') => `- [${f.severity || '?'}] ${locOf(f) ? locOf(f) + ': ' : ''}${titleOf(f)}${extra}`;

export const findingKey = (f) => {
  const loc = String(locOf(f)).toLowerCase().replace(/\\/g, '/');
  const title = String(titleOf(f)).toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  if (loc || title) return `${loc}|${title}`;
  try { return JSON.stringify(f).toLowerCase().slice(0, 80); } catch { return '|'; }
};

/** Verdict from a refuter/judge report: {real:boolean} / {verdict:'real'|'refuted'} / {score}. */
export function parseVerdict(report) {
  const t = String(report || '');
  const withKey = t ? lastFenced(t, hasVerdictKey) : undefined;
  if (withKey !== undefined) return verdictOf(withKey);
  // L18: a fenced object with no verdict key is still "not real" (not a prose fallback).
  const fenced = t ? lastFenced(t) : undefined;
  if (fenced !== undefined) {
    const j = fenced && typeof fenced === 'object' && !Array.isArray(fenced) ? fenced : {};
    return verdictOf(j) || { real: false, reason: JSON.stringify(fenced).slice(0, 200), score: null };
  }
  const found = lastBalancedObject(t, hasVerdictKey);
  if (found) return verdictOf(found);
  return { real: !/\b(refuted|not (?:real|a bug)|false positive|cannot reproduce)\b/i.test(t) && /\b(confirmed|real|reproduc)/i.test(t), reason: t.slice(0, 200), score: null };
}

export function tally(votes, mode = 'majority') {
  const real = votes.filter((v) => v.real).length;
  const need = mode === 'any' ? 1 : mode === 'all' ? votes.length : Math.floor(votes.length / 2) + 1;
  return { real, total: votes.length, confirmed: votes.length > 0 && real >= need };
}
