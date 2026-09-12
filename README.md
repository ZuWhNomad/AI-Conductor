# Conductor 2.0

# TL;DR - Who actually reads the full summary anymore
Claude ultracode;
- but with many more models to slave drive
- Output ranked model+effort selection
- Use the best worker, at the most economical rate, to complete the task (optimization

Same but more words:
A Claude Code clone with upgrades: the Claude model you pick is the **conductor** (plans, delegates,
reviews), and the grunt coding goes to cheaper workers — **GPT-6 Astra through the Codex CLI on
your ChatGPT subscription**, free local **Ollama** models, or any OpenAI-compatible API (DeepSeek,
Kimi, Grok, Qwen, Gemini). Browser UI with a **speech-to-text** button. Live model and limit
polling, task journaling with auto-resume at limits, an improvement log that the workbench can
review and fix itself, and a one-script installer to share with friends.

## Quickstart

1. **Windows: double-click `Conductor.exe`.** It finds Node, installs dependencies on first run, starts
the app in the background, opens your browser, and shows a small window with a Stop button.

2. The **Providers & limits** panel does this for you: a provider that is missing shows **Install**,
one that is installed but signed out shows **Sign in**; both open a real terminal window (browser
logins need one), then press **↻ Refresh**. Subscription CLIs are workers (delegate targets);
their models appear in the worker picker.

Use **Chrome or Edge** for the microphone button (Web Speech API). The page is served from
`127.0.0.1` only.

## Using it

1. Pick a **project folder** and the conductor as **provider : model : effort** (e.g.
   `claude:claude-fable-5-1[1m]:high`, the shipped default; "Claude Code default" means whatever the
   CLI picks, currently Opus 5). The model list shows every model from every provider; narrow it
   with the provider dropdown. Your last choice becomes the default. Model switches live; effort
   applies from the next message. **Any agent model can conduct**: Claude models run in the Claude
   Code harness (built-in tools, subagents, skills); Codex models run through `codex exec` with the
   workbench tools attached as an MCP server; Ollama/API models run through the tool loop
   (read/write/edit/search/run + the workbench tools). Image providers are workers only.
2. Say what you want. The conductor writes specs, delegates to workers, verifies their diffs, sends
   review comments back to the same worker thread, and reports.
3. Watch worker tasks in the strip above the composer (click a card for spec, actions, diff stat,
   worker report). Approve or deny permission prompts inline when not in auto-approve mode.
4. 🎤 or **Ctrl+M** dictates into the composer; edit, then Enter to send.

Shortcuts in the composer:

- `/worker <spec>` — send a task straight to the default worker (zero conductor tokens).
- `/astra <spec>`, `/ollama <model> <spec>`, `/claude <model> <spec>` — pick the worker explicitly.

CLI: `conductor models --refresh`, `conductor limits --refresh`, `conductor scores`, `conductor smoke --models codex:gpt-5.6-luna:low` (seeds the scorecard; spends budget), `conductor review`, `conductor share`.

## How the conductor delegates

The policy lives in `core/prompts/conductor.md` (edit it to change behaviour). In short: the
conductor keeps intent, decomposition, specs, review and verification for itself; everything that
is mostly typing goes to a worker with a self-contained spec and a verification command. Fix
rounds go back to the same worker thread (max 3), risky tasks get two independent attempts,
Claude subagents (haiku swarm / sonnet worker / adversarial reviewer) are available through the
built-in Agent tool, and limits are checked before big batches.

## Models and limits (never assumed static)

The sidebar polls every provider every 15 minutes (configurable) and on **↻ Refresh**:

- Claude: the SDK's aliases (`opus`, `sonnet`, `haiku`, `claude-fable-5-1[1m]`…) merged with the
  live Models API list (Opus 4.8/4.7/4.6, Sonnet 4.6, …) read with your Claude login; 5-hour /
  weekly windows from the SDK's control channel plus live rate-limit events during sessions.
  Any picker also has **Other…** for a model id that is not listed yet.
- Codex: `codex app-server` (`account/rateLimits/read`, `model/list`) — plan, windows, resets.
- Ollama: `/api/tags`; API-key providers: `/models`, with 429/`retry-after` learned on the fly.

A worker that hits a limit is **parked** and resumed automatically on the same thread when the
window resets; the conductor session itself resumes by session id after a restart.

## Context management

Root `CLAUDE.md` (Claude) / `AGENTS.md` (Codex) are read natively. Per-folder `CONTEXT.md` notes
are injected into worker specs for the paths in scope, so large projects stay modular. The
conductor is instructed to create or update `CONTEXT.md` when it adds modules.

## Self-improvement

Errors from workers, sessions and the server land in `~/.conductor2/improvements.ndjson`; the
conductor and you can add ideas (`log_improvement` tool, sidebar **Open log**). **Run review**
opens a conductor session on this repository with the log as input; it delegates fixes, runs
`npm test`, and marks entries resolved. Or run `conductor review` headless.

## Updating (and working from several machines)

The folder is a git checkout of the GitHub repo. `conductor update` (or the **⬇ Update** button that
appears in the header when GitHub is ahead, or Settings ⚙ → *Check for updates*) fast-forwards to the
latest commit and runs `npm install` when dependencies changed; restart Conductor afterwards. It refuses
while you have uncommitted or unpushed local changes, so commit and push from GitHub Desktop first.
Your state — settings, keys, scorecard, task journal — lives in `~/.conductor2` on each machine and is
never part of the repo.

## Feedback

`conductor feedback` writes `Conductor-feedback-<date>.json` to your Desktop — versions, which providers
are set up, limit windows, the improvement log (errors the workbench caught, ideas you logged) and the
scorecard — with your home path, user name, e-mail addresses and anything key-shaped redacted. It then
opens the project's issue page so you can attach the file. Nothing is sent automatically.

## Sharing with friends

```bash
git clone https://github.com/ZuWhNomad/AI-Conductor.git
```

Then run `share/install.cmd` (Windows) or `share/install.sh`, and log in to your own accounts
(nothing in the repo carries anyone's keys or logins: they live in `~/.conductor2/config.json` and
the vendor CLIs' own login state). `conductor share` still zips the folder (without `node_modules`)
to your Desktop for offline hand-offs.

## Configuration

Settings ⚙ has the same provider : model : effort pickers for the **default worker** (the grunt
coder every `delegate` uses unless the conductor names another provider/model) and the
**conductor default**. The conductor can still send lesser tasks anywhere: a haiku swarm for
reading, a free Ollama model for boilerplate, Astra for real coding — per task.

`~/.conductor2/config.json` (see `core/config.mjs` for every default): port, poll interval,
conductor defaults, default worker (`codex` / `gpt-6-astra` / `medium`), Codex sandbox
(`workspace-write`, network on), worker concurrency, timeouts, review rounds, provider URLs
and API keys (also read from `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `XAI_API_KEY`,
`DASHSCOPE_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `STABILITY_API_KEY`).

## Troubleshooting

- *Failed to authenticate: OAuth session expired* → `claude auth login`.
- *'gpt-6-astra' requires a newer version of Codex* → `npm i -g @openai/codex@latest`.
- Microphone button disabled → use Chrome/Edge; allow mic access for `127.0.0.1`.
- Ollama models missing → `ollama serve` (auto-started when installed) and `ollama pull <model>`.
- Codex models missing right after `npm i -g @openai/codex` → the app now also looks in npm's
  global folder, but a freshly installed CLI may need a new terminal/Explorer session for PATH.
  Settings ⚙ → **Run doctor** shows what the running app can see.

See `docs/ARCHITECTURE.md` for the design, and `CLAUDE.md` before changing code.




## Quickstart, if you're sadistic and would prefer to use a terminal.

1. Run the exe, same as above (`Conductor.cmd` does the same in a console; rebuild the exe with `scripts\build-launcher.cmd`.)
2. From a terminal (any OS):

```bash
npm install
node bin/conductor.mjs doctor        # Node, Claude login, Codex login, Ollama
node bin/conductor.mjs               # starts http://127.0.0.1:47474 and opens your browser
```

3. One-time logins (in a terminal, not in the app):

| Need | Command |
|---|---|
| Claude subscription (the conductor) | `claude auth login` (`npm i -g @anthropic-ai/claude-code` if `claude` is missing) |
| ChatGPT subscription (Astra worker) | `npm i -g @openai/codex` then `codex login` |
| Google AI Pro/Ultra (Gemini 3.x via Antigravity CLI) | `irm https://antigravity.google/cli/install.ps1 \| iex`, then run `agy` once and sign in |
| SuperGrok / X Premium+ (Grok CLI) | `irm https://x.ai/cli/install.ps1 \| iex`, then `grok login` |
| Qwen (free OAuth tier, Qwen Code) | `npm i -g @qwen-code/qwen-code`, then run `qwen` and pick Qwen OAuth |
| Kimi account (Kimi CLI) | `pip install --user kimi-cli`, then `kimi login` |
| Local models (free) | install [Ollama](https://ollama.com), then `ollama pull qwen3.8` |
| API-key providers (optional) | paste keys in **Settings ⚙** |

4. 
