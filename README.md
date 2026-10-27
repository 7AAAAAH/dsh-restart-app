# dsh-restart-app

A restart button in the DeepSeek Harness title strip, just right of the sidebar
toggle. One click stops the whole desktop application — Electron shell, Host,
renderers, tool subprocesses — and starts it again, then reloads the page into
the fresh instance.

![The restart button in the title strip](assets/screenshot-1.png)

Built for the packaged **Windows desktop** app. On any other Host (`dsh web`,
`dsh tui`, a plain Node process) the button hides itself: there is nothing to
restart, and a browser session must never be able to kill its own terminal.

## Why a plugin instead of Alt+F4

Reloading the page is not enough when the Host is wedged: the Host owns the
session, the tool subprocesses and the plugin state. Restarting it by hand means
finding the right window, quitting, waiting, and reopening — and on Windows the
application leaves a tree of `DeepSeek Harness.exe` children behind if you only
close one of them.

This plugin restarts the application from the inside, which lets it stop *every*
process of the application and none of the others.

## Install

From this repository:

```powershell
dsh plugin --profile desktop add github:7AAAAAH/dsh-restart-app
```

From a checkout:

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-restart-app
```

A `link:` install is treated as local development by the plugin manager: it is
labelled `local` and never updates itself. Install from `github:` (or from npm,
once the package is published) to get the released source and update checks.

Then **restart the application once** so the profile picks the plugin up. From
then on the button lives in the top-left strip, right of the sidebar toggle.

Uninstall:

```powershell
dsh plugin --profile desktop remove dsh-restart-app
```

## Where the button sits

The button is a glyph in the window's top-left strip, immediately right of the
sidebar toggle. It registers into `shell.overlay` rather than the sidebar foot:
the foot is hidden while the sidebar is collapsed, and the sidebar package's
`shell.leading` seat is only rendered on macOS. `shell.overlay` is a full-window
layer whose direct children get `pointer-events: auto`, so an absolutely
positioned button there sits in the titlebar without disturbing the layout.

The application's own menu strip starts at `--dsh-windows-menu-start` (48px) —
exactly where the button goes — so the plugin's stylesheet pushes that variable
to the right of the button: 84px normally, 120px while the sidebar is collapsed
(the collapsed layout parks its new-session button at 48px, so the button itself
moves to 84px there). The rules repeat the `data-windows-titlebar` attribute to
outrank the sidebar package's own `:has()` rule, which would otherwise slide the
menu back under the button.

## What one click does

1. `POST /dsh-restart-app/restart` → the Host answers `202` immediately.
2. The Host writes two PowerShell scripts under `%TEMP%\dsh-restart-app\<stamp>\`
   and starts the *stage*.
3. The stage `Start-Process`es the real helper and exits, so the helper has no
   live ancestor left inside the application by the time the application dies.
4. The helper waits 900 ms (long enough for the HTTP response to flush), stops
   every process whose image name is the application's or whose executable lives
   under the application directory, waits for the process table to clear, and
   starts the executable again with `Start-Process`.
5. Five seconds later it records whether the new application survived, then
   exits.
6. The page polls its own origin once a second. It waits for the server to go
   down *and* come back before reloading: the helper sleeps before it kills
   anything, so an early successful probe is still the old process.

The helper's log is the first place to look when something goes wrong:

```
%TEMP%\dsh-restart-app\<stamp>\helper.log
```

```
2026-10-23T17:59:01.7560041+08:00 helper start pid=21416
2026-10-23T17:59:03.0707319+08:00 stopping 1 application process(es): 25428
2026-10-23T17:59:03.3103882+08:00 application processes are gone
2026-10-23T17:59:03.8181757+08:00 relaunching C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe
2026-10-23T17:59:03.9243984+08:00 relaunched pid=24200
2026-10-23T17:59:08.9546037+08:00 relaunched application is alive after 5s (pid=24200)
2026-10-23T17:59:08.9556013+08:00 helper done
```

## The two things that make this hard on Windows

**Surviving the kill.** The helper cannot be a child of the Host: stopping the
Host's tree would stop the helper too. A Node `detached: true` spawn and a
`stdio: 'ignore'` spawn are both reaped at once on this platform (the child exits
0 and does nothing). What does work is an ordinary child that `Start-Process`es
the helper and exits — a helper whose parent is already gone is not part of
anybody's tree.

**Inheriting a usable environment.** The relaunched application must start with
the environment the user started it with. The first version of this plugin wrote
that environment to a JSON file and rebuilt it in PowerShell; that is a trap.
PowerShell 5.1 decodes a BOM-less file as the ANSI code page, so a `PATH` with a
non-ASCII directory either turns into mojibake or makes `ConvertFrom-Json` throw
— after `EnvironmentVariables.Clear()`, which leaves the application with an
*empty* environment. With no `TEMP`, the Electron shell resolves its own
native-addon cache against `os.tmpdir()`, which is then the literal relative path
`undefined\temp`, and the Host dies before it is ready:

```
dsh: host preparation failed: No usable native binding found for
node-addon-require-builtin-win32-x64-msvc (auto)
```

So the helper never copies the environment: it already has it (Host → helper),
and all it does is delete the two markers that would make the shell behave like a
Node runtime (`ELECTRON_RUN_AS_NODE`, `DSH_DESKTOP_NODE_EXECUTABLE`). It also
falls back to a sane `TEMP` if one is ever missing, because that single missing
variable is the difference between a working app and that crash dialog.

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host half: the two routes, and starting the stage. |
| `scripts.js` | `restart.ps1` / `stage.ps1` text and the desktop check — pure functions, no `ctx`, no I/O. |
| `client.js` | Client half: the title-strip button, its states, its dictionaries. |
| `cordis.patch.yml` | The bundle patch that inserts the plugin into a profile. |
| `locale/*.json` | Plugin-manager metadata only; runtime strings live in `client.js`. |
| `assets/` | Marketplace icon (256×256 PNG) and the title-strip screenshot. |
| `screenshots.json` | Which repository screenshots the marketplace lists. |
| `test/render.mjs` | Dependency-free assertions on the generated scripts. |

`test/` ships with the repository, not with the package: run the assertions from
a checkout, not from `node_modules`.

```powershell
node test/render.mjs
```

## Requirements

- Windows 10/11, the packaged DeepSeek Harness desktop app.
- PowerShell 5.1 (present on every supported Windows).
- Node 20+ for the Host side.

## License

MIT
