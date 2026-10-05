// Browser modules are outside tsc (tsconfig include omits ui/). Guard the import graph here.
import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const UI = fileURLToPath(new URL('../../ui/', import.meta.url));
const REGEX_BEFORE = new Set('(=:,!&|?{};+-*%~^<>[');
const GLOBALS = new Set('window document localStorage sessionStorage navigator location history console fetch Event EventSource CustomEvent HTMLElement Element MutationObserver ResizeObserver requestAnimationFrame cancelAnimationFrame setTimeout setInterval clearTimeout clearInterval queueMicrotask structuredClone performance crypto atob btoa TextEncoder TextDecoder URL URLSearchParams FormData Blob File FileReader AbortController WebSocket SpeechRecognition webkitSpeechRecognition alert confirm prompt getComputedStyle requestIdleCallback Map Set WeakMap WeakSet Promise Symbol Proxy Reflect Object Array String Number Boolean Date Math JSON RegExp Error TypeError RangeError SyntaxError ReferenceError Intl parseInt parseFloat isNaN isFinite NaN Infinity undefined globalThis self top parent frames screen Option Image Audio Worker'.split(' '));
const files = readdirSync(UI, { recursive: true }).filter((f) => String(f).endsWith('.js')).map((f) => join(UI, f));

const prevSig = (out) => { for (let i = out.length - 1; i >= 0; i--) if (out[i] !== ' ' && out[i] !== '\n') return out[i]; return ''; };
function takeRegex(src, i) {
  let j = i + 1, cls = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return null;
    if (c === '[' && !cls) cls = true;
    else if (c === ']' && cls) cls = false;
    else if (c === '/' && !cls) { j++; while (/[a-z]/i.test(src[j] || '')) j++; return j; }
    j++;
  }
  return null;
}
function strip(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { out += ' '; while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { out += ' '; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '/' && (REGEX_BEFORE.has(prevSig(out)) || /(?:^|[^A-Za-z_$])(return|throw|typeof|case|void|in|of|delete|await|yield|else)\s*$/.test(out))) {
      const j = takeRegex(src, i); if (j) { i = j; continue; }
    }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === '\n' && q !== '`') break; i++; }
      if (src[i] === q) i++;
      out += ' ';
      continue;
    }
    out += c; i++;
  }
  return out;
}
function depth0(src) {
  let d = 0, out = '';
  for (const c of src) {
    if ('{(['.includes(c)) { if (d++ === 0) out += ' '; }
    else if ('})]'.includes(c)) { if (--d <= 0) { d = 0; out += '\n'; } }
    else if (d === 0) out += c;
  }
  return out;
}
function words(text) { return [...String(text ?? '').matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]); }
function topLevel(src) {
  const flat = depth0(src), names = new Set();
  for (const m of flat.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|\bclass\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1] || m[2] || m[3]);
  for (const m of src.matchAll(/\bexport\s*\{([^}]+)\}/g)) for (const part of m[1].split(/\s+as\s+|,/)) { const t = part.trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t); }
  return names;
}
function localsOf(src) {
  const names = topLevel(src);
  for (const m of src.matchAll(/\b(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)|\b(?:const|let|var)\s+([^;=]+)|\bcatch\s*\(\s*([^)]*)\)|\bfor\s*\(\s*(?:const|let|var)\s+([^;=)]+?)\s+(?:of|in)\b|\(([^)]*)\)\s*=>/g)) for (const g of m.slice(1)) for (const n of words(g)) names.add(n);
  for (const m of src.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  return names;
}
function importedNames(clause) {
  const names = new Set();
  if (!clause) return names;
  const brace = clause.match(/\{([^}]*)\}/);
  if (brace) for (const part of brace[1].split(',')) { const t = part.trim().split(/\s+as\s+/).pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t); }
  for (const raw of clause.replace(/\{[^}]*\}/, '').split(',')) { const t = raw.replace(/\* as\s+/, '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t); }
  return names;
}

test('ui modules resolve relative imports, stay acyclic, and import cross-module names', () => {
  const graph = new Map(), parsed = [];
  for (const file of files) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, relative(UI, file) + '\n' + checked.stderr);
    const src = readFileSync(file, 'utf8'), edges = [], imported = new Set();
    for (const line of src.split('\n')) {
      const m = line.match(/^\s*import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"]/);
      if (!m || !m[2].startsWith('.')) continue;
      assert.ok(m[2].endsWith('.js') && existsSync(resolve(dirname(file), m[2])), `${relative(UI, file)} imports ${m[2]}`);
      edges.push(resolve(dirname(file), m[2]));
      for (const n of importedNames(m[1])) imported.add(n);
    }
    const code = strip(src);
    graph.set(resolve(file), edges);
    const refs = new Set();
    for (const m of code.matchAll(/(?<![\w$.])(\$|[A-Za-z_][\w$]*)(?![\w$])/g)) {
      if (/^\s*:/.test(code.slice(m.index + m[1].length))) continue;
      refs.add(m[1]);
    }
    parsed.push({ file: resolve(file), imported, top: topLevel(code), locals: localsOf(code), refs });
  }
  const owners = new Map();
  for (const row of parsed) for (const name of row.top) owners.set(name, (owners.get(name) || new Set()).add(row.file));
  const color = new Map(), stack = [];
  const cycle = (n) => {
    color.set(n, 1); stack.push(n);
    for (const m of graph.get(n) || []) {
      if (color.get(m) === 1) return stack.slice(stack.indexOf(m)).concat(m);
      if (!color.has(m)) { const c = cycle(m); if (c) return c; }
    }
    stack.pop(); color.set(n, 2); return null;
  };
  for (const n of graph.keys()) if (!color.has(n)) { const c = cycle(n); assert.equal(c, null, 'import cycle ' + (c || []).map((f) => relative(UI, f)).join(' -> ')); }
  const missing = [];
  for (const row of parsed) for (const name of row.refs) {
    if (![...(owners.get(name) || [])].some((f) => f !== row.file)) continue;
    if (row.locals.has(name) || row.imported.has(name) || GLOBALS.has(name)) continue;
    missing.push(`${relative(UI, row.file)} uses ${name} without importing it`);
  }
  assert.deepEqual(missing, []);
});
