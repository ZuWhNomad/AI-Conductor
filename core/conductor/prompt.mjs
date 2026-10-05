// Policy prompts for a conductor chat: the shared playbook, the framework index, and the per-runtime variant.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.ts';
import { frameworkIndex } from '../recipes.mjs';

const prompt = (f) => readFileSync(join(REPO_ROOT, 'core', 'policy', 'prompts', f), 'utf8');
// Policy + the structural playbook (model-agnostic). {{CONDUCTOR_DOCS}} is this install's docs/, whatever the chat's cwd.
export const PROMPT = (prompt('conductor.md') + `\n\n${frameworkIndex()}\nFrameworks are optional starting methods; fetch one with the framework tool when it fits, deviate when the task gives a reason.` + '\n\n' + prompt('orchestration.md')).replaceAll('{{CONDUCTOR_DOCS}}', () => join(REPO_ROOT, 'docs'));
export const PROMPT_CODEX = prompt('conductor-codex.md');
export const PROMPT_LOOP = prompt('conductor-loop.md');
