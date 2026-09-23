# test/ui/ — browser UI regressions

Read `../CONTEXT.md` first. `layout.test.mjs` renders the real HTML, CSS and app render functions in a headless
Chromium browser, with fixture state and no server, provider calls or real Conductor state. Node's built-in
WebSocket speaks the browser's DevTools protocol; there are no additional dependencies.

Run `node --test --import ./test/_env.mjs test/ui/layout.test.mjs` or `npm test`. The test finds Edge/Chrome at
standard installation paths, or uses `CONDUCTOR_TEST_BROWSER`. Browser cases explicitly skip if no browser is
installed. Profiles and screenshots stay in the isolated test home. Coverage: expanded/collapsed fleet and
header/composer geometry at 1920, 1000 and 375 px, SVG quit control, budget freshness/emphasis, and effort pickers.

`replay.test.mjs` runs the actual SSE handlers with stubbed transport and DOM: replay gaps and restarts refetch
state, reopen the transcript, refresh the improvement count and reconnect; contiguous cursors keep streaming.
Run `node --import ./test/_env.mjs --test test/ui/replay.test.mjs` without a browser.
