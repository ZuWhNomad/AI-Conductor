import { loadConfig } from '../../core/config.mjs';
import { bus } from '../../core/bus.ts';
import { getModels, refreshModels } from '../../core/models.mjs';
import { getLimits, refreshLimits } from '../../core/limits.mjs';
import { estimateUsage, recordUsage, limitsWithEstimates } from '../../core/usage-estimate.mjs';
import { PROVIDERS } from '../../core/providers/index.mjs';
import { detectCapabilities } from '../../core/capabilities.mjs';
import { json, readBody } from './_http.mjs';

export async function handle(ctx) {
  const { req, res, m, p, seg } = ctx;
  if (p === '/api/models' && m === 'GET') return json(res, 200, getModels());
  if (p === '/api/models/refresh' && m === 'POST') { const b = await readBody(req); const only = Array.isArray(b?.only) && b.only.length ? b.only : null; const r = await refreshModels(only ? { only } : undefined); if (!only) detectCapabilities().catch(() => {}); return json(res, 200, r); }
  if (p === '/api/limits' && m === 'GET') return json(res, 200, limitsWithEstimates());
  if (seg[1] === 'providers' && seg[2] && seg[3] === 'usage' && m === 'POST') {
    if (!PROVIDERS[seg[2]]) return json(res, 400, { error: 'unknown provider' });
    const b = await readBody(req); const pct = Number(b.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json(res, 400, { error: 'pct must be 0-100' });
    const row = recordUsage(seg[2], pct); bus.publish('limits', { updatedAt: getLimits().updatedAt });
    return json(res, 200, { ok: true, recorded: row, estimate: estimateUsage(seg[2], { budgetTokens: loadConfig().scorecard?.usageBudgets?.[seg[2]] || null }) });
  }
  if (p === '/api/limits/refresh' && m === 'POST') return json(res, 200, await refreshLimits());
  return false;
}
