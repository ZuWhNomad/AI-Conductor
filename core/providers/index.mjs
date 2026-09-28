// Provider registry. A provider = { id, label, kind, auth, detect(), listModels(), pollLimits() }.
// kind decides which worker runs a model: claude | codex | openai-compat | vendor-cli.
import * as anthropic from './anthropic.mjs';
import * as codex from './codex.mjs';
import { CATALOG, make } from './openai-compat.mjs';
import { VENDORS, providerFor } from './vendors.mjs';

export const PROVIDERS = {
  claude: anthropic,
  codex: { ...codex, kind: 'codex' },
  ...Object.fromEntries(Object.values(VENDORS).map((v) => [v.id, providerFor(v)])),
  ...Object.fromEntries(Object.keys(CATALOG).map((id) => [id, make(id)])),
};

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider "${id}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

export const PROVIDER_URLS = { claude: 'https://claude.ai', codex: 'https://chatgpt.com/codex', antigravity: 'https://antigravity.google', grok: 'https://grok.com' };
export function providerSummaries() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, kind: p.kind, auth: p.auth, url: p.url || PROVIDER_URLS[p.id] || null, canInstall: !!p.installCommand?.(), canLogin: !!p.loginCommand, canRelogin: !!p.loginCommand }));
}
