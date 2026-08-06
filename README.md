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
├── jump-to-opencode.ps1   # click-to-open helper (clickMode = "helper")
├── assets/                # icon + banner
└── node_modules/          # vendored node-notifier + detect-terminal
```

### Manual copy

```powershell
# Copy the flattened contents INTO the plugins root (not as a subfolder)
copy dist\kdco-notify-win\kdco-notify-win.js  %USERPROFILE%\.config\opencode\plugins\
copy dist\kdco-notify-win\jump-to-opencode.ps1 %USERPROFILE%\.config\opencode\plugins\
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
  "clickMode": "helper",
  "clickProgram": "",
  "clickArgs": [],
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
- **`clickMode`** — what a toast click does (`"helper"` default | `"simple"` | `"off"`):
  - `helper` (default): run the bundled `jump-to-opencode.ps1` — if a Windows Terminal is already running, bring the best-matching window to the foreground (session title, else any `opencode` window, else the most recent); only if **no** `wt.exe` is running does it open a fresh tab running `opencode` in the session's working directory. If the helper is missing or fails it falls back to `simple`.
  - `simple`: plain `wt.exe -d <cwd> opencode`.
  - `off`: clicking does nothing.
  - An explicit `clickProgram` always wins over these modes (used for a fully custom program). `clickArgs` may contain `{{title}}`, `{{cwd}}`, `{{sessionID}}` placeholders, substituted per notification.
- **Run cancellation (ESC)** — when a run is stopped by the user, OpenCode takes the session idle without an error; the plugin detects this from the final message-part state and sends a distinct **STOPPED BY YOU** toast with its own grey banner. Disable with `"notifyCancelled": false`.
- **Heartbeat (silent-stop watchdog)** — if a run goes quiet past `stallSec` (default 120s) and then ends **without** any `session.error`/`session.idle` event reaching the plugin, the heartbeat polls the session's real state and backfills a **SESSION ENDED** toast (body notes "not received an end signal"). `warnWhileStalled: true` additionally telegraphs a **SESSION STALLED** warning while a session is *still* running but silent past the stall. This closes the "no notification at all on silent network death" gap that pure event handling can never see. It is on by default.
- **Click-to-open implementation note** — the click handler reads the activation callback SnoreToast writes to the named pipe (previously that pipe's data was ignored and closed after 1.5s, so clicks did nothing). The pipe is now kept open for the toast's lifetime **only when a click target is configured**; the no-click path is unchanged (1.5s then release).
- **Precise-tab limitation** — Windows Terminal exposes no stable public CLI to focus an *arbitrary* tab by title. The helper focuses the matching *window* (whose title mirrors the focused tab). Exact per-session tab pinning is best-effort and not guaranteed.
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
- **Self-hosted sender**: toasts are sent by invoking the vendored SnoreToast directly, replicating node-notifier's named-pipe mechanics (a unique `\\.\pipe\notifierPipe-<uuid>` passed as `-pipeName`, which is what lets SnoreToast display reliably). Because we no longer route through node-notifier's argument whitelist, we can also pass `-application`/`-la` (click-to-open). The vendored `node-notifier` package is only used as a source of the `snoretoast-x64.exe` binary.
- `assets/` can be regenerated from the script; the PNG must stay ≤1024x1024 and ≤200KB (Windows toast image limits).

Regenerate assets:

```bash
python -m pip install pillow
python scripts/gen-notify-assets.py
```

## License

MIT