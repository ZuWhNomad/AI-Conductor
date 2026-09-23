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
        { provider: 'a', id: scope === 'failure' ? 'fresh-a' : 'scoped-a' },
      ].sort((a, b) => a.id.localeCompare(b.id)));
      if (scope === 'failure') {
        assert.equal(cache.providers.a.status, 'error');
        assert.equal(cache.providers.a.marker, 2, 'failure must preserve the current provider metadata');
        assert.equal(cache.providers.a.count, 1);
      }
      assert.deepEqual(readJson(join(HOME, 'models.json')), cache);
    } finally { slow.resolve([]); await scoped; }
  });
}
