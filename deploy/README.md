# deploy/ — pointer only

The deployment documentation moved to [`docs/DEPLOY.md`](../docs/DEPLOY.md): what runs, where it
lives, how it starts and stops, how to upgrade, roll back and uninstall, the restart policy, and
the one-time retirement of the old `LedWallAgent` / `ErrorPopups-Server` tasks.

Related:

- [`docs/TRAY.md`](../docs/TRAY.md) — the tray app and the detached supervisor, plus every file in
  `%PROGRAMDATA%\ShockBox\runtime`.
- [`docs/WIRING.md`](../docs/WIRING.md) — the machine topology, WSL loopback, and which base URL
  goes where.
- [`docs/DECK.md`](../docs/DECK.md) — the Stream Deck keys and the exact HTTP bodies they post.

The scripts in this folder start with:

| file | purpose |
|---|---|
| `ShockBox.Tray.exe` (built from `tray/ShockBox.Tray`) | what the desktop shortcut runs: the tray app, which adopts or spawns the python supervisor (`install.ps1:883-904`) |
| `install.ps1` | install / upgrade; stops what it replaces, copies the tree, migrates off the scheduled task, provisions the venv, writes the shortcut (`install.ps1:1-42`) |
| `uninstall.ps1` | stops the supervisor and server by evidence, removes shortcut, venv and a leftover `\ShockBox-Server` (`uninstall.ps1:1-32`) |
| `run.cmd` | **manual / legacy only** — a visible console with its own restart loop (`run.cmd:3-17`) |
| `ShockBox-Server.xml`, `start-hidden.vbs` | remnants of the retired logon task; `install.ps1` ends and unregisters `\ShockBox-Server` if it is still registered (`install.ps1:285-304`) |
