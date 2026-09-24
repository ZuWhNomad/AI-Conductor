# scripts/launcher/ — source of the double-click Conductor.exe

**New here? Read the root `AGENTS.md` first** (repo rules). Notes and plans live in the user's notes location, not here.

**Purpose.** The launcher a non-technical user double-clicks. `Conductor.cs` is a small WinForms program: it finds
Node, starts `bin/conductor.mjs`, waits for the port, opens the browser, and shows a tray/dialog if that fails.
`make-icon.ps1` generates `conductor.ico`; `build-launcher.cmd` (parent folder) compiles the `.exe` into the repo root.

**Invariants.**
- **Resolve everything relative to the executable's own location.** The launcher must keep working when the folder is
  renamed, moved to another drive, or reached through a junction.
- A checkout with its own `.state/` folder is a self-contained instance: the launcher must not force the shared home.
- Fail loudly and in words a user can act on ("Node.js 22+ is required…"), never a silent exit.
- Child exit code 0 is a deliberate Quit or an update relaunch: re-read `server.pid`, probe `/api/state` for up to
  20 s, and follow that pid if it answers; otherwise close quietly. Non-zero still shows the error dialog.
- Keep it dependency-free C#: it compiles with the .NET Framework compiler already on Windows.

**How to test.** Rebuild with `scripts\build-launcher.cmd`, double-click the produced `Conductor.exe` from a copy of
the repo in another folder, and confirm it opens the UI on that checkout's port. Not covered by `npm test`.
