// apiKeyHelper for the claude-api provider: Claude Code runs this and reads the key from stdout. It is read from
// config.json now, so the key never sits in argv or the CLI's environment. No key: nothing printed, exit 1.
import { loadConfig } from '../config.mjs';

const key = loadConfig().providers['claude-api']?.apiKey;
if (!key) process.exit(1);
process.stdout.write(key);
