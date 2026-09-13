// Feedback bundle for the maintainer: what went wrong here, with nothing personal in it.
// Redacts the home directory, user name, e-mail addresses and anything that looks like an API key or token.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo, platform, release, arch } from 'node:os';
import { REPO_ROOT } from './paths.mjs';
import { listImprovements } from './improve.mjs';
import { getLimits } from './limits.mjs';
import { getModels } from './models.mjs';
import { formatScores } from './scorecard.mjs';
import { loadConfig } from './config.mjs';

const pkg = () => JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
export const issuesUrl = () => pkg().bugs?.url || null;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function safeUser() { try { return userInfo().username; } catch { return null; } }

/** Strip identifying strings from any text. Exported so the bundle can be tested. */
export function redact(text, { home = homedir(), user = safeUser() } = {}) {
  let s = String(text);
  for (const h of new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])) if (h) s = s.split(h).join('~');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'); // before the user name, which is often the local part
  if (user) s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(user)}(?![A-Za-z0-9])`, 'g'), '<user>');
  s = s.replace(/\b(?:sk|sk-ant|xai|ghp|gho|ghu|ghs|ghr|github_pat|AIza|key|token)[-_][A-Za-z0-9_-]{16,}/gi, '<secret>'); // GitHub server/user/refresh tokens (ghs_/ghu_/ghr_) too
  s = s.replace(/(authorization|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]{8,}/gi, '$1$2<secret>');
  return s;
}

/** The bundle as an object: versions, providers, limits (windows only), the improvement log, and the scorecard text. */
export function feedbackBundle() {
  const cfg = loadConfig();
  const reg = getModels();
  const lim = getLimits();
  return {
    version: pkg().version, node: process.version, os: `${platform()} ${release()} ${arch()}`, at: new Date().toISOString(),
    conductor: { provider: cfg.conductor?.provider, model: cfg.conductor?.model, effort: cfg.conductor?.effort, permissionMode: cfg.conductor?.permissionMode },
    worker: cfg.worker,
    providers: Object.fromEntries(Object.entries(reg.providers || {}).map(([k, v]) => [k, { status: v.status, plan: v.plan, installed: v.installed, loggedIn: v.loggedIn, error: v.error }])),
    limits: Object.fromEntries(Object.entries(lim.providers || {}).map(([k, v]) => [k, { blocked: v.blocked, blockedReason: v.blockedReason, error: v.error, windows: (v.windows || []).map((w) => ({ id: w.id, label: w.label, usedPercent: w.usedPercent })) }])),
    improvements: listImprovements({ includeResolved: true }).slice(-300),
    scores: formatScores({}),
  };
}

/** Write the redacted bundle to a file (default: Desktop) and return its path. */
export function writeFeedback(outDir = join(homedir(), 'Desktop')) {
  mkdirSync(outDir, { recursive: true });
  const f = join(outDir, `Conductor-feedback-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(f, redact(JSON.stringify(feedbackBundle(), null, 2)));
  return f;
}
