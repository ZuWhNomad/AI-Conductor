// Stage templating: {{goal}}, {{seen}}, {{item}}, {{results:<stage>}}. Imports findings only.

import { locOf, titleOf } from './findings.mjs';

// Same 4000-char cap already used for a single free-text stage summary.
export const RESULTS_CHARS = 4000;
const findingFields = (f) => {
  const o = {};
  for (const k of ['id', 'title', 'detail', 'issue', 'summary', 'file', 'location', 'line', 'severity', 'evidence', 'fix']) {
    if (f[k] != null && f[k] !== '') o[k] = f[k];
  }
  return o;
};
function resultsText(r) {
  const parts = [];
  if (r.findings?.length) parts.push(JSON.stringify(r.findings.map(findingFields), null, 1));
  if (r.unverified?.length) {
    const unv = r.unverified.map((f) => ({
      ...findingFields(f),
      unverified: true,
      ...(f.failedTasks?.length ? { failedTasks: f.failedTasks } : {}),
    }));
    parts.push('Unverified:\n' + JSON.stringify(unv, null, 1));
  }
  if (parts.length) {
    const text = parts.join('\n\n');
    return text.length > RESULTS_CHARS ? text.slice(0, RESULTS_CHARS) + '…' : text;
  }
  return r.summary || '';
}

const fill = (tpl, vars) => String(tpl).replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));

/** Expand a stage into concrete task inputs given prior results (pure). */
export function expandStage(stage, ctx) {
  const vars = { goal: ctx.goal || '', seen: ctx.seen?.length ? ctx.seen.map((f) => `- ${titleOf(f)}${locOf(f) ? ` (${locOf(f)})` : ''}`).join('\n') : '(nothing yet)' };
  for (const [id, r] of Object.entries(ctx.results || {})) vars[`results:${id}`] = resultsText(r);
  const base = { ...(ctx.defaults || {}), ...(stage.defaults || {}) };
  if (!stage.for_each) return (stage.tasks || []).map((t, i) => ({ ...base, ...t, title: t.title || `${stage.id} #${i + 1}`, spec: fill(t.spec, vars) }));
  const [srcId, field] = String(stage.for_each).split('.');
  const src = ctx.results?.[srcId];
  const items = field === 'confirmed' ? src?.confirmed || [] : field === 'rejected' ? src?.rejected || [] : field === 'unverified' ? src?.unverified || [] : src?.findings || [];
  const out = [];
  for (const item of items) for (let v = 0; v < stage.votes; v++) {
    const lens = Array.isArray(stage.lenses) && stage.lenses.length ? stage.lenses[v % stage.lenses.length] : '';
    const stageTitle = stage.task.title || stage.id;
    const sharedSpec = fill(stage.task.spec, { ...vars, item: 'the item below', lens: 'the lens below' });
    const itemContext = [
      'Per-item vote context:',
      `Item JSON:\n${JSON.stringify(item, null, 1)}`,
      `Lens: ${lens || '(none)'}`,
      `Vote index: ${v}`,
    ].join('\n');
    out.push({ ...base, ...stage.task, item, vote: v, title: `${stageTitle}: ${titleOf(item).slice(0, 50)}${stage.votes > 1 ? ` [${v + 1}/${stage.votes}]` : ''}`, spec: `Stage: ${stageTitle}\n\n${sharedSpec}\n\n${itemContext}` });
  }
  return out;
}
