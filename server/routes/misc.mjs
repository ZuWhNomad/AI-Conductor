import { readdir, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { updateStatus, applyUpdate, lastUpdateStatus } from '../../core/update.mjs';
import { json, readBody } from './_http.mjs';

const isUncPath = (p) => /^[\\/]{2}[^\\/]/.test(String(p || ''));
const existsAsync = async (p) => { try { await access(p); return true; } catch { return false; } };

async function listDirs(p) {
  const raw = p || homedir();
  if (isUncPath(raw)) return { path: String(raw), parent: null, dirs: [], error: 'UNC' };
  const dir = resolve(raw);
  if (isUncPath(dir)) return { path: dir, parent: null, dirs: [], error: 'UNC' };
  let entries;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch (e) { return { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, dirs: [], error: e.code }; }
  return { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, dirs: entries, hasGit: await existsAsync(join(dir, '.git')), hasClaudeMd: await existsAsync(join(dir, 'CLAUDE.md')) };
}

export async function handle(ctx) {
  const { req, res, url, m, p } = ctx;
  if (m === 'POST' && p === '/api/shutdown') { // the UI Quit button — stop this server (in-flight tasks requeue and resume on next start)
    json(res, 200, { ok: true, stopping: true });
    ctx.beginShutdown();
    return true;
  }
  if (p === '/api/browse' && m === 'GET') {
    const browsePath = url.searchParams.get('path');
    if (browsePath && isUncPath(browsePath)) return json(res, 400, { error: 'unc paths are not allowed' });
    const listing = await listDirs(browsePath);
    if (listing.error === 'ENOENT' || listing.error === 'ENOTDIR') return json(res, 404, { error: listing.error === 'ENOENT' ? 'Folder does not exist' : 'Path is not a folder' });
    return json(res, 200, listing);
  }
  if (p === '/api/update' && m === 'GET') return json(res, 200, url.searchParams.get('fetch') === '1' ? await updateStatus() : lastUpdateStatus() || await updateStatus({ fetch: false }));
  if (p === '/api/update' && m === 'POST') { // pull, then self-restart into the new version; relaunching:false falls back to the manual-restart message
    const b = await readBody(req);
    const r = await applyUpdate();
    const need = !!(r.updated && r.restartNeeded && !r.npmError);
    if (!need) return json(res, 200, { ...r, relaunching: false });
    if (b.force === true || !ctx.workInFlight()) {
      const relaunching = !!ctx.scheduleRelaunch({ port: ctx.relaunchPort() });
      return json(res, 200, { ...r, relaunching });
    }
    ctx.setPendingRelaunch(r);
    ctx.publishUpdateWaiting();
    ctx.deferPendingRelaunch();
    return json(res, 200, { ...r, relaunching: 'when idle' });
  }
  if (p === '/api/doctor' && m === 'GET') return json(res, 200, await ctx.doctorReport());
  return false;
}
