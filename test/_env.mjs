// Import this FIRST in every test: isolates state in a temp dir and disables live side effects.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONDUCTOR_HOME = mkdtempSync(join(tmpdir(), 'conductor-test-'));
process.env.CONDUCTOR_NO_SCHEDULE = '1';
process.env.CONDUCTOR_NO_POLL = '1';

export const HOME = process.env.CONDUCTOR_HOME;
export const tmpDir = (name = 'proj') => mkdtempSync(join(tmpdir(), `conductor-${name}-`));
