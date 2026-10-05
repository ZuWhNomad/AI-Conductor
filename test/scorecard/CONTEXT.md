# test/scorecard/ — tests for core/scorecard/

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first in
every test file. Shared fixtures are `_helpers.mjs` (it imports `../_env.mjs` first). Tests still import the facade
`../../core/scorecard.mjs` through that helper. A test that touches several layers lives in the highest one it uses:
report, then recommend, then summary, then ledger.

| file | covers |
|---|---|
| `ledger.test.mjs` | Ledger rows, identity, env-failure and usage helpers, migration, eligibility, plus priors/config/bench checks that call no higher layer. |
| `summary.test.mjs` | `rootRuns` folding, `summarize` aggregates, error rates, and summary memoization. |
| `recommend.test.mjs` | `recommend()`, provider cost and availability, effort, waste discount, ladders, and escalation. |
| `report.test.mjs` | `formatScores`, `formatScoresShort`, `scoresCsv`, `benchedCells`, and `shortMemoKey`. |
| `_helpers.mjs` | Registry and limits seed, and the shared `run` / `seed` ledger fixtures. |

**How to test.** `node --import ./test/_env.mjs --test test/scorecard/`
