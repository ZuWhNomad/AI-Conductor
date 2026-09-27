// Process helpers: locate/spawn CLIs, track their owners, sample process trees, and kill by PID.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const WIN = process.platform === 'win32';
const probeChildren = new Set();
const ownerPids = new Map();
const execFileP = promisify(execFile);

/** Associate a spawned child with a task id (or `conductor:<sessionId>`) until it exits. */
export function registerProc(owner, child) {
  if (!owner || !child?.pid) return child;
  const pid = Number(child.pid);
  const pids = ownerPids.get(owner) || new Set();
  pids.add(pid); ownerPids.set(owner, pids);
  const done = () => {
    const current = ownerPids.get(owner); if (!current) return;
    current.delete(pid); if (!current.size) ownerPids.delete(owner);
  };
  child.once?.('close', done); child.once?.('error', done);
  return child;
}

export function registeredPids(owner) { return [...(ownerPids.get(owner) || [])]; }

/** Agent SDK spawn hook: ChildProcess satisfies SpawnedProcess and exposes its PID to the registry. */
export function spawnTracked(owner, { command, args, cwd, env, signal }) {
  return registerProc(owner, spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }));
}

const cpuTime = (text) => {
  const raw = String(text || '').trim();
  const dash = raw.indexOf('-');
  const days = dash >= 0 ? Number(raw.slice(0, dash)) : 0;
  const parts = raw.slice(dash + 1).split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  const sec = parts.pop() || 0, min = parts.pop() || 0, hours = parts.pop() || 0;
  return days * 86400 + hours * 3600 + min * 60 + sec;
};

/** Parse the compact JSON produced by the Win32_Process probe. */
export function parseWindowsProcesses(text) {
  const parsed = JSON.parse(String(text || '[]') || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(rows.flatMap((r) => {
    const pid = Number(r.ProcessId), ppid = Number(r.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0) return [];
    return [[pid, { pid, ppid: Number.isInteger(ppid) ? ppid : 0, cpuSeconds: (Number(r.KernelModeTime) + Number(r.UserModeTime)) / 10_000_000 || 0, rssBytes: Number(r.WorkingSetSize) || 0, name: String(r.Name || '') }]];
  }));
}

/** Parse `ps -A -o pid=,ppid=,time=,rss=,comm=` output. */
export function parsePsProcesses(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+((?:\d+-)?\d+:\d{2}(?::\d{2})?)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    out.set(pid, { pid, ppid: Number(m[2]), cpuSeconds: cpuTime(m[3]), rssBytes: Number(m[4]) * 1024, name: m[5] });
  }
  return out;
}

/** One bounded, shell-free OS process snapshot for all watchdog owners. */
export async function snapshotProcesses({ platform = process.platform, exec = execFileP } = {}) {
  try {
    if (platform === 'win32') {
      const ps = findCli('powershell') || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,Name | ConvertTo-Json -Compress';
      const { stdout } = await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
      return { ok: true, processes: parseWindowsProcesses(stdout) };
    }
    const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,comm='], { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, processes: parsePsProcesses(stdout) };
  } catch (e) { return { ok: false, processes: new Map(), error: String(e?.message || e) }; }
}

/** Sum a registered owner's live roots and descendants from one shared snapshot. */
export function ownerProcessSample(owner, snapshot) {
  if (!snapshot?.ok) return { available: false, alive: false, cpuSeconds: null, rssBytes: null, names: [] };
  const roots = new Set(registeredPids(owner));
  const owned = new Set([...roots].filter((pid) => snapshot.processes.has(pid)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of snapshot.processes.values()) if (!owned.has(p.pid) && owned.has(p.ppid)) { owned.add(p.pid); changed = true; }
  }
  let cpuSeconds = 0, rssBytes = 0; const names = new Set();
  for (const pid of owned) { const p = snapshot.processes.get(pid); cpuSeconds += p.cpuSeconds || 0; rssBytes += p.rssBytes || 0; if (p.name) names.add(p.name); }
  return { available: true, alive: owned.size > 0, cpuSeconds, rssBytes, names: [...names] };
}

export function findOnPath(name) {
  const exts = WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * How to spawn `codex` without a shell. The npm shim is a .cmd on Windows; we bypass it by
 * running its JS entry with the current node, which avoids all command-line quoting issues.
 */
/** Places npm puts global CLIs when the process PATH has not caught up (fresh installs, launchers). */
function npmGlobalDirs() {
  const dirs = [];
  if (WIN) { if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm')); if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'npm')); }
  else { if (process.env.HOME) dirs.push(join(process.env.HOME, '.npm-global', 'bin'), join(process.env.HOME, '.local', 'bin')); dirs.push('/usr/local/bin', '/opt/homebrew/bin'); }
  return dirs;
}

export function findCli(name) {
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  const exts = WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = [...npmGlobalDirs()];
  if (WIN && name === 'git') for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) if (pf) dirs.push(join(pf, 'Git', 'cmd'));
  for (const dir of dirs) for (const ext of exts) { const p = join(dir, name + ext); if (existsSync(p)) return p; }
  return null;
}

export function codexCommand() {
  if (process.env.CONDUCTOR_CODEX) return { command: process.env.CONDUCTOR_CODEX, args: [] };
  let found = findCli('codex');
  if (!found && WIN && process.env.LOCALAPPDATA) {
    const dir = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = readdirSync(dir).flatMap((name) => {
        const exe = join(dir, name, 'codex.exe');
        try { const s = statSync(exe); return s.isFile() ? [{ exe, mtime: s.mtimeMs }] : []; } catch { return []; }
      });
      found = candidates.sort((a, b) => b.mtime - a.mtime)[0]?.exe;
    } catch {}
  }
  if (!found) return null;
  if (/\.(cmd|bat)$/i.test(found)) {
    const js = join(dirname(found), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(js)) return { command: process.execPath, args: [js] };
    // A .cmd shim without its JS entry is a broken install; the shell fallback cannot carry codex's quoted
    // -c overrides safely, so treat it as not installed (set CONDUCTOR_CODEX to a real executable instead).
    return null;
  }
  return { command: found, args: [] };
}

