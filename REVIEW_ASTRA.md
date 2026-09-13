# Astra review: review-fix commits

Contract: review Conductor 2.0 `cdc74a9~1..4f81556` and Conductor-Benchmarks `f7af00f` for regressions in the requested areas; report reproducible findings with locations and verification. Change no code. Assumption: Repo B's requested `trace/` files are under `cookie-cutter/trace/`, as shown by the commit.

## Findings, ranked

1. **P1 — Windows shim arguments can execute shell commands.** `core/proc.mjs:66`, `core/proc.mjs:76`. The new `spawnCli` shell route reuses quoting that only recognizes whitespace/quotes and escapes quotes with a backslash, which does not protect the command from cmd.exe parsing. A real temporary shim named `shim with spaces.cmd`, invoked through the actual exported function with arguments `['literal&echo', 'ASTRA_SPAWN_INJECTION']`, printed the marker as a separate command. A single argument containing `a"&echo ASTRA_QUOTE_INJECTION&rem "` also executed the marker. Vendor prompts reach this path (e.g. `core/providers/vendors.mjs:171`), so ordinary quoted command examples in a task can become host commands. A spaced executable path and a plain spaced argument worked; metacharacter/embedded-quote safety did not.

2. **P1 — worker.shell's allow-list does not enforce its command boundary.** `core/workers/openai-compat.mjs:80`–`81`. With `worker.shell: ['git']`, `git --version & echo ASTRA_ALLOWLIST_BYPASS` executed both commands because only the first token is checked before the complete string is handed to a shell. The basename/prefix alternatives also accepted an absolute path to a temporary `git-unlisted.cmd` and executed its marker despite that executable never being listed. Checking a prefix or stripping directories cannot identify the permitted executable, and checking the first command cannot authorize the rest of a shell expression. Reproduced using the unchanged `makeTools` function extracted into an isolated harness with the real Windows spawn.

3. **P2 — The JSON fallback can corrupt the destination and delete the recoverable replacement.** `core/paths.mjs:31`. After rename fails, direct `writeFileSync(file, ...)` truncates the existing file. Its `finally` deletes the complete temporary copy even if the overwrite subsequently fails. Fault injection against the unchanged function made the implementation's five rename attempts throw EPERM, then simulated ENOSPC after the destination was partially written. The call threw ENOSPC, the old valid JSON became `{\n  "new`, and the directory contained only the corrupt destination: no recovery .tmp. This is a regression from rename-only persistence, which did not truncate the destination. Evidence is an injected I/O failure, not an observed disk failure on this machine.

4. **P2 — Missing costs for an applicable window are treated as zero, allowing an unmeasured batch.** `core/sweep.mjs:173`–`175`, `core/tasks.mjs:174`. If historical rows measure only weekly window `w` and a session window `s` starts being reported, `{w: 3}` is considered measured. The missing `s` cost is charged as zero. With weekly use 91% and fresh session use 0%, `admit` accepted all three `{w: 3}` tasks; the actual scheduler function with stubbed dispatch also started all three. None had a session measurement, so this bypasses the specified one-probe policy and provides no proof that each task fits every applicable window.

5. **P2 — A measured task can run alongside an unknown-cost probe.** `core/tasks.mjs:175`–`182`. `__probe` marks the provider busy, but `providerBusy` is consulted only when the *next* task is unmeasured or fails admission. Queue an unknown model followed by a measured model on the same provider: the probe starts, then a measured task costing `{w: 1, s: 1}` also starts because its admission ignores `__probe`. The scheduler harness reproduced both starts in one pass. An unknown task's real consumption can therefore overlap measured work, contradicting the comment that the probe runs alone.

## Verification and scope

- Ran the requested `git log --oneline -6` and `git diff cdc74a9~1..HEAD -- core/ ui/`; HEAD was `4f81556`. Read the architecture first.
- Repo B was readable. Git required the command-local exception: `git -c safe.directory=F:/Conductor-Benchmarks -C F:/Conductor-Benchmarks show --stat f7af00f`. No Git configuration was changed.
- `npm test` was blocked by PowerShell's execution policy on npm.ps1. `npm.cmd test` succeeded: **132 passed, 0 failed**.
- Additional `node --input-type=module` stdin probes ran via node_repl; they imported `test/_env.mjs` first. Actual admission returned 1 for `{w:3,s:13}`, 0 for weekly overflow `{w:10,s:13}`, 0 for session overflow `{w:3,s:96}`, and 0 when running weekly cost consumed the remaining headroom. The scalar case admitted three 3% tasks into 9% headroom; its existing tests passed.
- Scheduler probes used the unchanged schedule body with in-memory tasks and stubbed dispatch. Unknown-only and over-budget queues started one task and started the next after completion/removal plus rescheduling. No dropped task or livelock was reproduced in those cases. This is not a live-provider concurrency test.
- An isolated default config exercised the new absent-key reads for window targets, effort costs, difficulty effort, recipes and usage gaps without exceptions. API-key and MCP-env masks survived a publicConfig/saveConfig round trip with dummy secrets intact. No absent-key regression was found.

## Repo B result

**No reproducible regression found in the requested gate or trace changes.**

Ran `node F:/Conductor-Benchmarks/cookie-cutter/evaluate.mjs --out <scratch>/gate` against a copy of the real reference and a generated watertight, single-body tapered hollow shell. Exit 0. The reference passed: extents 108 × 85.6 × 16, cut holes 1, mid holes 11, walls 0.90/1.35 mm. The shell (108 × 86.4 × 16, walls 0.75/1.46 mm, mid/cut area 438/228) failed **only** the new hole rule: 1 mid hole versus 1 cut hole. Thus the new gate discriminates the specified cases, and its actual verifier stdout parsed correctly (`verify.py:33`, `evaluate.mjs:90`).

Ran `node F:/Conductor-Benchmarks/cookie-cutter/trace/evaluate-trace.mjs --out <scratch>/trace`. Exit 0. Identical and mirrored reference fixtures both scored Hausdorff 0%, IoU/SSIM 1, with correct orientations. A horizontally doubled fixture scored Hausdorff 19.29%, IoU 0.1281 and SSIM 0.7515, ranking below both; missing line art ranked last. A direct letterbox check preserved a 10 × 20 mask inside a 20 × 20 frame. No off-by-one or stdout parsing failure was reproduced. The documented CAD-proxy limitation remains a limitation, not a new finding.

The pinned Python 3.12 initially lacked access to its user-installed geometry packages under the sandbox account. Verification succeeded by setting child-process PYTHONPATH to the existing Python312 site-packages and MPLCONFIGDIR to scratch; nothing was installed. Scratch: `C:/Users/MDESKT~1.000/AppData/Local/Temp/astra-review-q2HQxp`. Both evaluators wrote only there; Repo B and real Conductor state were untouched.

## Ranked top findings

1. **P1:** spawnCli shell injection through shim arguments.
2. **P1:** worker.shell allow-list bypass through command chaining and executable prefixes/paths.
3. **P2:** writeJson fallback can destroy old data and remove the complete temporary replacement.
4. **P2:** partially measured window costs bypass the one-probe rule.
5. **P2:** measured work can overlap an unknown-cost probe.
