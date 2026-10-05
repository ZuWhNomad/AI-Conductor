import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const cap = await import('../core/capabilities.mjs');
const { saveConfig } = await import('../core/config.mjs');

test('the index merges the shared catalogue with config (add, tag, remove) and filters by platform', () => {
  const names = cap.loadIndex({ tools: { index: {} } }).map((e) => e.name);
  assert.ok(names.includes('ledger-ocr') && names.includes('tesseract') && names.includes('yt-dlp') && names.includes('youtube') && names.includes('x'));
  const cfg = { tools: { index: { tesseract: null, ledger: { kind: 'cli', categories: ['read'], purpose: 'private OCR pipeline', invoke: 'ledger-ocr <pdf>', detect: { command: 'ledger-ocr' } }, pdftotext: { categories: ['read', 'summarize', 'search'] }, elsewhere: { kind: 'app', categories: ['read'], purpose: 'x', platforms: ['mac'] } } } };
  const idx = cap.loadIndex(cfg);
  assert.ok(!idx.find((e) => e.name === 'tesseract'));                                   // removed
  assert.equal(idx.find((e) => e.name === 'ledger').source, 'config');                    // machine-specific entry
  assert.deepEqual(idx.find((e) => e.name === 'pdftotext').categories, ['read', 'summarize', 'search']); // tagged a shared one
  assert.equal(idx.find((e) => e.name === 'pdftotext').source, 'repo');
  assert.ok(!idx.find((e) => e.name === 'elsewhere'), 'a mac-only entry is not offered on this platform');
});

test('B10: Ledger-OCR is discovered, configurable, off when absent, and only shown for PDF/image work', () => {
  const defaultEntry = cap.loadIndex({ tools: { index: {} } }).find((e) => e.name === 'ledger-ocr');
  assert.equal(defaultEntry.disabled, !defaultEntry.command);
  if (defaultEntry.command) assert.match(defaultEntry.invoke, /--mode text --json$/);
  const configuredPath = process.execPath;
  const configured = cap.loadIndex({ tools: { index: {}, ledgerOcrCommand: configuredPath } }).find((e) => e.name === 'ledger-ocr');
  assert.equal(configured.command, configuredPath);
  const off = cap.loadIndex({ tools: { index: {}, ledgerOcrCommand: '' } }).find((e) => e.name === 'ledger-ocr');
  assert.equal(off.disabled, true);

  const status = cap.detectionStatus(), previous = status['ledger-ocr'];
  try {
    status['ledger-ocr'] = { available: true, version: 'LedgerOCR 0.2.0' };
    assert.doesNotMatch(cap.capabilityLines('read', { text: 'read notes.txt', cfg: { tools: { index: {} } } }), /ledger-ocr/i);
    const line = cap.capabilityLines('read', { text: 'extract statement.pdf', cfg: { tools: { index: {} } } });
    assert.match(line, /Ledger-OCR first/);
    assert.match(line, /--mode text --json/);
    assert.doesNotMatch(cap.capabilityLines('read', { text: 'extract scan.png', cfg: { tools: { index: {}, ledgerOcrCommand: '' } } }), /ledger-ocr/i);
  } finally {
    if (previous === undefined) delete status['ledger-ocr']; else status['ledger-ocr'] = previous;
  }
});

