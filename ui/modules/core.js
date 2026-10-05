const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const COMPOSER_PLACEHOLDER = 'Tell the conductor what to do…  (Enter to send, Shift+Enter for newline, / for commands, Ctrl+M to dictate)';
const api = {
  get: (p) => fetch(p).then(ok),
  post: (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(ok),
  del: (p) => fetch(p, { method: 'DELETE' }).then(ok),
};
async function ok(r) { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; }

const authTimers = new Map(); // one pending "stop waiting" timer per provider
const S = { awaitingAuth: new Set(), sessions: [], current: null, models: { models: [], providers: {} }, limits: { providers: {} }, tasks: [], improvements: [], config: {}, providers: [], update: null, lastSeq: 0, tools: new Map(), pending: new Map(), taskEls: new Map(), workerLog: new Map(), scoreInfo: new Map() };
let modalOpener = null;

function loadProviderView() {
  S.providerView = { signedInOnly: false, groups: { subscriptions: true, keys: true, local: true } };
  try {
    const saved = JSON.parse(localStorage.getItem('providerView'));
    if (typeof saved?.signedInOnly === 'boolean') S.providerView.signedInOnly = saved.signedInOnly;
    for (const key of Object.keys(S.providerView.groups)) {
      if (typeof saved?.groups?.[key] === 'boolean') S.providerView.groups[key] = saved.groups[key];
    }
  } catch {}
}
function saveProviderView() {
  try { localStorage.setItem('providerView', JSON.stringify(S.providerView)); } catch {}
}
loadProviderView();

function asBtn(element, action) {
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.onclick = action;
  element.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action(e);
    }
  };
  return element;
}

function showStatus(message, target) {
  const region = !$('#modal').hidden ? $('#modal-status') : target || (!$('#model-pop').hidden ? $('#model-status') : $('#ui-status'));
  region.textContent = message;
}

async function act(fn, revert, target) {
  try {
    return await fn();
  } catch (err) {
    if (typeof revert === 'function') revert(err);
    else if (revert && typeof revert === 'object' && 'checked' in revert) revert.checked = !revert.checked;
    showStatus(err.message || String(err), target);
  }
}

function openModal(title, body) {
  if ($('#modal').hidden) modalOpener = document.activeElement;
  S.improvementView = null;
  document.body.classList.remove('nav-open');
  $('#modal-title').textContent = title;
  const b = $('#modal-body');
  b.innerHTML = '';
  b.append(body);
  $('#modal-status').textContent = '';
  $('#modal').classList.toggle('settings-modal', title === 'Settings');
  for (const node of document.querySelectorAll('#sidebar, #main, #fleet, #scrim')) node.inert = true;
  $('#modal').onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(); }
    if (e.key !== 'Tab') return;
    const focusable = [...$('#modal').querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    const next = e.shiftKey ? focusable.at(-1) : focusable[0];
    if (document.activeElement === (e.shiftKey ? focusable[0] : focusable.at(-1))) { e.preventDefault(); next.focus(); }
  };
  $('#modal').hidden = false;
  $('#modal-close').focus();
}
function closeModal() {
  S.improvementView = null;
  $('#modal').hidden = true;
  for (const node of document.querySelectorAll('#sidebar, #main, #fleet, #scrim')) node.inert = false;
  if (modalOpener && typeof modalOpener.focus === 'function') {
    modalOpener.focus();
    modalOpener = null;
  }
}

export { $, el, COMPOSER_PLACEHOLDER, api, S, authTimers, saveProviderView, asBtn, showStatus, act, openModal, closeModal };
