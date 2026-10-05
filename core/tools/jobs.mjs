// Detached-job tools: job_start, job_status, watch_job, job_cancel, allow_command.
import { z } from 'zod';
import { loadConfig, saveConfig } from '../config.mjs';
import { logImprovement } from '../improve.mjs';
import { startJob, jobStatus, cancelJob, formatJob } from '../jobs.mjs';
import { registerWatch } from '../watchdog.mjs';

export function defs({ sessionId, cwd, maxBlockMs }) {
  return [
    {
      name: 'job_start',
      description: 'Start a long shell command as a detached job (a backtest, scrape or build that outlives a worker turn and a server restart). Set gpu: true for GPU-heavy work such as Whisper, local model inference, or training; only one GPU job can run at a time. New work is held when RAM reaches the configured cap. The watchdog registers the job and wakes this chat once all of its background work is finished. Returns a job id at once; poll it with job_status. Workers start the same jobs with: node <conductor>/bin/conductor.mjs job start [--cwd <dir>] [--gpu] -- <command>.',
      schema: z.object({ command: z.string().describe('Shell command line'), cwd: z.string().optional().describe('Directory to run in (default: the project directory)'), gpu: z.boolean().optional().describe('Set true for GPU-heavy work such as Whisper, local model inference, or training'), note: z.string().optional().describe('What to review when the watchdog wakes this chat') }),
      handler: async (a) => { const j = startJob({ command: a.command, cwd: a.cwd || cwd, gpu: a.gpu }); registerWatch({ sessionId, jobId: j.id, note: a.note || '', cwd }); return `Job ${j.id} started (pid ${j.pid ?? '?'}). The watchdog will wake this chat after all background work finishes; poll with job_status ${j.id}.`; },
    },
    {
      name: 'job_status',
      description: 'Status, exit code and output tail of a detached job.',
      schema: z.object({ job_id: z.string(), tail_chars: z.number().int().min(0).max(20000).optional().describe('Output tail length (default 4000)') }),
      handler: async (a) => { const j = jobStatus(a.job_id, { tailChars: a.tail_chars ?? 4000 }); return j ? formatJob(j) : `unknown job ${a.job_id}`; },
    },
    {
      name: 'watch_job',
      description: 'Register an already-started detached job, PID, or output path. The watchdog wakes this idle chat once only after every task and registered watch for it has finished.',
      schema: z.object({
        job_id: z.string().optional().describe('Conductor detached job id from job_start'),
        pid: z.number().int().positive().optional().describe('Process id to watch for exit'),
        path: z.string().optional().describe('Output path to watch for creation or change, relative to the project directory unless absolute'),
        note: z.string().optional().describe('Short instruction included in the completion summary'),
      }),
      handler: async (a) => {
        if (a.job_id && !jobStatus(a.job_id)) return `unknown job ${a.job_id}`;
        const w = registerWatch({ sessionId, jobId: a.job_id, pid: a.pid, path: a.path, note: a.note, cwd });
        return `Watch ${w.id} registered. This chat will wake after all of its background tasks and watches finish.`;
      },
    },
    {
      name: 'job_cancel',
      description: 'Stop a detached job (kills its process tree by PID).',
      schema: z.object({ job_id: z.string() }),
      handler: async (a) => { const j = cancelJob(a.job_id); return j ? `Job ${j.id} is ${j.status}.` : `unknown job ${a.job_id}`; },
    },
    {
      name: 'allow_command',
      description: 'Add a command to the worker.shell allow-list so API (non-Codex/Claude) workers may run it. Use this when a worker reports "run blocked: X is not in worker.shell allow-list" and X is a legitimate build/verify tool (e.g. openscad). Allowed programs are trusted: they run with the worker\'s privileges and are not sandboxed. Bare command name only. Refused for shells/interpreters (bash, sh, cmd, powershell) since those re-enable arbitrary execution. Every addition is logged.',
      schema: z.object({ command: z.string().describe('Bare command name to allow, e.g. "openscad" (no path, no arguments, no shell operators)') }),
      handler: async (a) => {
        const raw = String(a.command || '').trim();
        const base = raw.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
        if (!base || /[^\w.\-]/.test(base)) return `refused: "${raw}" must be a bare command name (letters, digits, . _ -) with no path, arguments, or shell operators.`;
        // OS2/S3: deny shells, interpreters, package managers and script hosts — allowing any re-enables arbitrary execution.
        const DENIED_EXACT = new Set(['bash', 'sh', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh', 'env', 'wsl', 'ssh',
          'python', 'python3', 'python2', 'py', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'tclsh', 'wish',
          'cscript', 'wscript', 'mshta', 'rundll32', 'regsvr32',
          'bunx', 'npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'exec',
          'pip', 'pip3', 'pipx', 'uv', 'uvx',
          'sudo', 'runas', 'osascript',
          'start', 'call', 'forfiles']);
        // S3: also deny by pattern — catches versioned interpreters (python3.12, python3.12w) and their w suffixes.
        const DENIED_PATTERN = /^(python|py|node|nodejs|ruby|perl|php|lua|pwsh|powershell|deno|bun|java|osascript)[\d.]*w?$/i;
        if (DENIED_EXACT.has(base.toLowerCase()) || DENIED_PATTERN.test(base)) return `refused: "${base}" is a shell, interpreter, or script host — allowing it would re-enable arbitrary execution and defeat the boundary.`;
        const shell = loadConfig().worker?.shell;
        if (shell === true) return 'worker.shell is already unrestricted (true); no allow-list to extend.';
        if (shell === false || shell === 'off') return 'worker.shell is off (the run tool is disabled). Set worker.shell to an allow-list array in config.json (or POST /api/settings) first.';
        const list = Array.isArray(shell) ? shell : [];
        if (list.some((x) => x.replace(/\.(exe|cmd|bat|com|ps1)$/i, '') === base)) return `"${base}" is already on the allow-list.`;
        saveConfig({ worker: { shell: [...list, base] } });
        logImprovement('idea', 'conductor', `added "${base}" to worker.shell allow-list`, {});
        return `Added "${base}" to the worker.shell allow-list (now ${list.length + 1} commands). API workers can run it.`;
      },
    },
  ];
}
