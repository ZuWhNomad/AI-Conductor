import { $, el, api, S, act } from './core.js';
import { md } from './markdown.js';

// ---------- rendering: transcript ----------
const T = () => $('#transcript');
function scrollBottom() { const t = T(); if (t.scrollHeight - t.scrollTop - t.clientHeight < 240) t.scrollTop = t.scrollHeight; }
let scrollPending = false;
function requestScrollBottom() {
  if (scrollPending) return;
  scrollPending = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      scrollPending = false;
      scrollBottom();
    });
  } else {
    scrollPending = false;
    scrollBottom();
  }
}
function clearTranscript() { T().innerHTML = ''; S.streams = new Map(); S.tools.clear(); S.pending.clear(); if (S.thinkingLines) S.thinkingLines.clear(); }
/** Streaming bubbles are tracked per parent (main thread = null, else the subagent's tool_use id) so interleaved subagent text never orphans a bubble. */
function streamFor(parent) { S.streams = S.streams || new Map(); return S.streams.get(parent || null) || null; }
function endStream(parent) { const st = streamFor(parent); if (st) { st.el.classList.remove('streaming'); S.streams.delete(parent || null); } }
function endAllStreams() { for (const st of (S.streams || new Map()).values()) st.el.classList.remove('streaming'); S.streams = new Map(); }
function stopSpinners(root = T()) { for (const s of root.querySelectorAll('.tool .st.spin')) s.replaceWith(el('span', 'st', '–')); }

