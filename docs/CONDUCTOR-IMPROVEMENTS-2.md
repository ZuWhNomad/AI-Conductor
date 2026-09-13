# Conductor 2.0 — improvements, iteration 2 (NEXT batch, NOT the current pass)

**Status:** capture-only, for the *next* conductor-edits iteration. The current in-flight pass is
`docs/CONDUCTOR-IMPROVEMENTS.md`. New conductor UI/logic comments from the user land **here** until
we start iteration 2.

---

## 1. Providers panel: consistent, dynamic usage-bar ordering

**Goal:** in the "Providers & Limits" block, order each provider's usage bars the same way so a user
can scan them at a glance — **session limit at the top, weekly limit at the bottom**:

1. **Top — 5-hour / session limit** (the current rolling session window)
2. **Middle — model-specific limits** (per-model or per-model-group windows)
3. **Bottom — weekly limit** (the long-horizon window)

**Must be fully dynamic — render only the buckets a provider actually reports, in this fixed order:**
- **Codex (Pro):** session (5-hour) bar on top, general **weekly** bar on the bottom.
- **Codex (Plus):** shows both the **5-hour** and the **weekly** bar (plan-dependent — don't
  hardcode which windows exist; derive from what the provider reports).
- **Grok:** only a weekly limit exists → show **only** the weekly bar (no empty session/model slots).
- Any future provider, however it exposes limits, slots into the same top→bottom order automatically.

**Implementation notes**
- Drive ordering from **data, not label string-guessing.** Tag each usage window with a
  `scope`/`cadence` at the source — `session` (≈5h) | `model` | `weekly` | `other` — in
  `core/limits.mjs` (and each provider's `limits()` in `core/providers/*` / `vendors.mjs`), and
  where estimates are synthesized in `server/index.mjs` `limitsWithEstimates()`. Each window already
  carries `{ id, label, usedPercent, resetsAt, estimated, note }`; add the `scope` tag.
- In the UI (`ui/` provider-render code + `ui/styles.css`, `#providers` block), sort each provider's
  windows by a fixed `scope` order (session → model → weekly → other) and render only present ones.
  Missing buckets collapse (no blank rows), so a weekly-only provider shows a single bar.
- Keep it resilient: an unknown/untagged window falls to `other` (rendered last) rather than being
  dropped, so a new provider's limits still appear even before we tag them.

_(append further iteration-2 conductor comments below)_
