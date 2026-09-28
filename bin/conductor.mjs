#!/usr/bin/env node
// Conductor 2.0 CLI. `conductor` starts the workbench; see `conductor help`.
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT, stateDir, statePath, redact, readJson } from '../core/paths.mjs';
import { loadConfig } from '../core/config.mjs';

const PID_FILE = () => statePath('server.pid');
const writePidFile = (info) => { try { writeFileSync(PID_FILE(), JSON.stringify({ pid: process.pid, ...info }, null, 2)); } catch {} };
const clearPidFile = () => { try { unlinkSync(PID_FILE()); } catch {} };
function pidServer() {
  const info = readJson(PID_FILE());
  const port = info?.port || loadConfig().port;
  return { info, port, base: info?.url || `http://127.0.0.1:${port}` };
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' }, 'no-open': { type: 'boolean' }, refresh: { type: 'boolean' }, model: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    cwd: { type: 'string' }, gpu: { type: 'boolean' },
    models: { type: 'string' }, 'all-models': { type: 'boolean' }, tasks: { type: 'string' }, keep: { type: 'boolean' }, category: { type: 'string' }, source: { type: 'string' }, archived: { type: 'boolean' }, 'void-env': { type: 'boolean' }, distill: { type: 'boolean' }, out: { type: 'string' }, csv: { type: 'boolean' }, 'agents-md': { type: 'string' }, variant: { type: 'string' }, run: { type: 'boolean' }, days: { type: 'string' }, check: { type: 'boolean' }, 'prune-days': { type: 'string' },
    hypothesis: { type: 'string' }, mechanism: { type: 'string' }, branch: { type: 'string' }, repeats: { type: 'string' }, heldout: { type: 'string' }, 'state-dir': { type: 'string', multiple: true }, verdict: { type: 'string' }, note: { type: 'string' },
  },
});
const cmd = positionals[0] || 'start';

const HELP = `conductor 2.0 — multi-model orchestration workbench

  conductor [start] [--port N] [--no-open]   start the local server + open the browser UI
  conductor doctor                           check Node, Claude login, Codex login
  conductor models [--refresh] [--json]      list models across providers
  conductor limits [--refresh] [--json]      show usage limits per provider
  conductor scores [--category C] [--source live|smoke] [--archived] [--json|--csv] [--void-env]
                                             scorecard: quality, $ and % of window per model, category and level;
                                             --archived shows only archived history; --void-env excludes smoke runs the sandbox blocked
  conductor scores --distill [--out FILE]    write aggregate smoke cells safe to ship (default core/policy/batteries.json)
  conductor smoke --models p:m[:e],...  | --all-models  [--tasks id,id] [--keep] [--agents-md FILE --variant NAME]
                                             run the smoke battery against models to seed the scorecard (spends budget)
  conductor bench [--run] [--days N] [--refresh]
                                             models with no battery or a stale one (default 21 days); --run probes then batteries them
  conductor review [--model M]               headless self-review of this workbench from the improvement log
  conductor share                            zip the committed files (what git tracks) to your Desktop
  conductor update [--check]                 pull the latest version from GitHub (fast-forward + npm install when needed); --check only reports
  conductor cli-update [provider] [--check]  update worker CLIs (codex, antigravity, grok; claude = the Agent
                                             SDK, dev checkout only) to their latest stable release once idle, verified and
                                             rolled back on failure; --check only reports
  conductor stop                             stop the local server (POST /api/shutdown; pid-file fallback only if /api/state matches)
  conductor job start [--cwd DIR] [--gpu] -- CMD…
                                             run a long command detached; set --gpu for GPU-heavy work
  conductor job status ID | job cancel ID    its exit code and output tail, or stop it (needs the running server)
  conductor experiment new <id> --hypothesis "..." --mechanism "..." [--branch B] [--tasks t1,t2] [--heldout t3,t4] [--repeats 3]
  conductor experiment list
  conductor experiment report <id> [--state-dir DIR]... [--json] [--verdict keep-a|keep-b|void --note "..."]
                                             record and compare A/B scorecard arms (CONDUCTOR_EXPERIMENT=<id>:<arm>)
  conductor worktrees [--prune-days N]       list isolate:true worktrees (task id, branch, status, age); prune ended chains older than N days (worktrees only, not branches)
  conductor feedback [--no-open]             write a redacted feedback bundle (versions, limits, improvement log, scores)
                                             to your Desktop and open the issue page to attach it
  conductor help`;

