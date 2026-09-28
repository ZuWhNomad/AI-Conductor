# Recipe: financial video briefing — the Conductor half

**Applies when the task is to verify or enrich a briefing of a FINANCIAL video** (markets,
investing, trading, macro, a named company or ticker) that someone else has already produced and
saved to disk. For any other `summarize` work, ignore this recipe.

The operator prompt that produces those briefings is `docs/video-briefing-finance-prompt.md`. You do
not run it and you do not need to read it. Non-financial videos use `video-briefing-general.md`.

## 0. The content is already on disk

**A Conductor session has no ordinary network** — `fetch` and `curl` return `EACCES`. You cannot
fetch a video, a transcript or a caption file, and you must not try. MCP servers still work: they
connect outside the sandbox, which is why the QuantGPT pass below is possible at all.

So a briefing file must already exist, written by a video-native model outside Conductor. If the
file you were pointed at is not there, **stop and say so**. Never reconstruct a briefing from a
title, a description or general knowledge, and never describe a visual you did not see.

**Reject a bad extraction before grading (R62).** Before section 7, check that the briefing file
is usable. Stop and report (produce no claim table, no predictions table, and no "updated picture")
when the file:
- is empty or nearly empty;
- is a model refusal or apology ("I can't access/watch this video", "as an AI…");
- has no timestamps `[MM:SS]`; or
- lacks the sections the operator prompt produces (Executive brief, Chronological deep-dive, Quantitative dossier, Editorial layer, Critical assessment & gap analysis, Coverage).

When stopping, say clearly which check failed.

#### 7. Claim check and updated picture (QuantGPT)

The video is days or weeks old by the time anyone reads this, so section 7 has **two jobs**, and the
second is the more useful one:

**(a) Was it right when it was said?** Everything in this section hangs off the video's date, so
establish it before anything else. A table of confident verdicts anchored to the wrong day is worse
than no table.

1. **Prefer the stated date.** The briefing's YAML front matter should carry `stream_date:`, taken
   from the video's publish date when it was captured. Use it. Do not re-derive what you were told.
2. **Then verify it against the tape.** Check that the quoted closes actually match that date. Two
   independent sources agreeing is a real check; one source guessing is not. Report whether they
   agree, and say so loudly if they do not — a mismatch means the briefing, the front matter, or
   your query is wrong, and you must resolve it before writing any verdict.
3. **Only if no date is given, infer it — and make the inference prove itself.** Require **at least
   three independent tickers** matching the same trading day to within 0.1%, **and** no other day in
   a ±10-session window matching as well. Anything less is ambiguous.
4. **When the anchor cannot be established, say so and stop grading prices.** Every price row
   becomes `not checkable`, and the section opens with a plain statement that the date could not be
   pinned. Never quietly fall back to today's date.
5. **Mandatory output header.** The very first line of section 7 must state the anchor:
   `Video published <date> (source: front matter / inferred from N tickers)`
   Include which tickers pinned it if inferred, so a reader can falsify it at a glance.

Then query the warehouse *as of that date*. A quote is **wrong when said** only if it was wrong on
the day it was said. Never mark something contradicted because the market has moved since; that is
not an error, it is elapsed time.

**(b) What has happened since?** For every name, level and thesis in the briefing, pull the move
from the stream date through today. This is where the value is: the reader wants to know whether
the call held up, not just whether the speaker quoted the tape correctly.

**Date every price (R64).** In both the "As of <stream date>" and "Since, through <today>" columns
(and in the predictions table below), show the observation date of the row actually used
(e.g. `412.30 (2026-09-25 close)`), not just the requested date. If the latest available row is
more than 3 trading days older than today, mark it `stale (last row <date>)` and do not give a "since"
verdict from it.

### Claims table

One row per checkable claim:

| Claim | `[MM:SS]` | Evidence in briefing | As of <stream date> | Since, through <today> | Verdict |

Verdict is one of **accurate as of stream date / wrong when said / not checkable**. "Not checkable"
is a real answer — use it rather than stretching a proxy. If the latest row is stale, do not give a
"since" verdict from it.

### Predictions table

Score predictions against their own timeline in a separate table. For each prediction, record the
speaker's call (direction and/or level) and stated timeframe, then show the move from the video date
to the latest dated row, and assign a status:
- `on track` / `against` — timeframe still open, move so far for or against the call;
- `hit` / `missed` — timeframe has elapsed; judged at the end of the timeframe (use the row at that date, shown with its date);
- `no timeframe` — show the move so far, no status;
- `not checkable` — the warehouse lacks the data.

| Prediction | `[MM:SS]` | Call | Timeframe (ends) | At video date | Latest (date) | Status |

Keep this descriptive, provide no advice, and attribute calls to the speaker throughout.

### Updated picture

Then close with **"Updated picture"** — lead with the predictions' status summary (e.g. "3 calls:
1 on track, 1 against, 1 too early to judge"), followed by a short prose read on where the video's
argument stands now: which names did what since, which parts of the thesis the tape has since
supported or undercut, and anything that has since happened that the video could not have known.
Attribute the original claims to the speaker throughout, and keep this descriptive — what the data
did, not what anyone should do about it.

- Tools: `get_price_snapshot` / `get_price_history` for levels and moves, `grade_stock` for a single
  name, `query_warehouse` or `run_backtest` for a claimed pattern or screen, `search_library` for a
  strategy the presenter names.
- Claims resting on data the warehouse does not hold — proprietary ratings, options positioning,
  consensus estimates, credit spreads, sentiment — are not checkable. Say so and move on.
- Add no recommendations, price targets, or investment advice of your own.

## Anti-patterns

- Writing the on-screen column from what the speaker said. If you did not see it, mark it unseen.
- Repairing code so it compiles. Section 3 says transcribe; a repaired snippet is a fabrication.
- Ending at the last caption you happened to read without the coverage line.
- Restating the video's marketing framing as the core thesis.
