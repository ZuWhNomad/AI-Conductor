import { HOME } from '../_env.mjs';
import { join } from 'node:path';
import { appendNdjson, statePath, writeJson } from '../../core/paths.ts';

// Registries are loaded at import time: seed them before importing the scorecard.
writeJson(join(HOME, 'models.json'), { updatedAt: 'x', providers: { codex: { status: 'ok' }, claude: { status: 'ok' }, deepseek: { status: 'ok' } }, models: [
  { provider: 'deepseek', id: 'deepseek-chat', kind: 'agent', cost: 'api' },
  { provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'codex', id: 'gpt-5.6-terra', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'codex', id: 'gpt-6-astra', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'claude', id: 'haiku', kind: 'agent', cost: 'subscription' },
  ...[
    ['claude', 'opus'], ['claude', 'sonnet'],
    ['deepseek', 'deepseek-flash'], ['antigravity', 'flash'],
  ].map(([provider, id]) => ({ provider, id, kind: 'agent' })),
] });
writeJson(join(HOME, 'limits.json'), { updatedAt: 'x', providers: {
  codex: { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] },
} });

export const sc = await import('../../core/scorecard.mjs');
export const pr = await import('../../core/priors.mjs');
export const { loadConfig, saveConfig, DEFAULTS } = await import('../../core/config.mjs');
export const { getModels } = await import('../../core/models.mjs');
// Explicit fixture class and zero price keep routing/cost scenarios independent of a local provider.
saveConfig({ scorecard: { classes: { codex: 'subscription', deepseek: 'free' }, prices: { 'deepseek:deepseek-chat': { in: 0, out: 0, cached: 0 } } } });
export const registryModels = (t, models) => {
  const reg = getModels(), previous = reg.models;
  reg.models = [...previous, ...models.map(([provider, id]) => ({ provider, id, kind: 'agent' }))];
  t.after(() => { reg.models = previous; });
};

let n = 0;
export const USAGE = { input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 10_000 }; // 50k uncached in, 50k cached, 10k out
export const run = ({ before, ...o }) => sc.recordRun({ id: o.id || `t${++n}`, title: 't', status: 'done', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'implement', difficulty: 2, result: { usage: USAGE, durationMs: 1000 }, ...o }, { before });
export const seed = (provider, model, effort, category, difficulty, verdicts, { usage = USAGE, retryOf = null, source = null } = {}) => {
  const ids = [];
  for (const v of verdicts) {
    const id = `s${++n}`; ids.push(id);
    run({ id, source, provider, model, effort, category, difficulty, retryOf, result: { usage, durationMs: 1000 } });
    if (v) sc.rateTask(id, v);
  }
  return ids;
};


export { HOME, join, appendNdjson, statePath, writeJson };