test('spec lines list only installed entries, respect the budget, and never a proposed entry', () => {
  const detected = { tesseract: { available: true, version: 'tesseract 5.3.0' }, pdftotext: { available: false }, ledger: { available: true } };
  writeFileSync(join(HOME, 'capabilities.json'), JSON.stringify(detected));
  Object.assign(cap.detectionStatus(), detected);
  const cfg = { tools: { index: { ledger: { kind: 'cli', categories: ['read'], purpose: 'private OCR pipeline', invoke: 'ledger-ocr <pdf>' }, guess: { kind: 'cli', categories: ['read'], purpose: 'found by research', invoke: 'guess', install: { url: 'https://x' }, added: 'researched 2026-09-20', approved: false } } } };
  const text = cap.capabilityLines('read', { cfg });
  assert.match(text, /^# Programs and services/);
  assert.match(text, /- tesseract \(tesseract 5\.3\.0\): OCR/);
  assert.match(text, /- ledger: private OCR pipeline\. Invoke: ledger-ocr <pdf>/);
  assert.doesNotMatch(text, /pdftotext/);                                                 // missing here
  assert.doesNotMatch(text, /guess/);                                                     // proposed, not approved
  assert.equal(cap.capabilityLines('debug', { cfg }), '');                                // nothing for that category
  const tight = cap.capabilityLines('read', { cfg, maxChars: 120 });
  assert.ok(tight.length < 300 && tight.split('\n').length <= 2, tight);                  // the budget cuts the list, never the first line
  assert.deepEqual(cap.missingFor('read', { tools: { index: {} } }).map((e) => e.name), ['pdftotext']);
  assert.match(cap.capabilityReport(cfg).find((r) => r.name === 'guess').status, /^proposed/);
  assert.match(cap.capabilityReport(cfg).find((r) => r.name === 'pdftotext').status, /^missing → https:/);
});

test('access rules restrict matching YouTube tasks to Antigravity and X tasks to Grok', () => {
  assert.deepEqual(cap.accessProviders('extract a transcript from https://www.youtube.com/watch?v=abc', { tools: { index: {} } }), { providers: ['antigravity'], names: ['youtube'] });
  assert.deepEqual(cap.accessProviders('summarize https://youtu.be/abc', { tools: { index: {} } }), { providers: ['antigravity'], names: ['youtube'] });
  assert.deepEqual(cap.accessProviders('read https://x.com/example/status/1', { tools: { index: {} } }), { providers: ['grok'], names: ['x'] });
  assert.deepEqual(cap.accessProviders('read https://twitter.com/example/status/1', { tools: { index: {} } }), { providers: ['grok'], names: ['x'] });
  const cfg = { tools: { index: { youtube: { providers: ['gemini'] }, xlinks: { kind: 'access', categories: ['search'], purpose: 'x.com links open only on Grok', match: ['x.com/', 'twitter.com/'], providers: ['grok'] } } } };
  assert.deepEqual(cap.accessProviders('read https://YouTu.be/abc please', cfg), { providers: ['gemini'], names: ['youtube'] });
  assert.deepEqual(cap.accessProviders('what does https://x.com/foo/status/1 say', cfg), { providers: ['grok'], names: ['x', 'xlinks'] });
  assert.equal(cap.accessProviders('refactor the scheduler', cfg), null);
});

test('unknown programs and MCP entries are absent until detected; access notes remain descriptive', () => {
  const cfg = { tools: { index: {
    fixture_cli: { kind: 'cli', categories: ['fixture'], purpose: 'local program', invoke: 'fixture-cli' },
    fixture_mcp: { kind: 'mcp', categories: ['fixture'], purpose: 'data service', invoke: 'fixture MCP' },
    fixture_access: { kind: 'access', categories: ['fixture'], purpose: 'Use the approved provider for private links', providers: ['fixture'], match: ['private.test/'] },
  } } };
  const status = cap.detectionStatus();
  try {
    assert.ok(cap.capabilitiesFor('fixture', cfg).every((e) => e.available === null));
    let text = cap.capabilityLines('fixture', { cfg });
    assert.doesNotMatch(text, /fixture_cli|fixture_mcp|installed here|Invoke:/);
    assert.match(text, /fixture_access: Use the approved provider for private links/);
    for (const name of ['fixture_cli', 'fixture_mcp']) status[name] = { available: true };
    text = cap.capabilityLines('fixture', { cfg });
    assert.match(text, /fixture_cli: local program\. Invoke: fixture-cli/);
    assert.match(text, /fixture_mcp: data service\. Invoke: fixture MCP/);
    status.fixture_access = { available: false };
    assert.match(cap.capabilityLines('fixture', { cfg }), /fixture_access: Use the approved provider/);
    assert.deepEqual(cap.accessProviders('read private.test/link', cfg), { providers: ['fixture'], names: ['fixture_access'] });
    cfg.tools.index.fixture_access.approved = false;
    assert.doesNotMatch(cap.capabilityLines('fixture', { cfg }), /fixture_access/);
  } finally {
    for (const name of Object.keys(cfg.tools.index)) delete status[name];
  }
});

test('L20: research proposals whose name is already indexed are dropped; timeout logs did not finish', () => {
  const src = readFileSync(new URL('../core/tools/delegation.mjs', import.meta.url), 'utf8');
  assert.match(src, /did not finish/);
  assert.match(src, /indexed\.has\(e\.name\)/);
  const [tesseract] = cap.parseResearched('```json\n' + JSON.stringify([{
    name: 'tesseract', kind: 'cli', purpose: 'OCR', invoke: 'tesseract',
    install: { url: 'https://github.com/tesseract-ocr/tesseract' },
  }]) + '\n```', 'read');
  const indexed = new Set(cap.loadIndex({ tools: { index: {} } }).map((e) => e.name));
  assert.ok(indexed.has('tesseract'));
  assert.equal(tesseract.name, 'tesseract');
  assert.equal([tesseract].filter((e) => !indexed.has(e.name)).length, 0);
});

test('research on a miss is opt-in, once per category per 30 days; reports parse into unapproved proposals', () => {
  assert.equal(cap.shouldResearch('docs', { tools: { researchOnMiss: false, index: {} } }), false);
  const cfg = { tools: { researchOnMiss: true, index: {} } };
  assert.equal(cap.shouldResearch('read', cfg), false);                                   // has entries already
  assert.equal(cap.shouldResearch('docs', cfg), true);
  assert.equal(cap.shouldResearch('docs', cfg), false);                                   // recorded: not again
  const report = 'Reasoning here.\n```json\n[{"name":"mkdocs","kind":"cli","purpose":"builds docs sites","invoke":"mkdocs build","detect":{"command":"mkdocs"},"install":{"url":"https://www.mkdocs.org/","command":"pip install mkdocs"}},{"name":"bad one","install":{"url":"http://mirror"}}]\n```';
  const got = cap.parseResearched(report, 'docs');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'mkdocs'); assert.equal(got[0].approved, false); assert.match(got[0].added, /^researched 20/); assert.deepEqual(got[0].categories, ['docs']);
  assert.deepEqual(cap.parseResearched('no block', 'docs'), []);
  saveConfig({ tools: { index: { mkdocs: got[0] } } });
  assert.equal(cap.capabilitiesFor('docs').find((e) => e.name === 'mkdocs').approved, false);
});

