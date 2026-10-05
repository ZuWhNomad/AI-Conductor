// Per-task brief: <state>/tasks/<id>.md. Written once, appended once when the task is terminal. No task state.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact, statePath } from '../paths.ts';
import { logImprovement } from '../improve.mjs';

const TERMINAL = new Set(['done', 'failed', 'canceled']);
// Unique so a spec that itself contains a bare "## Result" (pasted worker reports) does not suppress the append.
const RESULT_MARKER = '## Result <!-- conductor:result -->';

function hasResult(text) {
  return text.split(/\r?\n/).includes(RESULT_MARKER);
}

export const briefPath = (id) => statePath('tasks', `${id}.md`);

// Same text as the first line of describeTask. Kept here so the brief does not import the view.
function statusLine(t) {
  const r = t.result || {};
  return `Task ${t.id} [${t.status}] ${t.title} — ${t.provider}${t.model ? `/${t.model}` : ''}${t.effort ? ` (${t.effort})` : ''}, round ${t.rounds + 1}${r.durationMs ? `, ${Math.round(r.durationMs / 1000)}s` : ''}${t.threadId ? `, thread ${t.threadId}` : ''}`;
}

function briefText(t) {
  const lines = [
    `# ${t.title ?? ''}`,
    '',
    `- id: ${t.id}`,
    `- created: ${t.createdAt ?? ''}`,
    `- cwd: ${t.cwd ?? ''}`,
    `- provider: ${t.provider ?? ''}:${t.model ?? ''}:${t.effort ?? ''}`,
    `- category: ${t.category || t.difficulty ? `${t.category ?? '-'}@${t.difficulty ?? '-'}` : '-'}`,
  ];
  if (t.followUpOf) lines.push(`- followUpOf: ${t.followUpOf}`);
  if (t.retryOf) lines.push(`- retryOf: ${t.retryOf}`);
  if (t.isolation) {
    const i = t.isolation;
    lines.push(`- isolation: ${i.dir || ''}${i.base ? ` from ${i.base}` : ''}${i.branch ? `, branch ${i.branch}` : ''}`);
  }
  lines.push('', '## Spec', '', String(t.spec ?? ''), '');
  return lines.join('\n');
}

function resultText(t) {
  const r = t.result || {};
  const lines = ['', RESULT_MARKER, '', statusLine(t), ''];
  if (t.isolation?.dir || t.isolation?.branch) {
    const i = t.isolation;
    const parts = [];
    if (i.dir) parts.push(i.dir);
    if (i.branch) parts.push(`branch ${i.branch}`);
    lines.push(`- isolation: ${parts.join(', ')}`, '');
  }
  if (t.error) lines.push(`Error: ${t.error}`, '');
  if (t.changedFiles?.length) lines.push(`Changed files: ${t.changedFiles.join(', ')}`, '');
  if (t.diffStat) lines.push('Diff stat:', t.diffStat, '');
  if (r.usage) lines.push(`Usage: ${JSON.stringify(r.usage)}`, '');
  lines.push(String(r.finalMessage ?? ''), '');
  return lines.join('\n');
}

/** Create the brief if it is missing, and append the result marker once when the task is terminal. Never throws. */
export function syncBrief(t) {
  if (!t?.id) return;
  try {
    const file = briefPath(t.id);
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, redact(briefText(t)));
    }
    if (TERMINAL.has(t.status) && !hasResult(readFileSync(file, 'utf8'))) appendFileSync(file, redact(resultText(t)));
  } catch (e) {
    try { logImprovement('error', 'tasks:brief', `brief ${t.id}: ${e?.message || e}`, { taskId: t.id }); } catch {}
  }
}
