import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { loadConfig, saveConfig, publicConfig, DEFAULTS } = await import('../core/config.mjs');

test('defaults load, patches deep-merge, secrets redact', () => {
  const c = loadConfig();
  assert.equal(c.port, DEFAULTS.port);
  assert.equal(c.worker.provider, 'codex');
  saveConfig({ providers: { deepseek: { apiKey: 'sk-test' } }, worker: { effort: 'high' } });
  const c2 = loadConfig();
  assert.equal(c2.providers.deepseek.apiKey, 'sk-test');
  assert.equal(c2.worker.effort, 'high');
  assert.equal(c2.worker.provider, 'codex', 'untouched keys keep defaults');
  assert.equal(c2.providers.ollama.baseUrl, DEFAULTS.providers.ollama.baseUrl);
  assert.equal(publicConfig(c2).providers.deepseek.apiKey, '••••');
  assert.equal(publicConfig(c2).providers.xai.apiKey, null);
});

test('masked MCP URLs round-trip without replacing the real URLs', () => {
  const mcpServers = {
    query: { url: 'https://example.test/mcp?token=query-secret', env: { TOKEN: 'env-secret' } },
    userinfo: { url: 'https://operator:password@example.test/mcp' },
    both: { url: 'https://operator:password@example.test/mcp?key=query-secret' },
    malformed: { url: 'not-a-url?key=query-secret' },
    disabled: null,
  };
  saveConfig({ mcpServers });
  const patch = { mcpServers: publicConfig().mcpServers };
  for (const name of ['query', 'userinfo', 'both', 'malformed']) {
    assert.notEqual(patch.mcpServers[name].url, mcpServers[name].url, name);
    assert.ok(!patch.mcpServers[name].url.includes('secret'), name);
  }
  patch.mcpServers.query.categories = ['search'];
  const originalPatch = structuredClone(patch);
  saveConfig(patch);
  assert.deepEqual(patch, originalPatch, 'save does not mutate its caller');
  const stored = loadConfig().mcpServers;
  for (const [name, server] of Object.entries(mcpServers)) {
    if (server) assert.equal(stored[name].url, server.url, name);
  }
  assert.equal(stored.query.env.TOKEN, 'env-secret');
  assert.deepEqual(stored.query.categories, ['search']);
  assert.equal(stored.disabled, null);
  for (const mask of ['••••', encodeURIComponent('••••').toLowerCase()]) {
    saveConfig({ mcpServers: { query: { url: `https://example.test/mcp?token=${mask}` } } });
    assert.equal(loadConfig().mcpServers.query.url, mcpServers.query.url);
  }
  const replacement = 'https://example.test/new?token=replacement-secret';
  saveConfig({ mcpServers: { query: { url: replacement } } });
  assert.equal(loadConfig().mcpServers.query.url, replacement, 'unmasked edits still save');
  saveConfig({ mcpServers: { query: { url: '' } } });
  assert.equal(loadConfig().mcpServers.query.url, '', 'an explicit empty URL still saves');
});

test('publicConfig masks secret MCP args and saveConfig restores them from the stored config', () => {
  const cases = [
    [['--token', 'abc'], ['--token', '••••']],
    [['--api-key', 'abc'], ['--api-key', '••••']],
    [['--apikey', 'abc'], ['--apikey', '••••']],
    [['--key', 'abc'], ['--key', '••••']],
    [['--secret', 'abc'], ['--secret', '••••']],
    [['--password', 'abc'], ['--password', '••••']],
    [['--auth', 'abc'], ['--auth', '••••']],
    [['--token=abc'], ['--token=••••']],
    [['--api-key=abc'], ['--api-key=••••']],
    [['-k', 'abc'], ['-k', 'abc']],
    [['--verbose', 'keep'], ['--verbose', 'keep']],
  ];
  for (const [args, masked] of cases) {
    saveConfig({ mcpServers: { t: { command: 'npx', args } } });
    assert.deepEqual(publicConfig().mcpServers.t.args, masked, String(args));
  }
  const mcpServers = {
    split: { command: 'npx', args: ['--token', 'split-secret', '--other', 'ok'] },
    eq: { command: 'npx', args: ['--api-key=eq-secret'] },
  };
  saveConfig({ mcpServers });
  const pub = publicConfig().mcpServers;
  assert.deepEqual(pub.split.args, ['--token', '••••', '--other', 'ok']);
  assert.deepEqual(pub.eq.args, ['--api-key=••••']);
  assert.ok(!JSON.stringify(pub).includes('secret'));
  saveConfig({ mcpServers: pub });
  assert.deepEqual(loadConfig().mcpServers.split.args, mcpServers.split.args);
  assert.deepEqual(loadConfig().mcpServers.eq.args, mcpServers.eq.args);
  saveConfig({ mcpServers: { split: { args: ['--token', 'replacement-secret', '--other', 'ok'] } } });
  assert.deepEqual(loadConfig().mcpServers.split.args, ['--token', 'replacement-secret', '--other', 'ok'], 'unmasked edits still save');
});