function addUser(text, container, queued = null) {
  const m = el('div', 'msg user');
  if (queued?.id) {
    m.dataset.queueId = queued.id;
    m.classList.add('queued');
    m.append(el('span', 'user-text', text));
    m.append(el('span', 'queue-tag', 'queued'));
    const cancel = el('button', 'queue-cancel', '×');
    cancel.type = 'button'; cancel.title = 'Cancel queued message'; cancel.setAttribute('aria-label', 'Cancel queued message');
    cancel.onclick = () => act(async () => {
      cancel.disabled = true;
      try {
        const r = await api.del(`/api/sessions/${S.current.id}/queue/${encodeURIComponent(queued.id)}`);
        if (r.ok) removeQueuedBubble(queued.id);
      } finally { cancel.disabled = false; }
    });
    m.append(cancel);
  } else m.textContent = text;
  (container || T()).append(m); if (!container) scrollBottom();
}
function queuedBubble(id) { return [...T().querySelectorAll('.msg.user.queued')].find((m) => m.dataset.queueId === id); }
function dropQueueTag(id) {
  const m = queuedBubble(id); if (!m) return;
  m.classList.remove('queued');
  m.querySelector('.queue-tag')?.remove(); m.querySelector('.queue-cancel')?.remove();
  delete m.dataset.queueId;
}
function removeQueuedBubble(id) { queuedBubble(id)?.remove(); }
function addSys(text, cls = '', container) { const m = el('div', 'sysline ' + cls, text); (container || T()).append(m); if (!container) scrollBottom(); return m; }
function ensureStream(parent, container) {
  const have = streamFor(parent);
  if (have) return have;
  const m = el('div', 'msg assistant streaming' + (parent ? ' sub' : ''));
  const tn = document.createTextNode('');
  m.append(tn);
  (container || T()).append(m);
  const st = { el: m, tn, text: '', parent: parent || null };
  S.streams.set(parent || null, st);
  return st;
}
function addDelta(block, text, parent) {
  const pKey = parent || null;
  S.thinkingLines = S.thinkingLines || new Map();
  if (block !== 'text') {
    if (!S.thinkingLines.has(pKey)) {
      const lineEl = addSys('thinking…', pKey ? 'sub' : '');
      S.thinkingLines.set(pKey, lineEl);
    }
    return;
  }
  const th = S.thinkingLines.get(pKey);
  if (th) {
    th.remove();
    S.thinkingLines.delete(pKey);
  }
  const st = ensureStream(parent);
  st.text += text;
  if (st.tn && typeof st.tn.appendData === 'function') {
    st.tn.appendData(text);
  } else {
    st.el.textContent = st.text;
  }
  requestScrollBottom();
}
function addAssistant(msg, container) {
  const pKey = msg.parent || null;
  if (S.thinkingLines?.has(pKey)) {
    S.thinkingLines.get(pKey).remove();
    S.thinkingLines.delete(pKey);
  }
  for (const b of msg.blocks || []) {
    if (b.type === 'text') {
      const st = ensureStream(msg.parent || null, container);
      st.el.innerHTML = md(b.text); endStream(msg.parent || null);
    } else if (b.type === 'tool_use') {
      endStream(msg.parent || null);
      const d = el('details', 'tool' + (msg.parent ? ' sub' : ''));
      const sum = el('summary'); sum.append(el('span', null, '🔧'), el('span', 'n', b.name.replace('mcp__conductor__', 'conductor:')), el('span', 'muted', summarize(b.input)), el('span', 'st spin'));
      const body = el('div', 'body'); const pin = el('pre', null, JSON.stringify(b.input, null, 2)); body.append(pin);
      d.append(sum, body); (container || T()).append(d); S.tools.set(b.id, d);
    }
  }
  if (!container) scrollBottom();
}
function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.title || input.command || input.description || input.file_path || input.path || input.pattern || input.query || input.prompt || input.task_id || '';
  return String(v).slice(0, 90);
}
function addToolResult(msg) {
  const d = S.tools.get(msg.toolUseId);
  if (!d) return;
  d.querySelector('.st')?.replaceWith(el('span', 'st', msg.isError ? '✗' : '✓'));
  if (msg.isError) d.classList.add('err');
  const pre = el('pre', null, msg.text || '(no output)'); d.querySelector('.body').append(pre);
}
function addResult(msg, container) {
  endAllStreams();
  stopSpinners(container || T());
  if (S.thinkingLines) {
    for (const lineEl of S.thinkingLines.values()) lineEl.remove();
    S.thinkingLines.clear();
  }
  const cost = msg.costUsd ? ` · $${msg.costUsd.toFixed(3)}` : '';
  const dur = `${Math.round((msg.durationMs || 0) / 1000)}s${cost}`;
  if (msg.subtype === 'history') {
    addSys(`failed to load history: ${msg.text || 'unknown error'}`, 'err', container);
    return;
  }
  if (msg.subtype === 'interrupted' || msg.interrupted) {
    addSys(`interrupted · ${msg.numTurns ?? '?'} turns · ${dur}`, '', container);
    return;
  }
  addSys(`${msg.isError ? 'error: ' + (msg.text || msg.subtype) : 'done'} · ${msg.numTurns ?? '?'} turns · ${dur}`, msg.isError ? 'err' : '', container);
}
function addPermission(req) {
  const card = el('div', 'perm'); card.dataset.id = req.id;
  card.append(el('div', 'h', `Permission: ${req.toolName}${req.agentID ? ' (subagent)' : ''}`));
  if (req.description) card.append(el('div', 'muted', req.description));
  card.append(el('pre', null, JSON.stringify(req.input, null, 2).slice(0, 3000)));
  if (req.decisionReason) card.append(el('div', 'tiny muted', req.decisionReason));
  const row = el('div', 'row');
  const allow = el('button', 'primary sm', 'Allow'); const deny = el('button', 'sm danger', 'Deny');
  const answer = (a) => act(async () => {
    allow.disabled = true; deny.disabled = true;
    try {
      await api.post(`/api/sessions/${S.current.id}/permission`, { requestId: req.id, allow: a });
    } finally {
      allow.disabled = false; deny.disabled = false;
    }
  });
  allow.onclick = () => answer(true); deny.onclick = () => answer(false);
  row.append(allow, deny); card.append(row);
  T().append(card); S.pending.set(req.id, card);
  scrollBottom();
}
function resolvePermission(id, allow) {
  const c = S.pending.get(id); if (!c) return; S.pending.delete(id);
  c.querySelector('.row')?.replaceWith(el('div', 'tiny muted', allow === false ? 'denied' : allow ? 'allowed' : 'resolved'));
}

function renderHistory(messages) {
  clearTranscript();
  const frag = document.createDocumentFragment();
  for (const m of messages) {
    if (m.role === 'user') addUser(m.text, frag, m.queued ? { id: m.id } : null);
    else if (m.role === 'assistant') addAssistant(m, frag);
    else if (m.role === 'tool_result') addToolResult(m);
    else if (m.role === 'result') addResult(m, frag);
    else if (m.role === 'watchdog') addSys(m.text, 'watchdog', frag);
  }
  if (!messages.length) frag.append(el('div', 'empty', 'Say what you want done. The conductor will plan, delegate, and review.'));
  T().append(frag);
  scrollBottom();
}

export { T, stopSpinners, addUser, addSys, clearTranscript, renderHistory, addPermission, dropQueueTag, removeQueuedBubble, addDelta, addAssistant, addToolResult, addResult, resolvePermission };