function openBrowser(url) {
  const cmdline = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmdline[0], cmdline[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

function desktopDir() {
  const candidates = [join(homedir(), 'Desktop')];
  if (process.env.ONEDRIVE) candidates.push(join(process.env.ONEDRIVE, 'Desktop'));
  candidates.push(join(homedir(), 'OneDrive', 'Desktop'), homedir());
  return candidates.find((p) => existsSync(p)) || homedir();
}

if (flags.help || cmd === 'help') { console.log(HELP); process.exit(0); }

if (cmd === 'start') {
  // A non-zero exit leaves a line in crash.log (stderr is lost when not started by the launcher). Non-fatal uncaught
  // errors are logged to improvements.ndjson by installGlobalErrorCapture and do not exit; a hard kill leaves no trace.
  let lastError = null;
  process.on('uncaughtExceptionMonitor', (e, origin) => { lastError = `${origin}: ${e?.stack || e}`; });
  process.on('exit', (code) => { if (code) try { appendFileSync(statePath('crash.log'), redact(`${new Date().toISOString()} pid ${process.pid} exit code ${code}: ${lastError || 'no uncaught error recorded (process.exit call)'}\n`)); } catch {} });
  // The launcher copies stdout/stderr into launcher.log: redact on the way out.
  for (const out of [process.stdout, process.stderr]) { const write = out.write.bind(out); out.write = (chunk, ...rest) => write(typeof chunk === 'string' ? redact(chunk) : chunk, ...rest); }
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
  process.on('SIGHUP', stop);
} else if (cmd === 'stop') {
  const { info, port, base } = pidServer();
  if (!info?.pid) { console.error(`no running conductor found (${PID_FILE()} missing). If it's still up, close its window or find it by port ${port}.`); process.exit(1); }
  const stopped = () => { console.log(`Stopped conductor (pid ${info.pid}, port ${port}).`); process.exit(0); };
  try {
    const r = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (r.ok) { clearPidFile(); stopped(); }
  } catch {}
  try {
    const r = await fetch(`${base}/api/state`);
    if (r.ok) {
      const body = await r.json().catch(() => ({}));
      if (body.pid == null || body.pid === info.pid) {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(info.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(info.pid, 'SIGTERM');
        clearPidFile();
        stopped();
      }
    }
  } catch {}
  clearPidFile();
  console.error(`stale pid file removed (${PID_FILE()}); nothing matching pid ${info.pid} was listening at ${base}.`);
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
  else {
    const { limitsWithEstimates } = await import('../core/usage-estimate.mjs');
    if (flags.refresh || !getLimits().updatedAt) await refreshLimits();
    const r = limitsWithEstimates();
    console.log(flags.json ? JSON.stringify(r, null, 2) : formatLimits(r));
  }
  process.exit(0);
} else if (cmd === 'bench') {
  const { dueForBench, runBench, formatBench } = await import('../core/bench.mjs');
  const { getModels, refreshModels } = await import('../core/models.mjs');
  if (flags.refresh || !getModels().updatedAt) await refreshModels();
  const days = flags.days ? Number(flags.days) : undefined;
  console.log(formatBench(dueForBench({ days })));
  if (flags.run) {
    const { abortRunning, flushRecords, openTaskCount } = await import('../core/tasks.mjs');
    const open = openTaskCount();
    if (open) { console.error(`refusing to run: ${open} open task(s) in the journal (a running server owns them).`); process.exit(2); }
    process.on('SIGINT', () => { abortRunning(); setTimeout(() => process.exit(130), 1000); });
    const results = await runBench({ days, onResult: (r) => console.log(`${r.verdict.padEnd(7)} ${r.provider}:${r.model || 'default'}:${r.effort || 'default'}  ${r.task}${r.notes ? `  ${r.notes.split('\n')[0].slice(0, 100)}` : ''}`) });
    await flushRecords();
    for (const r of results) console.log(`${r.provider}:${r.model}:${r.effort || 'default'}  probe ${r.probe}${r.battery ? `  battery ${r.battery}` : ''}${r.probe !== 'pass' && r.notes ? `  (${r.notes.slice(0, 80)})` : ''}`);
  }
  process.exit(0);
} else if (cmd === 'scores') {
  const { summarize, formatScores, scoresCsv, voidTask, rootRuns, envFailure, distillBatteries } = await import('../core/scorecard.mjs');
  if (flags.distill) {
    const r = distillBatteries({ out: flags.out });
    console.log(`distilled ${r.cells} aggregate cell(s) to ${r.file} (${r.bytes} bytes)`);
    process.exit(0);
  }
  if (flags['void-env']) {
    // Exclude smoke runs the harness failed (sandbox denied the workspace) — the model never got to work.
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
  const o = { category: flags.category || null, source: flags.source || null, archived: !!flags.archived };
  if (flags.csv) process.stdout.write(scoresCsv(o)); else console.log(flags.json ? JSON.stringify(summarize(o), null, 2) : formatScores(o));
  process.exit(0);
} else if (cmd === 'smoke') {
  const { runSmoke, formatSmoke, SMOKE_TASKS } = await import('../core/smoke/index.mjs');
  const { parseSelection } = await import('../core/conductor.mjs');
  const { getModels, refreshModels } = await import('../core/models.mjs');
  const { abortRunning, flushRecords, openTaskCount } = await import('../core/tasks.mjs');
  // This process runs its own scheduler over the shared journal; a live server's open tasks would be run twice.
  const open = openTaskCount();
  if (open) { console.error(`refusing to run: ${open} task(s) are queued/running/parked in ${stateDir()} (a running server owns them). Wait for them or stop the server first.`); process.exit(2); }
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
  const { openTaskCount } = await import('../core/tasks.mjs');
  // This process runs its own scheduler over the shared journal; a live server's open tasks would be run twice
  // (module load requeues parked/running -> queued). Refuse, like `smoke` and `bench --run` do.
  const open = openTaskCount();
  if (open) { console.error(`refusing to run: ${open} open task(s) in ${stateDir()} (a running server owns them). Wait for them or stop the server first.`); process.exit(2); }
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
  const st = await updateStatus();
  console.log(formatUpdate(st));
  if (!flags.check && st.git && !st.error && st.behind) {
    try {
      const r = await applyUpdate();
      if (r.npmError) {
        console.error(`Partial update: code updated ${r.from} → ${r.to} (${r.commits} commit(s)), but dependency install failed: ${r.npmError}`);
        console.error(`Run "npm install" in "${REPO_ROOT}"; restart only after the install succeeds.`);
        process.exit(1);
      }
      console.log(`Updated ${r.from} → ${r.to} (${r.commits} commit(s))${r.npmInstalled ? ', dependencies installed' : ''}. Restart Conductor to run the new version.`);
    } catch (e) { console.error(e.message); process.exit(1); }
  }
  process.exit(st.error && st.git ? 1 : 0);
} else if (cmd === 'cli-update') {
  const cu = await import('../core/cli-update.mjs');
  const ids = positionals[1] ? [positionals[1]] : cu.CLI_UPDATE_IDS;
  if (flags.check) {
    for (const id of ids) { try { console.log(cu.formatCliUpdate(await cu.checkCliUpdate(id, { manual: true }))); } catch (e) { console.error(e.message); process.exit(2); } }
    process.exit(0);
  }
  // A running server owns the task journal and knows which chats are mid-turn: install through it when it is up.
  const { base } = pidServer();
  let serverReply = null;
  try { serverReply = await fetch(`${base}/api/cli-update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: positionals[1] || null }), signal: AbortSignal.timeout(3000) }); } catch {}
  let failed = false;
  if (serverReply) {
    const j = await serverReply.json(); if (!serverReply.ok) { console.error(j.error || serverReply.status); process.exit(2); }
    console.log(`installing through the running Conductor at ${base} (a busy provider is skipped; an install is verified with a test call)…`);
    for (const id of ids) {
      let last;
      while (!((last = (await (await fetch(`${base}/api/cli-update`)).json()).providers[id]?.last) && last.at >= j.at)) await new Promise((ok) => setTimeout(ok, 3000));
      console.log(cu.formatCliUpdate({ id, ...last })); failed ||= !!last.error;
    }
  } else {
    const { flushRecords } = await import('../core/tasks.mjs');
    for (const id of ids) { const r = await cu.applyCliUpdate(id); console.log(cu.formatCliUpdate(r)); failed ||= !!r.error; }
    await flushRecords();
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === 'job') {
  // Through the running server, so it works from a sandboxed worker (the server spawns and journals the job).
  const { base } = pidServer();
  const [, sub, id] = positionals;
  const call = async (method, path, body) => {
    try { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }
    catch (e) { console.error(`job ${sub}: ${e.message} (is the Conductor server running at ${base}?)`); process.exit(1); }
  };
  const { formatJob } = await import('../core/jobs.mjs');
  if (sub === 'start' && positionals.length > 2) console.log(formatJob(await call('POST', '/api/jobs', { command: positionals.slice(2).join(' '), cwd: flags.cwd || process.cwd(), gpu: !!flags.gpu })));
  else if (sub === 'status' && id) console.log(formatJob(await call('GET', `/api/jobs/${encodeURIComponent(id)}`)));
  else if (sub === 'cancel' && id) console.log(formatJob(await call('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`)));
  else { console.error('usage: conductor job start [--cwd DIR] [--gpu] -- COMMAND…  |  job status ID  |  job cancel ID'); process.exit(2); }
  process.exit(0);
} else if (cmd === 'worktrees') {
  const { listWorktrees, formatWorktrees } = await import('../core/tasks.mjs');
  const pruneDays = flags['prune-days'] != null ? Number(flags['prune-days']) : undefined;
  if (flags['prune-days'] != null && !(Number.isFinite(pruneDays) && pruneDays >= 0)) { console.error('usage: conductor worktrees [--prune-days N]'); process.exit(2); }
  console.log(formatWorktrees(await listWorktrees({ pruneDays })));
  process.exit(0);
} else if (cmd === 'feedback') {
  const { writeFeedback, issuesUrl } = await import('../core/feedback.mjs');
  const f = writeFeedback(desktopDir());
  const url = issuesUrl();
  console.log(`Wrote ${f}\n(no keys, paths or e-mail addresses in it — open it and check if you like)`);
  if (url) { console.log(`Attach it to a new issue: ${url}/new?title=Feedback`); if (!flags['no-open']) openBrowser(`${url}/new?title=Feedback&body=${encodeURIComponent('What happened / what would help:\n\n\n(attach the Conductor-feedback-*.json from your Desktop)')}`); }
  process.exit(0);
} else if (cmd === 'experiment') {
  const exp = await import('../core/experiment.mjs');
  const sub = positionals[1], id = positionals[2];
  try {
    if (sub === 'new' && id) {
      const rec = exp.createExperiment({ id, hypothesis: flags.hypothesis, mechanism: flags.mechanism, branch: flags.branch, tasks: flags.tasks, heldout: flags.heldout, repeats: flags.repeats });
      console.log(flags.json ? JSON.stringify(rec, null, 2) : exp.formatRecord(rec));
    } else if (sub === 'list') {
      const list = exp.listExperiments();
      console.log(flags.json ? JSON.stringify(list, null, 2) : exp.formatList(list));
    } else if (sub === 'report' && id) {
      const r = exp.reportExperiment(id, { stateDirs: flags['state-dir'] });
      if (flags.verdict) r.verdict = exp.setVerdict(id, flags.verdict, flags.note).verdict;
      console.log(flags.json ? JSON.stringify(r, null, 2) : exp.formatReport(r));
    } else {
      console.error('usage: conductor experiment new <id> --hypothesis "..." --mechanism "..." [--branch B] [--tasks t1,t2] [--heldout t3,t4] [--repeats 3]\n       conductor experiment list\n       conductor experiment report <id> [--state-dir DIR]... [--json] [--verdict keep-a|keep-b|void --note "..."]');
      process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(2); }
  process.exit(0);
} else if (cmd === 'share') {
  const out = join(desktopDir(), 'Conductor-2.0-share.zip');
  // Zip what git tracks at HEAD, never the disk: local state (.state/), *.local.* files and anything untracked cannot ship.
  const { findCli } = await import('../core/proc.mjs');
  try { execFileSync(findCli('git') || 'git', ['-C', REPO_ROOT, 'archive', '--format=zip', '-o', out, 'HEAD'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
  catch (e) { console.error(`share needs git and a git checkout of Conductor (${String(e.stderr || e.message).trim().split('\n')[0]}).\nSend your friend the repository link instead: ${JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).repository.url}`); process.exit(1); }
  console.log(`Wrote ${out}\nYour friend unzips it, runs share/install.cmd (or install.sh), then logs in with: claude auth login  and  codex login`);
} else {
  console.error(`unknown command ${cmd}\n${HELP}`); process.exit(2);
}
