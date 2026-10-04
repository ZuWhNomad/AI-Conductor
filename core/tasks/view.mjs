// Task views: what a task looks like to the fleet list, the detail endpoint and the conductor. Pure functions of a
// task record; no state, no I/O.

export function publicTask(t) {
  if (!t) return null;
  const { spec, ...rest } = t;
  return { ...rest, specPreview: String(spec ?? '').slice(0, 400) };
}

/** Fleet/list payload; detail endpoints and scoring keep the full record. */
export function taskSummary(t) {
  if (!t) return null;
  const { paths, diffStat, result, ...summary } = publicTask(t);
  summary.specPreview = summary.specPreview.slice(0, 120);
  if (result) {
    const { items, files, tools, finalMessage, ...small } = result;
    // The fleet's lastAction preview displays 120 characters.
    summary.result = { ...small, finalMessage: String(finalMessage || '').slice(0, 120) };
  } else summary.result = result;
  return summary;
}

/** Which tools/programs/MCP calls a worker used: { calls, errors, byName } from its items (all of them, not the journaled tail). */
export function countTools(items) {
  const out = { calls: 0, errors: 0, byName: {} };
  for (const i of items || []) {
    if (!i || !/tool_use|command_execution|mcp_tool_call/.test(i.type || '')) continue;
    const name = i.type === 'mcp_tool_call' ? `mcp:${i.server || '?'}:${i.tool || '?'}` : i.type === 'command_execution' ? `run:${String(i.command || '').trim().split(/\s+/)[0] || '?'}` : String(i.name || '?');
    out.calls++; out.byName[name] = (out.byName[name] || 0) + 1;
    if (i.error || i.isError || (typeof i.exitCode === 'number' && i.exitCode !== 0) || (typeof i.exit_code === 'number' && i.exit_code !== 0) || /^error:/i.test(String(i.output || ''))) out.errors++;
  }
  return out.calls ? out : null;
}

/** One compact, conductor-facing summary of a task. */
export function describeTask(t) {
  if (!t) return 'unknown task';
  const r = t.result || {};
  const cmds = r.tools?.calls ?? countTools(r.items)?.calls ?? 0;
  const lines = [
    `Task ${t.id} [${t.status}] ${t.title} — ${t.provider}${t.model ? `/${t.model}` : ''}${t.effort ? ` (${t.effort})` : ''}, round ${t.rounds + 1}${r.durationMs ? `, ${Math.round(r.durationMs / 1000)}s` : ''}${t.threadId ? `, thread ${t.threadId}` : ''}`,
  ];
  if (t.warning) lines.push(`Warning: ${t.warning}`);
  if (t.isolation) lines.push(`Isolation: worktree ${t.isolation.dir} from ${t.isolation.base}${t.isolation.branch ? `, branch ${t.isolation.branch}` : ''}; uncommitted changes in the main checkout are not in the worktree; remove it with worktree_cleanup, never plain "git worktree remove" (it follows the linked node_modules/.venv junctions and deletes their contents)`);
  if (t.status === 'stale') lines.push('Stale: interrupted by 2 restarts in a row. Ask the user to Re-run or Discard it.');
  else if (t.error) lines.push(`Error: ${t.error}`);
  if (t.failedOverTo) lines.push(`Failed over to task ${t.failedOverTo}: call await_task on it; this id will not complete.`);
  if (t.status === 'parked') {
    const source = t.park?.source || 'guess';
    const detail = source === 'window' ? 'reset reported' : source === 'retry-after' ? 'retry-after' : 'estimated; refined when limits refresh';
    lines.push(t.efficiencyMode
      ? `waiting for ${t.provider} reset at ${t.resumeAt ? new Date(t.resumeAt).toISOString() : '?'} (efficiency mode)`
      : `Parked until ${t.resumeAt ? new Date(t.resumeAt).toISOString() : '?'} (${detail}; auto-resumes)`);
  }
  if (t.status === 'running') {
    const p = t.progress, mins = (ms) => `${Math.round(ms / 60_000)} min`;
    lines.push(`Progress: running ${mins(Date.now() - (Date.parse(t.startedAt) || Date.now()))}${p?.activity ? `; last: ${p.activity}` : ''}${p?.tokens ? `; ${p.tokens} tokens so far` : ''}${p ? ` (as of ${mins(Date.now() - p.at)} ago)` : '; no worker activity yet'}`);
  }
  if (t.changedFiles?.length) lines.push(`Changed files: ${t.changedFiles.join(', ')}`);
  if (t.diffStat) lines.push(`Diff stat:\n${t.diffStat}`);
  if (r.usage) lines.push(`Usage: ${JSON.stringify(r.usage)}`);
  if (r.files?.length) lines.push(`Files: ${r.files.join(', ')}`);
  if (cmds) lines.push(`Actions: ${cmds} commands/tool calls`);
  if (r.finalMessage) lines.push(`Worker report:\n${r.finalMessage}`);
  return lines.join('\n');
}
