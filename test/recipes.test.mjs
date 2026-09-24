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

test('L25: delegate and run_plan schemas expose variant', async () => {
  const { conductorToolDefs } = await import('../core/tools.mjs');
  const defs = conductorToolDefs({ sessionId: 'l25', cwd: process.cwd() });
  assert.equal(defs.find((d) => d.name === 'delegate').schema.parse({ title: 't', spec: 's', variant: 'recipe-c' }).variant, 'recipe-c');
  const parsed = defs.find((d) => d.name === 'run_plan').schema.parse({
    goal: 'g',
    defaults: { variant: 'recipe-c', category: 'modeling' },
    stages: [{
      id: 'a',
      defaults: { variant: 'recipe-a', category: 'modeling' },
      tasks: [{ spec: 'x', variant: 'recipe-b', category: 'modeling' }],
      task: { spec: 'y', variant: 'video-finance', category: 'summarize' },
    }],
  });
  assert.equal(parsed.defaults.variant, 'recipe-c');
  assert.equal(parsed.stages[0].defaults.variant, 'recipe-a');
  assert.equal(parsed.stages[0].tasks[0].variant, 'recipe-b');
  assert.equal(parsed.stages[0].task.variant, 'video-finance');
});

test('every shipped recipe fits the default recipeChars budget', async () => {
  const { DEFAULTS } = await import('../core/config.mjs');
  const { recipeFor, RECIPES, RECIPE_VARIANTS } = await import('../core/recipes.mjs');
  const seen = [];
  for (const [category, file] of Object.entries(RECIPES)) {
    const text = recipeFor(category);
    assert.ok(text, file);
    assert.ok(text.length <= DEFAULTS.worker.recipeChars, `${file} is ${text.length} chars, default is ${DEFAULTS.worker.recipeChars}`);
    seen.push(file);
  }
  for (const [category, map] of Object.entries(RECIPE_VARIANTS)) {
    for (const [variant, file] of Object.entries(map)) {
      const text = recipeFor(category, variant);
      assert.ok(text, `${category}/${variant} (${file})`);
      assert.ok(text.length <= DEFAULTS.worker.recipeChars, `${file} is ${text.length} chars, default is ${DEFAULTS.worker.recipeChars}`);
      seen.push(file);
    }
  }
  assert.ok(seen.length, 'at least one shipped recipe');
});

test('recipe listing includes configured categories and reports overridden files', async () => {
  const { saveConfig } = await import('../core/config.mjs');
  const { recipeFor, listRecipes } = await import('../core/recipes.mjs');
  try {
    saveConfig({ recipes: { defaults: { debug: 'video-briefing-general.md', modeling: 'image-to-3d-model.md' } } });
    const listed = listRecipes();
    assert.deepEqual(listed.find((r) => r.category === 'debug'), { category: 'debug', file: 'video-briefing-general.md', present: true });
    assert.equal(recipeFor('debug'), recipeFor('summarize', 'video-general'));
    assert.deepEqual(listed.find((r) => r.category === 'modeling'), { category: 'modeling', file: 'image-to-3d-model.md', present: true });
    assert.equal(recipeFor('modeling'), recipeFor('modeling', 'recipe-a'));
  } finally { saveConfig({ recipes: null }); }
});
