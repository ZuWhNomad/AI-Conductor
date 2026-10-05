// Conductor tools, defined once and exposed three ways: Claude Agent SDK MCP server (Claude
// conductors), streamable-HTTP MCP (Codex conductors, see server/index.mjs) and OpenAI function
// tools (API-model conductors).
//
// Split into core/tools/ (_shared -> delegation -> jobs -> plans -> info -> index, each importing
// only earlier modules); this module re-exports the whole surface so existing imports keep working.
// New code imports the module it needs.
//
// The four imports below stay in THIS file. test/plans/_helpers.mjs replaces `./tasks.mjs`,
// `./scorecard.mjs`, `./capabilities.mjs` and `./plans.mjs` only when the importer is core/tools.mjs.
// Group modules receive those bindings as arguments; importing them from a group would skip the mock
// and a run_plan call would wait on the real scheduler.
import { awaitTask } from './tasks.mjs';
import { recommend } from './scorecard.mjs';
import { runPlan, getPlan } from './plans.mjs';
import { accessProviders, missingFor, shouldResearch, researchSpec, parseResearched, loadIndex } from './capabilities.mjs';
import { conductorToolDefs as groupDefs, conductorTools as buildConductorTools } from './tools/index.mjs';

const hooked = { awaitTask, recommend, runPlan, getPlan, accessProviders, missingFor, shouldResearch, researchSpec, parseResearched, loadIndex };

export function conductorToolDefs(opts) {
  return groupDefs({ ...opts, ...hooked });
}

export function conductorTools(opts) {
  return buildConductorTools({ ...opts, ...hooked });
}

export * from './tools/_shared.mjs';
export * from './tools/delegation.mjs';
export * from './tools/jobs.mjs';
export * from './tools/plans.mjs';
export * from './tools/info.mjs';
export * from './tools/index.mjs';
