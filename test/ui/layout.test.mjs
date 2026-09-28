import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../ui/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
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
