// Codex and loop turns both speak worker events. This maps them onto the one UI message shape.
import { nowIso } from '../paths.ts';
import { emit, persistAll, pushMessage } from './sessions.mjs';

/** Translate worker-style events (codex items / loop tool calls) into the UI's message shapes. */
export function turnEventMapper(s) {
  const seen = new Set();
  const say = (blocks) => { const msg = { role: 'assistant', blocks }; pushMessage(s, msg); emit(s, 'assistant', msg); };
  const result = (toolUseId, isError, text) => { const msg = { role: 'tool_result', toolUseId, isError: !!isError, text: String(text ?? '').slice(0, 4000) }; pushMessage(s, msg); emit(s, 'tool_result', msg); };
  return (event, data) => {
    if (event === 'thread' && data.threadId) { s.threadId = data.threadId; s.updatedAt = nowIso(); persistAll(); }
    else if (event === 'item' && data.item) {
      const it = data.item; const done = data.phase === 'completed';
      if (it.type === 'agent_message') { if (done && it.text) say([{ type: 'text', text: it.text }]); }
      else if (it.type === 'reasoning') { /* not shown */ }
      else if (it.type === 'command_execution') {
        if (!seen.has(it.id)) { seen.add(it.id); say([{ type: 'tool_use', id: it.id, name: 'shell', input: { command: it.command } }]); }
        if (done) result(it.id, it.exitCode != null && it.exitCode !== 0, it.output || `exit ${it.exitCode}`);
      } else if (it.type === 'file_change') {
        if (done) { say([{ type: 'tool_use', id: it.id, name: 'edit', input: { files: (it.changes || []).map((c) => `${c.kind || ''} ${c.path}`.trim()) } }]); result(it.id, false, 'applied'); }
      } else if (it.type === 'mcp_tool_call') {
        if (!seen.has(it.id)) { seen.add(it.id); say([{ type: 'tool_use', id: it.id, name: `conductor:${it.tool}`, input: it.args || {} }]); }
        if (done) result(it.id, !!it.error, it.error || it.result || 'done');
      } else if (it.type === 'tool_use') { // loop runtime
        if (data.phase === 'started') say([{ type: 'tool_use', id: it.id, name: it.name, input: it.args || it.input || {} }]);
      } else if (it.type === 'web_search') {
        if (!seen.has(it.id)) { seen.add(it.id); say([{ type: 'tool_use', id: it.id, name: 'web_search', input: { query: it.query } }]); }
        if (done) result(it.id, false, 'done');
      } else if (it.type === 'error') { emit(s, 'error', { message: it.message }); }
    } else if (event === 'tool_result') { result(data.toolUseId, data.isError, data.text); }
    else if (event === 'turn.failed' || event === 'error') { if (data.error) emit(s, 'error', { message: data.error }); }
  };
}
