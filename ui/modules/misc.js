import { $, el, api, S, act, showStatus, openModal } from './core.js';
import { renderProviders } from './sidebar.js';
import { connect } from './sse.js';

// ---------- quit / misc ----------
/** Stop the server process (destructive: gated behind a confirm). Used by the top-left Quit and the Settings Quit. */
async function quitServer(btn) {
  if (!confirm('Stop the Conductor server? In-flight tasks resume next time you start it. This tab stops working until you restart it.')) return false;
  S.stopped = true;
  if (S.eventSource) { try { S.eventSource.close(); } catch {} S.eventSource = null; }
  if (btn) btn.disabled = true;
  try { await api.post('/api/shutdown', {}); } catch (e) {
    S.stopped = false; if (btn) btn.disabled = false; connect(); showStatus(e.message); return false;
  }
  document.body.innerHTML = '<div style="padding:2rem;font:14px system-ui">Conductor stopped. Restart it with <code>conductor start</code>, then reload this page.</div>';
  return true;
}
function toggleModelPop(force) {
  const pop = $('#model-pop'); if (!pop) return;
  const show = force != null ? force : pop.hidden;
  pop.hidden = !show;
  $('#model-chip')?.setAttribute('aria-expanded', String(show));
}
/** SYSTEM drawer: providers, self-improvement, benchmarks, settings out of the primary flow. */
function openSystem(open) {
  const b = $('#system-body'); if (!b) return;
  const isOpen = open != null ? open : b.hidden;
  b.hidden = !isOpen;
  try { localStorage.setItem('systemOpen', isOpen ? '1' : '0'); } catch {}
  if (!isOpen) { S.revealSubscriptions = false; renderProviders(); }
  const car = $('#system-toggle .caret'); if (car) car.textContent = isOpen ? '▾' : '▸';
  $('#system-toggle')?.setAttribute('aria-expanded', String(isOpen));
}
/** "details ▸" on the budget headline opens the SYSTEM drawer at Providers & limits. */
function revealProviders() {
  openSystem(true); S.revealSubscriptions = true; renderProviders();
  document.body.classList.add('nav-open');
  $('.providers-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function openScores() {
  const body = el('div');
  const head = el('div', 'row between');
  const title = el('h4', null, 'Scores (measured worker selection)');
  const toggle = el('label', 'chk'); const archived = el('input'); archived.type = 'checkbox'; archived.setAttribute('aria-label', 'Show archived scores');
  toggle.append(archived, el('span', null, 'archived')); head.append(title, toggle);
  const gridTitle = el('h4', null, 'Category × level'); const grid = el('div', 'score-grid-wrap', 'Loading…');
  const benchedTitle = el('h4', null, 'Benched cells'); const benched = el('pre');
  const details = el('details', 'score-details'); const detailsLabel = el('summary', null, 'Full table and routing details');
  const scores = el('pre', null, 'Loading…'); details.append(detailsLabel, scores);
  const eligibility = el('div', 'row');
  const sel = el('input'); sel.placeholder = 'provider:model:effort'; sel.setAttribute('aria-label', 'Eligibility selection');
  const category = el('select'); category.setAttribute('aria-label', 'Eligibility category');
  const reason = el('input'); reason.placeholder = 'reason'; reason.setAttribute('aria-label', 'Eligibility reason');
  const block = el('button', 'sm danger', 'Block'); const allow = el('button', 'sm', 'Allow'); const eligibilityStatus = el('span', 'tiny muted');
  eligibility.append(sel, category, reason, block, allow, eligibilityStatus);
  const benchTitle = el('h4', null, 'Due for benchmark'); const bench = el('pre');
  body.append(head, gridTitle, grid, benchedTitle, benched, details, eligibility, benchTitle, bench);
  openModal('Benchmarks & scores', body);
  let benchData;
  const renderGrid = (rows) => {
    grid.textContent = '';
    if (!rows?.length) { grid.textContent = archived.checked ? 'Archived scores are listed in the full table.' : 'No score data.'; return; }
    const table = el('table', 'score-grid'); const thead = el('thead'); const hr = el('tr');
    const levelCols = rows[0]?.levels?.length ? rows[0].levels.map((c) => c.level) : [1, 2, 3, 4, 5, 6, 7];
    hr.append(el('th', null, 'Category'), ...levelCols.map((n) => el('th', null, `L${n}`))); thead.append(hr);
    const tbody = el('tbody');
    const reliability = (cell) => {
      const bits = [];
      if (cell.consistency != null) bits.push(`consistency ${(cell.consistency * 100).toFixed(0)}%`);
      if (cell.repeats) bits.push(`repeats ${cell.repeats.min}-${cell.repeats.max}`);
      if (cell.errorRate != null) bits.push(`err ${(cell.errorRate * 100).toFixed(0)}%`);
      if (cell.toolErrorRate != null) bits.push(`tool ${(cell.toolErrorRate * 100).toFixed(0)}%`);
      if (cell.avgTurns != null) bits.push(`turns ${cell.avgTurns.toFixed(1)}`);
      if (cell.thrash != null) bits.push(`thrash ${cell.thrash}`);
      if (cell.timeouts != null) bits.push(`timeouts ${cell.timeouts}`);
      if (cell.costPerSuccess != null) bits.push(`$/pass ${cell.costPerSuccess < 0.1 ? cell.costPerSuccess.toFixed(3) : cell.costPerSuccess.toFixed(2)}`);
      return bits.join(' · ');
    };
    for (const row of rows) {
      const tr = el('tr'); tr.append(el('th', null, row.category));
      for (const cell of row.levels || []) {
        let text;
        if (cell.status === 'no-data') text = 'no data';
        else if (cell.status === 'capped') text = `capped\n${(cell.selections || []).join(', ')}\nuntil ${cell.resetAt ? new Date(cell.resetAt).toLocaleString() : 'reset unknown'}`;
        else {
          const source = cell.evidenceSource === 'prior' ? 'prior' : `${cell.shipped ? 'shipped ' : ''}${cell.evidenceSource || 'evidence'}`;
          const rel = reliability(cell);
          text = `${cell.selection}\n${cell.quality == null ? '' : `q${cell.quality.toFixed(2)} · `}${source} · n=${cell.n ?? 0} · ${cell.last ? String(cell.last).slice(0, 10) : '-'}${rel ? `\n${rel}` : ''}`;
        }
        const td = el('td', `score-cell ${cell.status}`, text); td.title = text.replaceAll('\n', ' '); tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody); grid.append(table);
  };
  const load = async () => {
    scores.className = ''; scores.textContent = 'Loading…';
    try {
      const [sc, bn] = await Promise.all([api.get(archived.checked ? '/api/scores?archived=1' : '/api/scores'), benchData === undefined ? api.get('/api/bench').catch(() => null) : benchData]);
      benchData = bn; title.textContent = archived.checked ? 'Archived scores' : 'Scores (measured worker selection)'; scores.textContent = sc.text || '(no rated runs yet)'; renderGrid(sc.grid);
      if (sc.grid?.length) {
        const selected = category.value;
        category.replaceChildren(...sc.grid.map((row) => { const o = el('option', null, row.category); o.value = row.category; return o; }));
        if (sc.grid.some((row) => row.category === selected)) category.value = selected;
      }
      benchedTitle.hidden = benched.hidden = !(sc.benched || []).length;
      benched.textContent = (sc.benched || []).map((c) => `${c.selection} ${c.category}@${c.level}: q${c.quality.toFixed(2)}, n=${c.n}, ${c.last ? String(c.last).slice(0, 10) : '-'}`).join('\n');
      eligibility.hidden = archived.checked;
      benchTitle.hidden = bench.hidden = archived.checked || !bn?.text;
      bench.textContent = bn?.text || '';
    } catch (e) { scores.className = 'sysline err'; scores.textContent = e.message; }
  };
  const submitEligibility = (action) => act(async () => {
    eligibilityStatus.textContent = 'Saving…';
    try {
      const r = await api.post('/api/scores/eligibility', { sel: sel.value, category: category.value, action, reason: reason.value });
      eligibilityStatus.textContent = `${r.eligibility.action} saved`;
      await load();
    } catch (e) { eligibilityStatus.textContent = e.message; }
  });
  block.onclick = () => submitEligibility('block'); allow.onclick = () => submitEligibility('allow');
  archived.onchange = load;
  await load();
}

export { quitServer, toggleModelPop, openSystem, revealProviders, openScores };
