// Recipe registry: category defaults and variants remain explicit; framework metadata lets workers
// and the conductor discover short methods without loading their full text into every prompt.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, statePath } from './paths.mjs';
import { loadConfig } from './config.mjs';

const DIR = join(REPO_ROOT, 'core', 'policy', 'recipes');
// Keep current worker routing stable: modeling → B, drafting → B, summarize has no default.
export const RECIPES = { drafting: 'image-to-3d-model.b.md', modeling: 'image-to-3d-model.b.md' };
export const RECIPE_VARIANTS = { modeling: { 'recipe-a': 'image-to-3d-model.md', 'recipe-b': 'image-to-3d-model.b.md', 'recipe-c': 'image-to-3d-model.c-build.md', 'recipe-c-trace': 'image-to-3d-model.c-trace.md' }, summarize: { 'video-general': 'video-briefing-general.md', 'video-finance': 'video-briefing-finance.md' } };

export function parseFront(raw) {
  const text = String(raw);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

export function listFrameworks() {
  const byId = new Map();
  for (const dir of [DIR, statePath('recipes')]) {
    let files = [];
    try { files = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'CONTEXT.md').sort(); } catch { continue; }
    for (const file of files) {
      let raw; try { raw = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
      const { meta, body } = parseFront(raw);
      if (!meta.id) continue;
      byId.set(meta.id, { id: meta.id, types: Array.isArray(meta.types) ? meta.types : [], audience: meta.audience || 'worker', purpose: meta.purpose || '', file, text: body });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const cache = new Map();
const defaults = () => ({ ...RECIPES, ...(loadConfig().recipes?.defaults || {}) });
export const variantsOf = (category) => ({ ...(RECIPE_VARIANTS[category] || {}), ...(loadConfig().recipes?.variants?.[category] || {}) });
export const checkVariant = (category, variant) => {
  if (!variant) return null;
  const known = variantsOf(category);
  if (Object.hasOwn(known, variant)) return null;
  const names = Object.keys(known);
  return `unknown variant "${variant}" for ${category || 'this category'}${names.length ? `; known: ${names.join(', ')}` : ''}`;
};
/** Recipe body for a worker. An explicit category variant wins, then its current default. */
export function recipeFor(category, variant = null) {
  const file = (variant && variantsOf(category)[variant]) || defaults()[category]; if (!file) return null;
  if (!cache.has(file)) {
    let value = null;
    for (const dir of [statePath('recipes'), DIR]) {
      const p = join(dir, file);
      if (existsSync(p)) { value = parseFront(readFileSync(p, 'utf8')).body; break; }
    }
    cache.set(file, value);
  }
  return cache.get(file);
}

export function frameworkFor(category) {
  const all = listFrameworks();
  const worker = all.find((f) => (f.audience === 'worker' || f.audience === 'both') && f.types.includes(category));
  const conductor = all.find((f) => (f.audience === 'conductor' || f.audience === 'both') && f.types.includes(category));
  const hit = worker || conductor;
  return hit || all.find((f) => f.id === 'general') || null;
}

export function conductorFrameworks() {
  return listFrameworks().filter((f) => f.audience === 'conductor' || f.audience === 'both');
}
export function frameworkIndex() {
  return conductorFrameworks().map((f) => `${f.id} (${f.types.join(', ')}): ${f.purpose}`).join('\n');
}
export function listRecipes() { return Object.entries(defaults()).map(([category, file]) => ({ category, file, present: !!recipeFor(category) })); }