test('detection skips parsed unapproved proposals before probing and permits approved and curated entries', async (t) => {
  const [proposal] = cap.parseResearched('```json\n' + JSON.stringify([{
    name: 'fixture', kind: 'cli', purpose: 'fixture detector',
    detect: { command: 'fixture-detector', args: ['--run', 'arbitrary code'] },
    install: { url: 'https://example.com/fixture' },
  }]) + '\n```', 'other');
  assert.equal(proposal.approved, false);
  const curated = cap.loadIndex({ tools: { index: {} } });
  const cfg = { tools: { index: { ...Object.fromEntries(curated.map((e) => [e.name, null])), fixture: proposal } } };
  const probe = t.mock.method(fs, 'existsSync', (file) => /(?:^|[\\/])(fixture-detector|tesseract)(?:\.exe)?$/.test(file));
  const launch = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', 'fixture version 1\n'); child.emit('close', 0); });
    return child;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await cap.detectCapabilities(cfg), {});
    assert.equal(probe.mock.callCount(), 0, 'unapproved detectors must not even look up the command');
    assert.equal(launch.mock.callCount(), 0, 'unapproved detectors must not launch');

    proposal.approved = true;
    const approved = await cap.detectCapabilities(cfg);
    assert.equal(approved.fixture.available, true);
    assert.equal(approved.fixture.version, 'fixture version 1');
    assert.equal(launch.mock.callCount(), 1);
    assert.deepEqual(launch.mock.calls[0].arguments[1], proposal.detect.args);
    assert.equal(launch.mock.calls[0].arguments[2].windowsHide, true);
    assert.deepEqual(JSON.parse(readFileSync(join(HOME, 'capabilities.json'), 'utf8')), approved);

    proposal.approved = false;
    delete cfg.tools.index.tesseract; // Restore the curated entry with approval unset.
    cfg.tools.index.nope = { kind: 'cli', detect: { command: 'definitely-not-installed-xyz' } };
    assert.equal(cap.loadIndex(cfg).find((e) => e.name === 'tesseract').approved, undefined);
    const st = await cap.detectCapabilities(cfg);
    assert.equal(st.fixture, undefined, 'revoking approval also clears previous detection status');
    assert.equal(st.tesseract.available, true);
    assert.equal(st.nope.available, false);
    assert.equal(cap.detectionStatus().nope.available, false);
    assert.equal(launch.mock.callCount(), 2);
    assert.match(launch.mock.calls[1].arguments[0], /tesseract(?:\.exe)?$/);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
