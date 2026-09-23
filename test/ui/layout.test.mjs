import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../ui/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const executable = process.env.CONDUCTOR_TEST_BROWSER || [
  ...[process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
    .flatMap((dir) => [join(dir, 'Microsoft/Edge/Application/msedge.exe'), join(dir, 'Google/Chrome/Application/chrome.exe')]),
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

test('quit has a font-independent icon and an accessible name', () => {
  const quit = html.match(/<button\b[^>]*id="btn-quit"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(quit, /aria-label="Quit"/);
  assert.match(quit, /<svg\b[^>]*aria-hidden="true"[^>]*>[\s\S]*<path\b/);
  assert.doesNotMatch(quit, /⏻/);
});

test('rendered UI regressions', { skip: !executable && 'Set CONDUCTOR_TEST_BROWSER to a Chromium executable' }, async (t) => {
  const browser = spawn(executable, ['--headless', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${join(HOME, 'browser')}`, 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(browser, 'exit');
  let socket;
  t.after(async () => { socket?.close(); if (browser.exitCode === null) browser.kill(); await exited; });
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
