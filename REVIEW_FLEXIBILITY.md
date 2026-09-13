# Flexibility review — hard-coded values that should be configurable/data-driven

Scope: `core/`, `server/`, targeted. Goal: find hard-coded entries/values worth making flexible, propose the smallest mechanism, and rank by value-to-effort. Config already lives in `core/config.mjs` (`DEFAULTS` + `~/.conductor2/config.json`, deep-merged, normalized). A lot is already configurable and well done (ports, poll cadence, concurrency, budgets, class caps, provider weights, prices, base URLs, API keys, sandbox, timeouts). The findings below are the gaps.

Legend — Effort/Risk: **S** small, **M** medium, **L** large.

---

## Ranked findings

### 1. Effort-level list duplicated 6× — and `EFFORT_LADDER` is missing `ultra` (latent bug)
- **Where / current value:**
  - `core/conductor.mjs:51` `EFFORT_WORDS = {minimal, low, medium, high, xhigh, max, ultra, none, default}`
  - `core/scorecard.mjs:245` `EFFORT = ['low','medium','high','xhigh','max','ultra']`
  - `core/scorecard.mjs:340` `EFFORT_LADDER = ['low','medium','high','xhigh','max']`  ← **no `ultra`**
  - `core/sweep.mjs:60` `FALLBACK_LADDER = {low:1, medium:1.5, high:2, xhigh:3, max:4, ultra:6}`
  - `core/tools.mjs:49` effort description string
  - `core/providers/vendors.mjs:132,144` grok `['low','medium','high']`
- **Why it matters (concrete bug):** `priorEffort()` and `effortForTask()` (scorecard.mjs:345–364) rank efforts with `EFFORT_LADDER.indexOf(e)`. Because `ultra` is absent, `indexOf('ultra') === -1`:
  - cold-start routing (`priorEffort`) filters the model's efforts through `EFFORT_LADDER`, so a model that offers `ultra` (Codex Astra/Sol — exactly the models the modeling recipe wants at `ultra`, see `priors.mjs`) can **never** be cold-started at `ultra`;
  - a hand-set `worker.effort: 'ultra'` ranks as `-1` (below `low`) in `effortForTask`, so `want`/`base` comparisons silently down-shift it.
  Meanwhile the effort-dominance loop (scorecard.mjs:245) *does* know `ultra`, so the two disagree.
- **Recommended mechanism:** export a single ordered `EFFORTS = ['low','medium','high','xhigh','max','ultra']` (plus `minimal` if the SDK uses it) from one module (e.g. `core/priors.mjs` or a tiny `core/efforts.mjs`) and import everywhere; derive the multiplier ladder from index. Not user config — this is a canonical constant that must be DRY. Fixes the bug as a side effect.
- **Effort/Risk:** S / S. Highest value: corrects a real routing bug and removes 6-way drift.

### 2. Per-window sweep/gate targets (session 95 % / weekly 100 %) hard-coded in `sweep.mjs`, not read from config
- **Where / current value:** `core/sweep.mjs:105` `targetFor = (w) => isSession(w) ? 95 : 100;` used by `headroomFor`, `planGreedyWindows`, `nextResetWindows`, and `admit()` — i.e. the **framework-wide budget gate** for every dispatched task (`tasks.mjs:168`).
- **Why it matters:** `config.scorecard.classCap` already exposes `{conductor:95, …}` and the architecture doc describes "session 95 % / weekly 100 %" as policy, but the *actual* numbers that gate all dispatch are frozen in code. A user who wants a safety margin (weekly to 90 %, or session to 85 % on a shared account) cannot tune it; the two mechanisms (`classCap` vs `targetFor`) can also drift apart.
- **Recommended mechanism:** add `config.scorecard.windowTargets: { session: 95, weekly: 100 }` (or reuse `classCap`) and read it in `targetFor`. Keep the current values as `DEFAULTS`.
- **Effort/Risk:** S / M (touches the gate; covered by `test/sweep.test.mjs`).

### 3. Windows-only Python 3.12 path for the Kimi CLI shim
- **Where / current value:** `core/providers/vendors.mjs:16`
  `pyScripts = WIN ? [ …\Python\Python312\Scripts, …\Programs\Python\Python312\Scripts ] : [~/.local/bin]`
