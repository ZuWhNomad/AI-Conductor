# Financial video briefing — the prompt to paste into Gemini

This is the **operator** half of the two-stage pipeline: the text a human pastes into Gemini, which
watches the video and writes the briefing. The **worker** half — what a Conductor session then does
with that briefing — is `core/policy/recipes/video-briefing-finance.md`.

Kept out of the recipes directory on purpose: a worker never uses a word of this, and a recipe that
carries it blows the per-task recipe budget.

## How to run it

1. Fresh chat at `gemini.google.com/app`. Never re-prompt a chat that produced a bad answer — the
   model defends its first attempt. Start a new one.
2. Select **3.8 Flash + Extended thinking**. The picker resets to plain Flash on every new chat, so
   re-select it each time. Plain Flash silently drops the quantitative dossier (section 3); Extended
   keeps it.
3. Send the **bare video URL first**, alone, and let it ingest. Extended refuses the video if the
   link arrives alongside the directives ("cannot access or watch YouTube links directly").
4. Then send the prompt below as the second message.
5. Ingestion is flaky and video-dependent. A refusal or a stall in "Connecting to YouTube" is often
   cleared by retrying in a fresh chat — but some videos stall on every mode and every attempt.
   Retry a few times, then give up on that video rather than grinding.
6. Save the answer to the vault's `YouTube summaries` folder, with front matter including
   `stream_date:` taken from the video's publish date (see the recipe — section 7 depends on it).

Extraction note: Gemini's page blocks `fetch` to localhost, blocks popups, and refuses blob-URL
navigation. Converting the response DOM to Markdown in the page, copying to the clipboard, and
reading the clipboard back out is what works. Plain text extraction flattens every table.

---

## The prompt

Analyze technical, academic, or strategic video presentations and produce an exhaustive, high-density
briefing that removes the need for an expert, investor, or researcher to watch the footage.

### Processing directives

1. **Multimodal fusion**
   - Cross-reference audio against on-screen artifacts (slides, code terminals, IDEs, system diagrams, hardware setups, benchmark charts).
   - Flag visual asymmetry: prioritize data points, parameters, or diagram nodes shown visually that the speaker skips or only briefly mentions.

2. **Semantic boundary chunking**
   - Do not summarize in rigid time intervals. Anchor sections to topic transitions, technical shifts, or conceptual pivots.
   - Increase granularity for rapid-fire technical segments; compress conversational tangents ruthlessly.

3. **Noise handling**
   - Strip subscribe calls-to-action, clickbait hook framing, and ambient filler.
   - **Exception:** record sponsorship, paid promotion, or any disclosed affiliation in a single line under the Executive Brief (`Sponsorship/affiliation: …`, or `None disclosed`). It bears on how the claims should be read.

4. **Fact and claim separation**
   - Clearly delineate established facts and empirical test results from creator assertions, projections, or opinions.
   - **Attach evidence to every key claim:** a short verbatim quote (≤ 15 words, in quotation marks) or the exact on-screen value, with its `[MM:SS]`. A claim with no quotable anchor is marked `[no direct quote]`.

### Output architecture

#### 1. Executive brief

- **Core thesis:** the foundational technical argument or objective (max 2 sentences).
- **Primary beneficiary:** exact profile of who needs this (e.g. "systems engineers implementing distributed consensus", not "tech enthusiasts").
- **Key sentiment & paradigm:** tone (instructional, critical, promotional, defensive) and whether the content presents a novel framework, refines existing tools, or recycles common knowledge.
- **Sponsorship/affiliation:** one line.

#### 2. Chronological deep-dive

| Timestamp | Topic / pivot | Technical essence & key insights | Visual artifacts & on-screen data |
|---|---|---|---|
| `[MM:SS]` | Primary topic | Core mechanism, logic, or argument | Charts, UI elements, code files, slides |

Include actionable detail: tool names, library versions, specific architectural tradeoffs, and non-obvious "aha!" mechanisms.

#### 3. Quantitative dossier — REQUIRED, never skip

- **Every hard number with context:** price levels, percentages, moving averages, ratios, yields, spreads, dates, position sizes, allocation percentages.
- **Every rule, screen or formula stated**, written out as a formula or a step list — this is the section a weaker model silently drops, and it is the reason to run the stronger one.
- **Code & architecture:** **transcribe code exactly as it appears on screen**, including typos, truncation, and line breaks. Do not correct, complete, or reformat it. Mark anything you cannot read as `[unreadable]` inline. Diagrams may be redrawn as ASCII/Mermaid; code may not.
- **Formulas & methodologies:** mathematical equations, heuristic formulas, step-by-step implementations.

#### 4. Editorial layer — in ADDITION to section 3, not instead of it

Market commentary is argument as well as data, so both sections apply:

- **Thesis:** the claim being argued.
- **Evidence:** what is offered in support, and its type (data, backtest, anecdote, authority, demonstration, none).
- **Predictions:** any forecast, with its stated timeframe and the `[MM:SS]` where it is made.

#### 5. Critical assessment & gap analysis

- **Execution & rigor:** what was delivered with exceptional clarity or empirical rigor?
- **Omissions & blind spots:** which edge cases, failure modes, cost implications, or counter-arguments were bypassed?
- **Bottom-line value:** a 2-sentence verdict on whether the methodology or information is production-ready, experimentally promising, or superficial.

#### 6. Coverage

End the briefing with a single line: `Covered through [HH:MM:SS] of [HH:MM:SS].` If coverage is partial, say so plainly rather than ending silently.

### Formatting & behavioral constraints

- No superficial overviews or generic bullet points.
- **Bold** critical architectural terms, commands, and primary metrics.
- Format all timestamps as `[MM:SS]`, or `[HH:MM:SS]` for long-form content.
- If code or charts are unreadable, say so explicitly. Never guess.
- Output plain Markdown. Do not emit citation markers, footnote tags, or source badges of any kind (for example `[cite: 2]`); they make the file unusable downstream.

---

