# Review panel — YouTube financial-briefing recipe (uncommitted change)

Date: 2026-09-20. Conductor: Opus 4.8. Four angles delegated to separate workers, then synthesized
and spot-verified by the conductor.

**Change under review**
- `core/recipes.mjs` — `summarize: 'youtube-analysis.c.md'` added as a DEFAULT category recipe; `summarize`
  variants `youtube-b` / `youtube-c` added.
- `core/policy/recipes/CONTEXT.md` — entry note.
- NEW `core/policy/recipes/youtube-analysis.c.md` (recipe under test, 9891 chars) and `.b.md` (baseline, 4573 chars).
- OUT OF REPO (reviewed by description): `~/.conductor2/config.json` gained an `mcpServers` entry
  `chrome-devtools` (browser-driving MCP), `categories: ["summarize"]`, args only `--viewport 1280x1600`.

**Panel:** 1 recipe/prompt quality · 2 registry correctness · 3 MCP security · 4 pipeline soundness.
Conductor independently verified the registry cap arithmetic, the MCP scoping/approval code, and the test runs.

---

## MUST FIX before committing (5)

### M1 — Browser MCP on autonomous `summarize` = logged-in web authority (CRITICAL)
`config: chrome-devtools entry`; enforcement `core/mcp.mjs:62-63`, `core/mcp.mjs:82`
- `chrome-devtools-mcp` defaults to a **persistent** Chrome user-data profile. Whatever the operator
  signs into there (IBKR, Gmail, Drive, claude.ai) stays logged in across runs. A summarize worker with
  this MCP can navigate, click, fill forms, read the DOM, screenshot, inspect network and run page JS —
  as the logged-in user. IBKR makes the blast radius account-level.
- `categories: ["summarize"]` is **not** a security boundary. Verified: `mcpServersFor(category)` returns
  **every** server when the task is untagged (`mcp.mjs:62 if (!category) return all`), and otherwise only
  filters by tag — no origin allowlist, no per-tool policy, no human approval. Verified `codexMcpArgs`
  (`mcp.mjs:82`) sets `default_tools_approval_mode="approve"` for every server, so Codex workers
  auto-approve MCP calls; Claude workers attach without prompts. So any summarize (or untagged) worker can
  silently drive an authenticated browser.
- Confused-deputy: summarize inputs are exactly the attacker-influenced surfaces (video descriptions,
  linked articles, comments). A page that contains instructions can steer the browsing model to open
  Gmail/IBKR, exfiltrate content, or attempt actions.
- **Fix:** do not attach a browser MCP to an autonomous category. If kept, pin an isolated/ephemeral
  profile that is never signed into any personal or brokerage account, and pin hardening flags:
  `--isolated=true --headless=true --javascriptEvaluation=false --redactNetworkHeaders=true`
  `--no-usage-statistics`, plus `--allowedUrlPattern=<required origins>` where the Chrome version supports
  it. Do not set `--allowUnrestrictedPaths`. Longer term, treat browser MCP as manual/conductor-supervised
  and fail closed for untagged tasks.

### M2 — Stream-date inference can anchor every claim-check to the wrong day (CRITICAL)
`core/policy/recipes/youtube-analysis.c.md:113-116`
- §7(a) infers the stream date by matching quoted prices to "exactly one trading day." Rounded prices
  ("NVDA around 180"), intraday-vs-close, or the wrong ticker/share class can match multiple days, no day,
  or the wrong day. Stage 2 then silently anchors every "as of stream date" and "since" verdict to a wrong
  date — the whole section is quietly wrong with no error.
- **Fix:** require an explicit stream/publication date (YouTube metadata, on-screen text, or a Stage 1
  metadata sidecar). If only inferable, the recipe must list the candidate evidence and **stop unless the
  date is unique and all anchors agree** ("date unconfirmed → do not run as-of verdicts").