test('saveConfig restores masked MCP args by flag identity across insert and remove', () => {
  const stored = ['-y', 'server', '--token', 'SECRET1', '--api-key=SECRET2'];
  saveConfig({ mcpServers: { t: { command: 'npx', args: stored } } });
  saveConfig({ mcpServers: { t: { args: publicConfig().mcpServers.t.args } } });
  assert.deepEqual(loadConfig().mcpServers.t.args, stored, 'same-length round trip');

  saveConfig({ mcpServers: { t: { args: stored } } });
  saveConfig({ mcpServers: { t: { args: publicConfig().mcpServers.t.args.filter((a) => a !== '-y') } } });
  assert.deepEqual(loadConfig().mcpServers.t.args, ['server', '--token', 'SECRET1', '--api-key=SECRET2'], 'remove');

  saveConfig({ mcpServers: { t: { args: stored } } });
  const pub = publicConfig().mcpServers.t.args;
  saveConfig({ mcpServers: { t: { args: [pub[0], '--inserted', ...pub.slice(1)] } } });
  assert.deepEqual(loadConfig().mcpServers.t.args, ['-y', '--inserted', 'server', '--token', 'SECRET1', '--api-key=SECRET2'], 'insert');

  const twice = ['--token', 'A', '--other', 'x', '--token', 'B'];
  saveConfig({ mcpServers: { t: { args: twice } } });
  saveConfig({ mcpServers: { t: { args: publicConfig().mcpServers.t.args } } });
  assert.deepEqual(loadConfig().mcpServers.t.args, twice, 'nth occurrence of a repeated flag');

  saveConfig({ mcpServers: { t: { args: ['-y', 'server'] } } });
  saveConfig({ mcpServers: { t: { args: ['-y', 'server', '--token', '••••', '--api-key=••••'] } } });
  assert.deepEqual(loadConfig().mcpServers.t.args, ['-y', 'server'], 'no match drops the masked flag pair');
  assert.ok(!JSON.stringify(loadConfig().mcpServers.t.args).includes('••••'));
});

test('settings reject nonobjects, preserve subtrees and normalize positive numbers', () => {
  for (const patch of ['x', null, [], 42]) assert.throws(() => saveConfig(patch), { status: 400 });
  saveConfig({ conductor: null });
  assert.equal(loadConfig().conductor.provider, 'claude');
  for (const value of ['abc', '3', 0, -1, Infinity, NaN, null]) {
    saveConfig({ pollMinutes: value, conductor: { maxWorkerConcurrency: value }, worker: { timeoutMinutes: value, maxRounds: value } });
    const c = loadConfig();
    assert.equal(c.pollMinutes, 15);
    assert.equal(c.conductor.maxWorkerConcurrency, DEFAULTS.conductor.maxWorkerConcurrency);
    assert.equal(c.worker.timeoutMinutes, DEFAULTS.worker.timeoutMinutes);
    assert.equal(c.worker.maxRounds, DEFAULTS.worker.maxRounds);
  }
  saveConfig({ conductor: { model: null } });
  assert.equal(loadConfig().conductor.model, null);
});

