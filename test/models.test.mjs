import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJson } from '../core/paths.ts';
import { PROVIDERS } from '../core/providers/index.mjs';
import { getModels, findModel, markUnavailable, refreshModels, familyOf, normFamilies, selsInFamilies } from '../core/models.mjs';

for (const scope of ['disjoint', 'full', 'failure']) {
  test(`scoped model refresh merges into the live cache: ${scope}`, async (ctx) => {
    const original = { ...PROVIDERS };
    for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
    ctx.after(() => {
      for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
      Object.assign(PROVIDERS, original);
    });
    Object.assign(getModels(), { providers: {}, models: [] });
    const entered = Promise.withResolvers(), slow = Promise.withResolvers();
    let calls = 0;
    PROVIDERS.a = {
      id: 'a', detect: async () => ({ installed: true, marker: ++calls }),
      listModels: () => {
        if (calls === 1) { entered.resolve(); return slow.promise; }
        return [{ provider: 'a', id: 'fresh-a' }];
      },
    };
    PROVIDERS.b = { id: 'b', detect: async () => ({ installed: true, marker: 'fresh-b' }), listModels: async () => [{ provider: 'b', id: 'fresh-b' }] };
    const scoped = refreshModels({ only: ['a'] });
    await entered.promise;
    try {
      await refreshModels(scope === 'disjoint' ? { only: ['b'] } : {});
      if (scope === 'failure') slow.reject(new Error('scoped failure'));
      else slow.resolve([{ provider: 'a', id: 'scoped-a' }]);
      await scoped;
      const cache = getModels();
      assert.equal(cache.providers.b.marker, 'fresh-b');
      assert.deepEqual(cache.models, [
        { provider: 'b', id: 'fresh-b' },
        { provider: 'a', id: scope === 'disjoint' ? 'scoped-a' : 'fresh-a' },
      ].sort((a, b) => a.id.localeCompare(b.id)));
      if (scope !== 'disjoint') {
        assert.equal(cache.providers.a.status, 'ok');
        assert.equal(cache.providers.a.error, null);
        assert.equal(cache.providers.a.marker, 2, 'superseded success/error must preserve newer provider metadata');
        assert.equal(cache.providers.a.count, 1);
      }
      assert.deepEqual(readJson(join(HOME, 'models.json')), cache);
    } finally { slow.resolve([]); await scoped; }
  });
}

for (const newerFails of [false, true]) {
  for (const firstToCommit of ['older', 'newer']) {
    test(`collected full model result is superseded: ${firstToCommit} commits first, newer fails=${newerFails}`, async (ctx) => {
      const original = { ...PROVIDERS };
      for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
      ctx.after(() => {
        for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
        Object.assign(PROVIDERS, original);
      });
      const initial = { provider: 'deepseek', id: 'cached' };
      Object.assign(getModels(), { providers: { deepseek: { status: 'ok', count: 1 } }, models: [initial] });
      const old = Promise.withResolvers(), newer = Promise.withResolvers(), slow = Promise.withResolvers();
      const oldEntered = Promise.withResolvers(), newerEntered = Promise.withResolvers();
      let calls = 0;
      PROVIDERS.deepseek = {
        id: 'deepseek', detect: async () => ({ installed: true }),
        listModels: () => {
          if (++calls === 1) { oldEntered.resolve(); return old.promise; }
          newerEntered.resolve(); return newer.promise;
        },
      };
      PROVIDERS.slow = { id: 'slow', detect: async () => ({}), listModels: () => slow.promise };
      const full = refreshModels();
      let scoped;
      try {
        assert.equal(refreshModels(), full, 'full refreshes coalesce');
        await oldEntered.promise;
        old.resolve([]);
        await old.promise; // the registry has collected the empty list, but still awaits slow
        scoped = refreshModels({ only: ['deepseek'] });
        assert.equal(refreshModels({ only: ['deepseek'] }), scoped, 'same-scope refreshes coalesce');
        await newerEntered.promise;
        const finishNewer = () => newerFails ? newer.reject(new Error('newer failed')) : newer.resolve([{ provider: 'deepseek', id: 'added' }]);
        if (firstToCommit === 'older') {
          slow.resolve([{ provider: 'slow', id: 'unrelated' }]);
          await full;
          assert.deepEqual(getModels().models.filter((m) => m.provider === 'deepseek'), [], 'old data remains usable until a newer result commits');
          finishNewer(); await scoped;
        } else {
          finishNewer(); await scoped;
          const provider = { ...getModels().providers.deepseek };
          slow.resolve([{ provider: 'slow', id: 'unrelated' }]);
          await full;
          assert.deepEqual(getModels().providers.deepseek, provider, 'old collection cannot overwrite newer metadata');
        }
        assert.equal(calls, 2);
        const expected = newerFails ? (firstToCommit === 'older' ? [] : [initial]) : [{ provider: 'deepseek', id: 'added' }];
        assert.deepEqual(getModels().models, [...expected, { provider: 'slow', id: 'unrelated' }]);
        assert.equal(getModels().providers.deepseek.status, newerFails ? 'error' : 'ok');
        assert.equal(getModels().providers.deepseek.error, newerFails ? 'newer failed' : null);
        assert.deepEqual(readJson(join(HOME, 'models.json')), getModels());
      } finally {
        old.resolve([]); newer.resolve([]); slow.resolve([]);
        await Promise.allSettled([full, scoped]);
      }
    });
  }
}