### M3 — `youtube-analysis.c.md` as the DEFAULT `summarize` recipe hits every summarize task (HIGH)
`core/recipes.mjs:12`
- Verified path: `recipeFor('summarize')` → `defaults()['summarize']` → `youtube-analysis.c.md`, appended in
  full by `buildPrompt` (`core/tasks.mjs:168-172`). So summarizing a diff, a README, or a PDF now gets
  ~9.9KB of financial-video-briefing prompt appended. The self-scoping first line is a *negative*
  instruction; weaker/local models (the ones that take cheap summarize work) often ignore it and force the
  briefing structure or hallucinate tickers/timestamps.
- **Fix:** do not default `summarize` to this recipe. Leave `RECIPES.summarize` unset and select the
  video recipe via `variant` (or a URL/video capability match). `modeling` is a narrow niche; `summarize`
  is a core general category — a finance-video template is the wrong global default.

### M4 — Oversized recipe zeroes out all capability/tool lines (HIGH)
`core/tasks.mjs:170-172`, `core/capabilities.mjs:73-81`
- Verified arithmetic: `cap = 3000`; recipe = 9891 chars; `capabilityLines(cat, {maxChars: max(0, 3000-9891)})`
  = `maxChars: 0`; `capabilityLines` breaks on the first line (`len + l.length + 1 > 0`) → returns `''`.
  So **every** summarize task loses its entire "programs & services for this work" block (pdftotext,
  yt-dlp, ffmpeg…), while the 9.9KB recipe is appended unclipped. The `cap` bounds only the tool lines,
  not the recipe — the comment at `tasks.mjs:169` ("the two cannot silently double a prompt") is misleading.
  Note: baseline B (4573) and `image-to-3d-model.b.md` (4708) already exceed 3000, so this starvation
  pre-dates the change for `modeling`; the change newly extends it to all of `summarize`.
- **Fix:** either keep recipes under the cap, or budget recipe and capability lines separately (give the
  capability block its own floor so it is never fully starved), or clip the recipe to the cap too.

### M5 — B-vs-C A/B is not a fair comparison (HIGH)
`core/policy/recipes/youtube-analysis.c.md:3-10`; `core/policy/recipes/CONTEXT.md` (entry); `core/recipes.mjs:12`
- B (`b.md:3`) applies to **any** video; C restricts to **financial** videos only and explicitly bails on
  non-financial ones. C also adds §4 (editorial layer) and §7 (QuantGPT check) that B lacks. Run on one
  suite: C refuses non-financial videos, B scores zero on warehouse verification it was never told to do.
  The header (`c.md:8-10`) frames C as "B plus six edits" and omits the domain shift and §7 entirely, and
  CONTEXT.md advertises an A/B that cannot be graded on a shared rubric.
- **Fix:** make B the financial-scoped baseline too (so B and C differ only by the edits under test) OR
  name C a distinct domain recipe (e.g. `financial-video-analysis.md`) and stop calling this an A/B.
  Correct the header and CONTEXT.md to state the true delta (finance scope + §7).

---

## WORTH DOING LATER