test('registry entry null tombstones survive saving existing entries and reloading', () => {
  saveConfig({
    mcpServers: { existing: { command: 'fixture.exe' }, retained: { url: 'https://fixture.test/mcp' } },
    tools: { index: { existing: { kind: 'program', invoke: 'fixture' }, retained: { kind: 'program' } } },
    conductor: { effort: 'medium' },
  });
  const saved = saveConfig({ mcpServers: { existing: null }, tools: { index: { existing: null } }, conductor: null });
  for (const cfg of [saved, loadConfig()]) {
    assert.equal(cfg.mcpServers.existing, null);
    assert.equal(cfg.tools.index.existing, null);
    assert.equal(cfg.mcpServers.retained.url, 'https://fixture.test/mcp');
    assert.equal(cfg.tools.index.retained.kind, 'program');
    assert.equal(cfg.conductor.effort, 'medium');
  }
  saveConfig({ mcpServers: null, tools: { index: null } });
  assert.equal(loadConfig().mcpServers.existing, null);
  assert.equal(loadConfig().tools.index.retained.kind, 'program', 'registry subtree null still preserves entries');
  saveConfig({ mcpServers: { existing: { command: 'restored.exe' } }, tools: { index: { existing: { kind: 'mcp' } } } });
  assert.equal(loadConfig().mcpServers.existing.command, 'restored.exe');
  assert.equal(loadConfig().tools.index.existing.kind, 'mcp');
});

test('turn budgets default high and reject non-positive values', () => {
  assert.equal(DEFAULTS.conductor.maxTurns, 9999);
  assert.equal(DEFAULTS.worker.maxTurns, 500);
  assert.equal(DEFAULTS.conductor.maxWorkerConcurrency, 100);
  saveConfig({ conductor: { maxTurns: 0 }, worker: { maxTurns: -5 } });
  assert.equal(loadConfig().conductor.maxTurns, 9999);
  assert.equal(loadConfig().worker.maxTurns, 500);
  saveConfig({ conductor: { maxTurns: 20000 } });
  assert.equal(loadConfig().conductor.maxTurns, 20000);
  saveConfig({ conductor: { maxTurns: 9999 } });
});

test('timer and loop settings accept positive finite numbers and otherwise use DEFAULTS', () => {
  const keys = {
    conductor: ['turnTimeoutMinutes', 'updateQuietMinutes'], // updateCheckHours and detectMinutes: 0 means off, tested below
    worker: ['maxIterations', 'maxTurnsLocal', 'longRunMinutes'],
    scorecard: ['blockedMinutes'], server: ['lagWarnMs'],
  };
  for (const value of [0, -1, '3', null, Infinity, -Infinity, NaN, 1.5]) {
    const patch = Object.fromEntries(Object.entries(keys).map(([group, names]) => [group, Object.fromEntries(names.map((key) => [key, value]))]));
    patch.scorecard.windowTargets = { session: value, other: value };
    const saved = saveConfig(patch);
    for (const cfg of [saved, loadConfig()]) {
      for (const [group, names] of Object.entries(keys)) for (const key of names) {
        assert.equal(cfg[group][key], value === 1.5 ? value : DEFAULTS[group][key], `${group}.${key}`);
      }
      for (const key of ['session', 'other']) assert.equal(cfg.scorecard.windowTargets[key], value === 1.5 ? value : DEFAULTS.scorecard.windowTargets[key]);
    }
  }
  for (const value of ['bad', []]) {
    saveConfig({ scorecard: { windowTargets: value } });
    assert.deepEqual(loadConfig().scorecard.windowTargets, DEFAULTS.scorecard.windowTargets);
  }
  saveConfig(Object.fromEntries(Object.keys(keys).map((group) => [group, DEFAULTS[group]])));
});

test('the live prompt budgets are settings; the retired shared budget is absent', () => {
  assert.equal(DEFAULTS.worker.recipeChars, 6000);
  assert.equal(DEFAULTS.worker.toolLineChars, 1500);
  assert.ok(!('specAppendChars' in DEFAULTS.worker));
  saveConfig({ worker: { recipeChars: 7000, toolLineChars: 2000 } });
  assert.equal(loadConfig().worker.recipeChars, 7000);
  assert.equal(loadConfig().worker.toolLineChars, 2000);
  saveConfig({ worker: { recipeChars: DEFAULTS.worker.recipeChars, toolLineChars: DEFAULTS.worker.toolLineChars } });
});

