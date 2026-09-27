import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function openScores()');
const openScores = source.slice(start, source.indexOf('\n// ---------- boot', start));

test('scores modal archived toggle requests and displays the archived score view', async () => {
  const nodes = [], gets = [];
  const el = (tag, cls, text) => {
    const node = { tag, className: cls || '', textContent: text ?? '', children: [], hidden: false, checked: false, type: '',
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this[name] = value; },
    };
    nodes.push(node); return node;
  };
  const context = {
    el,
    openModal() {},
    api: { get: async (path) => { gets.push(path); return path === '/api/bench' ? { text: 'due' } : { text: path.includes('archived=1') ? 'archived rows' : 'active rows' }; } },
  };
  await runInNewContext(`${openScores}\nopenScores()`, context);
  const toggle = nodes.find((n) => n['aria-label'] === 'Show archived scores');
  assert.ok(toggle);
  assert.deepEqual(gets, ['/api/scores', '/api/bench']);
  toggle.checked = true;
  await toggle.onchange();
  assert.deepEqual(gets, ['/api/scores', '/api/bench', '/api/scores?archived=1']);
  assert.equal(nodes.find((n) => n.tag === 'pre' && n.textContent === 'archived rows')?.textContent, 'archived rows');
});

test('B10: scores modal posts a manual eligibility decision and reloads the explanation', async () => {
  const nodes = [], posts = [];
  const el = (tag, cls, text) => {
    const node = { tag, className: cls || '', textContent: text ?? '', children: [], hidden: false, checked: false, type: '', value: '',
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this[name] = value; },
    };
    nodes.push(node); return node;
  };
  const context = {
    el, openModal() {}, act: (fn) => fn(),
    api: {
      get: async (path) => path === '/api/bench' ? { text: '' } : { text: 'scores with eligibility' },
      post: async (path, body) => { posts.push({ path, body }); return { eligibility: body }; },
    },
  };
  await runInNewContext(`${openScores}\nopenScores()`, context);
  nodes.find((n) => n['aria-label'] === 'Eligibility selection').value = 'codex:gpt-6-astra:high';
  nodes.find((n) => n['aria-label'] === 'Eligibility category').value = 'review';
  nodes.find((n) => n['aria-label'] === 'Eligibility reason').value = 'owner UI decision';
  await nodes.find((n) => n.tag === 'button' && n.textContent === 'Block').onclick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/scores/eligibility');
  assert.equal(JSON.stringify(posts[0].body), JSON.stringify({ sel: 'codex:gpt-6-astra:high', category: 'review', action: 'block', reason: 'owner UI decision' }));
});
