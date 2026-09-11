// Image generation workers: OpenAI images (DALL-E / gpt-image), Stability AI, local Stable Diffusion (A1111 API).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * @param {object} t { id, cwd, prompt, provider: 'openai-images'|'stability'|'sd', model, size, n, outDir, apiKey, baseUrl }
 * @returns {Promise<{ok, files, error}>}
 */
export async function runImage(t) {
  const signal = AbortSignal.any([t.signal, ...(t.timeoutMs ? [AbortSignal.timeout(t.timeoutMs)] : [])].filter(Boolean));
  const outDir = resolve(t.cwd, t.outDir || 'generated-images');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files = [];
  try {
    if (t.provider === 'openai-images') {
      const r = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.apiKey}` }, body: JSON.stringify({ model: t.model || 'gpt-image-1', prompt: t.prompt, n: t.n || 1, size: t.size || '1024x1024' }) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 400)}`);
      const j = await r.json();
      for (const [i, d] of (j.data || []).entries()) {
        const buf = d.b64_json ? Buffer.from(d.b64_json, 'base64') : Buffer.from(await (await fetch(d.url, { signal })).arrayBuffer());
        if (signal.aborted) throw new Error('aborted');
        const f = join(outDir, `${stamp}-${i + 1}.png`); writeFileSync(f, buf); files.push(f);
      }
    } else if (t.provider === 'stability') {
      const form = new FormData(); form.append('prompt', t.prompt); form.append('output_format', 'png');
      const r = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', { method: 'POST', signal, headers: { authorization: `Bearer ${t.apiKey}`, accept: 'image/*' }, body: form });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 400)}`);
      const f = join(outDir, `${stamp}-1.png`); writeFileSync(f, Buffer.from(await r.arrayBuffer())); files.push(f);
    } else if (t.provider === 'sd') {
      const [w, h] = (t.size || '1024x1024').split('x').map(Number);
      const r = await fetch(`${(t.baseUrl || 'http://127.0.0.1:7860').replace(/\/$/, '')}/sdapi/v1/txt2img`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: t.prompt, steps: 25, width: w, height: h, batch_size: t.n || 1 }) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 400)}`);
      const j = await r.json();
      for (const [i, b64] of (j.images || []).entries()) { const f = join(outDir, `${stamp}-${i + 1}.png`); writeFileSync(f, Buffer.from(b64, 'base64')); files.push(f); }
    } else throw new Error(`unknown image provider ${t.provider}`);
    return { ok: true, provider: t.provider, files, finalMessage: `Generated ${files.length} image(s):\n${files.join('\n')}`, items: [], usage: null, error: null };
  } catch (e) {
    return { ok: false, provider: t.provider, files, finalMessage: '', items: [], usage: null, error: String(e?.message || e), limitHit: /429/.test(String(e?.message)) };
  }
}
