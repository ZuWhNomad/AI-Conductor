// Detached long jobs: a command that outlives the worker (and a server restart) and is polled later by id.
// <state>/jobs/<id>.json is the record, <id>.log the output. A small detached node wrapper runs the command through the
// shell, appends its output to the log and writes the exit code into the record itself, so nothing depends on the
// process that started it. Cancel kills the wrapper's tree by PID, never by image name.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { statePath, readJson, writeJson, shortId, nowIso, redact, readTail } from './paths.mjs';

const WIN = process.platform === 'win32';
const rec = (id) => statePath('jobs', `${id}.json`);
const log = (id) => statePath('jobs', `${id}.log`);
const validId = (id) => typeof id === 'string' && /^[a-z0-9]+$/.test(id);

// CommonJS on purpose (`node -e`): argv is [node, record, log, command, cwd]. The command travels in argv, not in the
// record, because the record is redacted on disk. Record updates are read-merge-write with a rename.
const WRAPPER = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
const [file, logFile, command, cwd] = process.argv.slice(1);
const save = (patch) => { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.status === 'canceled') return; fs.writeFileSync(file + '.tmp', JSON.stringify({ ...cur, ...patch }, null, 2)); fs.renameSync(file + '.tmp', file); };
const out = fs.openSync(logFile, 'a');
const c = spawn(command, { cwd, shell: true, stdio: ['ignore', out, out], windowsHide: true });
save({ pid: process.pid, childPid: c.pid || null });
c.on('error', (e) => { fs.writeSync(out, String(e.message) + '\\n'); save({ status: 'failed', exitCode: null, error: e.message, finishedAt: new Date().toISOString() }); });
c.on('exit', (code, signal) => save({ status: code === 0 ? 'done' : 'failed', exitCode: code, signal: signal || null, finishedAt: new Date().toISOString() }));`;

/** Start `command` (a shell command line) in `cwd`, detached. Returns the record. */
export function startJob({ command, cwd }) {
  if (typeof command !== 'string' || !command.trim()) throw Object.assign(new Error('command must be a non-empty string'), { status: 400 });
  let dir = false; try { dir = statSync(cwd).isDirectory(); } catch {}
  if (!dir) throw Object.assign(new Error(`cwd must be an existing directory: ${cwd}`), { status: 400 });
  const id = shortId((x) => existsSync(rec(x)));
  const r = { id, command, cwd, status: 'running', startedAt: nowIso(), pid: null, exitCode: null, finishedAt: null };
  writeJson(rec(id), r);
  const child = spawn(process.execPath, ['-e', WRAPPER, rec(id), log(id), command, cwd], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return { ...readJson(rec(id)), pid: child.pid || null };
}

/** The record plus the last `tailChars` of output; a 'running' job whose wrapper is gone is reported 'lost'. */
export function jobStatus(id, { tailChars = 4000 } = {}) {
  const r = validId(id) ? readJson(rec(id)) : null;
  if (!r) return null;
  if (r.status === 'running' && r.pid && !alive(r.pid)) {
    const again = readJson(rec(id)); // the wrapper may have finished between the two reads
    if (again?.status !== 'running') return jobStatus(id, { tailChars });
    r.status = 'lost'; r.error = 'the job process is gone without an exit code (machine restart or external kill)';
    writeJson(rec(id), r);
  }
  return { ...r, tail: redact(tail(log(id), tailChars)) };
}

/** Kill the job's process tree by PID. */
export function cancelJob(id) {
  const r = validId(id) ? readJson(rec(id)) : null;
  if (!r) return null;
  if (r.status !== 'running') return r;
  if (r.pid) {
    try {
      if (WIN) execFile('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else process.kill(-r.pid, 'SIGTERM');
    } catch {}
  }
  const out = { ...r, status: 'canceled', finishedAt: nowIso() };
  writeJson(rec(id), out);
  return out;
}

export function listJobs() {
  try { return readdirSync(statePath('jobs')).filter((f) => f.endsWith('.json')).map((f) => readJson(statePath('jobs', f))).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))); } catch { return []; }
}

export function formatJob(j) {
  if (!j) return 'unknown job';
  const took = j.finishedAt ? ` after ${Math.round((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000)}s` : ` for ${Math.round((Date.now() - Date.parse(j.startedAt)) / 60_000)} min`;
  return `Job ${j.id} [${j.status}]${j.exitCode != null ? ` exit ${j.exitCode}` : ''}${took} — ${j.command} (in ${j.cwd}, pid ${j.pid ?? '?'})${j.error ? `\nError: ${j.error}` : ''}${j.tail ? `\nOutput tail:\n${j.tail}` : ''}`;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

const tail = (file, chars) => readTail(file, Math.max(0, chars) * 4).slice(-chars);