/**
 * A Windows npm/pnpm global .cmd shim ultimately runs `node "<pkg>/…/entry.js" %*`. Resolve it to that JS entry so
 * we can spawn `node <entry>` directly — no shell, no cmd re-parse of `%*` (which is where a prompt containing `&`,
 * `|`, `>` would inject a command). Returns { command: node, args:[entry] } or null when it isn't a resolvable shim.
 */
export function resolveNpmShim(cmdPath) {
  if (!WIN || !/\.cmd$/i.test(cmdPath)) return null;
  let txt; try { txt = readFileSync(cmdPath, 'utf8'); } catch { return null; }
  const unwrap = (raw) => {
    const rel = raw.replace(/%~dp0\\?/gi, '').replace(/%[^%]*%/g, '').replace(/^["\\/]+/, '');
    return isAbsolute(rel) ? rel : join(dirname(cmdPath), rel);
  };
  // The shim's real invocation is `"<…>\entry.js" %*`. Take the last quoted .js path it references (node.exe comes first, isn't .js).
  const quotedJs = [...txt.matchAll(/"([^"\r\n]*?\.js)"/gi)].map((m) => m[1]);
  const rawJs = quotedJs[quotedJs.length - 1] || (txt.match(/([^\s"']+\.js)\b/i) || [])[1];
  if (rawJs) {
    const js = unwrap(rawJs);
    if (existsSync(js)) return { command: process.execPath, args: [js] };
  }
  // Native-bin packages: `"<…>\tool.exe" %*` (last quoted .exe is the actual target; an earlier IF EXIST node.exe is ignored).
  const quotedExe = [...txt.matchAll(/"([^"\r\n]*?\.exe)"/gi)].map((m) => m[1]);
  const rawExe = quotedExe[quotedExe.length - 1];
  if (rawExe) {
    const exe = unwrap(rawExe);
    if (existsSync(exe)) return { command: exe, args: [] };
  }
  return null;
}

/**
 * Spawn any CLI. A real `.exe`/binary spawns without a shell, args as separate argv (no shell parsing at all). A
 * Windows `.cmd`/`.bat` can't be spawned directly on modern Node (EINVAL); when it's an npm shim we unwrap it to
 * `node <entry>` and still avoid the shell entirely. Refuse unresolved scripts: shell escaping cannot safely
 * preserve arbitrary arguments through cmd.exe and a script's own `%*` re-parse.
 */
export function spawnCli(bin, args, opts = {}) {
  const base = { windowsHide: true, detached: !WIN, ...opts, shell: false }; // callers may override window visibility, never shell safety
  if (WIN && /\.(cmd|bat)$/i.test(bin)) {
    const shim = resolveNpmShim(bin);
    if (shim) return spawn(shim.command, [...shim.args, ...args], base); // no shell: argv passed verbatim, no re-parse
    throw new Error(`cannot run ${bin} without a shell (not a resolvable npm shim); point the config at the real executable`);
  }
  return spawn(bin, args, base);
}

export function spawnCodex(args, opts = {}) {
  const c = codexCommand();
  if (!c) throw new Error('codex CLI not found on PATH. Install with: npm i -g @openai/codex');
  const base = { windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'], ...opts };
  return spawn(c.command, [...c.args, ...args], base);
}

/** Kill a child and its descendants (Codex spawns a native binary under the node shim). */
export function killTree(child) {
  if (!child) return;
  if (child.pid && child.exitCode === null) {
    try {
      if (WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }, (err) => { if (err) try { child.kill(); } catch {} });
      else process.kill(-child.pid, 'SIGTERM');
    } catch { try { child.kill(); } catch {} }
  } else if (child.pid && !WIN) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {} // group may still hold the pipes after the direct child exited
  }
  // A grandchild can keep the pipes open after the kill, so 'close' never fires: after a short grace (output already
  // written still drains), destroy them.
  setTimeout(() => { try { child.stdout?.destroy(); } catch {} try { child.stderr?.destroy(); } catch {} }, 500).unref?.();
}

export function trackProbe(child) {
  if (child && child.pid) {
    probeChildren.add(child);
    const done = () => probeChildren.delete(child);
    child.once('exit', done);
    child.once('error', done);
  }
  return child;
}

export function killProbes() {
  for (const child of [...probeChildren]) {
    try { killTree(child); } catch {}
  }
  probeChildren.clear();
}

/** Feed newline-delimited data from a stream to a callback, line by line. */
export function onLines(stream, cb, { maxLine = 4 * 1024 * 1024 } = {}) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) cb(line);
    }
    if (buf.length > maxLine) { cb(buf); buf = ''; } // a stream with no newline must not grow the buffer without bound
  });
  stream.on('end', () => { if (buf.trim()) cb(buf); buf = ''; });
}
