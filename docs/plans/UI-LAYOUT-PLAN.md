# UI layout — research + plan

> Research + plan only. No app code changed, nothing committed. Grounded in a live read of
> `ui/index.html`, `ui/styles.css`, `ui/app.js`.
> Wireframes: [`ui/current.svg`](./ui/current.svg) (annotated pain points) and
> [`ui/proposed.svg`](./ui/proposed.svg) (annotated changes). They use the real `styles.css` palette;
> the orchestrator will attach live screenshots of the running app separately.

## The current UI (what the DOM/CSS actually is)

A CSS grid `320px 1fr`, full viewport, `overflow:hidden` (`body` in `styles.css`).

- **Sidebar** (`#sidebar`, flex column; **only `Chats` scrolls**, everything else is pinned):
  brand + ⚙ · **Project folder** (cwd input + browse) + **Conductor picker** (provider/model/effort
  selects) + selection text + auto-approve + API-overflow + **+ New chat** · **Providers & limits**
  (header with auto + ↻ Refresh; `#providers` list, `max-height:42vh`) · **Chats** (`.grow`, scrolls)
  · **Self-improvement** (count pill + Open log / Run review).
- **Main** (`#main`, grid rows `auto 1fr auto auto`): **header** (title+cwd, then provider/model/effort
  selects, auto-approve, API-overflow, update, status pill, Stop) · **transcript** (scrolls) ·
  **tasks** strip (`.tasks`, horizontal scroll, cards 260–360px) · **composer** (textarea + mic +
  Send). Settings/dirs/improvements live in a `#modal`.

## Pain points (see `current.svg` ①–⑦)

1. **Duplicated model pickers.** Sidebar "Conductor" 3-select cluster (for New chat) and the header
   3-select cluster (for the live chat) look identical but differ in scope — and the header one can
   only switch *model within the same provider* (`app.js #model.onchange`), which isn't visible.
2. **Duplicated toggles.** auto-approve + API overflow appear in *both* the new-chat row and the
   header — easy to mistake which instance applies.
3. **New-chat controls occupy prime space permanently**, pushing the Chats list (the actual
   navigation) down, even though new-chat is a momentary action.
4. **Providers & limits can eat up to 42vh** of a fixed-height sidebar, competing with Chats.
5. **Tasks are a thin strip.** For an *orchestration* workbench the delegated fleet is the core
   object, yet it's one horizontal line of small cards below the transcript, each showing only a
   "last action" line — easy to miss, can't convey queue/budget/rounds at a glance.
6. **No global budget headline.** Limits exist only as per-provider meters buried in the sidebar;
   there's nothing near where you actually spend (composer/header) telling you how much Claude/Codex
   window is left — despite budget-aware routing being the product's whole thesis.
7. **Crowded header.** title+cwd + 3 selects + 2 checkboxes + update + status + Stop on one row;
   selects are capped at 200px and truncate on narrow widths.

Secondary: effort/model/provider semantics are surfaced only via `title` tooltips and a transient
`#stt-hint`; `<900px` hides the sidebar entirely (no nav); `/worker` slash routing is hidden
knowledge; admin (Providers, Self-improvement, Settings) is interleaved with the primary loop.

## UX best practices for an agent-orchestration workbench

- **Make the fleet first-class.** The thing you supervise is a set of parallel workers — surface
  running/queued/done, which model, %window burned, cost, rounds, at a glance; one click to the
  worker log + diff + rate.
- **Put budget where decisions happen.** A compact global budget headline (the classes you spend:
  Claude session, Codex weekly) near the top, full per-provider detail one click away.
- **One unambiguous context switcher.** Project + model chosen in one place, with explicit scope
  ("new chat" vs "this chat"); never two identical-looking controls that do different things.
- **Progressive disclosure.** Keep the primary loop (Chats ↔ transcript ↔ fleet ↔ composer)
  prominent; fold admin (providers, self-improvement, benchmarks, settings) into a drawer.
- **Single source of truth per setting**, with a visible scope label; no duplicated toggles.
- **Transcript stays the hero**; give tasks a dockable/expandable region, not a permanent thin strip.
- **Discoverable commands** (`/` menu) and clear affordances for new modes (plan mode).

## Proposed reorganization (see `proposed.svg`)

Keep the two-pane grid but **nav-first sidebar / fleet-dock main**. Concretely:

- **Ⓐ One model chip.** Replace both 3-select clusters with a single header chip
  `claude · opus-4.8 · high ▾` that opens a popover holding the provider/model/effort pickers, the
  auto-approve / API-overflow / plan toggles, and a one-line scope note ("model switches live; effort
  applies next message; provider is fixed for an existing chat"). Removes pains ①②⑦.
- **Ⓑ Global budget headline.** A compact always-visible sidebar strip: Claude *session* % and Codex
  *weekly* % as bars, plus a one-line "grok ~est · gemini · +N" and a **details ▸** that expands the
  full current Providers & limits. Removes pain ⑥; shrinks ④.
- **Ⓒ New-chat collapses to one button.** `+ New chat` opens a small inline form / modal with project
  folder + conductor picker + toggles, so it stops occupying prime space; **Chats** gets the freed
  vertical room and becomes the primary nav (with a filter). Removes pain ③.
- **Ⓓ SYSTEM drawer.** Providers & limits, Self-improvement, Benchmarks & scores, Settings fold into a
  collapsible bottom "SYSTEM" section (or the existing `#modal`), out of the primary flow. Removes ④.
- **Ⓔ Fleet dock replaces the tasks strip.** A collapsible right-hand dock (~300px) with a header
  (`2 running · 1 queued · 3 done`), a **budget-today** line (%window + $), and richer cards (worker,
  category@level, %window, rounds, status, live last-action + progress); click → worker log, diff,
  rate. On narrow screens it collapses back to the current bottom strip. Removes pain ⑤.
- **Ⓕ Composer affordances.** A **Plan-mode** toggle and a discoverable `/` command menu (surfacing
  `/worker`, `/astra`, `/ollama …`) alongside mic + Send.
- **Ⓖ Auto-planner plan-card.** The transcript renders an interpret→confirm card
  ("Here's what I understand … + one question + a 3-step plan" with Confirm / Edit / No) before the
  conductor acts — the UI side of `AUTO-PLANNER-RESEARCH.md`.

Result: primary loop = Chats (sidebar) → transcript + plan-cards → Fleet dock → composer; budget is
always visible; admin is one drawer; every control has a single home and a clear scope.

## Phased change list (what changes, which files)

No build step; vanilla `ui/` (HTML/CSS/`app.js`) + a couple of server routes only where noted.
Each phase is independently shippable.

**Phase 1 — de-duplicate + budget headline (highest value, low risk).**
- `ui/index.html`: collapse the header's 3 selects + 2 checkboxes into one **model chip + popover**;
  remove the sidebar "Conductor" picker from the always-on New-chat block. Add the sidebar **budget**
  strip.
- `ui/styles.css`: chip + popover styles; `.budget` mini-meters (reuse `.meter`); trim
  `#chat-header .controls`.
- `ui/app.js`: render the chip from session state; move the existing picker/checkbox handlers
  (`#model`/`#effort`/`#bypass`/`#overflow` onchange) into the popover; keep the scope rules
  (`setModel` live, `setEffort` next-message, provider fixed).
- Server: none.

**Phase 2 — Fleet dock.**
- `ui/index.html`: move `#tasks` into a right-hand `#fleet` dock with a header + budget-today line.
- `ui/styles.css`: make `#main` a `1fr auto` **column** grid (chat column + dock) on wide screens;
  media-query fallback to today's bottom strip `<1100px`; richer `.task` cards.
- `ui/app.js`: richer card render (worker, `category@difficulty`, %window, rounds, status) from the
  task/`score` bus events already received; counts + today's %window/$ aggregation; keep the existing
  click→detail modal.
- Server/core: none required (data already flows via `/api/tasks` + `score`/`worker` SSE); optionally
  add a per-task `%window` field if not already present.

**Phase 3 — New-chat collapse + SYSTEM drawer.**
- `ui/index.html`: New-chat block → single button opening a small form/modal; wrap Providers &
  Self-improvement (and add Benchmarks & Scores, Settings) in a collapsible SYSTEM section.
- `ui/styles.css`: collapsible section; give `#sessions` the reclaimed height.
- `ui/app.js`: New-chat form submit reuses the current `POST /api/sessions` path; collapse state in
  `localStorage`.

**Phase 4 — Composer plan-mode + `/` menu + auto-planner card** (pairs with `AUTO-PLANNER-RESEARCH.md`).
- `ui/index.html` + `ui/styles.css`: Plan toggle, `/` command menu, `.plan` card styling (reuse
  `.perm`).
- `ui/app.js`: Plan toggle → `POST /api/sessions/:id/mode` (`'plan'`); render `plan` bus events as an
  approve/edit/reject card.
- Core/server (only if the structured plan tool is chosen): `core/tools.mjs` `propose_plan` +
  `POST /api/sessions/:id/plan` (see the auto-planner doc — optional).

**Phase 5 — responsive nav.**
- `ui/styles.css`: replace the `<900px` "hide sidebar" with a collapsible drawer so mobile keeps
  navigation.

## Open questions
- Fleet as a **right dock** (proposed) or a **taller bottom panel**? (Dock reads better on wide
  monitors; bottom is a smaller change.)
- New-chat as an **inline form** in the sidebar or the **`#modal`**?
- Move Providers/Self-improvement into a sidebar **SYSTEM drawer** or fully into **Settings**?
- Is a per-task **%window** value already on the task payload, or does Phase 2 need it added in
  `core/tasks.mjs`?

*Nothing here was committed or implemented.*
