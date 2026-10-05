// Scorecard report: the human and conductor views — the category × level grid, the short text the conductor gets,
// the CSV for `conductor scores --csv` and the full table. Pure presentation over summary.mjs and recommend.mjs.
import { statSync } from 'node:fs';
import { getLimits } from '../limits.mjs';
import { getModels } from '../models.mjs';
import { loadConfig } from '../config.mjs';
import { ledgerFile, CATEGORIES, LEVELS, selOf, evidenceRated, eligibilityOverrides, eligibilityKey } from './ledger.mjs';
import { summarize, errorRates } from './summary.mjs';
import { recommend } from './recommend.mjs';

/**
 * Short view (what the conductor gets by default): one compact line per category containing all seven levels.
 * Every cell is a pick with evidence, a capped selection/reset, or no data. Benched cells follow as a computed
 * view of the ledger, never a second record. Memoised on the ledger, limits, models and config.
 */
let shortMemo = null;
const nextBlockEnd = (limits, now) => {
  const ends = [];
  for (const p of Object.values(limits.providers || {})) {
    if (Number.isFinite(p?.blockedUntil) && p.blockedUntil > now) ends.push(p.blockedUntil);
    if (Number.isFinite(p?.confirmedLimit?.blockedUntil) && p.confirmedLimit.blockedUntil > now) ends.push(p.confirmedLimit.blockedUntil);
    for (const w of p?.windows || []) if (Number.isFinite(w.resetsAt) && w.resetsAt > now) ends.push(w.resetsAt);
  }
  return ends.length ? Math.min(...ends) : null;
};

export function shortMemoKey({ source = null, limits = getLimits(), now = Date.now() } = {}) {
  const cfg = loadConfig().scorecard;
  const reset = nextBlockEnd(limits, now);
  let key = source + '|' + JSON.stringify(cfg) + '|' + (limits.updatedAt || '') + '|' + (getModels().updatedAt || '') + '|' + Math.floor(now / 60_000) + '|' + (reset ?? 'none');
  try { const st = statSync(ledgerFile()); key += '|' + st.size + ':' + st.mtimeMs; } catch { key += '|none'; }
  return key;
}

export function benchedCells(summary, cfg = loadConfig().scorecard) {
  return (summary || []).filter((g) => g.steps === 1 && evidenceRated(g) >= cfg.benchMinSamples && g.quality != null && g.quality < cfg.quality);
}

const compactReliability = (g) => {
  const bits = [];
  if (g?.consistency != null) bits.push(`consistency ${(g.consistency * 100).toFixed(0)}%`);
  if (g?.repeats) bits.push(`repeats ${g.repeats.min}-${g.repeats.max}`);
  if (g?.errorRate != null) bits.push(`err ${(g.errorRate * 100).toFixed(0)}%`);
  if (g?.toolErrorRate != null) bits.push(`tool ${(g.toolErrorRate * 100).toFixed(0)}%`);
  if (g?.avgTurns != null) bits.push(`turns ${g.avgTurns.toFixed(1)}`);
  if (g?.thrash != null) bits.push(`thrash ${g.thrash}`);
  if (g?.timeouts != null) bits.push(`timeouts ${g.timeouts}`);
  if (g?.costPerSuccess != null) bits.push(`$/pass ${g.costPerSuccess < 0.1 ? g.costPerSuccess.toFixed(3) : g.costPerSuccess.toFixed(2)}`);
  return bits.join(' · ');
};

/** Structured category × level view shared by the short text, HTTP API and scores modal. */
export function scoresGrid({ source = null, summary = null, categories = CATEGORIES } = {}) {
  summary ||= summarize({ source });
  return categories.map((category) => ({
    category,
    levels: LEVELS.map((level) => {
      const { pick, explain } = recommend({ category, difficulty: level, source, summary, explain: true });
      if (pick) return {
        level, status: 'pick', selection: pick.plan?.steps?.join('>') || selOf(pick), quality: pick.plan?.quality ?? null,
        usd: pick.plan?.usd ?? null, n: pick.evidence?.n ?? 0, weightedN: pick.evidence?.weightedN ?? 0,
        last: pick.evidence?.last || null, evidenceSource: pick.evidence?.source || 'prior', shipped: !!pick.evidence?.shipped,
        consistency: pick.evidence?.consistency ?? null, repeats: pick.evidence?.repeats ?? null,
         errorRate: pick.evidence?.errorRate ?? null, toolErrorRate: pick.evidence?.toolErrorRate ?? null, avgTurns: pick.evidence?.avgTurns ?? null,
        thrash: pick.evidence?.thrash ?? null, timeouts: pick.evidence?.timeouts ?? null, costPerSuccess: pick.evidence?.costPerSuccess ?? null,
      };
      if (explain?.status === 'capped') {
        const resetAt = Math.min(...explain.capped.map((c) => c.resetAt).filter((v) => Number.isFinite(v)));
        return { level, status: 'capped', selections: explain.capped.map((c) => c.sel), resetAt: Number.isFinite(resetAt) ? resetAt : null };
      }
      return { level, status: 'no-data' };
    }),
  }));
}

