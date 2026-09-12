// Recipe registry (hand-curated): a coarse task category → an instruction set the worker gets with its spec.
// Recipes are distilled from runs that passed a benchmark where others failed; they say *how* to approach the
// kind of work, not what the task is. See docs/ROADMAP-capabilities.md (phase 2).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const DIR = join(REPO_ROOT, 'core', 'recipes');
export const RECIPES = { modeling: 'image-to-3d-model.md' };
// A/B variants: a task whose `variant` names one of these gets it instead of the default (the scorecard keeps the variant).
export const RECIPE_VARIANTS = { modeling: { 'recipe-a': 'image-to-3d-model.md', 'recipe-b': 'image-to-3d-model.b.md' } };

const cache = new Map();
/** Recipe text for a category (null when none is registered). */
export function recipeFor(category, variant = null) {
  const file = (variant && RECIPE_VARIANTS[category]?.[variant]) || RECIPES[category]; if (!file) return null;
  if (!cache.has(file)) { const p = join(DIR, file); cache.set(file, existsSync(p) ? readFileSync(p, 'utf8').trim() : null); }
  return cache.get(file);
}

export const listRecipes = () => Object.entries(RECIPES).map(([category, file]) => ({ category, file, present: !!recipeFor(category) }));
