#!/usr/bin/env bash
# Conductor 2.0 installer for macOS/Linux: checks Node, installs dependencies, creates a launcher.
set -e
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null; then echo "Node.js 22.18+ is required: https://nodejs.org"; exit 1; fi
# Conductor ships some modules as .ts and relies on Node stripping the types at load (on by default since 22.18).
if ! node -e "process.exit(process.features.typescript ? 0 : 1)"; then echo "Node.js $(node -p process.versions.node) found; Conductor needs 22.18+"; exit 1; fi
npm install --no-fund --no-audit
printf '#!/usr/bin/env bash\ncd -- %q && node bin/conductor.mjs start\n' "$PWD" > "$HOME/Desktop/conductor.sh"
chmod +x "$HOME/Desktop/conductor.sh"
echo
echo "Installed. Launcher: ~/Desktop/conductor.sh"
echo "One-time logins:"
echo "  claude auth login                      (Claude subscription; npm i -g @anthropic-ai/claude-code if missing)"
echo "  npm i -g @openai/codex && codex login  (ChatGPT subscription, for GPT-6 Astra)"
echo "  Optional: Ollama from https://ollama.com for free local models (off by default: set providers.ollama.enabled = true)"
echo "  Optional: a /conductor skill for Claude Code: see docs/DRIVE-CONDUCTOR.md, \"Optional: a /conductor skill\""
echo "Then: node bin/conductor.mjs doctor"
