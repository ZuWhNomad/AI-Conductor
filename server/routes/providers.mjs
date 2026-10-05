import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from '../../core/paths.ts';
import { PROVIDERS } from '../../core/providers/index.mjs';
import { json } from './_http.mjs';

/** Open a visible terminal running `command` (sign-in flows need a real console + browser). */
function openTerminal(title, command) {
  try {
    const dir = statePath('tmp'); mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      const file = join(dir, `run-${Date.now()}.cmd`);
      writeFileSync(file, `@echo off\r\ntitle ${title.replace(/[&|<>^]/g, ' ')}\r\necho ${command.replace(/[&|<>^%]/g, ' ')}\r\n${command}\r\necho.\r\necho Done. You can close this window and press Refresh in Conductor.\r\n`);
      spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else if (process.platform === 'darwin') {
      const file = join(dir, `run-${Date.now()}.command`);
      writeFileSync(file, `#!/bin/bash\n${command}\necho; echo "Done. You can close this window and press Refresh in Conductor."\n`, { mode: 0o755 });
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', 'bash', '-c', `${command}; echo; read -p "Done. Press Enter to close."`], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch { return false; }
}

export async function handle(ctx) {
  const { res, m, seg } = ctx;
  if (!(seg[1] === 'providers' && seg[2] && ['login', 'relogin', 'install'].includes(seg[3]) && m === 'POST')) return false;
  const prov = PROVIDERS[seg[2]];
  if (!prov) return json(res, 400, { error: 'unknown provider' });
  let command;
  if (seg[3] === 'install') command = prov.installCommand?.();
  else { // login / relogin: re-auth clears a stale token first (logout) where the CLI supports it, then signs in
    const login = prov.loginCommand?.();
    const logout = seg[3] === 'relogin' ? prov.logoutCommand?.() : null;
    command = login && logout ? ctx.chainShell(logout, login) : login;
  }
  if (!command) return json(res, 400, { error: `${seg[2]} has no ${seg[3]} command` });
  const note = seg[3] === 'install' ? 'Wait for the installer to finish in the window that opened — Conductor re-checks by itself.'
    : (prov.spec?.login?.note || `Finish the ${seg[3] === 'relogin' ? 're-auth (log out, then sign in)' : 'sign-in'} in the window that opened — Conductor re-checks by itself.`);
  const opened = openTerminal(`Conductor — ${seg[2]} ${seg[3]}`, command);
  if (opened && !process.env.CONDUCTOR_NO_POLL) ctx.watchSignIn(seg[2], { awaitDrop: seg[3] === 'relogin' }); // re-probe until it comes back ok: no manual Refresh
  return json(res, 200, { ok: opened, command, note: opened ? note : `Could not open a terminal here; run this yourself: ${command}` });
}
