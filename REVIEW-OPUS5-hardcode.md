# Conductor 2.0 — HARDCODE → DYNAMIC review

Read-only pass. Lens: values, identities, paths and policy baked into code that should be
configurable or data-driven. A prior pass already moved `windowTargets`, `usageGapHours`,
`difficultyEffort`, `fallbackLadder`, `blockedMinutes`, `recipes`, `usageBudgets` to config —
those are **not** re-reported here. Findings are ranked by value-to-effort. Each carries a
CONFIDENCE and an effort/risk rating, and I separate "genuinely should be configurable" from
"fine as a constant" (see the LEAVE-AS-IS list at the end — several tempting targets belong there).

Mechanism legend: **[cfg]** = add to `config.mjs` DEFAULTS + normalize + deep-merge override;
**[env]** = env var; **[param]** = function/spec parameter; **[data]** = external JSON/data file.

---

## 1. Vendor model lists are frozen in code (CLIs that can't self-list)
- **Where:** `core/providers/vendors.mjs:167` (`qwen-code`: `['qwen3-coder-plus','qwen3-coder-flash']`),
  `:195` (`kimi`: `['kimi-k3','kimi-k2.5']`); mirror in `core/providers/index.mjs:15`
  (`openai-images`: `['gpt-image-1','dall-e-3']`), `:23` (`stability`: `stable-image-core`).
- **Current value:** hard-coded arrays returned by `parseModels()` / `listModels()` because these
  CLIs/APIs expose no model list.
- **Why flexibility helps:** Kimi and Qwen ship/rename models frequently. Today a new model
  (`kimi-k3.5`, a new Qwen coder tier) is invisible to the picker and the scorecard until a code
  release — even though the user's subscription can already run it. The registry is otherwise the
  one place that is "never static"; these four providers are the exception that breaks it.
- **Recommended:** merge a config list, e.g. `providers.<id>.models: ['…']`, into `parseModels`
  output (`[...configured, ...hardcoded]`, dedup). **[cfg]** Keep the hard-coded list as the default.
- **Effort/risk:** low / low. **Confidence:** high.

## 2. Grok prompt-file cutoff is a hard-coded 8000 chars, Windows-shaped
- **Where:** `core/providers/vendors.mjs:146` — `if (t.prompt && t.prompt.length > 8000) …--prompt-file`.
- **Current value:** `8000`. Above it, the prompt is written to a temp file to dodge the Windows
  command-line length limit.
- **Why flexibility helps:** the real limit is the OS command-line cap (~32 KB total on Windows,
  megabytes on POSIX) minus the other args — not the prompt in isolation. On Linux/macOS the file
  swap is never needed; on Windows a big prompt *plus* long `--cwd`/model args can still overflow
  under 8000. A fixed constant is both too eager off-Windows and not robust on it.
- **Recommended:** `providers.grok.promptFileThreshold` **[cfg]**, defaulting to `8000` on
  win32 and a much larger value (or `Infinity`) elsewhere; or derive from
  `process.platform` + summed arg length.
- **Effort/risk:** low / low. **Confidence:** high.

## 3. Conductor turn timeout hard-coded at 2 hours
- **Where:** `core/conductor.mjs:317` and `:325` — `timeoutMs: 2 * 3600_000` for codex and loop
  conductor turns.
- **Current value:** `7200000` ms, appearing twice, no config path.
- **Why flexibility helps:** worker runs are already governed by `worker.timeoutMinutes` +
  `timeoutByCategory`; the *conductor* turn has no knob. A long orchestration on a big repo may want
  more; a user on a metered API conducting via a loop model may want a tight ceiling. Two literals
  also risk drifting apart on edit.
- **Recommended:** `conductor.turnTimeoutMinutes` **[cfg]** (default 120), referenced in both spots.
- **Effort/risk:** low / low. **Confidence:** high.

## 4. maxTurns divergence: 500 vs 150 vs 60 across the three call sites
- **Where:** config default `worker.maxTurns: 500` (`config.mjs:33`); dispatch passes
  `cfg.worker.maxTurns || 500` (`core/workers/index.mjs:28`); **but** the Ollama-through-Claude path
  hard-codes `maxTurns: 60` (`core/workers/index.mjs:35`); and the worker itself falls back to
  `t.maxTurns || 150` (`core/workers/claude.mjs:33`).
