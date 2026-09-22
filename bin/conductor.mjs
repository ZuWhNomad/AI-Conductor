#!/usr/bin/env node
// Conductor 2.0 CLI. `conductor` starts the workbench; see `conductor help`.
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT, stateDir, statePath } from '../core/paths.mjs';
import { loadConfig } from '../core/config.mjs';

const PID_FILE = () => statePath('server.pid');
const writePidFile = (info) => { try { writeFileSync(PID_FILE(), JSON.stringify({ pid: process.pid, ...info }, null, 2)); } catch {} };
const clearPidFile = () => { try { unlinkSync(PID_FILE()); } catch {} };

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' }, 'no-open': { type: 'boolean' }, refresh: { type: 'boolean' }, model: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    models: { type: 'string' }, 'all-models': { type: 'boolean' }, tasks: { type: 'string' }, keep: { type: 'boolean' }, category: { type: 'string' }, source: { type: 'string' }, 'void-env': { type: 'boolean' }, csv: { type: 'boolean' }, 'agents-md': { type: 'string' }, variant: { type: 'string' }, run: { type: 'boolean' }, days: { type: 'string' }, check: { type: 'boolean' },
  },
});
const cmd = positionals[0] || 'start';

const HELP = `conductor 2.0 — multi-model orchestration workbench

  conductor [start] [--port N] [--no-open]   start the local server + open the browser UI
  conductor doctor                           check Node, Claude login, Codex login, Ollama
  conductor models [--refresh] [--json]      list models across providers
  conductor limits [--refresh] [--json]      show usage limits per provider
  conductor scores [--category C] [--source live|smoke] [--json|--csv] [--void-env]
                                             scorecard: quality, $ and % of window per model, category and level;
                                             --void-env excludes smoke runs the sandbox blocked (not the model's fault)
  conductor smoke --models p:m[:e],...  | --all-models  [--tasks id,id] [--keep] [--agents-md FILE --variant NAME]
                                             run the smoke battery against models to seed the scorecard (spends budget)
  conductor bench [--run] [--days N] [--refresh]
                                             models with no battery or a stale one (default 21 days); --run probes then batteries them
  conductor review [--model M]               headless self-review of this workbench from the improvement log
  conductor share                            zip the committed files (what git tracks) to your Desktop
  conductor update [--check]                 pull the latest version from GitHub (fast-forward + npm install when needed); --check only reports
  conductor feedback [--no-open]             write a redacted feedback bundle (versions, limits, improvement log, scores)
                                             to your Desktop and open the issue page to attach it
  conductor help`;