test('worker.escalationRounds defaults to 2, allows 0 (disable), rejects negatives and non-integers', () => {
  assert.equal(DEFAULTS.worker.escalationRounds, 2);
  saveConfig({ worker: { escalationRounds: 0 } });
  assert.equal(loadConfig().worker.escalationRounds, 0, '0 is a valid choice: skip escalation, go straight to the conductor');
  for (const bad of [-1, 1.5, 'x', null, NaN]) {
    saveConfig({ worker: { escalationRounds: bad } });
    assert.equal(loadConfig().worker.escalationRounds, 2);
  }
});

test('providers panel auto-refresh settings default and normalize', () => {
  assert.deepEqual(loadConfig().ui, { autoRefresh: false, autoRefreshMinutes: 15, detectMinutes: 5 });
  saveConfig({ ui: { autoRefresh: 'yes', autoRefreshMinutes: 0 } });
  assert.equal(loadConfig().ui.autoRefresh, true);
  assert.equal(loadConfig().ui.autoRefreshMinutes, 15);
  saveConfig({ ui: { autoRefreshMinutes: 2 } });
  assert.equal(loadConfig().ui.autoRefreshMinutes, 2);
  saveConfig({ ui: { autoRefreshMinutes: 99999 } });
  assert.equal(loadConfig().ui.autoRefreshMinutes, 1440);
  saveConfig({ ui: { autoRefresh: false, autoRefreshMinutes: 15 } });
});

test('grok weekly usage-reset day and hour persist as numbers and clamp', () => {
  saveConfig({ scorecard: { usageResets: { grok: { resetDay: 3, resetHour: 9 } } } });
  const g = loadConfig().scorecard.usageResets.grok;
  assert.equal(g.resetDay, 3);
  assert.equal(g.resetHour, 9);
  assert.equal(typeof g.resetDay, 'number');
  assert.equal(typeof g.resetHour, 'number');
  assert.equal(g.periodHours, 168);
  saveConfig({ scorecard: { usageResets: { grok: { resetDay: 9, resetHour: 99 } } } });
  const g2 = loadConfig().scorecard.usageResets.grok;
  assert.equal(g2.resetDay, 6);
  assert.equal(g2.resetHour, 23);
  // No schedule is shipped (a plan's reset can move, so nothing is assumed): it exists only once the user sets it,
  // and "not set" is written as periodHours 0.
  assert.deepEqual(DEFAULTS.scorecard.usageResets, {});
  saveConfig({ scorecard: { usageResets: { grok: { periodHours: 0 } } } });
  assert.equal(loadConfig().scorecard.usageResets.grok.periodHours, 0);
});

test('state dir: CONDUCTOR_HOME wins; otherwise a .state/ folder beside the code, else ~/.conductor2', async () => {
  const { resolveStateDir, REPO_ROOT } = await import('../core/paths.mjs');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  assert.equal(resolveStateDir(), process.env.CONDUCTOR_HOME);
  const saved = process.env.CONDUCTOR_HOME; delete process.env.CONDUCTOR_HOME;
  try { assert.equal(resolveStateDir(), existsSync(join(REPO_ROOT, '.state')) ? join(REPO_ROOT, '.state') : join(homedir(), '.conductor2')); }
  finally { process.env.CONDUCTOR_HOME = saved; }
});

test('0 is a documented off switch for updateCheckHours and detectMinutes, so validation must keep it', async () => {
  const { saveConfig, loadConfig, DEFAULTS } = await import('../core/config.mjs');
  saveConfig({ conductor: { updateCheckHours: 0 }, ui: { detectMinutes: 0 } });
  assert.equal(loadConfig().conductor.updateCheckHours, 0, 'the periodic update check stays off');
  assert.equal(loadConfig().ui.detectMinutes, 0, 'the signed-out provider sweep stays off');
  saveConfig({ conductor: { updateCheckHours: -4 }, ui: { detectMinutes: 'soon' } });
  assert.equal(loadConfig().conductor.updateCheckHours, DEFAULTS.conductor.updateCheckHours, 'garbage still resets');
  assert.equal(loadConfig().ui.detectMinutes, DEFAULTS.ui.detectMinutes);
  saveConfig({ conductor: { updateCheckHours: DEFAULTS.conductor.updateCheckHours }, ui: { detectMinutes: DEFAULTS.ui.detectMinutes } });
});

