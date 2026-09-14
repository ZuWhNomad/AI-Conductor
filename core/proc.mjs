// Process helpers: locate CLIs on PATH, spawn the Codex CLI without a shell, kill process trees.
import { spawn, execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const WIN = process.platform === 'win32';
const probeChildren = new Set();

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
 * A Windows npm/pnpm global .cmd shim ultimately runs `node "<pkg>/…/entry.js" %*`. Resolve it to that JS entry so
 * we can spawn `node <entry>` directly — no shell, no cmd re-parse of `%*` (which is where a prompt containing `&`,
 * `|`, `>` would inject a command). Returns { command: node, args:[entry] } or null when it isn't a resolvable shim.
 */
export function resolveNpmShim(cmdPath) {
  if (!WIN || !/\.cmd$/i.test(cmdPath)) return null;
  let txt; try { txt = readFileSync(cmdPath, 'utf8'); } catch { return null; }
  // The shim's real invocation is `"<…>\entry.js" %*`. Take the last quoted .js path it references (node.exe comes first, isn't .js).
  const quoted = [...txt.matchAll(/"([^"\r\n]*?\.js)"/gi)].map((m) => m[1]);
  const raw = quoted[quoted.length - 1] || (txt.match(/([^\s"']+\.js)\b/i) || [])[1];
  if (!raw) return null;
  const rel = raw.replace(/%~dp0\\?/gi, '').replace(/%[^%]*%/g, '').replace(/^["\\/]+/, ''); // %~dp0 = the shim's own dir
  const js = join(dirname(cmdPath), rel);
  return existsSync(js) ? { command: process.execPath, args: [js] } : null;
}

/**
 * Escape one argument for a Windows cmd.exe command line so its VALUE can never inject a command (used only for a
 * .cmd we could not unwrap). Two layers: MSVCRT quoting, then caret-escape every cmd metacharacter including the
 * quotes. `%` cannot be escaped on a cmd command line — literal %VAR% env expansion is the standard benign residue.
 */
export function winArgEscape(s) {
  const crt = '"' + String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
  return crt.replace(/[()!^"<>&|]/g, '^$&');
}

/**
 * Spawn any CLI. A real `.exe`/binary spawns without a shell, args as separate argv (no shell parsing at all). A
 * Windows `.cmd`/`.bat` can't be spawned directly on modern Node (EINVAL); when it's an npm shim we unwrap it to
 * `node <entry>` and still avoid the shell entirely. Only a `.cmd` we cannot unwrap falls back to the shell, with
 * cmd-escaped args (imperfect against a shim's own `%*` re-parse, so unwrapping is strongly preferred).
 */
export function spawnCli(bin, args, opts = {}) {
  const base = { windowsHide: true, ...opts }; // never flash a console window on Windows (a caller may still override)
  if (WIN && /\.(cmd|bat)$/i.test(bin)) {
    const shim = resolveNpmShim(bin);
    if (shim) return spawn(shim.command, [...shim.args, ...args], base); // no shell: argv passed verbatim, no re-parse
    // Last-resort .cmd shell fallback: keep it windowless (windowsHide from base) and pipe stdio so no cmd.exe window shows.
    return spawn(`${quoteArg(bin)} ${args.map(winArgEscape).join(' ')}`, { stdio: ['pipe', 'pipe', 'pipe'], ...base, shell: true });
  }
  return spawn(bin, args, base);
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
    if (WIN) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  } catch { try { child.kill(); } catch {} }
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

export function cliVersion(name) {
  const found = findCli(name);
  if (!found) return null;
  try {
    if (/\.(cmd|bat)$/i.test(found)) return execSync(`"${found}" --version`, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return execFileSync(found, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
