import { $, S } from './core.js';

// ---------- model chip (header) ----------
function renderChip() {
  const t = $('#chip-text'); const chip = $('#model-chip'); if (!t) return;
  if (!S.current) { t.textContent = 'No chat selected'; chip.classList.remove('live'); chip.disabled = true; return; }
  chip.disabled = false;
  const model = S.current.model && S.current.model !== 'default' ? S.current.model : 'default';
  t.textContent = `${S.current.provider || 'claude'} · ${model} · ${S.current.effort || 'high'}`;
  chip.classList.add('live');
}

export { renderChip };
