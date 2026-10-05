// ---------- markdown-lite ----------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function md(src) {
  const parts = String(src).split(/```/);
  return parts.map((p, i) => {
    if (i % 2 === 1) { const nl = p.indexOf('\n'); const body = nl >= 0 ? p.slice(nl + 1) : p; return `<pre>${esc(body.replace(/\n$/, ''))}</pre>`; }
    return esc(p)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }).join('');
}

export { esc, md };
