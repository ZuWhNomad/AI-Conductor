// Import this FIRST in every test: isolates state in a temp dir and disables live side effects.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One temp root per process, removed on exit. TEMP/TMP/TMPDIR point at it, so every tmpdir() call here, in the code
// under test and in spawned children (git, CLIs, test files under the runner) lands inside it. rmSync removes
// junctions and symlinks themselves, never what they point to.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conductor-test-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch {} });

process.env.CONDUCTOR_HOME = mkdtempSync(join(root, 'home-'));
process.env.CONDUCTOR_NO_SCHEDULE = '1';
process.env.CONDUCTOR_NO_POLL = '1';
process.env.CONDUCTOR_NO_SHIPPED = '1';

export const HOME = process.env.CONDUCTOR_HOME;
export const tmpDir = (name = 'proj') => mkdtempSync(join(tmpdir(), `conductor-${name}-`));
