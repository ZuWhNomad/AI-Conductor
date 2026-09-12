# Roadmap: capability routing (index → recipe → research)

Status: **proposal** (2026-09-11). Captures the direction discussed. The benchmarks themselves live in a
separate repo — **[conductor-benchmarks](https://github.com/ZuWhNomad/conductor-benchmarks)** (heavy assets +
run data, own update cadence). Conductor keeps only a distilled prior/results for model selection and pulls
that repo on demand. Revise freely.

## The idea
The conductor should pick the *cheapest correct route* for a task, not always brute-force it with a model.
For a task type it has seen before, it consults an index and either delegates to the best-measured model or
runs a deterministic pipeline (e.g. an OCR extractor) that a model would otherwise reinvent. For a task type
it has *not* seen, it can spawn a bounded research step that finds the best approach and records it.

Categories stay **coarse** on purpose (`pdf-extract`, `modeling`, `ocr`, …). Over-precise keys never get
reused, which defeats the index.

## What already exists (the seams)
| Concept | Where |
|---|---|
| Public expectation index (cold start) | `core/priors.mjs` — categories → KIND (`code`/`read`/`reason`) → tier per model |
| Measured index (warm) | `core/scorecard.mjs` — `recommend({category, difficulty})` picks best value from real verdicts |
| Deterministic in-repo pipelines | `core/plans.mjs` — multi-stage fan-out / judge / loop plans on the task scheduler |
| External pluggable tools | `core/mcp.mjs` — conductor-wide MCP registry attached to every worker |
| Self-iteration loop | `core/improve.mjs` + `core/bench.mjs` — notes gaps, benches new models |

So measured per-category model routing is **already** there. The two missing pieces are (1) a registry that
can prefer a *deterministic route* over a model, and (2) a research step that fills the registry on a miss.

## The missing pieces
### 1. Recipe registry (`core/recipes.mjs`, new)
A small map: coarse category → preferred route, tried *before* model selection.
```
{ category: 'pdf-extract', prefer: { kind: 'mcp', server: 'ocr-pipeline' }, fallback: 'model' }
{ category: 'modeling',    prefer: { kind: 'model' } }   // no deterministic tool; route by scorecard
```
Flow: classify task → look up recipe → if a deterministic route exists and its tool is installed, use it;
else fall through to `scorecard.recommend()`. Starts **hand-curated**.

### 2. Research-on-miss (extend the bench/improve loop)
On an unknown category with no recipe and no measured data, spawn a bounded research *plan* that trials 2–3
approaches on a small holdout, then writes a recipe entry (registering an MCP server if a tool wins). Same
shape as `noteNewModels → bench`. **Not built until phases 1–2 prove out.**

## External tools: safety (non-negotiable)
Pulling a tool from GitHub and running it is a supply-chain risk. Rules:
- **Allowlist** of vetted tool repos; no arbitrary clones.
- **Pin versions**; record the pinned ref in the recipe.
- **First-run vetting in a sandbox/VM**: before a newly-pulled tool is trusted, run it once in an isolated
  VM/container and check it carries no malicious payload (no unexpected network egress, no writes outside its
  workdir). Only then promote it to the live registry.
- Installing a new capability is a **gated** step, never autonomous.

## Phasing
1. **`modeling` category + cookiebench data.** Add category `modeling` and KIND `visual` to `priors.mjs`;
   record cookiebench hybrid scores as scorecard verdicts so `recommend({category:'modeling'})` routes 3D
   tasks empirically. (Small; reuses existing routing.) — *in progress*
2. **Recipe registry, hand-curated.** `core/recipes.mjs` with a couple of entries (e.g. `pdf-extract` → an
   OCR MCP). Wire the classify → recipe → fallback path into the conductor policy. No auto-research.
   — *started 2026-09-12*: `core/recipes.mjs` maps a category to an instruction set in `core/recipes/` that is
   appended to the worker's spec (first entry: `modeling` → `image-to-3d-model.md`, distilled from the Astra
   ultra pass). Deterministic routes (kind: mcp) are the next step.
3. **Research-on-miss.** Only after 1–2 show value. Includes the sandbox-vetting step above.

## Parked ideas
- **Modeling step 0: search before modeling.** Before the image→3D pipeline runs, the conductor should ask the user
  whether to look for an existing 3D model of the object first (Thingiverse, Printables, MakerWorld, Thangs, Cults3D
  — many have search APIs or scrapeable listings). A found STL costs zero modeling tokens and is usually better than a
  generated one; the pipeline then becomes the fallback, or a remix step. Add once the pipeline itself is settled
  (noted 2026-09-12).

## Principle
**Bench before automating the registry.** The scorecard is empirical by design; the recipe registry should
start hand-curated and let measured results decide what gets promoted or automated.

## Related
- **conductor-benchmarks** repo, `cookie-cutter/` — first `modeling` benchmark; hybrid scoring (deterministic
  gate + human/vision visual score). Its operator scores are the seed set for an eventual auto-judge (a
  separate `visual-judge` capability: *judging* visual output is distinct from *producing* it).
