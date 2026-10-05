// One session's tool table, in the order models already see, plus the three adapters and Claude subagents.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { defs as delegationDefs } from './delegation.mjs';
import { defs as jobDefs } from './jobs.mjs';
import { defs as planDefs } from './plans.mjs';
import { defs as infoDefs } from './info.mjs';

/**
 * The tool table for one conductor session. Each entry: { name, description, schema (zod object), handler(args) -> string }.
 * `rate_task` is defined with the task tools but listed after the job tools, which is where it has always been.
 * `opts` may also carry the task, scorecard, capability and plan bindings imported by `../tools.mjs`.
 */
export function conductorToolDefs(opts) {
  const delegation = delegationDefs(opts);
  const rateAt = delegation.findIndex((d) => d.name === 'rate_task');
  return [
    ...delegation.slice(0, rateAt),
    ...jobDefs(opts),
    ...delegation.slice(rateAt),
    ...infoDefs(opts),
    ...planDefs(opts),
  ];
}

const jsonSchema = (schema) => { const s = z.toJSONSchema(schema); delete s.$schema; return s; };

/** Claude Agent SDK in-process MCP server. */
export function conductorTools(opts) {
  return createSdkMcpServer({
    name: 'conductor',
    version: '2.0.0',
    alwaysLoad: true, // delegation tools are the point; never hide them behind tool search
    instructions: `Workbench tools. Worker selection is empirical: tag delegate calls with category + difficulty and omit provider/model to let the scorecard pick; when the scorecard has no qualified plan the delegate is refused — name a provider/model explicitly (which always runs and seeds the scorecard) or do small work yourself. Rate finished tasks with rate_task. Tasks run in ${opts.cwd}.`,
    tools: conductorToolDefs(opts).map((d) => tool(d.name, d.description, d.schema.shape, async (args) => ({ content: [{ type: 'text', text: String(await d.handler(args)) }] }))),
  });
}

/** MCP `tools/list` shape (for the streamable-HTTP endpoint used by Codex conductors). */
export const toolsAsMcp = (defs) => defs.map((d) => ({ name: d.name, description: d.description, inputSchema: jsonSchema(d.schema) }));

/** OpenAI function-calling shape (for loop conductors). */
export const toolsAsFunctions = (defs) => defs.map((d) => ({ def: { name: d.name, description: d.description, parameters: jsonSchema(d.schema) }, impl: (args) => d.handler(d.schema.parse(args || {})) }));

/** Claude-family subagents available to a Claude conductor through the built-in Agent tool. */
export const CONDUCTOR_AGENTS = {
  'haiku-swarm': {
    description: 'Cheap, fast Claude worker for reading, searching, summarizing and small mechanical edits. Spawn several in parallel for fan-out.',
    prompt: 'You are a fast worker in a swarm. Do exactly the narrow task you were given, verify what you can, and return a compact result (facts, file paths, line numbers). No speculation, no scope creep.',
    model: 'haiku',
  },
  'sonnet-worker': {
    description: 'Mid-strength Claude worker for self-contained coding tasks when Codex is unavailable or the task needs Claude Code tools/skills.',
    prompt: 'You are a coding worker. Follow the spec exactly, run the verification command, and end with a report: done / files changed / verified / doubts.',
    model: 'sonnet',
  },
  reviewer: {
    description: 'Adversarial reviewer for diffs: finds bugs, security issues, unverified claims and scope creep. Read-only plus running tests.',
    prompt: 'You are an adversarial code reviewer. Read the diff and the surrounding code, run the tests, and report only real problems ranked by severity with file:line references. Say "no findings" when the change is sound.',
    model: 'inherit',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
};
