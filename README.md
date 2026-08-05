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
├── assets/                # icon + banner
└── node_modules/          # vendored node-notifier + detect-terminal
```

### Manual copy

```powershell
# Copy the flattened contents INTO the plugins root (not as a subfolder)
copy dist\kdco-notify-win\kdco-notify-win.js  %USERPROFILE%\.config\opencode\plugins\
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
| Session complete (`session.idle`) | Yes | Ready for review |
| Session error | Yes | Something went wrong |
| Network / HTTP interruption | Yes | **Network interrupted** (+ system beep) |
| Permission needed | Yes | Waiting for you |
| Question asked | Yes | Question for you |
| Sub-task events | No (default) | Set `notifyChildSessions: true` to include |

Behavior: parent-session filtering (no sub-task spam), quiet-hours suppression, 1.5s dedupe windows, and terminal detection (for logging/context only — Windows has no focus suppression).

## Network Interruption Detection

The original record asked whether the plugin can notify on **explicit** interruptions (HTTP 503/401/500/429/...) and **implicit** mid-stream disconnects (response cut while streaming).

- **Explicit** — OpenCode surfaces non-2xx status codes in `session.error`; the plugin classifies the status text.
- **Implicit** — the plugin never issues requests or reads response bodies itself, so it cannot watch a body stream directly. But when a connection dies mid-stream, undici raises `ECONNRESET` / `socket hang up` / `EPIPE` / `aborted` / `fetch failed`, which OpenCode forwards as `session.error`. Because the plugin notifies on **every** parent `session.error` and classifies that text, both interruption kinds are covered.

Classified errors use a distinct *Network interrupted* title and an optional system beep (config `beepOnInterruption`).

> **Boundary:** if OpenCode itself goes fully silent (no `session.error` emitted at all), a pure plugin cannot know. This is a limit of the plugin model, not a bug.

## Configuration (Optional)

Works out of the box. Create `~/.config/opencode/kdco-notify.json`:

```json
{
  "notifyChildSessions": false,
  "sounds": {
    "idle": "Glass",
    "error": "Basso",
    "permission": "Submarine",
    "question": "Submarine",
    "network": "Basso"
  },
  "quietHours": { "enabled": false, "start": "22:00", "end": "08:00" },
  "beepOnInterruption": true
}
```

Notes:
- `sound` is a no-op on Windows — SnoreToast ignores custom sounds. Keep it for config compatibility; use `beepOnInterruption` for an audible cue.
- `terminal` (optional) overrides terminal auto-detection.
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

- **App icon**: `assets/opencode-notify.ico`. On first run the plugin registers a Start Menu shortcut (`OpenCode Notify.lnk`) carrying the `OpenCode.Notify` AppUserModelID, so Windows shows our icon in the toast.
- **Hero banner**: `assets/opencode-notify-banner.png` (620x180 PNG) is passed as the toast `icon`, displayed as the large banner under the title.
- Toasts are sent through `node-notifier` (NOT direct SnoreToast) because only the node-notifier path passes a `-pipeName` that makes SnoreToast actually display reliably; branding rides on `appID` + `icon` options.
- `assets/` can be regenerated from `test` tooling; the PNG must stay ≤1024x1024 and ≤200KB (Windows toast image limits).

Regenerate assets:

```bash
python -m pip install pillow
python scripts/gen-notify-assets.py
```

## License

MIT