# kdco-notify-win

> Windows-only native notifications for OpenCode (fork of `@kdco/notify`, zero OCX, manual vendored).

A plugin for [OpenCode](https://github.com/sst/opencode) that delivers Windows Toast notifications when tasks complete, errors occur, the AI needs your input, or the network connection is interrupted.

This is a **Windows 10/11-only** fork. All macOS (alerter / focus detection), Linux (`notify-send`), and cmux paths have been removed. One JS file + two runtime npm packages, dropped straight into `.opencode/plugins/` — no OCX, no build step.

## Install (offline-friendly)

```bash
# 1. Copy this folder into your project or global plugins dir
copy dist\kdco-notify-win  %USERPROFILE%\.config\opencode\plugins\kdco-notify-win

# 2. Vendored deps (node-notifier + detect-terminal)
cd %USERPROFILE%\.config\opencode\plugins\kdco-notify-win
npm install

# 3. Restart OpenCode
```

Global vs project scope:

| Scope | Path |
|---|---|
| Global (all projects) | `~/.config/opencode/plugins/kdco-notify-win/` |
| Project-only | `.opencode/plugins/kdco-notify-win/` |

The plugin loads standalone even if deps are missing, but logs a warning instead of crashing. Run `npm install` inside the folder to vendor `node_modules`.

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

Design notes visible to maintainers:
- `createNotifyPlugin(overrides)` is a dependency-injected factory — the plugin is fully testable without `node-notifier` installed.
- Runtime deps (`node-notifier`, `detect-terminal`) are resolved lazily via `createRequire`, so the file loads even before `npm install`.

## License

MIT