// Ollama provider: local models, zero cost. Models run through the Claude harness (Ollama speaks
// the Anthropic Messages API) so they get the full toolset; the OpenAI-compatible loop is the fallback.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findOnPath as findOnPathOnly, findCli } from '../proc.mjs';
const findOnPath = (name) => findCli(name) || findOnPathOnly(name) || (process.platform === 'win32' && process.env.LOCALAPPDATA && [join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')].find((p) => existsSync(p))) || null;
import { loadConfig } from '../config.mjs';
import { bus } from '../bus.mjs';

export const id = 'ollama';
export const label = 'Ollama (local models)';
export const kind = 'ollama';
export const auth = { type: 'none', setup: 'Install Ollama from https://ollama.com and pull a model (e.g. `ollama pull qwen3.8`).' };
export const installCommand = () => (process.platform === 'win32' ? 'start https://ollama.com/download' : 'curl -fsSL https://ollama.com/install.sh | sh');

export const baseUrl = () => (loadConfig().providers.ollama?.baseUrl || 'http://localhost:11434').replace(/\/$/, '');

async function ping(ms = 1500) {
  try { const r = await fetch(`${baseUrl()}/api/version`, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}

let starting = null;
/** Ensure the server is running (spawns `ollama serve` detached when configured). */
export async function ensureRunning() {
  if (await ping()) return true;
  const bin = findOnPath('ollama');
  if (!bin || !loadConfig().providers.ollama?.autoStart) return false;
  if (!starting) {
    starting = (async () => {
      const p = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      p.unref();
      for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (await ping()) return true; }
      return false;
    })().finally(() => { starting = null; });
  }
  return starting;
}

export async function detect() {
  const bin = findOnPath('ollama');
  const v = await ping();
  return { installed: !!bin, running: !!v, version: v?.version || null };
}

export async function listModels() {
  if (!(await ping())) { if (!(await ensureRunning())) return []; }
  const r = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.models || []).map((m) => ({
    provider: id, id: m.name, label: m.name, description: `${m.details?.family || ''} ${m.details?.parameter_size || ''} ${m.details?.quantization_level || ''}`.trim(),
    sizeBytes: m.size, efforts: [], kind: /embed/i.test(m.name) ? 'embedding' : 'agent', cost: 'free-local',
  }));
}

export async function pollLimits() {
  return { provider: id, plan: 'local', blocked: false, windows: [] };
}

/** Pull a model with progress events on the bus. Resolves when done. */
export async function pullModel(name) {
  await ensureRunning();
  const r = await fetch(`${baseUrl()}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: true }) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const j = JSON.parse(line); bus.publish('model_pull', { provider: id, model: name, status: j.status, completed: j.completed, total: j.total, error: j.error }); if (j.error) throw new Error(j.error); } catch (e) { if (e.message !== 'Unexpected token') throw e; } }
  }
  bus.publish('model_pull', { provider: id, model: name, status: 'done' });
}

/** Env for running this model through the Claude harness. */
export function claudeHarnessEnv() {
  return { ANTHROPIC_BASE_URL: baseUrl(), ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