export function formatScoresShort({ source = null } = {}) {
  const cfg = loadConfig().scorecard;
  const key = shortMemoKey({ source });
  if (shortMemo?.key === key) return shortMemo.text;
  const all = summarize({ source });
  const manual = eligibilityOverrides();
  const money = (v) => (v == null ? 'unpriced' : '$' + v.toFixed(v < 0.1 ? 3 : 2));
  const date = (v) => v ? String(v).slice(0, 10) : '-';
  const reset = (v) => v ? new Date(v).toISOString().slice(0, 16) + 'Z' : 'reset unknown';
  const lines = ['Category@level picks (q = quality; n/date = raw rated evidence and latest run; bench = smoke/shipped benchmark). Full table: model_scores with detail: true or a category.'];
  for (const row of scoresGrid({ source, summary: all })) lines.push('- ' + row.levels.map((c) => {
    const tag = `${row.category}@${c.level}`;
    if (c.status === 'no-data') return `${tag}: no data`;
    if (c.status === 'capped') return `${tag}: capped: ${c.selections.join(', ')} until ${reset(c.resetAt)}`;
    const evidence = c.evidenceSource === 'prior' ? 'prior' : `${c.shipped ? 'shipped ' : ''}${c.evidenceSource} n=${c.n} ${date(c.last)}`;
    const reliability = compactReliability(c);
    return `${tag}: ${c.selection} ${c.quality == null ? '' : `q${c.quality.toFixed(2)} ${money(c.usd)} `}[${evidence}${reliability ? `; ${reliability}` : ''}]`;
  }).join(' · '));
  const manualByCell = new Map(manual.map((r) => [eligibilityKey(r.sel, r.category), r]));
  const benched = benchedCells(all, cfg).filter((g) => manualByCell.get(eligibilityKey(g.sel, g.category))?.action !== 'allow');
  if (benched.length) {
    lines.push('', 'Benched (quality < ' + cfg.quality + ' over >= ' + cfg.benchMinSamples + ' recency-weighted rated; recommend() skips these cells; a better run lifts them):');
    for (const g of benched) lines.push('- ' + g.sel + ' ' + g.category + '@' + g.difficulty + ': q' + g.quality.toFixed(2) + ' over ' + g.rated + ' raw / ' + evidenceRated(g).toFixed(2) + ' weighted rated (' + g.pass + '/' + g.fixable + '/' + (g.close || 0) + '/' + g.fail + '/' + g.phantom + ')' + (g.last ? ', last run ' + String(g.last).slice(0, 10) : '') + (compactReliability(g) ? ', ' + compactReliability(g) : ''));
  }
  if (manual.length) {
    lines.push('', 'Manual eligibility (latest per selection + category):');
    for (const r of manual) lines.push(`- ${r.action.toUpperCase()} ${r.sel} for ${r.category}: ${r.reason}`);
  }
  const text = lines.join('\n');
  shortMemo = { key, text };
  return text;
}

/** `conductor scores --csv`: the summary table as CSV (opens in Excel). */
export function scoresCsv({ source = null, archived = false } = {}) {
  const cols = ['sel', 'category', 'difficulty', 'steps', 'n', 'rated', 'quality', 'accept', 'pass', 'fixable', 'close', 'fail', 'phantom', 'avgUsd', 'avgPct', 'avgTokens', 'avgDurationMs', 'avgRounds', 'errorRate', 'toolErrorRate', 'avgTurns', 'thrash', 'timeouts', 'costPerSuccess', 'phantomRate', 'priorTier', 'cost', 'last', 'consistency', 'repeats'];
  const q = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [cols.join(','), ...summarize({ source, archived }).map((g) => cols.map((k) => q(k === 'repeats' && g[k] ? `${g[k].min}-${g[k].max}` : g[k])).join(','))].join('\n') + '\n';
}

