// Shared response helpers. Route modules import this; they do not import ../index.mjs.
import { redact } from '../../core/paths.ts';

// Every API answer is redacted (task records, chat messages, improvements), except the settings, which publicConfig masks
// in its own round-trippable way (`raw`).
export const json = (res, code, body, raw = false) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); const text = JSON.stringify(body); res.end(raw ? text : redact(text)); return true; };
// Oversized bodies are drained (not destroyed) so the 413 actually reaches the client.
export const readBody = (req) => new Promise((resolve, reject) => { let d = '', stopped = false; req.on('data', (c) => { if (stopped) return; d += c; if (d.length > 5e6) { stopped = true; d = ''; reject(Object.assign(new Error('body too large'), { status: 413 })); req.resume(); } }); req.on('end', () => { if (stopped) return; try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); } }); req.on('error', reject); });