test('familyOf maps a model to its family whichever provider serves it', () => {
  for (const [provider, model, family] of [
    ['claude', 'claude-opus-5-5[1m]', 'claude'], ['claude', 'default', 'claude'], ['claude', null, 'claude'],
    ['codex', 'gpt-5.5', 'gpt'], ['codex', 'gpt-6-astra', 'gpt'], ['codex', 'luna', 'gpt'],  ['codex', 'default', 'gpt'],
    ['antigravity', 'claude-sonnet-4-6', 'claude'], ['antigravity', 'claude-opus-4-6-thinking', 'claude'], ['antigravity', 'gpt-oss-120b', 'gpt'], ['antigravity', 'gemini-3.1-pro', 'gemini'],
    ['grok', 'grok-4.7-build-fast', 'grok'], ['grok', 'default', 'grok'], ['deepseek', 'deepseek-v4-pro', 'deepseek'],
  ]) assert.equal(familyOf(provider, model), family, `${provider}:${model}`);
  assert.deepEqual(normFamilies([' Claude', 'claude', 'GPT', 7, '']), ['claude', 'gpt']);
  const reg = { models: [{ provider: 'claude', id: 'claude-opus-5' }, { provider: 'antigravity', id: 'claude-sonnet-4-6' }, { provider: 'antigravity', id: 'gemini-3.1-pro' }, { provider: 'deepseek', id: 'deepseek-chat' }] };
  assert.deepEqual(selsInFamilies(['claude', 'deepseek'], reg), ['claude:claude-opus-5', 'antigravity:claude-sonnet-4-6', 'deepseek:deepseek-chat']);
  assert.deepEqual(selsInFamilies([], reg), []);
});

test('marked models disappear from lookup and return on the next successful provider refresh', async (ctx) => {
  const originalProviders = { ...PROVIDERS };
  const originalCache = { ...getModels(), models: [...getModels().models], providers: { ...getModels().providers } };
  ctx.after(() => {
    for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
    Object.assign(PROVIDERS, originalProviders);
    Object.assign(getModels(), originalCache);
  });
  for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
  const model = { provider: 'claude', id: 'claude-refresh-test', kind: 'agent' };
  Object.assign(getModels(), { providers: {}, models: [model] });
  assert.equal(markUnavailable('claude', model.id, 'SDK too old'), true);
  assert.equal(markUnavailable('claude', model.id, 'SDK too old'), false);
  assert.deepEqual(getModels().models, []);
  assert.equal(findModel('claude', model.id), null);
  PROVIDERS.claude = { id: 'claude', detect: async () => ({ installed: true }), listModels: async () => [model] };
  await refreshModels({ only: ['claude'] });
  assert.deepEqual(getModels().models, [model]);
  assert.equal(findModel('claude', model.id), model);
});
