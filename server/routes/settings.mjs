import { loadConfig, saveConfig, publicConfig } from '../../core/config.mjs';
import { json, readBody } from './_http.mjs';

export async function handle(ctx) {
  const { req, res, m, p } = ctx;
  if (p !== '/api/settings') return false;
  if (m === 'GET') return json(res, 200, publicConfig(), true);
  if (m === 'POST') {
    const b = await readBody(req);
    const prev = loadConfig();
    const next = saveConfig(b);
    ctx.applySettings(prev, next);
    return json(res, 200, publicConfig(next), true);
  }
  return false;
}
