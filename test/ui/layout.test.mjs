import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { DEFAULTS } from '../../core/config.mjs';

const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../ui/styles.css', import.meta.url), 'utf8');
function uiSource(root) {
  const files = ['modules/core.js', 'modules/markdown.js', 'modules/sidebar.js', 'modules/budget.js', 'modules/chip.js', 'modules/picker.js', 'modules/transcript.js', 'modules/fleet.js', 'modules/sessions.js', 'modules/update.js', 'modules/sse.js', 'modules/modals.js', 'modules/misc.js', 'app.js'];
  return files.map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n').replace(/^\s*import\b.*$/gm, '').replace(/^\s*export\b.*$/gm, '');
}
const app = uiSource(new URL('../../ui/', import.meta.url));
export function browserCandidates(env = process.env, exists = existsSync) {
  if (env.CONDUCTOR_TEST_BROWSER) return [env.CONDUCTOR_TEST_BROWSER];
  const dirs = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  return [
    ...dirs.map((dir) => join(dir, 'Google/Chrome/Application/chrome.exe')),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...dirs.map((dir) => join(dir, 'Microsoft/Edge/Application/msedge.exe')),
  ].filter(exists);
}

export async function launchBrowser(candidates, userDataDir = join(HOME, 'browser')) {
  let lastError;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const profileDir = candidates.length > 1 ? `${userDataDir}-${i}` : userDataDir;
    const browser = spawn(candidate, ['--headless', '--disable-gpu', '--no-first-run', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(browser, 'exit').catch(() => {});
    try {
      const url = await new Promise((resolve, reject) => {
        let stderr = '';
        browser.stderr.on('data', (data) => {
          stderr += data;
          const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
          if (match) resolve(match[1]);
        });
        browser.once('error', reject);
        browser.once('exit', (code) => reject(new Error(`Browser exited (${code}): ${stderr}`)));
      });
      return { browser, url, exited };
    } catch (err) {
      lastError = err;
      if (browser.pid && browser.exitCode === null) { try { browser.kill(); } catch {} }
      await exited;
    }
  }
  throw lastError || new Error('No browser candidate could be launched');
}

const candidates = browserCandidates();

test('quit has a font-independent icon and an accessible name', () => {
  const quit = html.match(/<button\b[^>]*id="btn-quit"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(quit, /aria-label="Quit"/);
  assert.match(quit, /<svg\b[^>]*aria-hidden="true"[^>]*>[\s\S]*<path\b/);
  assert.doesNotMatch(quit, /⏻/);
});

test('icon buttons have aria-labels, modal has dialog role, and favicon link is present', () => {
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,[^"]*🎼[^"]*">/);
  assert.match(html, /<button id="btn-settings"[^>]*aria-label="Settings"/);
  assert.match(html, /<button id="btn-browse"[^>]*aria-label="Browse folders"/);
  const mic = html.match(/<button\b[^>]*id="btn-mic"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(mic, /aria-label="Speech to text"/);
  assert.match(mic, /<svg\b[^>]*aria-hidden="true"[^>]*>[\s\S]*<path\b/);
  assert.match(html, /<button id="fleet-collapse"[^>]*aria-label="Collapse \/ expand fleet"/);
  assert.match(html, /<button id="modal-close"[^>]*aria-label="Close dialog"/);
  assert.match(html, /<div id="modal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="modal-title"/);
});

test('chat actions are native buttons and do not select the chat', () => {
  const code = app.slice(app.indexOf('function renderSessions()'), app.indexOf('async function renameSession('));
  const box = { children: [], append(node) { this.children.push(node); } };
  const selected = [], renamed = [], deleted = [];
  const el = (tag, cls, text) => ({ tag, className: cls, textContent: text, children: [],
    setAttribute(key, value) { this[key] = value; }, append(...nodes) { this.children.push(...nodes); } });
  runInNewContext(code + '\nrenderSessions();', {
    S: { sessions: [{ id: 'chat-1', title: 'Chat', cwd: '/project' }], tasks: [], current: null },
    $: () => box, el,
    asBtn: (node, action) => { node.onclick = action; node.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') action(e); }; },
    renameSession: (session) => renamed.push(session.id), openSession: (id) => selected.push(id),
    confirm: () => true, act: (fn) => fn(), api: { del: (path) => deleted.push(path) },
  });
  const row = box.children[0];
  const [rename, remove] = row.children.slice(-2);
  assert.deepEqual([rename.tag, remove.tag], ['button', 'button']);
  assert.deepEqual([rename.type, remove.type], ['button', 'button']);
  assert.deepEqual([rename['aria-label'], remove['aria-label']], ['Rename chat', 'Delete chat']);
  for (const button of [rename, remove]) {
    let stopped = false;
    button.onclick({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
    button.onkeydown({ key: 'Enter', stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
  }
  assert.deepEqual(selected, []);
  assert.deepEqual(renamed, ['chat-1']);
  assert.deepEqual(deleted, ['/api/sessions/chat-1']);
});

test('folder picker shows a browse error and disables folder selection', async () => {
  const code = app.slice(app.indexOf('async function browse(path)'), app.indexOf('function openSettings()'));
  let modal;
  const el = (tag, cls, text) => ({ tag, className: cls, textContent: text, children: [],
    setAttribute(key, value) { this[key] = value; }, append(...nodes) { this.children.push(...nodes); } });
  await runInNewContext(code + '\nbrowse("/missing")', {
    api: { get: async () => { throw new Error('Folder does not exist'); } },
    localStorage: { getItem: () => '', setItem() {} }, el, $: () => ({}),
    openModal: (_title, body) => { modal = body; }, closeModal() {}, act() {}, asBtn() {},
    encodeURIComponent,
  });
  const [input, , use] = modal.children[0].children;
  assert.equal(input.value, '/missing');
  assert.equal(use.disabled, true);
  assert.equal(modal.children[1].textContent, 'Cannot open folder: Folder does not exist');
});

test('new-chat toggles wrap inside the sidebar', () => {
  assert.match(html, /<div class="row between wrap"><span id="new-selection"/);
});

test('running progress uses clipped transform animation', () => {
  assert.match(css, /\.task \.prog \{[^}]*overflow: hidden/);
  assert.match(css, /@keyframes slide \{ 0% \{ transform: translateX\(-100%\); \} 100% \{ transform: translateX\(250%\); \} \}/);
});

test('bare slash lists commands; model suggestions need a query', () => {
  const start = app.indexOf('function cmdItemsFor(query)');
  const code = app.slice(start, app.indexOf('/** Open only', start));
  const models = [{ kind: 'agent', id: 'gpt-6-astra', label: 'Astra', provider: 'codex' }];
  const items = runInNewContext(code + '\n({ empty: cmdItemsFor(""), query: cmdItemsFor("ast") })', {
    S: { models: { models } }, COMMANDS: [{ cmd: 'worker', args: '<spec>', help: 'Default worker' }],
  });
  assert.deepEqual(Array.from(items.empty, (item) => item.label), ['/worker <spec>']);
  assert.deepEqual(Array.from(items.query, (item) => item.label), ['/worker gpt-6-astra']);
});

test('browser candidates prefer Chrome over Edge and respect CONDUCTOR_TEST_BROWSER', () => {
  const dirs = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' };
  const list = browserCandidates(dirs, () => true);
  const lastChrome = list.findLastIndex((p) => p.includes('Chrome') || p.includes('chrome'));
  const firstEdge = list.findIndex((p) => p.includes('Edge') || p.includes('edge'));
  assert.ok(lastChrome !== -1 && firstEdge !== -1, 'both Chrome and Edge candidates present');
  assert.ok(lastChrome < firstEdge, 'all Chrome candidates precede Edge candidates');
  assert.deepEqual(browserCandidates({ CONDUCTOR_TEST_BROWSER: 'custom-bin' }, () => true), ['custom-bin']);
});

test('launchBrowser falls back when earlier candidate exits early', {
  skip: !candidates.length && 'Set CONDUCTOR_TEST_BROWSER to a Chromium executable',
}, async (t) => {
  const { browser, url, exited } = await launchBrowser([process.execPath, ...candidates], join(HOME, 'browser-fallback'));
  t.after(async () => { if (browser.pid && browser.exitCode === null) { try { browser.kill(); } catch {} } await exited; });
  assert.match(url, /^ws:\/\//);
});

test('rendered UI regressions', { skip: !candidates.length && 'Set CONDUCTOR_TEST_BROWSER to a Chromium executable' }, async (t) => {
  const { browser, url, exited } = await launchBrowser(candidates);
  let socket;
  t.after(async () => { socket?.close(); if (browser.pid && browser.exitCode === null) { try { browser.kill(); } catch {} } await exited; });
  socket = new WebSocket(url);
  await once(socket, 'open');
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => call(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp('Page.enable');
  const { frameTree } = await cdp('Page.getFrameTree');
  await cdp('Page.setDocumentContent', { frameId: frameTree.frame.id, html: html
    .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
    .replace('<script type="module" src="/app.js"></script>', '') });
  // Run the actual render functions without boot's network requests or speech setup.
  await evaluate(app.replace(/^import[^\n]*\n/, '').replace(/^boot\(\)\.catch\([\s\S]*$/m, ''));
  await t.test('ultra survives fallback model pickers and saved selections', async () => {
    for (const model of ['', 'unlisted-model']) {
      const result = await evaluate(`
        (() => {
        S.providers = [{ id: 'codex', kind: 'codex' }]; S.models.models = [];
        fillPicker('new-', { provider: 'codex', model: ${JSON.stringify(model)}, effort: 'ultra' }, { all: false });
        const saved = new Map();
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } });
        refreshNewPicker(true);
        return { current: pickerValue('new-'), saved: savedSelection() };
        })();
      `);
      assert.deepEqual(result.current, { provider: 'codex', model, effort: 'ultra' });
      assert.deepEqual(result.saved, result.current);
    }
    const effort = await evaluate(`
      S.models.models = [{ provider: 'codex', id: 'listed', label: 'Listed', kind: 'agent', efforts: ['low', 'high'] }];
      fillPicker('new-', { provider: 'codex', model: 'listed', effort: 'ultra' }, { all: false });
      pickerValue('new-').effort;
    `);
    assert.equal(effort, 'high', 'listed model capabilities still take precedence');
  });
  await evaluate(`
    S.current = { provider: 'codex', model: 'gpt-5.6-long-model-name', effort: 'high' }; renderChip();
    $('#chat-title').textContent = 'A chat title that should shrink to fit';
    $('#chat-cwd').textContent = 'C:/projects/conductor';
    $('#btn-update').hidden = false;
    $('#tasks').innerHTML = '<div class="task running"><div class="t">A running worker</div><div class="last">Working on the requested change</div></div>';
  `);
  for (const width of [1920, 1000, 375]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    for (const collapsed of [false, true]) {
      await t.test(`${width}px, fleet ${collapsed ? 'collapsed' : 'expanded'}`, async () => {
        const geometry = await evaluate(`
          document.body.classList.toggle('fleet-collapsed', ${collapsed});
          ({ width: innerWidth, height: innerHeight, scrollWidth: document.body.scrollWidth,
            rects: Object.fromEntries(['main', 'chat-header', 'composer', 'btn-stop', 'btn-send', 'model-chip', 'fleet', 'fleet-collapse']
              .map(id => [id, document.getElementById(id).getBoundingClientRect().toJSON()])) });
        `);
        assert.equal(geometry.width, width);
        assert.ok(geometry.scrollWidth <= width, 'body does not overflow horizontally');
        assert.equal(geometry.rects.main.right, width <= 1100 ? width : geometry.rects.fleet.left, 'main fills the available columns');
        for (const [id, rect] of Object.entries(geometry.rects)) {
          assert.ok(rect.width > 0 && rect.height > 0, `${id} is visible`);
          assert.ok(rect.left >= 0 && rect.right <= width, `${id} fits horizontally: ${JSON.stringify(rect)}`);
          assert.ok(rect.top >= 0 && rect.bottom <= geometry.height, `${id} fits vertically: ${JSON.stringify(rect)}`);
        }
        if (width <= 1100) assert.ok(geometry.rects.main.bottom <= geometry.rects.fleet.top, 'dock is below main without overlap');
      });
    }
  }
  await t.test('search and provider controls fit the sidebar at each viewport', async () => {
    for (const width of [1920, 1000, 375]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
      const result = await evaluate(`
        document.body.classList.add('nav-open'); $('#sidebar').style.transition = 'none'; openSystem(true);
        $('#chat-filter').focus();
        ({ background: getComputedStyle($('#chat-filter')).backgroundColor, border: getComputedStyle($('#chat-filter')).borderColor,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          overflow: $('#sidebar').scrollWidth > $('#sidebar').clientWidth,
          fits: ['chat-filter', 'providers-signed-in', 'auto-refresh', 'btn-refresh'].every(id => { const r = $('#' + id).getBoundingClientRect(), side = $('#sidebar').getBoundingClientRect(); return r.left >= side.left && r.right <= side.right; }) });
      `);
      assert.equal(result.background, 'rgb(22, 26, 33)');
      assert.equal(result.border, 'rgb(124, 156, 255)');
      assert.equal(result.overflow, false); assert.equal(result.fits, true);
    }
    const results = await evaluate(`
      S.sessions = [{ id: 'a', title: 'Alpha', cwd: '/Project/ONE' }, { id: 'b', title: 'Beta', cwd: '/two' }];
      ['ALPHA', 'project/one', ''].map(query => { S.chatFilter = query; renderSessions(); return $('#sessions').children.length; });
    `);
    assert.deepEqual(results, [1, 1, 2]);
    await evaluate(`document.body.classList.remove('nav-open'); S.chatFilter = '';`);
  });
  await t.test('budget freshness belongs to the selected provider', async () => {
    const result = await evaluate(`
      S.boot = 2000;
      S.models.providers = { codex: { status: 'ok' } };
      S.limits = { updatedAt: 3000, providers: { codex: { updatedAt: 1000, windows: [
        { id: 'codex:primary', windowMinutes: 300, usedPercent: 12 },
        { id: 'codex:secondary', windowMinutes: 10080, usedPercent: 94 }
      ] } } };
      renderBudget(); ({ stale: $('#budget').classList.contains('stale'), text: $('#budget').textContent });
    `);
    assert.equal(result.stale, true, 'another provider refresh must not make cached numbers current');
    assert.match(result.text, /as of/);
    const fresh = await evaluate(`S.limits.providers.codex.updatedAt = 3000; renderBudget(); $('#budget').classList.contains('stale');`);
    assert.equal(fresh, false);
    const failed = await evaluate(`S.limits.providers.codex.error = 'poll failed'; renderBudget(); ({ stale: $('#budget').classList.contains('stale'), text: $('#budget').textContent });`);
    assert.equal(failed.stale, true, 'a failed poll retains cached windows');
    assert.match(failed.text, /refresh failed/i);
    const unknown = await evaluate(`delete S.limits.providers.codex.error; delete S.limits.providers.codex.updatedAt; renderBudget(); $('#budget').textContent;`);
    assert.match(unknown, /Age unknown/);
  });
  await t.test('selected conductor percentages share their meters warning colors', async () => {
    const rows = await evaluate(`
      delete S.limits.providers.codex.error;
      S.limits.providers.codex.updatedAt = 3000;
      S.limits.providers.codex.windows[0].usedPercent = 75;
      renderBudget();
      [...$('#budget').querySelectorAll('.b')].map(row => ({
        text: row.querySelector('.v').textContent,
        weight: getComputedStyle(row.querySelector('.v')).fontWeight,
        labelWeight: getComputedStyle(row.querySelector('.k')).fontWeight,
        color: getComputedStyle(row.querySelector('.v')).color,
        meter: getComputedStyle(row.querySelector('.meter > i')).backgroundColor
      }));
    `);
    assert.deepEqual(rows.map((r) => r.text), ['75%', '94%']);
    for (const row of rows) {
      assert.equal(row.color, row.meter, `${row.text} has the same urgency as its meter`);
      assert.ok(Number(row.weight) > Number(row.labelWeight), 'the percentage is emphasized');
    }
  });
  await t.test('budget uses only actual provider-wide windows and the default conductor', async () => {
    const result = await evaluate(`
      (() => {
        S.config.conductor = { provider: 'codex' }; S.current = null;
        S.limits.providers = {
          claude: { windows: [{ id: 'five_hour', usedPercent: 7 }, { id: 'seven_day', usedPercent: 92 }] },
          codex: { windows: [{ id: 'codex:secondary', windowMinutes: 10080, usedPercent: 51 }] }
        };
        renderBudget(); const fallback = $('#budget').textContent;
        S.current = { provider: 'claude' }; renderBudget(); const claude = $('#budget').textContent;
        S.current = { provider: 'codex' }; renderBudget(); const codex = $('#budget').textContent;
        const thresholds = [90, 90.01].map(pct => { S.limits.providers.codex.windows[0].usedPercent = pct; renderBudget(); return $('#budget').textContent.includes('weekly'); });
        const exclusions = [
          { id: 'session', windowMinutes: 60, usedPercent: 99 },
          { id: 'five_hour', estimated: true, usedPercent: 99 },
          { id: 'five_hour', models: 'special', usedPercent: 99 },
          { id: 'model:weekly', scope: 'model', windowMinutes: 10080, usedPercent: 99 },
          { id: 'seven_day_overage_included', usedPercent: 99 }
        ].map(window => { S.limits.providers.codex.windows = [window]; renderBudget(); return $('#budget').textContent; });
        S.current = null; delete S.config.conductor.provider; renderBudget();
        return { fallback, claude, codex, thresholds, exclusions, absent: $('#budget').textContent };
      })();
    `);
    assert.match(result.fallback, /codex: 5-hour usage unavailable/);
    assert.doesNotMatch(result.fallback, /weekly|claude/);
    assert.match(result.claude, /claude.*5-hour.*7%.*weekly.*92%/);
    assert.doesNotMatch(result.claude, /codex/);
    assert.equal(result.codex, result.fallback);
    assert.deepEqual(result.thresholds, [false, true]);
    for (const text of result.exclusions) { assert.match(text, /5-hour usage unavailable/); assert.doesNotMatch(text, /99%|weekly/); }
    assert.match(result.absent, /claude.*5-hour/);
  });
  await t.test('provider groups preserve counts, filters and genuine toggles; details expands only this view', async () => {
    await evaluate(`
      S.providers = [
        { id: 'claude', auth: { type: 'subscription' } },
        { id: 'codex', auth: { type: 'subscription' }, canLogin: true },
        { id: 'keyed', auth: { type: 'api-key' } },
        { id: 'local', kind: 'ollama', auth: { type: 'subscription' } }
      ];
      S.models.providers = { claude: { status: 'ok' }, codex: { status: 'error', loggedIn: false }, keyed: { status: 'ok' }, local: { status: 'ok' } };
      loadProviderView(); renderProviders();
    `);
    const summaries = () => evaluate(`[...$('#providers').querySelectorAll('summary')].map(node => node.textContent)`);
    const original = await summaries();
    assert.deepEqual(original.map(text => text.split(' ').at(-1)), ['1/2', '1/1', '1/1']);
    await evaluate(`$('#providers-signed-in').click(); S.awaitingAuth.add('codex'); renderProviders();`);
    assert.equal(await evaluate(`$('#providers-subscriptions').querySelectorAll('.prov').length`), 2);
    assert.equal(await evaluate(`$('#providers-subscriptions').textContent.includes('Sign in')`), true);
    await evaluate(`S.awaitingAuth.clear(); renderProviders();`);
    assert.equal(await evaluate(`$('#providers-subscriptions').querySelectorAll('.prov').length`), 1);
    assert.deepEqual(await summaries(), original);
    await evaluate(`new Promise(resolve => { const group = $('#providers-subscriptions'); group.addEventListener('toggle', resolve, { once: true }); group.open = false; })`);
    const result = await evaluate(`
      renderProviders(); loadProviderView(); renderProviders();
      const remembered = { open: $('#providers-subscriptions').open, filter: $('#providers-signed-in').checked };
      const stored = localStorage.getItem('providerView');
      openSystem(false); revealProviders(); revealProviders();
      ({ remembered, stored, after: localStorage.getItem('providerView'), expanded: $('#system-toggle').getAttribute('aria-expanded'), group: $('#providers-subscriptions').open, filter: $('#providers-signed-in').checked });
    `);
    assert.deepEqual(result.remembered, { open: false, filter: true });
    assert.equal(result.after, result.stored);
    assert.equal(result.expanded, 'true'); assert.equal(result.group, true); assert.equal(result.filter, true);
    const empty = await evaluate(`
      openSystem(false); renderProviders();
      const restored = !$('#providers-subscriptions').open;
      S.providers = S.providers.filter(p => p.id !== 'local'); S.models.providers.keyed.status = 'error'; renderProviders();
      ({ restored, noLocal: !$('#providers-local'), empty: $('#providers-keys').textContent });
    `);
    assert.equal(empty.restored, true); assert.equal(empty.noLocal, true); assert.match(empty.empty, /0\/1.*No signed-in/);
    for (const value of ['{broken', '{"signedInOnly":"yes","groups":{"subscriptions":0}}', 'null']) {
      const defaults = await evaluate(`localStorage.setItem('providerView', ${JSON.stringify(value)}); loadProviderView(); S.providerView;`);
      assert.deepEqual(defaults, { signedInOnly: false, groups: { subscriptions: true, keys: true, local: true } });
    }
    const blocked = await evaluate(`
      (() => {
        const storage = localStorage;
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } } });
        try { loadProviderView(); renderProviders(); $('#providers-signed-in').click(); openSystem(false); revealProviders(); return $('#system-toggle').getAttribute('aria-expanded'); }
        finally { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage }); }
      })();
    `);
    assert.equal(blocked, 'true');
  });
  await t.test('improvement events refresh only the active list and cannot reopen or replace a modal', async () => {
    await evaluate(`
      globalThis.originalGet = api.get; globalThis.originalPost = api.post; globalThis.originalEvents = EventSource;
      globalThis.entries = [{ id: 'open', kind: 'idea', message: 'Open idea' }, { id: 'done', kind: 'idea', message: 'Resolved idea', resolved: true }];
      api.get = async () => structuredClone(entries);
      api.post = async path => { entries.find(entry => path.includes(entry.id)).resolved = true; };
      globalThis.handlers = {};
      globalThis.EventSource = class { addEventListener(type, fn) { handlers[type] = fn; } close() {} };
      connect(); openImprovements();
    `);
    assert.deepEqual(await evaluate(`[...$('#modal-body').querySelectorAll('.imp .m')].map(node => node.textContent)`), ['Open idea']);
    await evaluate(`
      const ideaInput = $('#modal-body input'); ideaInput.value = 'unfinished'; ideaInput.focus();
      entries[0].resolved = true; handlers.improvement({ data: JSON.stringify({ seq: 1, count: 0 }) });
    `);
    // Drain the existing coalescing timer using a DOM signal, not an assumed network delay.
    const live = await evaluate(`new Promise(resolve => {
      const done = () => resolve({ text: S.improvementView.list.textContent, value: $('#modal-body input').value, focused: document.activeElement === $('#modal-body input'), open: S.improvements.length });
      if (!S.improvementView.list.querySelector('.imp')) done();
      else { const observer = new MutationObserver(() => { observer.disconnect(); done(); }); observer.observe(S.improvementView.list, { childList: true }); }
    })`);
    assert.match(live.text, /Nothing logged/); assert.equal(live.value, 'unfinished'); assert.equal(live.focused, true); assert.equal(live.open, 0);
    await evaluate(`S.improvementView.showResolved = true; refreshImprovements();`);
    assert.equal(await evaluate(`$('#modal-body').querySelectorAll('.imp').length`), 2);
    await evaluate(`entries = []; refreshImprovements();`);
    assert.match(await evaluate(`S.improvementView.list.textContent`), /Nothing resolved yet/);
    for (const replacement of [false, true]) {
      const state = await evaluate(`(async () => {
        api.get = async () => []; await openImprovements(true);
        api.get = () => new Promise(resolve => { globalThis.finishList = resolve; });
        globalThis.refresh = refreshImprovements();
        ${replacement ? "openModal('Other modal', el('div', null, 'Keep me'));" : 'closeModal();'}
        finishList([]); await Promise.resolve();
        // Resolved-tab refresh also reads the all endpoint.
        finishList([]); await refresh;
        return { hidden: $('#modal').hidden, title: $('#modal-title').textContent, text: $('#modal-body').textContent };
      })()`);
      if (replacement) { assert.equal(state.title, 'Other modal'); assert.equal(state.text, 'Keep me'); }
      else assert.equal(state.hidden, true);
    }
    await evaluate(`api.get = originalGet; api.post = originalPost; globalThis.EventSource = originalEvents; closeModal();`);
  });
  await t.test('Claude fallback effort list excludes ultra and matches Claude tiers', async () => {
    const efforts = await evaluate(`
      (() => {
        S.providers = [{ id: 'claude', kind: 'claude' }];
        S.models.models = [];
        fillPicker('new-', { provider: 'claude', model: 'claude-3-7-sonnet' }, { all: false });
        return [...$('#new-effort').options].map(o => o.value);
      })();
    `);
    assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.ok(!efforts.includes('ultra'));
  });
  await t.test('U8: lastAction formats object input as JSON string', async () => {
    const text = await evaluate(`
      (() => {
        S.workerLog.set('t-obj', [{ name: 'search', input: { query: 'conductor', limit: 5 } }]);
        return lastAction({ id: 't-obj' });
      })()
    `);
    assert.match(text, /"query":"conductor"/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });
  await t.test('U11: clearCurrent resets UI and disables model chip', async () => {
    await evaluate(`
      S.current = { id: 'test-session', provider: 'codex', model: 'test' };
      renderChip();
      clearCurrent();
    `);
    const chipDisabled = await evaluate(`$('#model-chip').disabled`);
    const title = await evaluate(`$('#chat-title').textContent`);
    assert.equal(chipDisabled, true);
    assert.equal(title, 'No chat selected');
  });
  await t.test('U14: asBtn adds role=button and tabindex=0 to interactive items', async () => {
    await evaluate(`
      S.sessions = [{ id: 's1', title: 'Test Session', updatedAt: Date.now() }];
      renderSessions();
    `);
    const sessionAttrs = await evaluate(`
      (() => {
        const item = $('#sessions .item');
        return { role: item.getAttribute('role'), tabIndex: item.tabIndex };
      })()
    `);
    assert.equal(sessionAttrs.role, 'button');
    assert.equal(sessionAttrs.tabIndex, 0);
  });
  await t.test('I4: pendingCount shows approve pill in sidebar row', async () => {
    await evaluate(`
      S.sessions = [{ id: 's2', title: 'Pending Chat', pendingCount: 2, updatedAt: Date.now() }];
      renderSessions();
    `);
    const pillText = await evaluate(`$('#sessions .item .pill.warn')?.textContent`);
    assert.equal(pillText, 'approve 2');
  });
  await t.test('U12: session updated event resyncs checkboxes', async () => {
    await evaluate(`
      S.current = { id: 's-live', permissionMode: 'acceptEdits', overflowApi: false, parallelOverride: false };
      onSessionEvent({ kind: 'updated', sessionId: 's-live', session: { id: 's-live', permissionMode: 'bypassPermissions', overflowApi: true, parallelOverride: true } });
    `);
    const states = await evaluate(`({
      bypass: $('#bypass')?.checked,
      overflow: $('#overflow')?.checked,
      parallel: $('#parallel')?.checked
    })`);
    assert.deepEqual(states, { bypass: true, overflow: true, parallel: true });
  });
  await t.test('U13: re-opening modal keeps outer modalOpener', async () => {
    const retained = await evaluate(`
      const btn = $('#btn-settings');
      btn.focus();
      openModal('First', el('div'));
      const opener1 = modalOpener;
      openModal('Second', el('div'));
      const same = modalOpener === opener1;
      closeModal();
      same;
    `);
    assert.equal(retained, true);
  });
  await t.test('P18 + U15: thinking deltas keyed by parent', async () => {
    await evaluate(`
      clearTranscript();
      addDelta('thinking', '', 'sub-1');
      addDelta('thinking', '', 'sub-2');
    `);
    const count = await evaluate(`$('#transcript').querySelectorAll('.sysline').length`);
    assert.equal(count, 2);
    await evaluate(`
      addDelta('text', 'hello from sub-1', 'sub-1');
    `);
    const countAfter = await evaluate(`$('#transcript').querySelectorAll('.sysline').length`);
    assert.equal(countAfter, 1);
    await evaluate(`clearTranscript();`);
  });
  await t.test('P20: terminal task evicts workerLog', async () => {
    const evicted = await evaluate(`
      (() => {
        S.workerLog.set('task-t1', [{ text: 'done' }]);
        updateTask({ id: 'task-t1', status: 'done', title: 'Done task' });
        return !S.workerLog.has('task-t1');
      })()
    `);
    assert.equal(evicted, true);
  });
  await t.test('fleet keeps task counts without a local spend reading', async () => {
    const result = await evaluate(`
      (() => {
        S.current = null;
        S.tasks = [
          { id: 'run', status: 'running', provider: 'codex', title: 'Running' },
          { id: 'queue', status: 'queued', provider: 'codex', title: 'Queued' },
          { id: 'done', status: 'done', provider: 'codex', title: 'Done', finishedAt: new Date().toISOString(), pctWindow: 9 },
        ];
        renderTasks();
        return { counts: $('#fleet-counts').textContent, spend: $('#fleet-budget')?.textContent ?? null };
      })()
    `);
    assert.match(result.counts, /1 running.*1 queued.*1 done today/);
    assert.equal(result.spend, null);
  });
  // Wire the real UI actions without boot's API reads, timers or speech setup.
  await evaluate(`(() => { ${app.slice(app.indexOf("  $('#btn-new').onclick"), app.indexOf('  // speech to text'))} })()`);
  await t.test('chat empty states distinguish no chats from no matches and clear the filter', async () => {
    const state = await evaluate(`(() => {
      S.sessions = []; S.chatFilter = ''; renderSessions(); const empty = $('#sessions').textContent;
      S.sessions = [{ id: 'a', title: 'Alpha' }]; S.chatFilter = 'missing'; renderSessions(); const filtered = $('#sessions').textContent;
      $('#sessions button').click();
      return { empty, filtered, count: $('#sessions').querySelectorAll('.item').length, filter: $('#chat-filter').value };
    })()`);
    assert.match(state.empty, /No chats yet/); assert.match(state.filtered, /No chats match/);
    assert.equal(state.count, 1); assert.equal(state.filter, '');
  });
  await t.test('failed chat activation reports beside the list and preserves the selected chat', async () => {
    const state = await evaluate(`(async () => {
      const get = api.get; api.get = async () => { throw Error('chat unavailable'); };
      S.current = { id: 'previous' }; renderSessions();
      try { await $('#sessions .item').onclick(); return { id: S.current.id, message: $('#sessions-status').textContent }; }
      finally { api.get = get; }
    })()`);
    assert.deepEqual(state, { id: 'previous', message: 'chat unavailable' });
  });
  await t.test('errors stay in the active modal or action region and do not replace speech status', async () => {
    const state = await evaluate(`(async () => {
      $('#stt-hint').textContent = 'listening'; toggleModelPop(false);
      await act(async () => { throw Error('global failure'); }); const global = $('#ui-status').textContent;
      toggleModelPop(true); await act(async () => { throw Error('model failure'); }); const model = $('#model-status').textContent;
      openModal('Test', el('div')); await act(async () => { throw Error('modal failure'); });
      const modal = $('#modal-status').textContent; closeModal(); toggleModelPop(false);
      return { global, model, modal, speech: $('#stt-hint').textContent };
    })()`);
    assert.deepEqual(state, { global: 'global failure', model: 'model failure', modal: 'modal failure', speech: 'listening' });
  });
  await t.test('header provider is fixed and only its models can be selected', async () => {
    const state = await evaluate(`(() => {
      S.providers = [{ id: 'claude', kind: 'claude' }, { id: 'codex', kind: 'codex' }];
      S.models.models = [{ provider: 'claude', id: 'claude-known', label: 'Claude', kind: 'agent' }, { provider: 'codex', id: 'codex-known', label: 'Codex', kind: 'agent' }];
      S.current = { id: 'chat', provider: 'claude', model: 'claude-known' }; refreshHeaderPicker();
      return { disabled: $('#provider').disabled, providers: [...$('#provider').options].map(o => o.value), models: [...$('#model').options].map(o => o.value) };
    })()`);
    assert.equal(state.disabled, true); assert.deepEqual(state.providers, ['claude']);
    assert.ok(state.models.includes('claude-known')); assert.ok(!state.models.includes('codex-known'));
  });
  await t.test('CLI Update failure restores the button and reports in its provider row', async () => {
    const state = await evaluate(`(async () => {
      const post = api.post; api.post = async () => { throw Error('install failed'); };
      S.providers = [{ id: 'codex' }]; S.models.providers = { codex: { status: 'ok' } };
      S.cliUpdates = { providers: { codex: { available: true, current: '1', latest: '2' } } }; loadProviderView(); renderProviders();
      const button = [...$('#providers').querySelectorAll('button')].find(b => b.textContent === 'Update');
      try { const pending = button.onclick({ stopPropagation() {} }); const during = button.disabled; await pending;
        return { during, after: button.disabled, message: $('#providers .action-status').textContent };
      } finally { api.post = post; }
    })()`);
    assert.deepEqual(state, { during: true, after: false, message: 'install failed' });
  });
  await t.test('rejected Quit keeps the UI, restores Quit and reconnects SSE', async () => {
    const state = await evaluate(`(async () => {
      const post = api.post, events = EventSource, confirmBefore = confirm;
      let connected = 0, closed = 0; S.eventSource = { close() { closed++; } };
      globalThis.EventSource = class { constructor() { connected++; } addEventListener() {} close() {} };
      globalThis.confirm = () => true; api.post = async () => { throw Error('shutdown refused'); };
      try { const accepted = await quitServer($('#btn-quit')); return { accepted, connected, closed, stopped: S.stopped, disabled: $('#btn-quit').disabled, message: $('#ui-status').textContent, intact: !!$('#main') }; }
      finally { api.post = post; globalThis.EventSource = events; globalThis.confirm = confirmBefore; S.eventSource = null; }
    })()`);
    assert.deepEqual(state, { accepted: false, connected: 1, closed: 1, stopped: false, disabled: false, message: 'shutdown refused', intact: true });
  });
  await t.test('modal traps Tab in both directions, makes background inert and restores focus on Escape', async () => {
    await evaluate(`document.body.classList.add('nav-open'); $('#btn-settings').focus(); openModal('Focus', el('button', null, 'Last'));`);
    assert.equal(await evaluate(`['sidebar', 'main', 'fleet'].every(id => $('#' + id).inert)`), true);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
    assert.equal(await evaluate(`document.activeElement.textContent`), 'Last');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate(`document.activeElement.id`), 'modal-close');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.deepEqual(await evaluate(`({ hidden: $('#modal').hidden, inert: $('#main').inert, focus: document.activeElement.id })`), { hidden: true, inert: false, focus: 'btn-settings' });
  });
  await t.test('/claude preserves plain spec words, accepts known models and aliases, and failed tasks leave no user bubble', async () => {
    const state = await evaluate(`(async () => {
      const post = api.post, bodies = []; S.current = { id: 'chat', cwd: '/project' };
      S.models.models = [{ provider: 'claude', id: 'claude-known', aliasOf: ['fable'], kind: 'agent' }];
      api.post = async (path, body) => { bodies.push(body); return { id: 'task', provider: 'claude' }; };
      try {
        clearTranscript();
        for (const input of ['/claude fix this bug', '/claude claude-known fix bug', '/claude sonnet fix bug', '/claude fable fix bug', '/claude fix']) { $('#input').value = input; await send(); }
        const before = $('#transcript').querySelectorAll('.user').length;
        api.post = async () => { throw Error('creation failed'); }; $('#input').value = '/worker fix bug'; await send();
        return { bodies, before, after: $('#transcript').querySelectorAll('.user').length, restored: $('#input').value };
      } finally { api.post = post; }
    })()`);
    assert.deepEqual(state.bodies.map(b => [b.model ?? null, b.spec]), [[null, 'fix this bug'], ['claude-known', 'fix bug'], ['sonnet', 'fix bug'], ['fable', 'fix bug'], [null, 'fix']]);
    assert.equal(state.before, 5); assert.equal(state.after, 5); assert.equal(state.restored, '/worker fix bug');
  });
  await t.test('headline balance replaces unavailable usage and supports budget-only windows', async () => {
    const state = await evaluate(`(() => {
      S.current = { provider: 'deepseek' }; S.limits.providers.deepseek = { balance: { amount: 12, currency: 'USD', available: true }, windows: [{ id: 'deepseek:budget', label: 'budget USD 20', usedPercent: 40 }] };
      renderBudget(); const balance = $('#budget').textContent; delete S.limits.providers.deepseek.balance;
      renderBudget(); return { balance, budget: $('#budget').textContent };
    })()`);
    assert.match(state.balance, /balance 12 USD/); assert.doesNotMatch(state.balance, /unavailable/);
    assert.match(state.budget, /budget USD 20.*40%/); assert.doesNotMatch(state.budget, /unavailable/);
  });
  await t.test('improvement form submits through Enter and Add', async () => {
    await evaluate(`globalThis.savedPost = api.post; globalThis.savedGet = api.get; globalThis.ideas = [];
      api.get = async () => []; api.post = async (path, body) => { ideas.push(body.message); }; openImprovements();`);
    await evaluate(`$('#modal-body input').value = 'From Enter'; $('#modal-body input').focus();`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await evaluate(`$('#modal-body input').value = 'From Add'; $('#modal-body button[type=submit]').click();`);
    assert.deepEqual(await evaluate(`ideas`), ['From Enter', 'From Add']);
    await evaluate(`api.post = savedPost; api.get = savedGet; closeModal();`);
  });
  await t.test('New Chat toggle exposes state and Project Folder Enter starts a chat', async () => {
    const state = await evaluate(`(async () => {
      toggleNewChat(false); $('#btn-newchat-toggle').click();
      const expanded = $('#btn-newchat-toggle').getAttribute('aria-expanded'), cue = $('#btn-newchat-toggle').textContent;
      const post = api.post, get = api.get, paths = [];
      const session = { id: 'created', cwd: '/project', provider: 'claude', model: 'claude-known', status: 'idle' };
      api.post = async (path) => { paths.push(path); return session; }; api.get = async () => session;
      fillPicker('new-', session, { all: false }); $('#cwd').value = '/project';
      try {
        $('#cwd').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await newSessionPromise;
        return { expanded, cue, paths, collapsed: $('#btn-newchat-toggle').getAttribute('aria-expanded'), hidden: $('#newchat-form').hidden, id: S.current.id };
      } finally { api.post = post; api.get = get; }
    })()`);
    assert.equal(state.expanded, 'true'); assert.match(state.cue, /− New chat/);
    assert.equal(state.paths[0], '/api/sessions'); assert.equal(state.id, 'created');
    assert.equal(state.collapsed, 'false'); assert.equal(state.hidden, true);
  });
  await t.test('task snapshot Refresh fetches current status and actions', async () => {
    const state = await evaluate(`(async () => {
      const get = api.get; let reads = 0;
      api.get = async () => ({ id: 'task', provider: 'codex', status: ++reads === 1 ? 'running' : 'done', result: { items: [{ text: 'action ' + reads }] } });
      try { await openTask('task'); const before = $('#modal-body').textContent;
        await [...$('#modal-body').querySelectorAll('button')].find(b => b.textContent === 'Refresh').onclick();
        return { reads, before, after: $('#modal-body').textContent };
      } finally { api.get = get; closeModal(); }
    })()`);
    assert.equal(state.reads, 2); assert.match(state.before, /running.*action 1.*Snapshot/s); assert.match(state.after, /done.*action 2/s);
  });
  await t.test('This chat scope is disabled until a chat is selected', async () => {
    const state = await evaluate(`(() => {
      S.current = null; renderFleetHead(); const b = $('#fleet-scope button[data-scope=mine]');
      const disabled = b.disabled, title = b.title; S.current = { id: 'created' }; renderFleetHead(); b.click();
      return { disabled, title, enabled: !b.disabled, scope: fleetScope() };
    })()`);
    assert.equal(state.disabled, true); assert.match(state.title, /Select a chat/); assert.equal(state.enabled, true); assert.equal(state.scope, 'mine');
  });
  await t.test('empty folder picker says No subfolders', async () => {
    const text = await evaluate(`(async () => { const get = api.get; api.get = async () => ({ path: '/empty', dirs: [] });
      try { await browse('/empty'); return $('#modal-body').textContent; } finally { api.get = get; closeModal(); }
    })()`);
    assert.match(text, /No subfolders/);
  });
  await t.test('Settings tabs stay anchored and mobile controls use full rows with dark time inputs', async () => {
    await evaluate(`S.config = ${JSON.stringify(DEFAULTS)}; openSettings();`);
    // The picker is filled on the next event-loop turn, as in the live page.
    await evaluate(`new Promise(resolve => setTimeout(resolve, 0))`);
    const state = await evaluate(`(() => {
      const tops = ['general', 'subscriptions', 'keys'].map(id => { $('#settings-tab-' + id).click(); return $('.settings-tabs').getBoundingClientRect().top; });
      $('#settings-tab-general').click(); const time = document.getElementById('cfg-bench.offPeak.start');
      const picker = $('#wk-model').getBoundingClientRect(), grid = $('.settings-panel .grid').getBoundingClientRect();
      return { tops, background: getComputedStyle(time).backgroundColor, scheme: getComputedStyle(time).colorScheme, picker: picker.width, grid: grid.width, overflow: $('#modal-body').scrollWidth > $('#modal-body').clientWidth };
    })()`);
    assert.equal(new Set(state.tops).size, 1); assert.equal(state.background, 'rgb(22, 26, 33)'); assert.equal(state.scheme, 'dark');
    assert.equal(state.picker, state.grid); assert.equal(state.overflow, false);
    await evaluate(`closeModal(); toggleNewChat(true); renderUpdate({ git: true, behind: 2 });`);
    const layout = await evaluate(`({ model: $('#new-model').getBoundingClientRect().width, picker: $('.newchat-form .picker').getBoundingClientRect().width,
      titleTop: $('#chat-title').getBoundingClientRect().top, controlsTop: $('#chat-header .controls').getBoundingClientRect().top,
      label: getComputedStyle($('#btn-update .update-label')).display,
      arrows: [false, true].map(collapsed => { document.body.classList.toggle('fleet-collapsed', collapsed); return getComputedStyle($('#fleet-collapse'), '::before').content; }) })`);
    assert.equal(layout.model, layout.picker); assert.ok(layout.titleTop < layout.controlsTop); assert.equal(layout.label, 'none');
    assert.deepEqual(layout.arrows, ['"⌄"', '"⌃"']);
  });
  // Keep reviewable renders outside the product tree; show the phone's off-canvas sidebar too.
  await evaluate(`document.body.classList.remove('fleet-collapsed');`);
  for (const width of [1920, 1000, 375]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    await evaluate(`Promise.all($('#sidebar').getAnimations().map(animation => animation.finished));`);
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(HOME, `ui-${width}.png`), Buffer.from(data, 'base64'));
  }
  await evaluate(`document.body.classList.add('nav-open'); $('#sidebar').style.transition = 'none';`);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(HOME, 'ui-375-sidebar.png'), Buffer.from(data, 'base64'));
  t.diagnostic(`Screenshots: ${HOME}`);
  await call('Browser.close');
});
