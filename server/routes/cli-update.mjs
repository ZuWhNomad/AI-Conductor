import { cliUpdateStatus, checkCliUpdate, applyCliUpdate, CLI_UPDATE_IDS } from '../../core/cli-update.mjs';
import { json, readBody } from './_http.mjs';

export async function handle(ctx) {
  const { req, res, m, p } = ctx;
  // Worker CLI updates. POST { provider?, check? }: a check answers at once; an install runs in the background (it waits
  // for an idle provider and verifies with a real task), and its result lands in providers[id].last.
  if (p === '/api/cli-update' && m === 'GET') return json(res, 200, cliUpdateStatus());
  if (p === '/api/cli-update' && m === 'POST') {
    const b = await readBody(req);
    const ids = b?.provider ? [String(b.provider)] : CLI_UPDATE_IDS;
    if (b?.check) return json(res, 200, { providers: await Promise.all(ids.map((id) => checkCliUpdate(id, { manual: true }))) });
    for (const id of ids) if (!CLI_UPDATE_IDS.includes(id)) return json(res, 400, { error: `no CLI update recipe for "${id}"` });
    const at = new Date().toISOString();
    (async () => { for (const id of ids) await applyCliUpdate(id); })().catch(() => {});
    return json(res, 202, { started: ids, at });
  }
  return false;
}