- **Current value:** three different numbers for "tool turns per Claude-harness worker".
- **Why flexibility helps:** the local-model cap of `60` is invisible policy — a local Ollama model
  doing real multi-file work silently gets ~8× fewer turns than a cloud Claude worker, with no way to
  raise it. The `150` fallback in `claude.mjs` is dead (callers always pass a value) and, if ever hit,
  contradicts the documented 500.
- **Recommended:** give the local path its own knob `worker.maxTurnsLocal` **[cfg]** (or reuse
  `maxTurns`); drop or align the `|| 150` literal to `|| cfg default`.
- **Effort/risk:** low / low. **Confidence:** high.

## 5. Prior tier table and 3D-modeling verdicts are code-only policy (prices aren't)
- **Where:** `core/priors.mjs` — `PRIORS[]` (`:51-82`), `MODELING.best`/`MODELING.results`
  (`:24-42`), `TIER_CEILING` (`:10`), `VISUAL_TIER` (`:46`).
- **Current value:** per-model benchmark tiers and the frozen list of which models may take 3D work
  (`best: ['codex:gpt-6-astra','codex:gpt-5.6-sol']`).
- **Why flexibility helps:** only `price` is config-overridable (`scorecard.prices`). Everything else —
  tiers, and especially the *policy* "only these two models may attempt modeling" — requires a code
  edit to change, even though it is exactly the kind of thing that updates as benchmarks are re-run
  (the header even dates the data "2026-09-09/09-11/09-12"). A new provider gets tier `null` and can
  never be prior-routed without editing this file.
- **Recommended:** load the table from a **[data]** JSON file (`priors.json`) or allow
  `scorecard.priors` / `scorecard.modeling` **[cfg]** to merge over the built-in defaults, mirroring
  how `scorecard.prices` already works. Keeps curation in-repo but unblocks per-user/offline updates.
- **Effort/risk:** medium / low-medium (touches routing; guard with the existing normalize).
  **Confidence:** medium (it *is* curated evolving data — a data file is the right compromise, not
  full user config).

## 6. Image-generation parameters hard-coded
- **Where:** `core/workers/image.mjs:32` (`steps: 25` for local SD), `:17` (`gpt-image-1`,
  `1024x1024`), `:27` (Stability endpoint pinned to `.../generate/core`).
- **Current value:** `steps=25`, default size/model literals.
- **Why flexibility helps:** SD `steps` is the main quality/speed dial and there is no way to raise it
  for a final render or lower it for a draft. Size/model defaults are reasonable but a user on a
  different SD checkpoint or a newer OpenAI image model can't change them without code.
- **Recommended:** thread through `imageOptions` **[param]** (the tool already carries `size`/`n`) and
  add `providers.sd.steps` / `providers.openai.imageModel` **[cfg]** defaults.
- **Effort/risk:** low / low. **Confidence:** high.

## 7. MCP timeouts have no global default (per-server only)
- **Where:** `core/mcp.mjs:65` — `tool_timeout_sec=${s.toolTimeoutSec || 3600}`,
  `startup_timeout_sec=${s.startupTimeoutSec || 30}`.
- **Current value:** `3600` / `30`, overridable per-server but with no config-wide default.
- **Why flexibility helps:** a slow-starting MCP (a local server that compiles on boot) needs a higher
  startup timeout across the board; today you'd have to set it on every server entry.
- **Recommended:** `mcp.toolTimeoutSec` / `mcp.startupTimeoutSec` **[cfg]** as the fallback before the
  hard-coded numbers.
- **Effort/risk:** low / low. **Confidence:** medium.

## 8. Bench probe budget is hard-coded (3 min, task `read-1`)
- **Where:** `core/bench.mjs:33,43` (`saveConfig({ smoke: { timeoutMinutes: 3 } })`), `:37`
  (`tasks: ['read-1']`).
- **Current value:** probe timeout `3` minutes and a single fixed probe task id.
- **Why flexibility helps:** the probe gates whether a full battery runs; a slow local model may need
  more than 3 min to prove itself, and `read-1` is a read task — a poor probe for an image/modeling
  provider. Also note it round-trips `saveConfig` repeatedly to fake a temporary value, which is a
  smell that this should be a parameter, not a persisted setting.
- **Recommended:** `scorecard.benchProbeMinutes` and a probe-task id (or per-kind probe) **[cfg]**,
  passed as a **[param]** to `runSmoke` instead of mutating saved config.
- **Effort/risk:** low / low. **Confidence:** medium.

