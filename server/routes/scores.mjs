import { summarize, formatScores, scoresGrid, benchedCells, eligibilityOverrides, setEligibility } from '../../core/scorecard.mjs';
import { dueForBench, formatBench } from '../../core/bench.mjs';
import { json, readBody } from './_http.mjs';

export async function handle(ctx) {
  const { req, res, url, m, p } = ctx;
  if (p === '/api/bench' && m === 'GET') { const due = dueForBench(); return json(res, 200, { due, text: formatBench(due) }); }
  if (p === '/api/scores/eligibility' && m === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: true, eligibility: setEligibility(b.sel, b.category, b.action, b.reason) });
  }
  if (p === '/api/scores' && m === 'GET') {
    const source = url.searchParams.get('source') || null;
    const archived = url.searchParams.get('archived') === '1';
    const category = url.searchParams.get('category') || null;
    const summary = summarize({ source, archived });
    return json(res, 200, {
      text: formatScores({ source, category, archived, summary }),
      grid: archived ? [] : scoresGrid({ source, summary, categories: category ? [category] : undefined }),
      benched: benchedCells(summary.filter((g) => !category || g.category === category)).map((g) => ({
        selection: g.sel, category: g.category, level: g.difficulty, quality: g.quality, n: g.rated,
        weightedN: g.weightedRated ?? g.rated, last: g.last || null, shipped: !!g.shipped,
        consistency: g.consistency ?? null, repeats: g.repeats ?? null,
      })),
      eligibility: archived ? [] : eligibilityOverrides({ category }),
    });
  }
  return false;
}
