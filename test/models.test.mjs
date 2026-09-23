import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJson } from '../core/paths.mjs';
import { PROVIDERS } from '../core/providers/index.mjs';
import { getModels, refreshModels } from '../core/models.mjs';

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
      const initial = { provider: 'ollama', id: 'cached' };
      Object.assign(getModels(), { providers: { ollama: { status: 'ok', count: 1 } }, models: [initial] });
      const old = Promise.withResolvers(), newer = Promise.withResolvers(), slow = Promise.withResolvers();
      const oldEntered = Promise.withResolvers(), newerEntered = Promise.withResolvers();
      let calls = 0;
      PROVIDERS.ollama = {
        id: 'ollama', detect: async () => ({ installed: true }),
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
        scoped = refreshModels({ only: ['ollama'] });
        assert.equal(refreshModels({ only: ['ollama'] }), scoped, 'same-scope refreshes coalesce');
        await newerEntered.promise;
        const finishNewer = () => newerFails ? newer.reject(new Error('newer failed')) : newer.resolve([{ provider: 'ollama', id: 'added' }]);
        if (firstToCommit === 'older') {
          slow.resolve([{ provider: 'slow', id: 'unrelated' }]);
          await full;
          assert.deepEqual(getModels().models.filter((m) => m.provider === 'ollama'), [], 'old data remains usable until a newer result commits');
          finishNewer(); await scoped;
        } else {
          finishNewer(); await scoped;
          const provider = { ...getModels().providers.ollama };
          slow.resolve([{ provider: 'slow', id: 'unrelated' }]);
          await full;
          assert.deepEqual(getModels().providers.ollama, provider, 'old collection cannot overwrite newer metadata');
        }
        assert.equal(calls, 2);
        const expected = newerFails ? (firstToCommit === 'older' ? [] : [initial]) : [{ provider: 'ollama', id: 'added' }];
        assert.deepEqual(getModels().models, [...expected, { provider: 'slow', id: 'unrelated' }]);
        assert.equal(getModels().providers.ollama.status, newerFails ? 'error' : 'ok');
        assert.equal(getModels().providers.ollama.error, newerFails ? 'newer failed' : null);
        assert.deepEqual(readJson(join(HOME, 'models.json')), getModels());
      } finally {
        old.resolve([]); newer.resolve([]); slow.resolve([]);
        await Promise.allSettled([full, scoped]);
      }
    });
  }
}
