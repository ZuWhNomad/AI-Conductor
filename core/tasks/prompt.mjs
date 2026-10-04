// The worker prompt. Shared, stable text first (worker preamble, MSW), task-specific text last (resume note, task,
// recipe, capability lines) so provider prompt caches hit. Reads policy text once at import; no task state.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.mjs';
import { loadConfig } from '../config.mjs';
import { contextBlock } from '../context.mjs';
import { logImprovement } from '../improve.mjs';
import { recipeFor } from '../recipes.mjs';
import { capabilityLines } from '../capabilities.mjs';
import { mcpServersFor } from '../mcp.mjs';

const WORKER_PREAMBLE = readFileSync(join(REPO_ROOT, 'core', 'policy', 'prompts', 'worker.md'), 'utf8').replaceAll('{{conductorCli}}', join(REPO_ROOT, 'bin', 'conductor.mjs'));
// MSW kernel (necessity test for every claim): measured 2026-09-09 on the battery as 5-15% faster and 3-10% fewer output tokens at equal pass rate.
const MSW = readFileSync(join(REPO_ROOT, 'core', 'policy', 'prompts', 'msw.md'), 'utf8');
const RESUME_NOTE = 'You were interrupted earlier (usage limit or restart). Continue from the current state of the files; do not redo finished work.\n\n';

export function buildPrompt(t) {
  if (t.followUpOf) return `${t.resume ? RESUME_NOTE : ''}Follow-up from the conductor on your previous work in this same thread. Address every point, re-run the verification, and report in the same format.\n\n${t.spec}`;
  const ctx = contextBlock(t.cwd, t.paths);
  const mcp = t.provider === 'codex' || t.provider === 'claude' ? Object.keys(mcpServersFor(t.category)) : [];
  const mcpNote = mcp.length ? `\n\nMCP servers available to you: ${mcp.join(', ')}. Use them for data instead of guessing.` : '';
  const msw = loadConfig().worker.msw === false ? '' : `

${MSW}

Remember to follow the MSW deletion rule for all claims - no exceptions.`;
  const recipe = recipeFor(t.category, t.variant);
  // Recipe and capability lines get SEPARATE budgets. They used to share one (`specAppendChars`), which meant a
  // recipe longer than the cap silently drove capabilityLines to maxChars:0 — the worker lost every tool line while
  // the recipe was appended unclipped. A long recipe must never be able to starve the tool index.
  const wcfg = loadConfig().worker;
  const recipeCap = wcfg.recipeChars;
  const toolsCap = wcfg.toolLineChars;
  if (recipe && recipe.length > recipeCap) logImprovement('friction', 'recipes', `recipe for '${t.category}'${t.variant ? ` (variant ${t.variant})` : ''} is ${recipe.length} chars, over the ${recipeCap} budget`, { taskId: t.id, title: t.title });
  const tools = capabilityLines(t.category, { maxChars: toolsCap, text: `${t.title || ''}\n${t.spec || ''}\n${(t.paths || []).join('\n')}` });
  return `${WORKER_PREAMBLE}${msw}${mcpNote}\n\n${ctx ? `# Project context notes\n${ctx}\n\n` : ''}${t.resume ? RESUME_NOTE : ''}# Task\n\n${t.spec}\n\nTitle: ${t.title}${recipe ? `\n\n---\n\n${recipe}` : ''}${tools ? `\n\n${tools}` : ''}`;
}
