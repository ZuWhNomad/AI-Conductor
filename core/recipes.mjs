// Recipe registry (hand-curated): a coarse task category → an instruction set the worker gets with its spec.
// Recipes are distilled from runs that passed a benchmark where others failed; they say *how* to approach the
// kind of work, not what the task is.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { loadConfig } from './config.mjs';

const DIR = join(REPO_ROOT, 'core', 'policy', 'recipes');
// Default per category. modeling: recipe B (A/B on 2026-09-12: visually substantially better than A on Sol and Terra).
// drafting gets the SAME file: its B0.1 is the drafting stage and says to stop there, so a drafting task is never
// told to deliver an STL. Splitting the file would duplicate the clearance arithmetic in two places.
export const RECIPES = { drafting: 'image-to-3d-model.b.md', modeling: 'image-to-3d-model.b.md' };
// summarize has NO default on purpose: a video-briefing recipe appended to every summarize task (diffs, docs) is
// noise, and a self-scoping first line is a soft instruction a weak worker ignores. Video tasks opt in by variant;
// the `youtube` entry in policy/capabilities.json tells the conductor which variant to set.
// Variants: a task whose `variant` names one of these gets it instead of the default (the scorecard keeps the variant).
// recipe-c is the two-stage pipeline: a cheap model traces (recipe-c-trace), a strong model builds (recipe-c).
export const RECIPE_VARIANTS = { modeling: { 'recipe-a': 'image-to-3d-model.md', 'recipe-b': 'image-to-3d-model.b.md', 'recipe-c': 'image-to-3d-model.c-build.md', 'recipe-c-trace': 'image-to-3d-model.c-trace.md' }, summarize: { 'video-general': 'video-briefing-general.md', 'video-finance': 'video-briefing-finance.md' } };

const cache = new Map();
// Config can add/override routing without a code edit: recipes.defaults[category] and recipes.variants[category][variant].
const defaults = () => ({ ...RECIPES, ...(loadConfig().recipes?.defaults || {}) });
const variantsOf = (category) => ({ ...(RECIPE_VARIANTS[category] || {}), ...(loadConfig().recipes?.variants?.[category] || {}) });
/** Recipe text for a category (null when none is registered). */
export function recipeFor(category, variant = null) {
  const file = (variant && variantsOf(category)[variant]) || defaults()[category]; if (!file) return null;
  if (!cache.has(file)) { const p = join(DIR, file); cache.set(file, existsSync(p) ? readFileSync(p, 'utf8').trim() : null); }
  return cache.get(file);
}

export const listRecipes = () => Object.entries(defaults()).map(([category, file]) => ({ category, file, present: !!recipeFor(category) }));
