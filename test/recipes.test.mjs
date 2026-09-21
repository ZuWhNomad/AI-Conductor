import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- drafting: the 2-D half of image->3D work -----------------------------------------------------------------
// Drafting exists because a modelling round costs half an hour and a drawing round costs seconds: the artwork is
// settled on paper first. The trap it fixes is a recipe contradicting the spec it is appended to — a drafting task
// that inherits "deliver an STL" makes the worker choose between two instructions, and a worker that guesses is
// worse than one that stops.
test('drafting is a category of its own and gets the image->3D recipe, scoped to its B0.1 stage', async () => {
  const sc = await import('../core/scorecard.mjs');
  const { recipeFor } = await import('../core/recipes.mjs');
  const { KIND } = await import('../core/priors.mjs');

  assert.ok(sc.CATEGORIES.includes('drafting'), 'drafting is a scorecard category');
  assert.equal(KIND.drafting, 'visual', 'drafting is visual work, like modeling');

  const r = recipeFor('drafting');
  assert.ok(r, 'a drafting task gets a recipe');
  assert.equal(r, recipeFor('modeling'), 'both halves share one recipe file, so the arithmetic lives in one place');
  assert.match(r, /B0\.1 . DRAFTING/, 'the recipe names the drafting stage');
  assert.match(r, /B0\.2 . MODELLING/, 'and the modelling stage');
  assert.match(r, /tagged `drafting`, B0\.1 is the whole job/, 'the recipe self-scopes for a drafting task');
});

test('a modelling task still gets the whole recipe, drafting stage included', async () => {
  const { recipeFor } = await import('../core/recipes.mjs');
  const r = recipeFor('modeling');
  assert.match(r, /B0\.1 . DRAFTING/);
  // Section numbers move when a stage is inserted, so assert on the stage's subject, not its number.
  assert.match(r, /Geometry in Python with shapely \+ manifold3d/, 'modelling keeps the geometry stage');
  assert.match(r, /Rectify the photograph before you trace it/, 'and the rectification stage that precedes it');
  assert.match(r, /W \+ 1\.5 mm/, 'and the clearance rule the drafting stage is checked against');
});

test('recipe variants still resolve, and an unknown category gets nothing', async () => {
  const { recipeFor } = await import('../core/recipes.mjs');
  assert.ok(recipeFor('modeling', 'recipe-a'), 'recipe A is still selectable by variant');
  assert.equal(recipeFor('nonsense-category'), null);
});
