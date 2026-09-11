# Tests

Node's built-in test runner covers the engine, providers, workers and HTTP server. Run `npm test` from the repository root, or `node --test test/<name>.test.mjs` for one module.

Import `_env.mjs` first: it supplies `HOME` and `tmpDir()`, isolates the journal/configuration and disables scheduling and polling. Scheduler tests must restore those flags. Use temporary repositories for Git checks and stubs for worker/API calls; never use the live state directory or server.
