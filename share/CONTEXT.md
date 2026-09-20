# share/ — first-run installers for someone you hand this to

**New here? Read the root `AGENTS.md` first** (repo rules). Plans, reviews and notes stay out of this repo.

**Purpose.** `install.cmd` (Windows) and `install.sh` (macOS/Linux): check for Node, install dependencies, create a
launcher, and say what to do next. They are what a friend runs after unzipping `conductor share`'s output.

**Invariants.**
- **The audience has never seen a terminal.** Every failure must name the missing thing and where to get it, then
  pause so the window does not vanish.
- No assumption about where the folder is: resolve from the script's own path.
- They install dependencies and nothing else — no global installs, no PATH edits, no admin rights.
- They must stay in step with `conductor share` (`bin/conductor.mjs`), which zips what git tracks.

**How to test.** `node bin/conductor.mjs share`, unzip the result somewhere else, run the installer there, and start
the app. Not covered by `npm test`: it is an end-to-end check on a clean folder.