### L1 — Refusal / empty briefing is not rejected (HIGH)
`c.md:35,38` — Stage 2 only stops if the file is *absent*. A Gemini refusal stub ("cannot access YouTube
links") or an empty file passes into §7 → briefing-from-nothing. Add a validity gate before §7: non-empty,
no refusal/error text, required sections present, ≥1 timestamped anchor, valid coverage line; else stop.

### L2 — Coverage footer is trusted, not verified (HIGH)
`c.md:104-106,158` — Stage 2 has no video, so a false "Covered through 01:30:00 of 01:30:00" (or a missing
footer) passes as complete. Treat the footer as Gemini-reported/unverified unless a transcript/VTT or
source-metadata sidecar is saved alongside; stop on a missing/malformed footer.

### L3 — Stale/missing warehouse rows read as real prices (HIGH)
`c.md:115,137` — `get_price_snapshot`/`get_price_history` may return last-available values (delisted,
halted, holiday, lag). Stage 2 could mark an accurate quote "wrong when said" or report "no move since"
when data is simply missing. Require recording the warehouse observation date per price; if it doesn't
match the requested market date, label missing/stale and don't score it. Say "through <actual warehouse
date>", not "today", when stale.

### L4 — "Not checkable" / tool errors hide verification failure (MEDIUM)
`c.md:127-128,140` — MCP errors, ticker-mapping failures, and unsupported data all collapse into "not
checkable"; and predictions are "not checkable by definition" even when the stated horizon has already
elapsed. Split into `checked / unsupported / pending / verification-failed`; score predictions whose
horizon has passed.

### L5 — Two-stage duality inside one worker prompt (MEDIUM)
`c.md:18-36` — the recipe mixes Stage 1 (watch the video via the Gemini web UI — impossible in the
sandbox) with Stage 2 (read from disk, run §7). Appended whole to a Conductor worker, it hands the worker
instructions it cannot execute. Split the in-Conductor Stage 2 instructions from the external Stage 1
ingestion notes, or clearly gate them.

### L6 — Phantom "optional non-technical block" (MEDIUM)
`c.md:9` — the header lists a sixth edit ("an optional non-technical block") that appears nowhere in the
output architecture. Remove the claim or add the section.

### L7 — Residual general-tech persona in a financial recipe (MEDIUM)
`c.md:45,71` — "technical, academic, or strategic video presentations" and "systems engineers implementing
distributed consensus" are copy-paste from B and conflict with the finance scoping at `c.md:3`. Replace
with finance-appropriate wording.

### L8 — Variant naming inconsistency (LOW)
`core/recipes.mjs:15` — `summarize` uses `youtube-b`/`youtube-c` while `modeling` uses `recipe-a/b/c`. A
caller passing the generic `variant: 'recipe-b'` for summarize silently falls back to the default (C).
Add `recipe-b`/`recipe-c` aliases or standardize.

### L9 — Missing summarize recipe test coverage (LOW)
`test/hygiene.test.mjs` — only `modeling` recipe resolution is asserted. Add `recipeFor('summarize')`,
variant selection, and unknown-variant fallback assertions.

---

## Explicitly FINE (checked, not a problem)
- Code-transcription rule (`c.md:87`) and anti-pattern #2 (`c.md:157`) are consistent; noise-handling
  (`c.md:58-60`) and formatting constraints do **not** invite cleaning up code. No conflict.
- The yt-dlp / `timedtext` PO-token note (`c.md:33-34`) is accurate to current YouTube behavior.
- Coverage line (`c.md:106`) vs anti-pattern #3 (`c.md:158`) are consistent.
- Category filtering *does* protect explicitly-tagged non-summarize workers: a server tagged only
  `summarize` will not reach a `modeling` worker. The gap is untagged tasks (see M1).
- Recipe forbids writing from title/description/general knowledge (`c.md:38-39`) and adds no advice/proxies
  (`c.md:140-142`) — good guards, just not yet enforced as preflight gates.
- `recipes.mjs` config-override plumbing, caching, and `listRecipes()` are correct.

## Panel disagreements / notes
- **Evidence-anchor determinism** (`c.md:64`): Panel 1 rated the "checkable by a script" gap HIGH;
  conductor downgrades to MEDIUM — no validator exists today, so it is a future concern (on-screen values
  lack delimiters, "key claim" is semantic, `[MM:SS]` vs `[HH:MM:SS]` diverge). Fix only if/when a script
  is built to enforce it; then prescribe an exact anchor syntax.
- **Test results:** Panel 2 ran `npm test` → 193/193 pass; `node --test test/hygiene.test.mjs` → 10/10
  pass (output captured). Panel 4 saw one failure, `test/tasks.test.mjs:195` (expected 2 running tasks, got
  3). Conductor attributes that to the four panel workers running concurrently in the same repo (that test
  counts live running tasks); the diff touches nothing in scheduling. Not a regression from this change.