/** Conductor/CLI view: the table plus the current plan per category and level. */
export function formatScores({ category = null, source = null, archived = false, summary = null } = {}) {
  summary ||= summarize({ source, archived });
  const rows = summary.filter((g) => !category || g.category === category);
  const manual = archived ? [] : eligibilityOverrides({ category });
  const cfg = loadConfig().scorecard;
  if (!rows.length && (archived || (cfg.coldStart !== 'priors' && !manual.length))) return 'Scorecard is empty. Tag delegations with category/difficulty and rate them with rate_task, or run smoke_test on a model.';
  const f = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
  const lines = rows.length ? ['selection | category@lvl | n | rated | quality | accept | pass/fix/close/fail/phantom | $/task | %window/task | avg s | rounds | error | tool err | avg turns | thrash | timeouts | $/pass | consistency | repeats | hand-picked prior'] : ['No measured score rows.'];
  for (const g of rows) { const marker = g.pricedShare != null && g.pricedShare < 1 ? (g.steps === 1 ? ` (${Math.round(g.pricedShare * g.n)}/${g.n} priced)` : ` (${(g.pricedShare * 100).toFixed(0)}% priced)`) : ''; const usd = (g.avgUsd == null ? '-' : f(g.avgUsd, 3)) + marker; const percent = (v) => v == null ? '-' : `${(v * 100).toFixed(0)}%`; lines.push(`${g.sel}${g.shipped ? ' [shipped]' : ''} | ${g.category}@${g.difficulty} | ${g.n} | ${g.rated} | ${f(g.quality, 2)} | ${f(g.accept, 2)} | ${g.pass}/${g.fixable}/${g.close || 0}/${g.fail}/${g.phantom} | ${usd} | ${f(g.avgPct, 1)} | ${f(g.avgDurationMs / 1000)} | ${f(g.avgRounds, 1)} | ${percent(g.errorRate)} | ${percent(g.toolErrorRate)} | ${f(g.avgTurns, 1)} | ${f(g.thrash)} | ${f(g.timeouts)} | ${g.costPerSuccess == null ? '-' : f(g.costPerSuccess, 3)} | ${percent(g.consistency)} | ${g.repeats ? `${g.repeats.min}-${g.repeats.max}` : '-'} | ${g.priorTier || '-'}`); }
  if (!archived) {
    lines.push('', `Plans (quality ≥ ${cfg.quality} over ≥ ${cfg.minSamples} recency-weighted rated; utility = $${cfg.qualityValueUsd} × quality − $ cost${cfg.hourlyUsd ? ` − $${cfg.hourlyUsd}/h` : ''}; $ = tokens at API list price × provider weight (${Object.entries(cfg.providerWeight || {}).map(([k, v]) => `${k} ${v}`).join(', ')}; full price past ${cfg.quotaPressurePct}% of a window; reserve ${cfg.reservePct} × weight × (ceiling − level); subscription reset discount ${(cfg.wasteSteps || []).map(([h, d]) => `−${Math.round(d * 100)}% ≤${h}h`).join(', ')})${cfg.coldStart === 'priors' ? '; cold start: hand-picked priors' : ''}):`);
    let any = false;
    for (const c of category ? [category] : CATEGORIES) for (const d of LEVELS) {
      const r = recommend({ category: c, difficulty: d, source, summary });
      if (r) { any = true; lines.push(`- ${c}@${d}: ${r.reason}`); }
    }
    if (!any) lines.push('- none yet (not enough rated runs above the bar)');
  }
  const benched = benchedCells(rows, cfg);
  if (benched.length) {
    lines.push('', `Benched (quality < ${cfg.quality} over ≥ ${cfg.benchMinSamples} recency-weighted rated):`);
    for (const g of benched) lines.push(`- ${g.sel} ${g.category}@${g.difficulty}: q${g.quality.toFixed(2)} over ${g.rated} raw / ${evidenceRated(g).toFixed(2)} weighted rated${g.last ? `, last run ${String(g.last).slice(0, 10)}` : ''}`);
  }
  if (manual.length) {
    lines.push('', 'Manual eligibility (latest per selection + category):');
    for (const r of manual) lines.push(`- ${r.action.toUpperCase()} ${r.sel} for ${r.category}: ${r.reason}`);
  }
  lines.push('', 'Error rates (fail + fixable; φ = phantom / unverified completions):');
  const ers = errorRates({ source, archived }).byProvider;
  if (!ers.length) lines.push('- none rated yet');
  else for (const e of ers) lines.push(`- ${e.key}: ${(e.errorRate * 100).toFixed(0)}% error, ${(e.phantomRate * 100).toFixed(0)}% φ (n=${e.rated})`);
  return lines.join('\n');
}