- **Why it matters:** hard-codes `Python312`. A user on Python 3.13/3.14 (or a future upgrade on the same machine) installs `kimi` into `Python313\Scripts`, and `bin()` silently fails to find it → Kimi shows as not installed. This is a "new machine / version bump" break, exactly the flexibility target.
- **Recommended mechanism:** glob `Python3*/Scripts` (stdlib `readdirSync` filter), or accept `providers.kimi.binPath` in config. Prefer the glob — it needs no config and the ladder's "does it need config?" rung says no.
- **Effort/Risk:** S / S.

### 4. `GAP_MS = 6h` window-inference constant in `usage-estimate.mjs`
- **Where / current value:** `core/usage-estimate.mjs:9` `GAP_MS = 6 * 3600_000`.
- **Why it matters:** for providers whose CLI reports no window (Grok), a 6 h gap in activity is assumed to be a window reset. Per the project's own memory, SuperGrok resets *daily* (~6 pm); a 6 h idle gap mid-day would wrongly re-anchor the window and reset the token count, corrupting the usage estimate. Different providers reset on different cadences.
- **Recommended mechanism:** make it per-provider: `config.scorecard.usageWindow[provider] = { gapMinutes, resetsDailyAt }` (or a single `usageGapMinutes` default). Advisory-only path, so risk is low.
- **Effort/Risk:** S / S–M.

### 5. Session-window heuristic (`/hour|session/` + `windowMinutes ≤ 600`) duplicated 3× 
- **Where / current value:** `core/sweep.mjs:95` (`nextReset`), `core/sweep.mjs:104` (`isSession`), `core/scorecard.mjs:302` (`providerUsedPct sessionOnly`).
- **Why it matters:** the definition of "a session window" (the 600-minute cutoff + label regex) is copy-pasted; changing it (e.g. a provider with a 4 h window labelled oddly) means editing three call sites, and they can drift. Not user-facing config, but a DRY/robustness win.
- **Recommended mechanism:** export one `isSessionWindow(w)` helper from `sweep.mjs` and import it in `scorecard.mjs`. Optionally make the 600 cutoff a named constant.
- **Effort/Risk:** S / S.

### 6. Cold-start policy maps: `DIFFICULTY_EFFORT` and `FALLBACK_LADDER`
- **Where / current value:**
  - `core/scorecard.mjs:343` `DIFFICULTY_EFFORT = {1:'low',2:'medium',3:'medium',4:'high',5:'xhigh'}` — desired effort per difficulty before any data exists.
  - `core/sweep.mjs:60` `FALLBACK_LADDER` — token multiplier per effort when unmeasured.
