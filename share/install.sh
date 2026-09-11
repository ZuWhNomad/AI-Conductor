#!/usr/bin/env bash
# Conductor 2.0 installer for macOS/Linux: checks Node, installs dependencies, creates a launcher.
set -e
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null; then echo "Node.js 22+ is required: https://nodejs.org"; exit 1; fi
major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 22 ]; then echo "Node.js $major found; Conductor needs 22+"; exit 1; fi
npm install --no-fund --no-audit
cat > "$HOME/Desktop/conductor.sh" <<EOF
#!/usr/bin/env bash
cd "$(pwd)" && node bin/conductor.mjs start
EOF
chmod +x "$HOME/Desktop/conductor.sh"
echo
echo "Installed. Launcher: ~/Desktop/conductor.sh"
echo "One-time logins:"
echo "  claude auth login                      (Claude subscription; npm i -g @anthropic-ai/claude-code if missing)"
echo "  npm i -g @openai/codex && codex login  (ChatGPT subscription, for GPT-6 Astra)"
echo "  Optional: Ollama from https://ollama.com for free local models"
echo "Then: node bin/conductor.mjs doctor"
