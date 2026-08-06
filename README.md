# kdco-notify-win

> Windows-only native notifications for OpenCode (fork of `@kdco/notify`, zero OCX, manual vendored).

A plugin for [OpenCode](https://github.com/sst/opencode) that delivers Windows Toast notifications when tasks complete, errors occur, the AI needs your input, or the network connection is interrupted.

This is a **Windows 10/11-only** fork. All macOS (alerter / focus detection), Linux (`notify-send`), and cmux paths have been removed. One JS file + two runtime npm packages, dropped straight into the plugins directory — no OCX, no build step.

## Install (offline-friendly)

> **Critical:** OpenCode only auto-loads plugins that are **direct `.js`/`.ts` files** in the plugins directory. It does **NOT** recurse into subdirectories. So the plugin files must be flattened into the plugins root — not nested in a `kdco-notify-win/` subfolder.

### One-command deploy (recommended)

```powershell
# Global (all projects)
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Target global

# Or project-only
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Target "E:\path\to\project"
```

Resulting layout (this is what must be in the plugins root):

```
~/.config/opencode/plugins/          (or .opencode/plugins/)
├── kdco-notify-win.js     # entry — auto-loaded
├── plugin-logger.js       # generic file logger (Diagnostic instrumentation)
├── assets/                # icon + banner
└── node_modules/          # vendored node-notifier + detect-terminal
```

### Manual copy

```powershell
# Copy the flattened contents INTO the plugins root (not as a subfolder)
copy dist\kdco-notify-win\kdco-notify-win.js  %USERPROFILE%\.config\opencode\plugins\
copy dist\kdco-notify-win\plugin-logger.js %USERPROFILE%\.config\opencode\plugins\
xcopy dist\kdco-notify-win\node_modules       %USERPROFILE%\.config\opencode\plugins\node_modules\ /E
xcopy dist\kdco-notify-win\assets             %USERPROFILE%\.config\opencode\plugins\assets\ /E

# 2. Restart OpenCode (plugins load at startup)
```

Global vs project scope:

| Scope | Entry file location |
|---|---|
| Global (all projects) | `~/.config/opencode/plugins/kdco-notify-win.js` |
| Project-only | `.opencode/plugins/kdco-notify-win.js` |

The plugin loads standalone even if deps are missing, but logs a warning instead of crashing. `dist/kdco-notify-win/node_modules` is already vendored; re-run `npm install` there only if you change deps.

## How It Works

> "Notify the human when the AI needs them back, not for every micro-event."

| Event | Notifies? | Title |
|-------|-----------|-------|
| Session complete (`session.idle`) | Yes | READY FOR REVIEW |
| Session error | Yes | SOMETHING WENT WRONG |
| Network / HTTP interruption | Yes | **NETWORK INTERRUPTED** (+ system beep) |
| Run stopped by user (ESC / cancel) | Yes (`notifyCancelled`) | **STOPPED BY YOU** |
| Session ended silently, never emitted an event | Yes (heartbeat) | **SESSION ENDED** |
| Permission needed | Yes | WAITING FOR CONFIRMATION |
| Question asked | Yes | QUESTION FOR YOU |
| Sub-task events | No (default) | Set `notifyChildSessions: true` to include |

Behavior: parent-session filtering (no sub-task spam), quiet-hours suppression, 1.5s dedupe windows, and terminal detection (for logging/context only — Windows has no focus suppression).

> **Cross-instance dedupe:** OpenCode loads plugins from both the global plugins dir and the project `.opencode/plugins` dir. If the same plugin is installed in both places, it runs as **two instances**, each with its own in-memory state. To avoid duplicate toasts, recent-notify timestamps are shared through the dedupe file `os.tmpdir()/kdco-notify-win-dedupe.json`, so all instances agree on what was just sent. If you still see duplicates, it's usually from a stale older copy of the plugin still installed somewhere.

## Network Interruption Detection

The original record asked whether the plugin can notify on **explicit** interruptions (HTTP 503/401/500/429/...) and **implicit** mid-stream disconnects (response cut while streaming).

- **Explicit** — OpenCode surfaces non-2xx status codes in `session.error`; the plugin classifies the status text.
- **Implicit** — the plugin never issues requests or reads response bodies itself, so it cannot watch a body stream directly. But when a connection dies mid-stream, undici raises `ECONNRESET` / `socket hang up` / `EPIPE` / `aborted` / `fetch failed`, which OpenCode forwards as `session.error`. Because the plugin notifies on **every** parent `session.error` and classifies that text, both interruption kinds are covered.

Classified errors use a distinct *NETWORK INTERRUPTED* title and an optional system beep (config `beepOnInterruption`).

A network failure must not be followed by a "READY FOR REVIEW" toast for the same run. Suppression is **state-driven** (not just a 1.5s time window): when a session goes idle, the plugin checks the final assistant message-part state — if the run ended in error, READY is suppressed; if it ended in a user stop, a distinct *STOPPED BY YOU* toast fires instead.

> **Boundary:** if OpenCode itself goes fully silent (no `session.error` emitted at all *and* the run stays marked running), a pure event-based plugin cannot know. The heartbeat watchdog covers the part where OpenCode *did* transition the session to a terminal state without emitting an event; if the session is still marked running, enable `heartbeat.warnWhileStalled` to be told about the stall.

## Known observations (logged, not yet investigated)

- One `INTERNET INTERRUPT` was not notified once; the most recent `NETWORK INTERRUPTED` toast at the time was at `12:00:00`. Possibly a real miss, possibly user confusion — recorded for later investigation, related to the heartbeat watchdog above.

## Fixes applied (2026-08-06, after deployment)

- **Toasts stopped appearing and the CLI printed SnoreToast's usage banner**: `buildSnoreToastArgs` used to forward click-to-open as `-application <prog> -la <args>`. The vendored SnoreToast fork does not understand `-la` — its parser prints the usage banner and exits with `-1`, so **no toast was ever shown**. Click-to-open is now handled entirely by the plugin's own named-pipe activation callback (`spawnClick`), so SnoreToast only ever receives its safe arg set (`-appID -t -m -p -s -pipeName`).
- **Repeated ESC / interrupts crashed the CLI**: the `event` and `tool.execute.before` handlers were `async` without a top-level guard, so any rejected `await` became an `unhandledRejection` (Node 15+ terminates the whole process on one). Both handlers are now wrapped in try/catch that logs and swallows, so a flaky session fetch or plugin bug can never take down OpenCode.
- **ESC showed NETWORK INTERRUPTED**: a manual interrupt surfaces as `session.error` with a bare `AbortError` whose message contains "aborted" — which the old `classifyError` treated as a network drop. New `categorizeErrorEvent` checks the error **name** first (`AbortError` / `UserInterrupt` / user-naming message → `user-cancel`), so ESC now correctly fires **STOPPED BY YOU** (or is silent when `notifyCancelled: false`).
- **Click-to-open was over-engineered**: the two mechanisms (pipe-callback `spawnClick` vs the helper script) became two distinct `clickMode` values — `"program"` (our own pipe callback) and `"native"` (SnoreToast `-application`). The `jump-to-opencode.ps1` helper and its fallback chain were deleted; click behavior is now fully described by `clickMode` + `clickProgram` + `clickArgs`.
- **Diagnostic logging added**: new `plugin-logger.js` ships with the plugin so a misclassification can be diagnosed in the field (`logging.enabled: true, "minLogLevel": "ALL"`). Also fixed the silent-stop READY path to consult a 15s suppression window and a per-run token claim, so an error/stop followed by a silent idle no longer re-fires "READY FOR REVIEW".

## Configuration (Optional)

Works out of the box. Create `~/.config/opencode/kdco-notify.json`:

```json
{
  "notifyChildSessions": false,
  "sounds": {
    "idle": "Notification.Mail",
    "error": "Notification.Reminder",
    "permission": "Notification.SMS",
    "question": "Notification.IM",
    "network": "Notification.Mail",
    "cancelled": "Notification.Mail"
  },
  "quietHours": { "enabled": false, "start": "22:00", "end": "08:00" },
  "beepOnInterruption": true,
  "showTimestamp": true,
  "showSummary": true,
  "summarySteps": 3,
  "themedIcons": true,
  "iconTheme": "legacy",
  "soundOverride": "",
  "clickMode": "off",
  "clickProgram": "",
  "clickArgs": [],
  "logging": {
    "enabled": false,
    "minLogLevel": "WARN",
    "dir": ""
  },
  "notifyCancelled": true,
  "heartbeat": {
    "enabled": true,
    "intervalSec": 30,
    "stallSec": 120,
    "warnWhileStalled": false
  }
}
```

Notes:
- **`sound`** — a Windows toast preset name in the `Notification.*` namespace (`Notification.Mail`, `Notification.Reminder`, `Notification.SMS`, `Notification.IM`, `Notification.Looping.Call`, …). Values that are NOT `Notification.*`-prefixed (the old `Glass`/`Basso`/`Submarine` names) are normalized to `Notification.Reminder`, because SnoreToast rejects bare names and shows no toast at all. Verified audible on this machine: `Mail`, `Reminder`, `SMS`, `IM`, `Looping.Call`. `Notification.Default` is **silent** on this system, so it is avoided as a default.
- **`soundOverride`** — a `Notification.*` preset name that overrides the per-kind `sound`. (SnoreToast's `-s` accepts sound URIs / `ms-winsoundevent` names; absolute `.wav` paths are not supported and are normalized to `Notification.Reminder`.)
- **`clickMode`** — what a toast click does (`"off"` default | `"program"` | `"native"`). Requires a non-empty `clickProgram` in both non-`off` modes:
  - `off` (default): clicking does nothing — the toast's activation pipe is still read, but no program is launched.
  - `program`: the plugin's own named-pipe activation callback spawns `clickProgram` with `clickArgs` (supports `{{title}}`, `{{cwd}}`, `{{sessionID}}` placeholders). Full control, host-agnostic re-open of the working directory:
    ```json
    { "clickMode": "program", "clickProgram": "wt.exe", "clickArgs": ["-w", "0", "-d", "{{cwd}}", "opencode"] }
    ```
    (`wt.exe -w 0` reuses the most recent Windows Terminal window, or opens a fresh one).
  - `native`: pass `-application <clickProgram>` straight to SnoreToast, which launches the program itself — no args, no pipe kept open, always a brand-new window. Simplest to configure but least control:
    ```json
    { "clickMode": "native", "clickProgram": "wt.exe opencode" }
    ```
  - There is no separate "helper" mode any more — the bundsed `jump-to-opencode.ps1` was removed (the click fallback/complexity it added is gone).
- **Run cancellation (ESC)** — a run stopped by the user surfaces either as a `session.error` carrying an `AbortError` (checked first via the error name) or as an idle final part in `aborted` state. Both paths produce the distinct **STOPPED BY YOU** toast with its own grey banner. Disable with `"notifyCancelled": false`.
- **Heartbeat (silent-stop watchdog)** — if a run goes quiet past `stallSec` (default 120s) and then ends **without** any `session.error`/`session.idle` event reaching the plugin, the heartbeat polls the session's real state and backfills a **SESSION ENDED** toast (body notes "not received an end signal"). `warnWhileStalled: true` additionally telegraphs a **SESSION STALLED** warning while a session is *still* running but silent past the stall. This closes the "no notification at all on silent network death" gap that pure event handling can never see. It is on by default.
- **Click-to-open implementation note** — the click handler reads the activation callback SnoreToast writes to the named pipe (previously that pipe's data was ignored and closed after 1.5s, so clicks did nothing). The pipe is now kept open for the toast's lifetime **only when a click target is configured**; the no-click path is unchanged (1.5s then release).
- **Precise-tab limitation** — Windows Terminal exposes no stable public CLI to focus an *arbitrary* tab by title. `-w 0` reuses the most recent *window* (whose title mirrors the focused tab); exact per-session tab pinning is best-effort and not guaranteed.
- **`logging`** — optional Diagnostic file logging. `enabled: true` + `minLogLevel: "ALL"` writes every classified event (`L1001` raw payload, `L2001`/`L2002` error category, `L2010`–`L2012` READY decisions, `L3001`/`L3002` toast dispatch) to `%TEMP%\kdcokenny-notify-win\{yyyy-MM-dd}-kdcokenny-notify-win.log`. `dir` overrides the folder; `minLogLevel` (`ALL`/`TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`/`NO`, default `WARN`) and `moduleLogLevels` let you gate verbosity. The config is hot-reloaded when the file changes.
- `terminal` (optional) overrides terminal auto-detection.
- **`showTimestamp`** — prepend a `[yyyy-MM-dd HH:mm:ss]` line to the notification body (default `true`).
- **`showSummary` / `summarySteps`** — for READY notifications, append a one-line summary of the last N tool steps fetched from the session (default `true`, `3`).
- **`themedIcons`** — use the per-kind colored hero banner (ready=green, error=orange, network=red, permission=yellow, question=blue, cancelled=grey) when the asset exists (default `true`).
- `quietHours` supports overnight windows (e.g. `22:00`–`08:00`).

## Development

This repo has no build tooling — the plugin in `dist/kdco-notify-win/kdco-notify-win.js` is both source and deliverable (Bun runs ESM JS directly).

```bash
# Self-test (no real notifier / OpenCode needed; fakes are injected)
node test/notify.test.mjs
node test/logger.test.mjs

# Demo: real Windows Toast (after `npm install` in dist/kdco-notify-win)
node test/demo.mjs
```

### Debugging why the plugin doesn't fire

- **Loaded?** Plugins print nothing by default. Add a temporary `console.log(...)` at the top of the plugin file, then run `opencode run --print-logs --log-level DEBUG "hi"` in any project — your log appears if (and only if) OpenCode loaded the file.
- **Event reached?** The plugin's `event` handler logs nothing today. To trace, add `console.log("[kdco-notify] event", event?.type)` inside the `event` handler and re-run.
- **Main log file:** `~/.local/share/opencode/log/opencode.log` — search it for `kdco-notify` / plugin errors.
- **Restart required:** plugins load at OpenCode startup. Restart the app (normal exit, not a hard `KILL` unless the process is hung) after deploying.

Design notes visible to maintainers:
- `createNotifyPlugin(overrides)` is a dependency-injected factory — the plugin is fully testable without `node-notifier` installed.
- Runtime deps (`node-notifier`, `detect-terminal`) are resolved lazily via `createRequire`, so the file loads even before `npm install`.

## Branded toasts

Toasts are branded with a custom app icon + hero banner:

- **App icon**: `assets/opencode-notify.ico` (flat) / `assets/legacy/legacy.ico` (legacy). On first run the plugin registers a Start Menu shortcut (`OpenCode Notify.lnk`) carrying the `OpenCode.Notify` AppUserModelID, so Windows shows our icon in the toast. The icon follows `iconTheme` (`"flat"` | `"legacy"`), and switching themes rebuilds the shortcut's icon.
- **Hero banner**: a 620x180 PNG passed as the toast `icon`, displayed as the large banner under the title. When `themedIcons` is on, each notification kind uses a color-coded banner (ready=green / error=orange / network=red / permission=yellow / question=blue); otherwise it falls back to the generic banner. Both icon themes ship their own banners (`assets/opencode-notify-banner*.png` for flat, `assets/legacy/legacy-banner*.png` for legacy).
- **`iconTheme`** — selects the icon set (`"flat"` full-gradient + white logo, or `"legacy"` square blue-gradient block + thin color border + terminal `≥`). Default is `"legacy"`.
- **Self-hosted sender**: toasts are sent by invoking the vendored SnoreToast directly, replicating node-notifier's named-pipe mechanics (a unique `\\.\pipe\notifierPipe-<uuid>` passed as `-pipeName`, which is what lets SnoreToast display reliably). Because we no longer route through node-notifier's argument whitelist, we also control sound and the hero banner. **Click-to-open is NOT forwarded to SnoreToast** (its parser rejects `-la`, exiting `-1` with a usage banner); instead the plugin keeps the named pipe alive for the toast's lifetime and `spawnClick` launches the target program itself when the activation callback arrives. The vendored `node-notifier` package is only used as a source of the `snoretoast-x64.exe` binary.
- `assets/` can be regenerated from the script; the PNG must stay ≤1024x1024 and ≤200KB (Windows toast image limits).

Regenerate assets:

```bash
python -m pip install pillow
python scripts/gen-notify-assets.py
```

## License

MIT