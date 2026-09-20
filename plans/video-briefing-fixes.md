# Plan: panel findings 2, 3, 4

Status: plans only, nothing implemented. Finding 1 (browser MCP) is already resolved — the
`chrome-devtools` entry was removed from `~/.conductor2/config.json`. Finding 5 is resolved — the
recipes are now `video-briefing-finance.md` and `video-briefing-general.md`, the A/B framing is
dropped.

---

## Finding 4 first — it is the root cause of 3

**Problem.** `core/tasks.mjs:170-172`:

```js
const recipe = recipeFor(t.category, t.variant);
const tools = capabilityLines(t.category, { maxChars: Math.max(0, cap - (recipe || '').length) });
```

The finance recipe is ~9.9 KB against a 3000-char cap, so `maxChars` floors to 0, `capabilityLines`
returns nothing, and the worker loses **all** capability guidance — while the recipe is appended
unclipped. A big recipe silently starves the tool index.

**Root cause is not the cap. It is that the file has two audiences in it.**
The recipe currently contains both:
- **Stage 1**, the prompt a human pastes into Gemini — the biggest part of the file, and a
  Conductor worker never uses a word of it.
- **Stage 2**, what a Conductor worker actually does — read the briefing off disk, run the
  QuantGPT claim-and-update pass.

**Plan — split by audience.**
1. `core/policy/recipes/video-briefing-finance.md` shrinks to the **worker** recipe: step 0 (no
   network, where the file comes from, stop if absent), section 7 in full, and the constraints.
   Estimated ~1.5-2 KB, comfortably under the cap.
2. The **operator** prompt (the Gemini-facing text) moves out of the recipes directory — it is not
   a worker recipe. It belongs with the prompt in the vault, with the repo keeping a pointer.
3. Then `cap - recipe.length` leaves ~1 KB for tool lines, and the bug stops firing for this recipe.

**Plan — fix the arithmetic anyway**, because the next long recipe will hit it again:
- Give recipe and capability lines **separate budgets** (`recipeCap`, `toolsCap`) instead of having
  them compete for one, so a long recipe can never zero the tool index.
- Add a guard: if a recipe exceeds its budget, log a `friction` improvement entry naming the file
  and its size. Today it fails silently, which is why nobody noticed.
- A test asserting that a task with an oversized recipe still receives non-empty capability lines.

---

## Finding 3 — the finance recipe is the default for every `summarize` task

**Problem.** `core/recipes.mjs:12` makes it the category default, so a summarize task about a diff
or a doc gets the finance-video prompt appended. The mitigation is a self-scoping first line telling
the model to ignore it, which is a soft instruction a weaker worker will not reliably obey.

**Plan, in order of preference.**

1. **Route by variant, not default (small, do this now).** Remove `summarize` from `RECIPES`; keep
   `RECIPE_VARIANTS.summarize = { 'video-finance', 'video-general' }`. Nothing gets the recipe
   unless the task asks for it. Cost: the caller must set `variant`, and a conductor delegating a
   video task will not know to.
2. **Close that gap with the hook that already exists.** `core/policy/capabilities.json` has a
   `youtube` entry that already fires on a `youtube.com/` match in the spec. Extend its text to say:
   for a financial video, run the task with `variant: video-finance`. One line, in a mechanism that
   is already wired and already triggers on exactly the right tasks.
3. **Medium term — match-based recipe selection.** Recipes are chosen by category alone; capability
   entries are chosen by pattern match. Give recipes the same `match` field and have
   `recipeFor(category, variant, specText)` consult it. That fixes the whole class of problem
   (a recipe that applies to *a kind of task*, not *a whole category*) rather than this instance.
   Needs a change to `recipes.mjs`, its callers, and the hygiene test.

Once (1) lands, the self-scoping first lines stay as belt-and-braces but stop being load-bearing.

---

## Finding 2 — stream-date inference can silently mis-anchor section 7

**Problem.** Section 7 finds the video's date by matching quoted prices to a trading day. On the IBD
run this worked well — ~15 tickers agreed on 2026-09-14. But if it matches the **wrong** day, or no
day, every verdict in the section is anchored wrong and nothing says so. A confident table of
verdicts against the wrong date is worse than no table.

**Plan — stop inferring what we can simply know.**

1. **Capture the date in stage 1.** Whoever fetches the video has network and the date is right
   there in the watch page metadata (`datePublished` / `uploadDate`). Stage 1 writes it into the
   briefing's YAML front matter:
   `stream_date: 2026-09-14` and `date_source: youtube metadata`.
2. **Section 7 reads it instead of deriving it.** Inference becomes *verification*: the tape should
   agree with the stated date, and section 7 reports whether it does. Two independent sources
   agreeing is a real check; one source guessing is not.
3. **When no date is supplied, make inference prove itself.** Require at least 3 independent tickers
   matching the same trading day to within 0.1%, AND no other day in a +/-10 session window matching
   as well. If either test fails, the date is ambiguous: every price row becomes `not checkable`,
   and the section opens with a plain statement that the anchor could not be established. Never
   fall back to "today".
4. **Make the anchor auditable.** Section 7 already states the date; require it to also state how it
   was established and which tickers pinned it, so a reader can falsify it in one glance.

**Cheap check worth adding.** A quoted price matching a day is weak on its own — many days are
close. Matching on *several* tickers simultaneously is strong, because the joint probability of a
coincidental match collapses. That is already what the IBD run did by instinct; step 3 makes it the
written rule rather than luck.