## 9. HTTP 429 default block (60s) ignores `blockedMinutes`
- **Where:** `core/limits.mjs:104` — when a 429 carries no usable `retry-after`, `retry = … : 60_000`.
- **Current value:** `60_000` ms, while every *other* "blocked with no retry-after" path uses
  `scorecard.blockedMinutes` (30 min) via `blockedMs()` in the same file (`:10`).
- **Why flexibility helps:** inconsistent policy — an API 429 with no header unblocks after 1 min, a
  subscription limit after 30. One knob should govern "assumed block when the provider won't say".
- **Recommended:** reuse `blockedMs()` (or a separate `scorecard.http429Seconds` **[cfg]**) instead of
  the literal.
- **Effort/risk:** low / low. **Confidence:** medium.

## 10. Claude effort-level thresholds are hard-coded model-generation policy
- **Where:** `core/providers/anthropic.mjs:76-79` — `effortsFor()` gates effort lists on
  `family==='fable' || v>=5 || (opus && v>=4.7)` etc.
- **Current value:** version cutoffs (`5`, `4.7`, `4.6`, `4.5`) mapping to effort arrays.
- **Why flexibility helps:** this only fires for models discovered via the Models API that the SDK
  doesn't report efforts for (the SDK path at `:110` is primary and correct). But when a *new* Claude
  generation ships (Opus 6, Fable 6) before an SDK update, its efforts are guessed by these frozen
  rules and can be wrong. It encodes future-model policy in code.
- **Recommended:** low urgency given the SDK is the primary source; if changed, a
  `providers.claude.effortRules` **[cfg]** or a **[data]** map. Otherwise document as a known
  best-effort fallback.
- **Effort/risk:** low / low-medium. **Confidence:** low-medium (mostly shadowed by the SDK path).

---

## Honorable mentions (real, lower value)

- **Custom binary path override for non-Codex vendor CLIs.** `core/proc.mjs`/`vendors.mjs` discover
  `agy`/`grok`/`kimi`/`qwen` via PATH + a few hard-coded fallback dirs. Codex has `CONDUCTOR_CODEX`
  **[env]**; the others have no escape hatch for an unusual install location. Add
  `providers.<id>.bin` **[cfg]**. Low value, low effort.
- **DeepSeek off-peak schedule** (`priors.mjs:111-115`) and **balance endpoint / `pid==='deepseek'`
  special-casing** (`openai-compat.mjs:60-64`) are vendor policy in code. Correct today; only worth
  touching if a second balance-aware provider appears.
- **`NOT_CHAT` model-filter regex** (`openai-compat.mjs:13`) could hide a legitimately-named chat
  model. Borderline; a `providers.<id>.modelFilter` override is possible but low value.

## LEAVE AS-IS (constants that don't vary — do not churn)

- **`planBatch` `bufferPct=25` / `maxParallel=4`** (`sweep.mjs:19`): the framework budget gate uses
  the config-driven `windowTargets` path (`headroomFor`/`admit`); `planBatch`/`nextBatch`/`planGreedy`
  are referenced only by `sweep.mjs` itself and tests (grep confirms no runtime caller). The `25`
  buffer is effectively superseded — don't promote it to config.
- **`DIFFICULTY_EFFORT`** (`scorecard.mjs:344`) and **`FALLBACK_LADDER`** (`sweep.mjs:73`): both are
  already `{...DEFAULT, ...loadConfig().scorecard.<x>}`-merged with config. The in-code copy is just
  the default. Correct as-is.
- **`EFFORTS` ordering** (`scorecard.mjs:341`): a single source of truth for a universal ranking;
  making it configurable would break comparisons. Keep constant.
- **`SKIP` dir set** (`openai-compat.mjs:30`), **`read_file` 60k cap / `fetch_url` 60k + 30s UA**,
  **`run` default 120s** (model can override via `timeout_s`): universal, sane tool limits.
- **`models.mjs` `ORDER`** display sort, **`EFFORT_WORDS`**, **conductor ring buffers**
  (`pushMessage` 2000, `trimHistory` 160), **`bus` replay 2000**: presentation/memory constants that
  never legitimately vary per-deployment.
- **`smoke/battery.mjs` fixtures**: this is benchmark test data, not configuration. Correct in code.
- **`openai-compat.mjs` `CATALOG` baseUrls**: already overridable via `providers.<id>.baseUrl`
  (`baseUrlFor`). Not a finding.
- **`codexCommand` `CONDUCTOR_CODEX` + LOCALAPPDATA discovery**, **`spawnCodex`/`spawnCli`
  no-shell logic**: platform handling is already dynamic and env-overridable where it matters.
