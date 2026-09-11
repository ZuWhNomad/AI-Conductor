// Codex (ChatGPT subscription) provider: limits, models and account via `codex app-server` JSON-RPC.
import { spawnCodex, killTree, onLines, codexCommand } from '../proc.mjs';

export const id = 'codex';
export const label = 'ChatGPT / Codex (GPT-6 Astra, GPT-5.x)';
export const auth = { type: 'subscription', setup: 'Run `codex login` in a terminal, or sign in from the Codex app.' };
export const loginCommand = () => 'codex login';
export const installCommand = () => 'npm i -g @openai/codex';

class AppServer {
  #p; #next = 1; #pending = new Map(); #notifications = [];
  static async connect() {
    const s = new AppServer();
    s.#p = spawnCodex(['app-server']);
    onLines(s.#p.stdout, (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && s.#pending.has(m.id)) {
        const { resolve, reject } = s.#pending.get(m.id); s.#pending.delete(m.id);
        m.error ? reject(new Error(m.error.message || JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) s.#notifications.push(m);
    });
    s.#p.stderr.on('data', () => {});
    const fail = (e) => { for (const { reject } of s.#pending.values()) reject(e); s.#pending.clear(); };
    s.#p.on('error', fail);
    s.#p.stdin.on('error', fail);
    s.#p.on('close', () => fail(new Error('app-server exited')));
    try {
      await s.request('initialize', { clientInfo: { name: 'conductor', title: 'Conductor 2.0', version: '2.0.0' } });
      s.#p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
      return s;
    } catch (e) { s.close(); throw e; }
  }
  request(method, params = {}, timeoutMs = 20000) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.#pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.#p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  close() { try { this.#p?.stdin?.end(); } catch {} setTimeout(() => killTree(this.#p), 500).unref(); }
}

/** Run a few requests on a throwaway app-server and close it. */
export async function withAppServer(fn) {
  const s = await AppServer.connect();
  try { return await fn(s); } finally { s.close(); }
}

export function detect() {
  return { installed: !!codexCommand() };
}

/** Normalized limit windows for this account. */
export async function pollLimits() {
  return withAppServer(async (s) => {
    const r = await s.request('account/rateLimits/read', {});
    const buckets = r.rateLimitsByLimitId ? Object.values(r.rateLimitsByLimitId) : [r.rateLimits].filter(Boolean);
    const windows = [];
    for (const b of buckets) {
      for (const [k, w] of [['primary', b.primary], ['secondary', b.secondary]]) {
        if (!w) continue;
        windows.push({
          id: `${b.limitId}:${k}`,
          label: `${b.limitName || (b.limitId === 'codex' ? 'Codex' : b.limitId)} ${w.windowDurationMins >= 10080 ? 'weekly' : w.windowDurationMins >= 300 ? `${Math.round(w.windowDurationMins / 60)}h` : `${w.windowDurationMins}m`}`,
          usedPercent: w.usedPercent ?? null,
          windowMinutes: w.windowDurationMins ?? null,
          resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
        });
      }
    }
    const main = r.rateLimits;
    return {
      provider: id,
      plan: main?.planType || null,
      blocked: !!main?.rateLimitReachedType || !!main?.spendControlReached,
      blockedReason: main?.rateLimitReachedType || (main?.spendControlReached ? 'spend_control' : null),
      windows,
    };
  });
}

export async function listModels() {
  return withAppServer(async (s) => {
    const r = await s.request('model/list', {});
    return (r.data || []).filter((m) => !m.hidden).map((m) => ({
      provider: id,
      id: m.model || m.id,
      label: m.displayName || m.model,
      description: m.description || '',
      efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
      defaultEffort: m.defaultReasoningEffort || null,
      isDefault: !!m.isDefault,
      kind: 'agent',
      cost: 'subscription',
    }));
  });
}

export async function account() {
  return withAppServer(async (s) => {
    const r = await s.request('account/read', { refreshToken: false });
    return { loggedIn: !!r.account, plan: r.account?.planType || null, type: r.account?.type || null };
  });
}