test('malformed hand-edited roots and sections load safely and remain repairable by saveConfig', () => {
  const previous = process.env.CONDUCTOR_HOME;
  process.env.CONDUCTOR_HOME = tmpDir('config-shapes');
  try {
    const shapes = ['bad', 42, false, [], null];
    const roots = [...shapes, ...shapes.map((value) => Object.fromEntries(
      ['conductor', 'worker', 'scorecard', 'smoke', 'providers', 'ui', 'server', 'mcpServers'].map((key) => [key, value])))];
    for (const [i, raw] of roots.entries()) {
      writeFileSync(join(process.env.CONDUCTOR_HOME, 'config.json'), JSON.stringify(raw) + ' '.repeat(i));
      const cfg = loadConfig();
      for (const key of ['conductor', 'worker', 'scorecard', 'smoke', 'providers', 'ui', 'server', 'mcpServers']) assert.deepEqual(cfg[key], DEFAULTS[key], key);
      assert.doesNotThrow(() => saveConfig({ port: 0 }));
      assert.equal(loadConfig().port, 0);
    }
    const before = structuredClone(DEFAULTS);
    saveConfig({ worker: 'bad', scorecard: [] });
    const first = loadConfig();
    first.worker.timeoutByCategory.modeling = -1;
    assert.equal(loadConfig().worker.timeoutByCategory.modeling, before.worker.timeoutByCategory.modeling);
    assert.deepEqual(DEFAULTS, before, 'normalization and returned objects never mutate defaults');
  } finally { process.env.CONDUCTOR_HOME = previous; }
});

test('config validates ports, provider endpoints and malformed MCP entries', () => {
  for (const value of [-1, 65536, 1.5, '47474', null, NaN]) assert.equal(saveConfig({ port: value }).port, DEFAULTS.port);
  for (const port of [0, 65535]) assert.equal(saveConfig({ port }).port, port);
  const cfg = saveConfig({
    providers: { ollama: { baseUrl: 42 }, sd: false, deepseek: { baseUrl: [] } },
    mcpServers: { bad: 'x', list: [], disabled: false, malformed: { command: 42, url: {}, args: 'abc', env: 'token' },
      typed: { command: 'node', args: ['ok', null, {}], env: { KEEP: 'value', BAD: {} } } },
  });
  assert.equal(cfg.providers.ollama.baseUrl, DEFAULTS.providers.ollama.baseUrl);
  assert.deepEqual(cfg.providers.sd, DEFAULTS.providers.sd);
  assert.equal(cfg.providers.deepseek.baseUrl, undefined);
  assert.equal(cfg.mcpServers.bad, undefined);
  assert.equal(cfg.mcpServers.list, undefined);
  assert.equal(cfg.mcpServers.disabled, null);
  assert.deepEqual(cfg.mcpServers.malformed, { args: [], env: {} });
  assert.deepEqual(cfg.mcpServers.typed, { command: 'node', args: ['ok'], env: { KEEP: 'value' } });
});

test('config filters invalid usage and category values, bounds waste settings, and restores prompt budgets', () => {
  const badValues = [0, -1, null, '3', 'bad', NaN, Infinity];
  for (const value of badValues) {
    const cfg = saveConfig({ worker: { timeoutByCategory: { bad: value }, recipeChars: value, toolLineChars: value },
      scorecard: { usageBudgets: { bad: value }, usageGapHours: { bad: value } } });
    assert.equal(cfg.worker.timeoutByCategory.bad, undefined);
    for (const key of ['usageBudgets', 'usageGapHours']) assert.equal(cfg.scorecard[key].bad, undefined);
    for (const key of ['recipeChars', 'toolLineChars']) assert.equal(cfg.worker[key], DEFAULTS.worker[key]);
  }
  for (const value of ['bad', []]) {
    const cfg = saveConfig({ scorecard: { usageBudgets: value, usageGapHours: value, wasteHorizonHours: value, wasteStrength: value } });
    assert.deepEqual(cfg.scorecard.usageBudgets, {});
    assert.deepEqual(cfg.scorecard.usageGapHours, {});
    assert.equal(cfg.scorecard.wasteHorizonHours, DEFAULTS.scorecard.wasteHorizonHours);
    assert.equal(cfg.scorecard.wasteStrength, DEFAULTS.scorecard.wasteStrength);
  }
  let cfg = saveConfig({ scorecard: { wasteHorizonHours: -1, wasteStrength: -1 } });
  assert.equal(cfg.scorecard.wasteHorizonHours, 1);
  assert.equal(cfg.scorecard.wasteStrength, 0);
  cfg = saveConfig({ scorecard: { wasteStrength: 2, usageBudgets: { valid: 100 }, usageGapHours: { valid: 1.5 } } });
  assert.equal(cfg.scorecard.wasteStrength, 1);
  assert.equal(loadConfig().scorecard.usageBudgets.valid, 100);
  assert.equal(loadConfig().scorecard.usageGapHours.valid, 1.5);
});