function openBrowser(url) {
  const cmdline = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmdline[0], cmdline[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

if (flags.help || cmd === 'help') { console.log(HELP); process.exit(0); }

if (cmd === 'start') {
  const { startServer, stopBackgroundWork } = await import('../server/index.mjs');
  const { abortRunning } = await import('../core/tasks.mjs');
  const cfg = loadConfig();
  let started;
  try { started = await startServer({ port: flags.port ? Number(flags.port) : undefined }); }
  catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
    const p = flags.port ? Number(flags.port) : cfg.port;
    console.error(`port ${p} is already in use — Conductor is probably already running at http://127.0.0.1:${p}. Open it, or stop it with: conductor stop`);
    process.exit(1);
  }
  const { url, port } = started;
  writePidFile({ port, url, startedAt: new Date().toISOString() }); // so `conductor stop` (and the UI Quit button) can find this process
  console.log(`Conductor 2.0 running at ${url}   (state: ${stateDir()})`);
  console.log('Stop it with:  conductor stop   (or the Quit button in the UI, or Ctrl+C here)');
  if (!flags['no-open'] && cfg.openBrowser) openBrowser(url);
  const stop = () => { clearPidFile(); try { stopBackgroundWork(); } catch {} abortRunning({ requeue: true }); setTimeout(() => process.exit(0), 1500); }; // in-flight tasks resume on next start
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (cmd === 'stop') {
  // Kill a running conductor server started with `conductor start` (its pid is in the state dir); /T covers its process tree, so no extra cleanup is needed.
  let info = null;
  try { info = JSON.parse(readFileSync(PID_FILE(), 'utf8')); } catch {}
  if (!info?.pid) { console.error(`no running conductor found (${PID_FILE()} missing). If it's still up, close its window or find it by port 47474.`); process.exit(1); }
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(info.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(info.pid, 'SIGTERM');
    clearPidFile();
    console.log(`Stopped conductor (pid ${info.pid}${info.port ? `, port ${info.port}` : ''}).`);
  } catch (e) { console.error(`could not stop pid ${info.pid}: ${e.message} (already gone?)`); clearPidFile(); process.exit(1); }
  process.exit(0);
} else if (cmd === 'doctor') {
  const { doctorReport } = await import('../server/index.mjs');
  const r = await doctorReport();
  for (const row of r.rows) console.log(`${row.name.padEnd(20)} ${String(row.value).padEnd(28)} ${row.status}${row.path ? `   (${row.path})` : ''}`);
  console.log('\nCapability index (programs a worker is told about, by task category; missing ones are offered, never installed):');
  for (const c of r.capabilities) console.log(`${c.name.padEnd(20)} ${c.categories.join(',').padEnd(28)} ${c.status}`);
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  process.exit(0);
} else if (cmd === 'models' || cmd === 'limits') {
  const { getModels, refreshModels } = await import('../core/models.mjs');
  const { getLimits, refreshLimits } = await import('../core/limits.mjs');
  const { formatModels, formatLimits } = await import('../core/tools.mjs');
  if (cmd === 'models') { const r = flags.refresh || !getModels().updatedAt ? await refreshModels() : getModels(); console.log(flags.json ? JSON.stringify(r, null, 2) : formatModels(r)); }
  else { const r = flags.refresh || !getLimits().updatedAt ? await refreshLimits() : getLimits(); console.log(flags.json ? JSON.stringify(r, null, 2) : formatLimits(r)); }
  process.exit(0);
} else if (cmd === 'bench') {
  const { dueForBench, runBench, formatBench } = await import('../core/bench.mjs');
  const { getModels, refreshModels } = await import('../core/models.mjs');
  if (flags.refresh || !getModels().updatedAt) await refreshModels();
  const days = flags.days ? Number(flags.days) : undefined;
  console.log(formatBench(dueForBench({ days })));
  if (flags.run) {
    const { abortRunning, flushRecords, listTasks } = await import('../core/tasks.mjs');
    const open = listTasks({ limit: Infinity }).filter((t) => !['done', 'failed', 'canceled'].includes(t.status));
    if (open.length) { console.error(`refusing to run: ${open.length} open task(s) in the journal (a running server owns them).`); process.exit(2); }
    process.on('SIGINT', () => { abortRunning(); setTimeout(() => process.exit(130), 1000); });
    const results = await runBench({ days, onResult: (r) => console.log(`${r.verdict.padEnd(7)} ${r.provider}:${r.model || 'default'}:${r.effort || 'default'}  ${r.task}${r.notes ? `  ${r.notes.split('\n')[0].slice(0, 100)}` : ''}`) });
    await flushRecords();
    for (const r of results) console.log(`${r.provider}:${r.model}:${r.effort || 'default'}  probe ${r.probe}${r.battery ? `  battery ${r.battery}` : ''}${r.probe !== 'pass' && r.notes ? `  (${r.notes.slice(0, 80)})` : ''}`);
  }
  process.exit(0);
} else if (cmd === 'scores') {
  const { summarize, formatScores, scoresCsv, voidTask, rootRuns } = await import('../core/scorecard.mjs');
  if (flags['void-env']) {
    // Exclude smoke runs the harness failed (sandbox denied the workspace) — the model never got to work.
    const { envFailure } = await import('../core/smoke/index.mjs');
    const { readJson } = await import('../core/paths.mjs');
    let n = 0;
    for (const c of rootRuns({ source: 'smoke' })) for (const a of c.attempts) {
      if (a.verdict !== 'fail') continue;
      const t = readJson(join(stateDir(), 'tasks', `${a.taskId}.json`));
      const why = t && envFailure(t);
      if (why) { voidTask(a.taskId, `environment: ${why}`); n++; console.log(`voided ${a.taskId} ${a.sel} ${a.category}@${a.difficulty}: ${why}`); }
    }
    console.log(`${n} run(s) voided`);
  }
  const o = { category: flags.category || null, source: flags.source || null };
  if (flags.csv) process.stdout.write(scoresCsv(o)); else console.log(flags.json ? JSON.stringify(summarize(o), null, 2) : formatScores(o));
  process.exit(0);
} else if (cmd === 'smoke') {
  const { runSmoke, formatSmoke, SMOKE_TASKS } = await import('../core/smoke/index.mjs');
  const { parseSelection } = await import('../core/conductor.mjs');
  const { getModels, refreshModels } = await import('../core/models.mjs');
  const { abortRunning, flushRecords, listTasks } = await import('../core/tasks.mjs');
  // This process runs its own scheduler over the shared journal; a live server's open tasks would be run twice.
  const open = listTasks({ limit: Infinity }).filter((t) => !['done', 'failed', 'canceled'].includes(t.status));
  if (open.length) { console.error(`refusing to run: ${open.length} task(s) are queued/running/parked in ${stateDir()} (a running server owns them). Wait for them or stop the server first.`); process.exit(2); }
  let models;
  if (flags['all-models']) {
    const reg = getModels().updatedAt ? getModels() : await refreshModels();
    const { priceFor } = await import('../core/priors.mjs');
    const proxy = (m) => { const p = priceFor(m.provider, m.id); return p ? p.in + p.out : Infinity; }; // cheapest first, unpriced last
    models = reg.models.filter((m) => m.kind === 'agent' && reg.providers[m.provider]?.status === 'ok').sort((a, b) => proxy(a) - proxy(b)).map((m) => ({ provider: m.provider, model: m.id, effort: m.efforts?.includes('low') ? 'low' : null }));
  } else if (flags.models) {
    models = flags.models.split(',').map((s) => parseSelection(s.trim(), { provider: loadConfig().worker.provider, model: null, effort: null }));
  } else {
    console.error(`usage: conductor smoke --models provider:model[:effort][,...] | --all-models  [--tasks id,id] [--keep]\ntasks: ${SMOKE_TASKS.map((t) => t.id).join(', ')}`);
    process.exit(2);
  }
  const tasks = flags.tasks ? flags.tasks.split(',').map((s) => s.trim()).filter(Boolean) : null;
  process.on('SIGINT', () => { abortRunning(); setTimeout(() => process.exit(130), 1000); });
  console.log(`smoke: ${models.length} selection(s) x ${(tasks || SMOKE_TASKS).length} task(s); scorecard in ${stateDir()}`);
  const agentsMd = flags['agents-md'] ? (await import('node:fs')).readFileSync(flags['agents-md'], 'utf8') : null;
  const results = await runSmoke({ models, tasks, keep: !!flags.keep, agentsMd, variant: flags.variant || (agentsMd ? 'agents-md' : null), onResult: (r) => console.log(formatSmoke([r]).split('\n')[0]) });
  await flushRecords();
  console.log('\n' + formatSmoke(results).split('\n').slice(results.length).join('\n'));
  process.exit(0);
} else if (cmd === 'review') {
  const { runOnce, parseSelection } = await import('../core/conductor.mjs');
  const { buildReviewPrompt } = await import('../core/improve.mjs');
  const { listTasks } = await import('../core/tasks.mjs');
  // This process runs its own scheduler over the shared journal; a live server's open tasks would be run twice
  // (module load requeues parked/running -> queued). Refuse, like `smoke` and `bench --run` do.
  const open = listTasks({ limit: Infinity }).filter((t) => !['done', 'failed', 'canceled'].includes(t.status));
  if (open.length) { console.error(`refusing to run: ${open.length} open task(s) in ${stateDir()} (a running server owns them). Wait for them or stop the server first.`); process.exit(2); }
  let server, r;
  if (parseSelection(flags.model, loadConfig().conductor).provider !== 'claude') {
    process.env.CONDUCTOR_NO_POLL ??= '1';
    const { startServer } = await import('../server/index.mjs');
    ({ server } = await startServer({ port: 0 }));
  }
  try { r = await runOnce({ cwd: REPO_ROOT, prompt: buildReviewPrompt(), model: flags.model || null /* "provider:model:effort" accepted */, onText: (t) => process.stdout.write(t) }); }
  finally { server?.close(); }
  console.log(`\n[${r.kind}] ${r.text || r.message || ''}`);
  process.exit(r.isError || r.kind === 'error' ? 1 : 0);
} else if (cmd === 'update') {
  const { updateStatus, applyUpdate, formatUpdate } = await import('../core/update.mjs');
  const st = updateStatus();
  console.log(formatUpdate(st));
  if (!flags.check && st.git && !st.error && st.behind) {
    try {
      const r = applyUpdate();
      console.log(`Updated ${r.from} → ${r.to} (${r.commits} commit(s))${r.npmInstalled ? ', dependencies installed' : ''}. Restart Conductor to run the new version.`);
    } catch (e) { console.error(e.message); process.exit(1); }
  }
  process.exit(st.error && st.git ? 1 : 0);
} else if (cmd === 'feedback') {
  const { writeFeedback, issuesUrl } = await import('../core/feedback.mjs');
  const f = writeFeedback();
  const url = issuesUrl();
  console.log(`Wrote ${f}\n(no keys, paths or e-mail addresses in it — open it and check if you like)`);
  if (url) { console.log(`Attach it to a new issue: ${url}/new?title=Feedback`); if (!flags['no-open']) openBrowser(`${url}/new?title=Feedback&body=${encodeURIComponent('What happened / what would help:\n\n\n(attach the Conductor-feedback-*.json from your Desktop)')}`); }
  process.exit(0);
} else if (cmd === 'share') {
  const out = join(homedir(), 'Desktop', 'Conductor-2.0-share.zip');
  // Zip what git tracks at HEAD, never the disk: local state (.state/), *.local.* files and anything untracked cannot ship.
  const { findCli } = await import('../core/proc.mjs');
  try { execFileSync(findCli('git') || 'git', ['-C', REPO_ROOT, 'archive', '--format=zip', '-o', out, 'HEAD'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
  catch (e) { console.error(`share needs git and a git checkout of Conductor (${String(e.stderr || e.message).trim().split('\n')[0]}).\nSend your friend the repository link instead: ${JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).repository.url}`); process.exit(1); }
  console.log(`Wrote ${out}\nYour friend unzips it, runs share/install.cmd (or install.sh), then logs in with: claude auth login  and  codex login`);
} else {
  console.error(`unknown command ${cmd}\n${HELP}`); process.exit(2);
}
