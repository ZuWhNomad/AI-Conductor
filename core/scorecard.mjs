// Scorecard: what each model actually cost (tokens -> shadow dollars at API list price, plus the % of
// its provider window) and how well it did (the conductor's verdict) per task category and
// difficulty. Append-only ndjson. `recommend` turns the data into a *plan*: one model, or a ladder
// (cheap model first, stronger model on fail), chosen by utility = value-of-quality - expected cost.
//
// Split into core/scorecard/ (ledger -> summary -> recommend -> report, each importing only the ones before it);
// this module re-exports the whole surface so existing imports keep working. New code imports the module it needs.
export * from './scorecard/ledger.mjs';
export * from './scorecard/summary.mjs';
export * from './scorecard/recommend.mjs';
export * from './scorecard/report.mjs';
export { providerWindows } from './limits.mjs';