test('timer config bounds prevent Node timer overflow and preserve documented zero switches', () => {
  const cfg = saveConfig({ pollMinutes: Number.MAX_VALUE, ui: { detectMinutes: Number.MAX_VALUE },
    conductor: { turnTimeoutMinutes: Number.MAX_VALUE, updateCheckHours: Number.MAX_VALUE },
    worker: { timeoutMinutes: Number.MAX_VALUE, timeoutByCategory: { huge: Number.MAX_VALUE, valid: 2.5 } },
    smoke: { timeoutMinutes: Number.MAX_VALUE } });
  for (const minutes of [cfg.pollMinutes, cfg.ui.detectMinutes, cfg.conductor.turnTimeoutMinutes, cfg.worker.timeoutMinutes, cfg.worker.timeoutByCategory.huge, cfg.smoke.timeoutMinutes]) assert.equal(minutes, 1440);
  assert.equal(cfg.conductor.updateCheckHours, 596);
  assert.ok(cfg.conductor.updateCheckHours * 3_600_000 <= 2 ** 31 - 1, 'Node timer maximum');
  assert.equal(cfg.worker.timeoutByCategory.valid, 2.5);
  saveConfig({ conductor: { updateCheckHours: 0 }, ui: { detectMinutes: 0 } });
  assert.equal(loadConfig().conductor.updateCheckHours, 0);
  assert.equal(loadConfig().ui.detectMinutes, 0);
});

test('broad secret flags and URL arguments redact and restore through JSON with reordered nonsecret args', () => {
  const flags = ['--header', '--access-token', '--api_key', '--github-token', '--client-secret', '--db-pass', '--AUTHORIZATION', '--bearer', '--credential-file', '-H', '-t'];
  const args = flags.flatMap((flag, i) => [flag, `split-secret-${i}`, `${flag}=equal-secret-${i}`]);
  args.push('--header', '--token', 'postgresql://user:db-secret@host/db?option=query-secret',
    '--endpoint=https://user:web-secret@host/mcp?key=url-secret', '--endpoint', 'https://host/second?token=other-secret', '--verbose');
  saveConfig({ mcpServers: { broad: { command: 'node', args } } });
  const masked = JSON.parse(JSON.stringify(publicConfig().mcpServers.broad.args));
  assert.doesNotMatch(JSON.stringify(masked), /(?:split|equal|db|query|web|url|other)-secret|Authorization: Bearer/);
  assert.ok(masked.includes('-H') && masked.includes('-t'));
  saveConfig({ mcpServers: { broad: { args: ['--inserted', ...masked.filter((a) => a !== '--verbose')] } } });
  assert.deepEqual(loadConfig().mcpServers.broad.args, ['--inserted', ...args.filter((a) => a !== '--verbose')]);
  const unknown = 'https://unknown.test/?token=' + encodeURIComponent('••••');
  saveConfig({ mcpServers: { broad: { args: [unknown, '--access-token', '••••', '-H=••••', 'keep'] } } });
  assert.deepEqual(loadConfig().mcpServers.broad.args, ['--access-token', 'split-secret-1', '-H=equal-secret-9', 'keep']);
  saveConfig({ mcpServers: { fresh: { command: 'node', args: [unknown, '--header', '••••', '-t=••••', 'keep'] } } });
  assert.deepEqual(loadConfig().mcpServers.fresh.args, ['keep'], 'unmatched masks never persist');
});