- **Why it matters:** these are tuning knobs a power user reasonably wants to adjust (e.g. "level-3 work should start at `high`", or "my model's `ultra` costs 8× not 6×"). They shape routing and batch sizing before measurements accrue.
- **Recommended mechanism:** move both into `config.scorecard` (`difficultyEffort`, `effortLadder`) with the current maps as `DEFAULTS`. Merge is already deep, so partial overrides work.
- **Effort/Risk:** S / S. (Do #1 first so `effortLadder` is the single source.)

### 7. Hard-coded model lists for CLIs that can't enumerate their own models
- **Where / current value:** `core/providers/vendors.mjs:159` qwen `['qwen3-coder-plus','qwen3-coder-flash']`; `:187` kimi `['kimi-k3','kimi-k2.5']`.
- **Why it matters:** these two vendor CLIs expose no `models` command, so the list is frozen in code. When Moonshot/Qwen ship a new model, the user can't select it without editing the source — contradicting the "limits and models are never static" principle that holds everywhere else.
- **Recommended mechanism:** let `config.providers.<id>.models: ['…']` override the built-in fallback list in `parseModels()`. Tiny change, keeps the hard-coded list as the default.
- **Effort/Risk:** S / S.

### 8. Recipe category→file maps hard-coded in `recipes.mjs`
- **Where / current value:** `core/recipes.mjs:10` `RECIPES = { modeling: 'image-to-3d-model.b.md' }`; `:13` `RECIPE_VARIANTS = { modeling: {...} }`.
- **Why it matters:** which recipe a category/variant gets is policy the user (or the self-improvement loop) may want to change without a code edit — e.g. promote recipe-c to default, or add a recipe for a new category. Files already live in `core/recipes/`.
- **Recommended mechanism:** allow `config.recipes` to override/extend the maps (merge over the built-in defaults), or auto-discover `core/recipes/<category>.*.md`. Config override is the smaller change.
- **Effort/Risk:** S / S.

### 9. "Assume blocked for 30 min" magic number, repeated
- **Where / current value:** `core/limits.mjs:84` and `:118` (`Date.now() + 30 * 60_000`), `core/tasks.mjs:211` (`r.retryAfterMs || 30 * 60_000`), `core/limits.mjs:99` (`60_000` retry-after fallback).
- **Why it matters:** when a provider says it's rate-limited but gives no reset time, the code guesses 30 min. Repeated literal; a user with tight/loose windows can't tune the park duration, and the three copies can diverge.
- **Recommended mechanism:** one named `DEFAULT_BLOCK_MS` constant (shared), optionally `config.scorecard.defaultBlockMinutes`. Low value but cheap to consolidate.
- **Effort/Risk:** S / S.

### 10. Grok `--prompt-file` threshold (8000 chars) and Ollama-via-Claude `maxTurns: 60`
- **Where / current value:** `core/providers/vendors.mjs:138` `t.prompt.length > 8000`; `core/workers/index.mjs:35` `maxTurns: 60` (Ollama+claude harness), vs `config.worker.maxTurns` (500) used for real Claude workers on `:28`.
- **Why it matters:** the 8000-char cutoff is a conservative guess at the Windows command-line limit and applies only to Grok; other CLIs (kimi, qwen) pass big prompts as a bare arg with no such guard. The `60` is an unexplained divergence from the configurable worker turn cap — a long local-model task could hit it while the config says 500.
- **Recommended mechanism:** hoist the arg-length cutoff to a shared constant used by every CLI runner that passes a prompt as an argument; route the Ollama-claude `maxTurns` through `config.worker.maxTurns` (or a documented `worker.ollamaMaxTurns`).
- **Effort/Risk:** S / S.

---

## Lower-value / borderline (noted, not top-ranked)

- **`awaitTask` default `45 * 60_000` (`tasks.mjs:116`)** duplicates `config.worker.timeoutMinutes` (45). Have the default read the config value so they can't drift. S/S.
- **Category taxonomy `CATEGORIES` (`scorecard.mjs:14`) + `KIND` map (`priors.mjs:17`)** are hard-coded and coupled (adding a category needs edits in both, plus recipes). Genuinely a taxonomy; data-driving it is possible but risky and rarely needed — leave as constants unless categories start changing.
- **`MODELING.best / results / caveat` (`priors.mjs:24–42`)** — hand-maintained benchmark verdicts embedded in code. They already update by hand and `scorecard.prices` overrides the price half; moving the verdicts to a data/ndjson file would be cleaner but is not blocking. Low priority.
- **DeepSeek off-peak hours (`priors.mjs:111–115`)** and **antigravity `windowMinutes` 300/10080 (`vendors.mjs:46`)** reflect real vendor facts; **fine as constants** (change only if the vendor changes them).
- **`difficulty` default `2` in `recommend()` (`scorecard.mjs:209`)**, `LEVELS = [1..5]` (`:17`) — fine as constants; the 1–5 scale is validated at the API boundary (`tasks.mjs:80`).

## Explicitly fine as constants (do not churn)

- **Server bind host `127.0.0.1` (`server/index.mjs:266`, and the host/origin allowlist `:251–252`)** — deliberate localhost-only security posture. Port is already `config.port`. Making the host configurable would weaken the security model; leave it. (Listed in the brief as a candidate — recommend *against* changing.)
- **State dir** — already flexible via `CONDUCTOR_HOME` (`paths.mjs:10`).
- **Codex binary location** — already flexible via `CONDUCTOR_CODEX` + npm/desktop discovery (`proc.mjs:42`).
- **API base URLs** — already overridable via `config.providers.<id>.baseUrl` (`openai-compat.mjs:38`); CATALOG is a proper data table.
- **SSE heartbeat 15 s, update-check 3 s, review interval 6 h, body cap 5 MB, display truncations (`slice`)** — internal tuning/limits with no user-facing scenario.
