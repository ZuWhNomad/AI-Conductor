// Process helpers: locate CLIs on PATH, spawn the Codex CLI without a shell, kill process trees.
import { spawn, execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const WIN = process.platform === 'win32';

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

export function quoteArg(a) {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/**
 * Spawn any CLI. A Windows `.cmd`/`.bat` (npm global shims like `qwen.cmd`, pip's `kimi.cmd`) cannot be spawned
 * directly on modern Node — it throws `EINVAL` — so route those through the shell with quoted args. Everything
 * else (real `.exe`/binaries) spawns without a shell as before.
 */
export function spawnCli(bin, args, opts = {}) {
  if (WIN && /\.(cmd|bat)$/i.test(bin)) return spawn([bin, ...args].map(quoteArg).join(' '), { ...opts, shell: true });
  return spawn(bin, args, opts);
}

export function assertShellSafe(args) {
  if (args.some((a) => /["\r\n&|<>^%!]/.test(a))) throw new Error('unsafe argument for the codex .cmd shim; set CONDUCTOR_CODEX to the codex executable');
}

export function spawnCodex(args, opts = {}) {
  const c = codexCommand();
  if (!c) throw new Error('codex CLI not found on PATH. Install with: npm i -g @openai/codex');
  const base = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...opts };
  if (c.shell) { assertShellSafe([c.command, ...args]); return spawn([c.command, ...args].map(quoteArg).join(' '), { ...base, shell: true }); }
  return spawn(c.command, [...c.args, ...args], base);
}

/** Kill a child and its descendants (Codex spawns a native binary under the node shim). */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return; // never spawned (ENOENT) or already gone
  try {
    if (WIN) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { try { child.kill(); } catch {} }
}

/** Feed newline-delimited data from a stream to a callback, line by line. */
export function onLines(stream, cb) {
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
  });
  stream.on('end', () => { if (buf.trim()) cb(buf); buf = ''; });
}

export function cliVersion(name) {
  const found = findCli(name);
  if (!found) return null;
  try {
    if (/\.(cmd|bat)$/i.test(found)) return execSync(`"${found}" --version`, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return execFileSync(found, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
