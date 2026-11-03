/**
 * kdco-notify-win
 * ===============
 * Windows-only notification plugin for OpenCode (zero-OCX, manual-vendored fork of @kdco/notify).
 *
 * Philosophy: "Notify the human when the AI needs them back, not for every micro-event."
 *
 * Features:
 *  - Windows Toast notifications via SnoreToast (direct invocation, branded)
 *    with a custom appID + banner image + Start-Menu-registered app icon
 *  - Task complete / error / permission / question notifications
 *  - Session-aware content: the session title shares the toast title, with a
 *    context line (project · agent · model · diff), latest user prompt, latest
 *    assistant reply and recent tool steps in the body
 *  - Quiet-hours suppression
 *  - Parent-session filtering (no sub-task spam) + 1.5s dedupe windows
 *    (timestamps shared across plugin instances via a tmpdir store)
 *  - Network interruption detection: explicit HTTP errors (503/401/500/429/...)
 *    and implicit mid-stream disconnects (ECONNRESET / socket hang up / aborted / fetch failed / ...)
 *    get a distinct "Network interrupted" title + optional system beep.
 *
 * Install (offline-friendly):
 *   1. Copy this whole `kdco-notify-win/` folder into `.opencode/plugins/`
 *   2. `cd kdco-notify-win && npm install`   (vendors node-notifier + detect-terminal into node_modules)
 *   3. Restart OpenCode.
 *
 * Config file (JSONC with comments, see README / DEFAULT_CONFIG below). Resolved
 * along a priority chain (low → high, deep-merged key by key):
 *   P7  code DEFAULT_CONFIG
 *   P6  <plugin-dir>/config/kdco-notify-win.jsonc (empty slot: no bundled file)
 *   P2  project .opencode/plugins/config/kdco-notify-win.jsonc
 *   P1+P3  opencode.json(c) `plugin` tuple options (server's 2nd arg, highest)
 * Legacy `kdco-notify.jsonc` / `kdco-notify.json` under the same dirs are also
 * honored. An annotated sample template (inert, never loaded) ships as
 * `kdco-notify-win.sample.jsonc` — copy to `kdco-notify-win.jsonc` to activate.
 */

import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import * as net from "node:net"
import { randomUUID } from "node:crypto"
import PluginLogger from "./plugin-logger.js"

// ==========================================
// LOGGING (generic plugin-logger, default WARN)
// ==========================================

/**
 * Safe stringify for arbitrary event payloads that might contain circular
 * references or huge object graphs. Truncated so a pathological payload can't
 * flood the log file.
 * @param {unknown} value
 * @param {number} [maxChars=2000]
 * @returns {string}
 */
function safeStringify(value, maxChars = 2000) {
	if (value === undefined) return "undefined"
	if (value === null) return "null"
	if (typeof value === "string") return value.slice(0, maxChars)
	try {
		const json = JSON.stringify(value)
		if (json === undefined) return String(value)
		return json.length > maxChars ? json.slice(0, maxChars) + "…" : json
	} catch {
		try { return String(value) } catch { return "[unprintable]" }
	}
}

/**
 * Compute a monotonic "config version" from the current chain layers (sum of
 * mtimes, or 0 when no file exists). Any file-layer change bumps the version,
 * which is what drives hot reload.
 * @returns {{version:number, layers:{path:string,kind:string}[]}}
 */
function configVersion() {
	const layers = resolveConfigLayers()
	let version = 0
	for (const layer of layers) {
		try { version += fsSync.statSync(layer.path).mtimeMs } catch {}
	}
	return { version, layers }
}

/**
 * Build a synchronous config-loader for PluginLogger that hot-reloads the
 * `logging` section whenever ANY config-chain file changes (mtime). Only the
 * `logging` block is returned — the logger doesn't need the rest.
 * @returns {{version:number, config:object}|null}
 */
function buildLoggingConfigLoader() {
	return () => {
		try {
			const { version } = configVersion()
			const layers = resolveConfigLayers()
			let logging = { ...DEFAULT_CONFIG.logging }
			for (const layer of layers) {
				const content = fsSync.readFileSync(layer.path, "utf8")
				const parsed = parseJsonc(content)
				logging = deepMerge(logging, parsed.logging ?? {})
			}
			return { version, config: logging }
		} catch {
			return null
		}
	}
}

// Runtime dependencies are resolved lazily so the plugin can load even when
// node-notifier / detect-terminal are not yet vendored (falls back to a clear
// warning instead of crashing OpenCode).
const moduleRequire = createRequire(import.meta.url)

function tryRequire(name) {
	try {
		return moduleRequire(name)
	} catch {
		return null
	}
}

function resolveDetectTerminal() {
	return tryRequire("detect-terminal")
}

// ==========================================
// BRANDED WINDOWS TOAST (self-hosted)
// ==========================================
//
// Direct SnoreToast invocation proved unreliable (silent exit, no toast). The
// stable approach is to pass a -pipeName (unique named pipe callback) that lets
// SnoreToast actually display — this is exactly what node-notifier's toaster
// wrapper did. We replicate that mechanics ourselves (net.createServer +
// `-pipeName`) so we ALSO keep full control over every other argument:
// node-notifier's whitelist drops `-application` and forces sounds into the
// "Notification.*" namespace, which we no longer depend on. Branding is done
// by passing:
//   - appID: "OpenCode.Notify"  -> Windows resolves the toast icon from the
//     Start-Menu shortcut registered for this appID
//   - icon: banner PNG          -> hero image shown in the toast body

const APP_ID = "OpenCode.Notify"
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(PLUGIN_DIR, "assets")

// Two icon sets, switchable via the `iconTheme` config ("flat" | "legacy"):
//   - flat:   full themed gradient background + white logo (default, current)
//   - legacy: thick square color border + fixed blue gradient center block
// Generated by scripts/gen-notify-assets.py into dist/kdco-notify-win/assets/.
const ICON_THEMES = {
	flat: {
		bannerBase: path.join(ASSETS_DIR, "opencode-notify-banner"),
		icon: path.join(ASSETS_DIR, "opencode-notify.ico"),
	},
	legacy: {
		bannerBase: path.join(ASSETS_DIR, "legacy", "legacy-banner"),
		icon: path.join(ASSETS_DIR, "legacy", "legacy.ico"),
	},
}
const BANNER_PATH = ICON_THEMES.flat.bannerBase + ".png"
const ICON_PATH = ICON_THEMES.flat.icon

/**
 * Theme -> hero banner file. Generated by scripts/gen-notify-assets.py so each
 * notification kind uses a visually distinct color (border + accent) instead of
 * the single generic icon.
 *  - ready:      green          (task complete)
 *  - error:      orange         (generic failure)
 *  - network:    red            (connection interrupted)
 *  - permission: yellow         (waiting on user / authorization)
 *  - question:   blue           (question asked)
 */
const THEMED_BANNERS = {
	ready: path.join(ASSETS_DIR, "opencode-notify-banner-ready.png"),
	error: path.join(ASSETS_DIR, "opencode-notify-banner-error.png"),
	network: path.join(ASSETS_DIR, "opencode-notify-banner-network.png"),
	permission: path.join(ASSETS_DIR, "opencode-notify-banner-permission.png"),
	question: path.join(ASSETS_DIR, "opencode-notify-banner-question.png"),
	cancelled: path.join(ASSETS_DIR, "opencode-notify-banner-cancelled.png"),
}

// Resolve the banner + shortcut-icon paths for a given icon theme. `iconTheme`
// comes from config ("flat" | "legacy"); anything unknown falls back to "flat".
// Returns { bannerPath, themedBanners, iconPath }.
function resolveIconTheme(iconTheme) {
	const t = ICON_THEMES[iconTheme] ? iconTheme : "flat"
	const base = ICON_THEMES[t].bannerBase
	const themedBanners = {}
	for (const kind of ["ready", "error", "network", "permission", "question", "cancelled"]) {
		themedBanners[kind] = `${base}-${kind}.png`
	}
	return {
		bannerPath: `${base}.png`,
		themedBanners,
		iconPath: ICON_THEMES[t].icon,
	}
}

/**
 * Register a Start Menu shortcut for the appID so Windows displays our icon.
 * Idempotent + best-effort. Also writes the AppUserModelID property onto the
 * shortcut (required for Windows to map the appID to the shortcut icon).
 */
async function ensureAppRegistration(iconPath = ICON_PATH) {
	if (process.platform !== "win32") return
	// The relevant icon file must exist. A Start-Menu shortcut whose
	// IconLocation points at a file that was removed (e.g. after a layout or
	// deploy change) makes Windows render the toast as a blank white box with no
	// icon, because Windows resolves the toast icon from this shortcut.
	if (!existsSync(iconPath)) return
	
	const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
	const shortcutPath = path.join(
		appData, "Microsoft", "Windows", "Start Menu", "Programs",
		"OpenCode Notify.lnk",
	)
	// The shortcut is valid only if it exists AND points at an icon file that
	// still exists AND is the one for the active iconTheme (so switching themes
	// forces a rebuild of the shortcut's IconLocation).
	if (await shortcutIconIsValid(shortcutPath, iconPath)) return

	try {
		const psScript = [
			"$ws = New-Object -ComObject WScript.Shell",
			`$s = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
			`$s.TargetPath = '${process.execPath.replace(/'/g, "''")}'`,
			`$s.IconLocation = '${iconPath.replace(/'/g, "''")},0'`,
			"$s.Save()",
		].join("\n")
		const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
			stdio: "ignore",
			windowsHide: true,
		})
		await new Promise((resolve) => child.on("exit", resolve))
	} catch {
		// best effort
	}
}

function existsSync(p) {
	try { return moduleRequire("node:fs").existsSync(p) } catch { return false }
}

/**
 * True if the Start-Menu shortcut exists, its icon file is still present, and it
 * points at the icon expected for the active iconTheme.
 * @returns {Promise<boolean>}
 */
async function shortcutIconIsValid(shortcutPath, expectedIconPath) {
	try {
		if (!existsSync(shortcutPath)) return false
		// Read the .lnk's IconLocation via WScript.Shell.ActiveX.
		const psScript = [
			"$ws = New-Object -ComObject WScript.Shell",
			`$s = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
			"Write-Output $s.IconLocation",
		].join("\n")
		const { stdout } = await runPsCapture(psScript, 4000)
		const iconLoc = (stdout || "").trim()
		if (!iconLoc) return false
		// WScript strips the ",0" icon index suffix; parse the path back out.
		const iconPath = iconLoc.replace(/,-\d+$/, "").replace(/,\d+$/, "")
		if (!existsSync(iconPath)) return false
		// If we expect a specific icon (iconTheme switch), the shortcut must
		// already point at it, otherwise rebuild.
		if (expectedIconPath && path.resolve(iconPath) !== path.resolve(expectedIconPath)) return false
		return true
	} catch {
		return false
	}
}

/**
 * Run a PowerShell one-liner and capture its stdout.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runPsCapture(script, timeoutMs = 4000) {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		const done = () => {
			if (settled) return
			settled = true
			resolve({ stdout, stderr })
		}
		try {
			const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
				windowsHide: true,
			})
			child.stdout?.on("data", (d) => { stdout += d.toString() })
			child.stderr?.on("data", (d) => { stderr += d.toString() })
			child.on("error", done)
			child.on("exit", done)
			setTimeout(done, timeoutMs)
		} catch {
			done()
		}
	})
}

/**
 * Locate the vendored SnoreToast executable.
 * @returns {string | null}
 */
function resolveSnoreToastExe() {
	try {
		const vendorDir = path.dirname(moduleRequire.resolve("node-notifier"))
		const x64 = path.join(vendorDir, "vendor", "snoreToast", "snoretoast-x64.exe")
		const x86 = path.join(vendorDir, "vendor", "snoreToast", "snoretoast-x86.exe")
		const fsSync = moduleRequire("node:fs")
		if (process.arch === "x64" && fsSync.existsSync(x64)) return x64
		if (fsSync.existsSync(x86)) return x86
		return x64
	} catch {
		return null
	}
}

/**
 * Self-hosted branded Windows Toast sender.
 *
 * Replicates exactly what node-notifier's toaster wrapper does (create a unique
 * named pipe, hand its path to SnoreToast via `-pipeName` so the toast displays
 * reliably and activation callbacks can arrive), but WITHOUT node-notifier's
 * `allowedToasterFlags` whitelist — which would otherwise drop `-application`
 * and force sounds into the "Notification.*" namespace.
 * @param {{
 *   title:string,
 *   message:string,
 *   sound?:string,
 *   theme?: 'ready'|'error'|'network'|'permission'|'question',
 *   clickProgram?:string,
 *   clickArgs?:string[],
 * }} opts
 * @param {object} overrides - test overrides: {platform?, snoreToastExe?, bannerPath?, fsApi?, spawn?}
 * @returns {boolean} whether the SnoreToast process was spawned
*/
/**
 * Launch the click-to-open program once the toast is activated.
 *
 * `clickTarget` = { program, args } resolved from config + per-notification
 * context. Only used by clickMode "program"; "native" launches via SnoreToast
 * itself and never reaches this function.
 * @param {{program:string,args:string[]}} clickTarget
 * @param {object} overrides
 * @returns {boolean}
 */
function spawnClick(clickTarget, overrides = {}) {
	if (!clickTarget?.program) return false
	const spawnFn = overrides.clickSpawn ?? overrides.spawn ?? defaultSpawn
	try {
		const child = spawnFn(clickTarget.program, clickTarget.args, { stdio: "ignore", windowsHide: true, detached: true })
		if (typeof child?.unref === "function") child.unref()
		return !!child
	} catch {
		return false
	}
}

/**
 * Parse the activation payload SnoreToast writes to our named pipe on click.
 * SnoreToast's exact encoding is not guaranteed (UTF-16LE vs UTF-8), so the
 * caller tries both decodings; this only tests the text for the activation
 * token. Returns "activate" on hit, else null.
 * @param {string} text
 * @returns {"activate"|null}
 */
export function parseActivationPayload(text) {
	if (!text) return null
	if (/(^|[;&=\s])(activate|clicked)([;&\s]|$)/i.test(String(text))) return "activate"
	return null
}

/** Resolve { program, args } from a notification's click options ("program" mode). */
function resolveClickTarget(opts) {
	if (opts?.clickMode === "native") return null
	const program = opts?.clickProgram
	if (!program) return null
	const args = Array.isArray(opts?.clickArgs) ? opts.clickArgs.map(String) : []
	return { program, args }
}

/**
 * Close the named pipe server after the toast's SnoreToast process exits, with
 * a hard cap so a hung process can't leak the handle forever. Test fakes that
 * don't implement `child.on` fall back to the cap.
 */
function releasePipeAfter(child, server, maxMs) {
	const close = () => {
		try { server.close() } catch {}
	}
	let timer = null
	const onExit = () => {
		if (timer) clearTimeout(timer)
		close()
	}
	if (child && typeof child.on === "function") {
		child.on("exit", onExit)
	}
	timer = setTimeout(close, maxMs)
}

export function sendWindowsToast(opts, overrides = {}) {
	if ((overrides.platform ?? process.platform) !== "win32") return false
	const exe = overrides.snoreToastExe ?? resolveSnoreToastExe()
	if (!exe) return false
	const spawnFn = overrides.spawn ?? defaultSpawn
	const banner = resolveBannerPath(opts, overrides)
	const clickTarget = resolveClickTarget(opts)
	// "native" clickMode: hand the program to SnoreToast via -application; no
	// named-pipe callback needed (SnoreToast launches it on click itself).
	const nativeApp = opts?.clickMode === "native" ? opts?.clickProgram ?? null : null
	// Only when a pipe-callback click target is configured do we need the pipe to
	// stay alive to receive the activation callback. Without it we behave exactly
	// as before.
	const keepOpenForClick = !!clickTarget

	// Unique named pipe, mirroring node-notifier's getPipeName() + createNamedPipe().
	const pipePath = `\\\\.\\pipe\\notifierPipe-${randomUUID()}`
	let server = null
	try {
		server = net.createServer((conn) => {
			const chunks = []
			conn.on("data", (d) => chunks.push(d))
			conn.on("end", () => {
				if (!clickTarget) return
				const buf = Buffer.concat(chunks)
				const activated =
					parseActivationPayload(buf.toString("utf16le")) ||
					parseActivationPayload(buf.toString("utf8"))
				if (activated) spawnClick(clickTarget, overrides)
			})
		})
		server.on("error", () => {})
	} catch {
		server = null
	}

	const doSpawn = () => {
		const args = buildSnoreToastArgs(opts, banner, pipePath, !!server, nativeApp)
		try {
			// detached + unref: SnoreToast must fully outlive the parent (it stays
			// resident until the toast is clicked/times out). Waiting on 'exit'
			// would block for many seconds, so we never do.
			const child = spawnFn(exe, args, { stdio: "ignore", windowsHide: true, detached: true })
			if (typeof child?.unref === "function") child.unref()
			return child
		} catch {
			return null
		}
	}

	if (!server) {
		doSpawn()
		return true
	}

	try {
		// Listen first (like node-notifier), then spawn once the pipe accepts
		// connections so SnoreToast can write its activation callback back.
		server.listen(pipePath, () => {
			const child = doSpawn()
			if (keepOpenForClick) {
				// Keep the callback channel alive for the toast's lifetime so a
				// click (which can happen many seconds later) still reaches us.
				releasePipeAfter(child, server, 30000)
			} else {
				// No pipe-callback click target: release shortly after, exactly
				// like before. (native -application is still delivered even after
				// the pipe closes, because SnoreToast owns the launch.)
				setTimeout(() => {
					try { server.close() } catch {}
				}, 1500)
			}
			return !!child
		})
		return true
	} catch {
		try { server.close() } catch {}
		doSpawn()
		return true
	}
}

/**
 * Replace {{title}} / {{cwd}} / {{sessionID}} placeholders in a string with the
 * notification's session context. Used to build per-notification click targets.
 */
export function substitutePlaceholders(value, ctx = {}) {
	if (typeof value !== "string") return value
	return value
		.replace(/\{\{title\}\}/g, ctx.title ?? "")
		.replace(/\{\{cwd\}\}/g, ctx.cwd ?? "")
		.replace(/\{\{sessionID\}\}/g, ctx.sessionID ?? "")
}

/**
 * Build the full SnoreToast argument list: everything node-notifier's whitelist
 * would allow (`-appID`, `-pipeName`, `-t`, `-m`, `-p`, `-s`) PLUS, for the
 * "native" clickMode, `-application <program>` (SnoreToast launches it itself
 * on click). Pure + sync so tests can assert on the args.
 * @param {object} opts
 * @param {string|undefined} banner
 * @param {string|undefined} pipePath
 * @param {boolean} includePipe
 * @param {string|null} [nativeApp] program to hand to SnoreToast via `-application`
 * @returns {string[]}
 */
export function buildSnoreToastArgs(opts, banner, pipePath, includePipe, nativeApp = null) {
	const args = ["-appID", APP_ID]
	if (opts.title) args.push("-t", String(opts.title))
	if (opts.message) args.push("-m", String(opts.message))
	if (banner) args.push("-p", banner)
	const sound = normalizeToastSound(opts.sound)
	if (sound) args.push("-s", sound)
	if (includePipe) args.push("-pipeName", pipePath)
	if (nativeApp) args.push("-application", String(nativeApp))
	// NOTE: we deliberately do NOT forward `-la`. The vendored SnoreToast fork's
	// parser does not understand `-la` — it prints its usage banner and exits -1,
	// so the toast is never displayed at all. "program" clickMode is handled
	// entirely by our own named-pipe callback (spawnClick); "native" uses the
	// bare `-application` flag above, which works fine.
	return args
}

// SnoreToast's `-s` only accepts Windows `ms-winsound` style names under the
// "Notification." namespace (e.g. "Notification.Mail", "Notification.Default").
// Bare preset names like "Glass" or file paths make SnoreToast fail with exit
// code -1 and NO toast is shown at all. Mirror node-notifier's own guard
// (lib/utils.js): any sound not starting with "Notification." is silently
// normalized to a default sound so a toast is always displayed. NOTE: on this
// system "Notification.Default" plays NO audio, so fall back to a sound that
// actually chimes ("Notification.Reminder").
function normalizeToastSound(sound) {
	if (!sound) return undefined
	if (typeof sound === "string" && sound.indexOf("Notification.") === 0) return sound
	return "Notification.Reminder"
}

/**
 * Pick the hero banner for a notification, preferring the theme color. Falls back
 * to the generic branded banner, then to no banner if nothing exists.
 * @returns {string | undefined}
 */
function resolveBannerPath(opts, overrides = {}) {
	// `showBanner:false` gives the text more visual weight by dropping the
	// 620x180 hero image entirely (the app icon in the header still shows).
	if (opts?.showBanner === false) return undefined
	const fsApi = overrides.fsApi ?? moduleRequire("node:fs")
	// `iconTheme` on opts selects the icon set (from config). Fall back to flat.
	const assets = resolveIconTheme(opts?.iconTheme)
	const themed = overrides.themedBanners ?? assets.themedBanners
	const bannerBase = overrides.bannerPath
		? overrides.bannerPath
		: assets.bannerPath
	let candidate = undefined
	if (overrides.bannerPath) {
		candidate = overrides.bannerPath
	} else if (opts.theme && themed[opts.theme]) {
		candidate = themed[opts.theme]
	} else {
		candidate = bannerBase
	}
	try {
		if (candidate && fsApi.existsSync(candidate)) return candidate
	} catch {
		// ignore
	}
	return undefined
}

/**
 * Invoke a command with the given args (default spawn, overridable in tests).
 * @returns {import("node:child_process").ChildProcess}
 */
function defaultSpawn(cmd, args, opts) {
	return spawn(cmd, args, opts)
}

// ==========================================
// CONFIG
// ==========================================

const DEFAULT_CONFIG = {
	notifyChildSessions: false,
	sounds: {
		idle: "Notification.Mail",
		error: "Notification.Reminder",
		permission: "Notification.SMS",
		question: "Notification.IM",
		network: "Notification.Mail",
		cancelled: "Notification.Mail",
	},
	quietHours: {
		enabled: false,
		start: "22:00",
		end: "08:00",
	},
	/** Network-interruption errors also play a system beep (Windows SnoreToast ignores custom sounds). */
	beepOnInterruption: true,
	/** Include a "[yyyy-MM-dd HH:mm:ss]" timestamp line at the top of the notification message. */
	showTimestamp: true,
	/**
	 * Include a one-line summary of the latest tool steps (e.g. "Read file X → Bash ls").
	 * Numeric value = max steps to include. false/0 disables.
	 */
	showSummary: true,
	/** Max number of recent tool steps to fold into the summary line. */
	summarySteps: 3,
	/**
	 * Put the session title into the toast TITLE, which Windows renders in the
	 * largest font: "READY · Fix login flow". When false, the old fixed title is
	 * kept and the session title moves back into the body.
	 */
	showSessionTitle: true,
	/** Max characters of the session title used in the toast title. */
	sessionTitleChars: 40,
	/**
	 * Show a compact context line under the timestamp:
	 * "<project folder> · <agent> · <model> · +12/-3 · 2 files".
	 */
	showContext: true,
	/** Show the latest user prompt excerpt as a "You:" line. */
	showPrompt: true,
	/** Max characters of the user prompt excerpt. */
	promptChars: 80,
	/** Show the latest assistant reply excerpt as an "AI:" line. */
	showReply: true,
	/** Max characters of the assistant reply excerpt. */
	replyChars: 100,
	/**
	 * Optional content template override. Leave both empty to use the built-in
	 * layout. Placeholders use `{name}`; see README "Content templates".
	 *
	 *   titleTemplate: "{type} · {sessionTitle}"
	 *   bodyTemplate:  ["[{timestamp}]  {meta}", "{status}", "You: {prompt}",
	 *                   "AI: {reply}", "Steps: {steps}"]
	 */
	content: {
		titleTemplate: "",
		bodyTemplate: [],
		dropEmptyLines: true,
	},
	/** Colors each notification theme with a distinct hero banner (red/yellow/orange/green). */
	themedIcons: true,
	/**
	 * Show the large hero banner image. false drops it so the title/body text
	 * dominates the toast (useful when many notifications must be told apart).
	 */
	showBanner: true,
	/**
	 * Icon set used for the toast icon + hero banner:
	 *   "flat"   -> full themed gradient background + white logo
	 *   "legacy" -> square blue-gradient block + thin color border + terminal "≥"
	 * Both sets are generated by scripts/gen-notify-assets.py. Legacy is the
	 * user-picked default.
	 */
	iconTheme: "legacy",
	/**
	 * Sound: either a Windows system preset name starting with "Notification." (e.g.
	 * "Notification.Looping.Call", "Notification.IM", "Notification.Mail"), OR an
	 * absolute path to a .wav/.mp3 file (played via SnoreToast). Leave undefined to
	 * keep the per-kind defaults from `sounds`.
	 */
	soundOverride: "",
	/**
	 * What to launch when the user clicks a Windows toast notification:
	 *   "off"     -> clicking does nothing (default).
	 *   "program" -> our own named-pipe callback spawns `clickProgram` with
	 *                `clickArgs` (supports {{title}}/{{cwd}}/{{sessionID}}
	 *                placeholders + a `-w 0` style window-reuse flag). Most
	 *                flexible; keeps the pipe alive until the toast is clicked.
	 *   "native"  -> pass `-application <clickProgram>` straight to SnoreToast,
	 *                which launches it itself (no args, no pipe kept open).
	 *                Not as capable, but purely host-agnostic.
	 * Requires `clickProgram` to be non-empty in both non-"off" modes.
	 */
	clickMode: "off",
	/** Launch this program when the user clicks a notification (click-to-open). Empty = clickMode is effectively off. */
	clickProgram: "",
	/** Extra args appended when launching `clickProgram` (clickMode "program"). Supports {{title}}/{{cwd}}/{{sessionID}}. */
	clickArgs: [],
	/**
	 * Diagnostic logging via the generic plugin-logger. Default "WARN" keeps
	 * disk I/O minimal; set minLogLevel to "ALL" while debugging and it will
	 * capture raw session.error / idle / status payloads plus classification
	 * and toast decisions.
	 */
	logging: {
		/** Master switch. false == "NO" (no file writes at all, ERROR still prints to console). */
		enabled: false,
		/** Min severity that is written to the file: ALL/TRACE/DEBUG/INFO/WARN/ERROR/NO. */
		minLogLevel: "WARN",
		/** Per-module overrides ({moduleName: level}) — "INHERIT" means the global. */
		moduleLogLevels: {},
		/** Force a directory (tests). Default: %TEMP%\kdcokenny-notify-win. */
		logDir: null,
		/** Days to keep rotated logs before delete. */
		logRetentionDays: 30,
		/** flush strategy: "hybrid" | "sync". */
		logFlushMode: "hybrid",
		/** hybrid: sync to disk every N entries. */
		logSyncCheckpointInterval: 5,
		/** max buffered entries before forced flush. */
		logBufferMaxEntries: 100,
		/** timer-based flush interval ms. */
		logBufferFlushIntervalMs: 500,
	},
	/**
	 * When the user presses ESC / stops a run, OpenCode takes the session idle
	 * without an error. Instead of announcing READY FOR REVIEW, send a distinct
	 * "STOPPED BY YOU" notification (own title + banner). false disables it.
	 */
	notifyCancelled: true,
	/**
	 * Watchdog for runs that end without ANY event reaching the plugin (a silent
	 * stream death where OpenCode never emits session.error/session.idle). While
	 * the session was recently active but then went quiet past `stallSec`, poll
	 * the session's real state; if it is terminal but was never notified, send a
	 * backfill "SESSION ENDED" toast. Pure plugin-event logic cannot see this
	 * gap; the heartbeat closes it.
	 */
	heartbeat: {
		enabled: true,
		intervalSec: 30,
		stallSec: 120,
		/** Also warn (STALLED) while the session is STILL running but idle-past-stall. Off by default to avoid false positives on long thinking. */
		warnWhileStalled: false,
	},
}

// Project-level config lives under the project's own `.opencode/plugins/config/`
// (high priority over the global one) so a project-scoped deployment can carry
// its own settings without touching `~/.config/opencode/`. Files are named after
// the plugin (`kdco-notify-win.jsonc`) so the commented template ships next to
// the plugin and can't be confused with other tools' `kdco-notify.json`.
// ---------------------------------------------------------------------------
// Config resolution (P1–P7 chain)
//
// Low → high priority, deep-merged key by key (object keys recurse; arrays are
// replaced wholesale). Official opencode.json(c) tuple options (P1/P3) are the
// highest-priority layer and are merged last at runtime.
//   P7  code DEFAULT_CONFIG                       (base)
//   P6  <plugin-dir>/config/kdco-notify-win.jsonc (empty slot: no bundled file)
//   P2  .opencode/plugins/config/kdco-notify-win.jsonc (project file)
//   P1+P3  opencode.json(c) `plugin` tuple options (server's 2nd arg, highest)
// ---------------------------------------------------------------------------
const PLUGIN_ID = "kdco-notify-win"
const BUNDLED_CONFIG_DIR = () => path.join(PLUGIN_DIR, "config")
const PROJECT_CONFIG_DIR = () => path.join(process.cwd(), ".opencode", "plugins", "config")

// Per-directory candidate filenames, newest convention first (legacy names last).
const CONFIG_FILENAMES = ["kdco-notify-win.jsonc", "kdco-notify-win.json", "kdco-notify.jsonc", "kdco-notify.json"]
const bundledCandidates = () => CONFIG_FILENAMES.map((f) => path.join(BUNDLED_CONFIG_DIR(), f))
const projectCandidates = () => CONFIG_FILENAMES.map((f) => path.join(PROJECT_CONFIG_DIR(), f))

/** First existing file from a candidate list, else null. @returns {string|null} */
function firstExisting(candidates) {
	for (const c of candidates) if (fsSync.existsSync(c)) return c
	return null
}

/**
 * Resolve every config file layer that exists, in low→high priority order.
 * Each layer is `{ path, kind }` where kind is "bundled" | "project".
 * @returns {{path:string, kind:string}[]}
 */
export function resolveConfigLayers() {
	const layers = []
	const bundled = firstExisting(bundledCandidates())
	if (bundled) layers.push({ path: bundled, kind: "bundled" })
	const project = firstExisting(projectCandidates())
	if (project) layers.push({ path: project, kind: "project" })
	return layers
}

/**
 * Highest-priority config file path (for logging / display). Returns null when
 * no file exists anywhere (pure defaults).
 * @returns {string|null}
 */
export function resolveConfigPath() {
	const layers = resolveConfigLayers()
	return layers.length ? layers[layers.length - 1].path : null
}

/**
 * Deep merge `over` onto `base` and return a new object. Object keys recurse
 * (per-key), arrays and scalars are replaced wholesale. Neither input mutated.
 */
export function deepMerge(base, over) {
	if (over === undefined || over === null) return base
	if (Array.isArray(over)) return over
	if (typeof over !== "object") return over
	if (base === null || typeof base !== "object" || Array.isArray(base)) {
		// Non-object base: overlay over's own enumerable keys.
		const out = {}
		for (const k of Object.keys(over)) out[k] = deepMerge(undefined, over[k])
		return out
	}
	const out = { ...base }
	for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k])
	return out
}

/**
 * Load plugin config along the P1–P7 chain.
 * @param {object} [options] Official opencode.json(c) tuple options (P1/P3, highest).
 * @returns {Promise<object>}
 */
export async function loadConfig(options = {}) {
	let config = { ...DEFAULT_CONFIG }
	for (const layer of resolveConfigLayers()) {
		try {
			const content = await fs.readFile(layer.path, "utf8")
			config = deepMerge(config, parseJsonc(content))
		} catch {
			// Unreadable/broken layer -> skip (keep defaults / lower layers)
		}
	}
	config = deepMerge(config, options)
	return config
}

/**
 * Parse JSONC (comments + trailing commas + optional UTF-8 BOM) into a value.
 * `//` line comments and block comments (slash-star ... star-slash) plus
 * trailing commas before a closing brace/bracket are stripped WITHOUT touching
 * them inside string literals, then the remainder is JSON.parse'd.
 * @param {string} content
 * @returns {any}
 */
export function parseJsonc(content) {
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
	let out = ""
	let i = 0
	let inString = false
	while (i < content.length) {
		const c = content[i]
		const next = content[i + 1]
		if (inString) {
			if (c === '"') { inString = false; out += c; i++; continue }
			if (c === "\\") { out += c + (next ?? ""); i += 2; continue }
			out += c; i++; continue
		}
		if (c === '"') { inString = true; out += c; i++; continue }
		if (c === "/" && next === "/") {
			while (i < content.length && content[i] !== "\n") i++
			continue
		}
		if (c === "/" && next === "*") {
			i += 2
			while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++
			i = Math.min(i + 2, content.length)
			continue
		}
		if (c === ",") {
			let j = i + 1
			while (j < content.length && /[\s\r\n\t]/.test(content[j])) j++
			if (content[j] === "}" || content[j] === "]") { i++; continue }
			out += c; i++; continue
		}
		out += c; i++
	}
	return JSON.parse(out)
}

// ==========================================
// QUIET HOURS
// ==========================================

function isQuietHours(config, now = new Date()) {
	if (!config.quietHours.enabled) return false

	const currentMinutes = now.getHours() * 60 + now.getMinutes()
	const [sh, sm] = config.quietHours.start.split(":").map(Number)
	const [eh, em] = config.quietHours.end.split(":").map(Number)
	const startMinutes = sh * 60 + sm
	const endMinutes = eh * 60 + em

	// Overnight e.g. 22:00 - 08:00
	if (startMinutes > endMinutes) {
		return currentMinutes >= startMinutes || currentMinutes < endMinutes
	}
	return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// ==========================================
// ERROR CLASSIFICATION (network interruption)
// ==========================================

/**
 * Explicit network interruption kinds: HTTP status codes surfaced by OpenCode.
 * Lowercased status text is matched against the error message.
 */
const HTTP_STATUS_HINTS = [
	"503", "502", "500", "504", "429", "520", "521", "522", "524",
	"401", "403", "408",
]

/** Implicit network interruption kinds: mid-stream / connection-level failures. */
const NETWORK_ERROR_HINTS = [
	"econnreset",
	"econnrefused",
	"econnaborted",
	"etimedout",
	"timeout",
	"socket hang up",
	"epipe",
	"fetch failed",
	"und_conn",
	"und_addr",
	"connection reset",
	"connection closed",
	"network error",
	"network is unreachable",
	"aborted",
	"broken pipe",
	"read ec",
	"terminated",
	"the socket is closed",
	"request failed",
	"ssl",
	"tls",
	"certificate",
]

/**
 * Extract a readable message from a session.error value, which can be a string,
 * an Error-like object ({name, data:{message}, message, ...}) or anything else.
 * @param {unknown} error
 * @returns {string | undefined}
 */
function extractErrorMessage(error) {
	if (error === undefined || error === null) return undefined
	if (typeof error === "string") return error
	if (typeof error === "object") {
		const record = error
		const fromData = record?.data && typeof record.data === "object" ? record.data.message : undefined
		const fromMsg = record?.message
		const fromName = record?.name
		return fromData ?? fromMsg ?? fromName ?? String(error)
	}
	return String(error)
}

/**
 * Classify a session.error message.
 * @param {string} rawError
 * @returns {"network-interruption"|"http-error"|"generic"}
 */
export function classifyError(rawError) {
	if (!rawError || typeof rawError !== "string") return "generic"

	const text = rawError.toLowerCase()

	// Explicit: HTTP status code present (e.g. "503", "status 503", "503 Service Unavailable")
	if (HTTP_STATUS_HINTS.some((code) => text.includes(code))) return "http-error"

	// Implicit: connection / mid-stream disconnect signature
	if (NETWORK_ERROR_HINTS.some((hint) => text.includes(hint))) return "network-interruption"

	return "generic"
}

/**
 * Message signatures that explicitly name the USER as the source of the abort,
 * as opposed to an implicit network / mid-stream disconnect.
 */
const USER_ABORT_MESSAGE_HINTS = [
	"user aborted",
	"aborted by the user",
	"aborted by user",
	"user stopped",
	"stopped by the user",
	"user interrupted",
	"interrupted by the user",
	"aborted a request",
	"cancelled by the user",
	"canceled by the user",
]

/**
 * Nameless payloads (bare strings, no `name` field) that still unambiguously
 * read as a manual interrupt. `categorizeErrorEvent` uses these as a fallback
 * when there is no Error name to inspect — OpenCode frequently surfaces an ESC
 * as a plain string ("This operation was aborted", "The user aborted", ...)
 * rather than an AbortError object, and those strings must not fall into the
 * network-interruption bucket just because they contain the word "aborted".
 */
const USER_STOP_TEXT_HINTS = [
	"aborted",
	"aborted by user",
	"aborted by the user",
	"user aborted",
	"aborted a request",
	"operation was aborted",
	"this operation was aborted",
	"was aborted",
	"user stopped",
	"stopped by user",
	"user interrupted",
	"interrupted by the user",
	"interrupt signal",
]

/** Error names that unambiguously mean the user/runtime stopped the run on purpose. */
const USER_STOP_ERROR_NAMES = [
	"userinterrupt",
	"userinterrupted",
	"userabort",
	"useraborted",
	"stoperror",
	"stoprequested",
	"interrupted",
	"interruptederror",
	"cancelled",
	"canceled",
	"error.interrupt",
]

/**
 * Categorize a `session.error` payload into a notification category.
 *
 * A manual ESC / user interrupt surfaces as a `session.error` event (a bare
 * AbortError), NOT as `session.idle`, so this is the primary path for the
 * STOPPED BY YOU toast. The error NAME decides first: a user-stop name or a
 * message that names the user wins over the "aborted" text hint that would
 * otherwise mislabel the interrupt as a network drop.
 *
 * @param {unknown} error raw payload (string or Error-like object)
 * @returns {"user-cancel"|"network-interruption"|"http-error"|"generic"}
 */
export function categorizeErrorEvent(error) {
	if (error === undefined || error === null) return "generic"

	const name = String(error?.name ?? "").toLowerCase()
	const text = (extractErrorMessage(error) ?? "").toLowerCase()

	// Explicit user-stop name beats everything.
	if (USER_STOP_ERROR_NAMES.some((n) => name.includes(n))) return "user-cancel"
	// Message that names the user as the abort source.
	if (USER_ABORT_MESSAGE_HINTS.some((hint) => text.includes(hint))) return "user-cancel"

	// A bare AbortError-ish name ("AbortError", "MessageAbortedError",
	// "abortederror", "useraborted", ...) is the classic manual interrupt.
	// Genuine network aborts still carry a connection signature, so keep the
	// "aborted" text hint out of the network bucket here. (Prefix match on
	// "abort" rather than "aborterror" so names like
	// `MessageAbortedError` = "aborted" + "error" are caught too.)
	if (name.includes("abort")) {
		const explicitNetwork = NETWORK_ERROR_HINTS.some((hint) => hint !== "aborted" && text.includes(hint))
		return explicitNetwork ? "network-interruption" : "user-cancel"
	}

	// Nameless payload (bare string): OpenCode often surfaces a manual ESC as a
	// plain string rather than an Error object, so there is no name to inspect.
	// If the text itself reads as a user stop (and no genuine connection-level
	// signature is present), prefer user-cancel over the network mislabel.
	if (!name && USER_STOP_TEXT_HINTS.some((hint) => text.includes(hint))) {
		const explicitNetwork = NETWORK_ERROR_HINTS.some((hint) => hint !== "aborted" && text.includes(hint))
		if (!explicitNetwork) return "user-cancel"
	}

	// Everything else falls back to message heuristics.
	return classifyError(text)
}

/**
 * Error names OpenCode attaches to the final assistant part when the USER (or
 * the runtime) stops a run, as opposed to a genuine failure. These map an idle
 * session to the "cancelled" category instead of READY FOR REVIEW.
 */
const ABORT_ERROR_NAMES = [
	"aborterror",
	"userinterrupt",
	"stop",
	"stoperror",
	"cancellederror",
	"interrupted",
	"error.interrupt",
]

/**
 * Decide whether an assistant message/part error represents a user/runtime stop
 * rather than a genuine failure. Mirrors `categorizeErrorEvent`'s abort-name
 * logic: a prefix match on "abort" catches `MessageAbortedError` =
 * "aborted" + "error" (which the legacy `ABORT_ERROR_NAMES` "aborterror" entry
 * misses), plus the explicit user-stop names.
 * @param {{name?: unknown}|undefined} error
 * @returns {"aborted"|"error"}
 */
function classifyAssistantError(error) {
	const name = String(error?.name ?? "").toLowerCase()
	if (name.includes("abort")) return "aborted"
	if (USER_STOP_ERROR_NAMES.some((n) => name.includes(n))) return "aborted"
	if (ABORT_ERROR_NAMES.some((n) => name.includes(n))) return "aborted"
	return "error"
}

/** Play a short system beep via PowerShell (best-effort, Windows). */
function playInterruptionBeep(beep = true) {
	if (!beep || process.platform !== "win32") return
	try {
		const child = spawn(
			"powershell",
			["-NoProfile", "-Command", "[console]::beep(700, 350); Start-Sleep -Milliseconds 120; [console]::beep(700, 350)"],
			{ stdio: "ignore", windowsHide: true },
		)
		child.unref()
	} catch {
		// best effort
	}
}

// ==========================================
// PARENT SESSION DETECTION
// ==========================================

async function isParentSession(client, sessionID) {
	try {
		const session = await client.session.get({ path: { id: sessionID } })
		// No parentID means this IS the parent/root session
		return !session?.data?.parentID
	} catch {
		// If we can't fetch, assume parent to be safe (notify rather than miss)
		return true
	}
}

/**
 * Normalize a session-like object (event info or `session.get` data) into the
 * context the notification body needs. The title is kept long here and only
 * shortened at render time, so each surface can pick its own budget.
 * @param {any} data
 * @returns {{title:string, cwd?:string, directory?:string, summary?:any, updated?:number}}
 */
function normalizeSessionContext(data) {
	const title = data?.title ?? data?.slug
	const directory = data?.directory ?? data?.cwd ?? data?.workspace ?? data?.path?.cwd
	const cwd = data?.cwd ?? data?.workspace ?? data?.directory ?? data?.path?.cwd
	return {
		title: title ? String(title).slice(0, 200) : "Task",
		cwd: cwd ? String(cwd) : undefined,
		directory: directory ? String(directory) : undefined,
		summary: data?.summary,
		updated: data?.time?.updated ?? undefined,
	}
}

/**
 * Resolve session context for a notification, preferring the info carried on
 * the event (cheapest) and falling back to a session fetch. Event info often
 * carries only a title; when it lacks directory/summary we still fetch once so
 * the context line can show the project and diff stats. cwd feeds the click-to-
 * open targets ({{cwd}} placeholder).
 */
async function getSessionContext(client, sessionID, info) {
	const eventTitle = info?.title ?? info?.slug
	const eventContext = eventTitle ? normalizeSessionContext(info) : null
	// Event info is only good enough when it carries the richer fields too.
	if (eventContext && (eventContext.directory || eventContext.summary)) return eventContext
	try {
		const session = await client.session.get({ path: { id: sessionID } })
		const data = session?.data
		if (data) return normalizeSessionContext(data)
	} catch {
		// fall through to whatever the event gave us
	}
	return eventContext ?? normalizeSessionContext({})
}

/**
 * Format a Date as local date/time parts plus the legacy bracketed timestamp.
 * @param {Date} [date]
 * @returns {{date:string, time:string, timestamp:string}}
 */
function timestampParts(date = new Date()) {
	const p = (n) => String(n).padStart(2, "0")
	const datePart = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
	const timePart = `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
	return { date: datePart, time: timePart, timestamp: `[${datePart} ${timePart}]` }
}

/**
 * Format a Date as "[yyyy-MM-dd HH:mm:ss]" in the LOCAL timezone.
 * @param {Date} [date]
 * @returns {string}
 */
export function formatTimestamp(date = new Date()) {
	return timestampParts(date).timestamp
}

/**
 * Extract a short step label describing a tool-invocation part. Tool parts carry
 * a `title` (e.g. "Read file /src/index.ts") or at least a tool name; fall back
 * to the tool name when no title is available.
 * @param {any} part
 * @returns {string | undefined}
 */
function toolStepLabel(part) {
	if (!part || typeof part !== "object") return undefined
	const title = part.title || part.state?.title
	if (title) return String(title).trim()
	if (part.tool) return String(part.tool).trim()
	return undefined
}

/**
 * Fetch a session's message timeline, tolerating both a bare array and a
 * `{ data: [...] }` shape. Returns [] on any failure so callers degrade.
 * @returns {Promise<any[]>}
 */
async function loadSessionMessages(client, sessionID) {
	if (!client?.session?.messages) return []
	try {
		const res = await client.session.messages({ path: { id: sessionID } })
		return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
	} catch {
		return []
	}
}

/**
 * Collapse all whitespace to single spaces and truncate to `maxChars`.
 * Returns "" for empty input. Non-finite/zero max keeps the whole string.
 * @param {any} value
 * @param {number} [maxChars]
 * @returns {string}
 */
export function shortenText(value, maxChars) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim()
	if (!text) return ""
	const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0
	if (!max || text.length <= max) return text
	return text.slice(0, Math.max(1, max - 1)).trimEnd() + "…"
}

/**
 * Display an agent/mode name in PascalCase. OpenCode stores these lowercase
 * ("orchestrator", "build", "plan"), but the UI shows "Orchestrator", "Build",
 * "Plan". Only the first character is touched, so already-cased names and
 * names with internal capitals are preserved.
 * @param {any} value
 * @returns {string}
 */
export function formatAgentName(value) {
	const name = String(value ?? "").trim()
	if (!name) return ""
	return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Extract human-written text from message parts. Skips synthetic/ignored text
 * (system-injected reminders) so notifications show what the user/AI actually
 * said.
 * @param {any[]} parts
 * @param {{lastOnly?:boolean}} [opts]
 * @returns {string}
 */
function textFromParts(parts, opts = {}) {
	if (!Array.isArray(parts)) return ""
	const chunks = []
	for (const part of parts) {
		if (part?.type !== "text") continue
		if (part.synthetic || part.ignored) continue
		const text = typeof part.text === "string" ? part.text.trim() : ""
		if (text) chunks.push(text)
	}
	if (chunks.length === 0) return ""
	return opts.lastOnly ? chunks[chunks.length - 1] : chunks.join(" ")
}

/**
 * Pull the conversation context that identifies WHAT this notification is about:
 * the latest user prompt, the latest assistant reply, the agent/model used, and
 * the provider ID (needed to resolve a human-readable model name).
 * Falls back to empty strings so callers can omit individual lines.
 *
 * @param {any[]} items session timeline (each item: `{ info, parts }`)
 * @returns {{prompt:string, reply:string, agent:string, model:string, provider:string}}
 */
export function conversationContextFromMessages(items) {
	const context = { prompt: "", reply: "", agent: "", model: "", provider: "" }
	if (!Array.isArray(items) || items.length === 0) return context

	// Newest user message with real text = the prompt that started this run.
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]
		const info = item?.info ?? item
		if (info?.role !== "user") continue
		const parts = Array.isArray(item?.parts) ? item.parts : Array.isArray(info?.parts) ? info.parts : []
		const prompt = textFromParts(parts)
		if (!prompt) continue
		context.prompt = prompt
		context.agent = info?.agent ? String(info.agent) : ""
		context.model = info?.model?.modelID ? String(info.model.modelID) : ""
		context.provider = info?.model?.providerID ? String(info.model.providerID) : ""
		break
	}

	// Newest assistant text part = the final reply (not intermediate narration).
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]
		const info = item?.info ?? item
		if (info?.role !== "assistant") continue
		const parts = Array.isArray(item?.parts) ? item.parts : Array.isArray(info?.parts) ? info.parts : []
		const reply = textFromParts(parts, { lastOnly: true })
		if (!reply) continue
		context.reply = reply
		if (!context.agent && info?.mode) context.agent = String(info.mode)
		if (!context.model && info?.modelID) context.model = String(info.modelID)
		if (!context.provider && info?.providerID) context.provider = String(info.providerID)
		break
	}
	return context
}

/**
 * Strip leading bracketed annotations from a model display name:
 * "[自配][CMDC] DeepSeek V4.1 Flash" -> "DeepSeek V4.1 Flash".
 * Falls back to the original string when stripping leaves nothing.
 * @param {any} value
 * @returns {string}
 */
export function shortenModelName(value) {
	const text = String(value ?? "").trim()
	if (!text) return ""
	const bare = text.replace(/^(?:\s*\[[^\]]*\])+\s*/, "").trim()
	return bare || text
}

/**
 * Format session diff stats: "+12/-3 · 2 files". Empty when unavailable.
 * @param {any} summary
 * @returns {string}
 */
function buildDiffText(summary) {
	const additions = Number(summary?.additions)
	const deletions = Number(summary?.deletions)
	if (!Number.isFinite(additions) || !Number.isFinite(deletions) || (!additions && !deletions)) return ""
	const files = Number(summary?.files)
	const filesBit = Number.isFinite(files) && files > 0 ? ` · ${files} file${files === 1 ? "" : "s"}` : ""
	return `+${additions}/-${deletions}${filesBit}`
}

/**
 * Build the compact context line shown under the timestamp:
 * `<project folder> · <agent> · <model> · +adds/-dels · N files`.
 * Empty when `showContext` is false or nothing is known.
 * @param {{title?:string, cwd?:string, directory?:string, summary?:any}} ctx
 * @param {{agent?:string, model?:string, modelName?:string}} conv
 * @param {any} config
 * @returns {string[]}
 */
function contextMetaBits(ctx, conv, config) {
	if (config.showContext === false) return []
	const bits = []
	const dir = String(ctx?.directory ?? ctx?.cwd ?? "").replace(/[\\/]+$/, "")
	const project = dir ? path.basename(dir) : ""
	if (project) bits.push(project)
	if (conv?.agent) bits.push(formatAgentName(conv.agent))
	// `{model}` means the human-readable name; the raw ID is `{modelId}`.
	if (conv?.model) bits.push(conv.modelName || conv.model)
	const diff = buildDiffText(ctx?.summary)
	if (diff) bits.push(diff)
	return bits
}

// Provider catalogs rarely change; cache per client for 10 minutes. A WeakMap
// keeps the cache scoped to the plugin instance (and lets tests use fresh
// clients without cross-test leakage).
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000
const modelCatalogCache = new WeakMap()

/** Flatten a provider catalog into `providerID/modelID -> display name`. */
function modelNamesFromProviders(providers) {
	const names = new Map()
	for (const provider of Array.isArray(providers) ? providers : []) {
		const providerID = provider?.id
		if (!providerID) continue
		const models = provider?.models ?? {}
		for (const [key, model] of Object.entries(models)) {
			const name = typeof model?.name === "string" ? model.name.trim() : ""
			if (!name) continue
			const modelID = model?.id ? String(model.id) : String(key)
			names.set(`${providerID}/${modelID}`, name)
			names.set(`${providerID}/${key}`, name)
		}
	}
	return names
}

/**
 * Load the provider catalog once per client/TTL. Prefers `config.providers()`
 * (the same source the TUI/CLI uses) and falls back to `provider.list()`.
 * Any failure degrades to an empty map so notifications still render the ID.
 * @param {any} client
 * @returns {Promise<Map<string,string>>}
 */
async function loadModelNameCatalog(client) {
	if (!client) return new Map()
	const cached = modelCatalogCache.get(client)
	if (cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.names
	let providers = []
	try {
		if (typeof client.config?.providers === "function") {
			const res = await client.config.providers()
			providers = res?.data?.providers ?? res?.providers ?? []
		}
	} catch {
		// Fall through to provider.list() below.
		providers = []
	}
	if ((!Array.isArray(providers) || providers.length === 0) && typeof client.provider?.list === "function") {
		try {
			const res = await client.provider.list()
			providers = res?.data?.all ?? res?.all ?? []
		} catch {
			providers = []
		}
	}
	const names = modelNamesFromProviders(providers)
	if (names.size > 0) modelCatalogCache.set(client, { at: Date.now(), names })
	return names
}

/**
 * Resolve a model's human-readable name. Returns "" when the provider catalog
 * is unavailable or the model is unknown; callers fall back to the model ID.
 * @param {any} client
 * @param {string|undefined} providerID
 * @param {string|undefined} modelID
 * @returns {Promise<string>}
 */
export async function resolveModelName(client, providerID, modelID) {
	if (!providerID || !modelID) return ""
	const names = await loadModelNameCatalog(client)
	return names.get(`${providerID}/${modelID}`) ?? ""
}

// Full labels keep the old behavior (and read well alone); short labels are
// used when the session title shares the title bar and space is precious.
const TITLE_LABELS = {
	ready: { full: "READY FOR REVIEW", short: "READY" },
	error: { full: "SOMETHING WENT WRONG", short: "ERROR" },
	network: { full: "NETWORK INTERRUPTED", short: "NETWORK" },
	cancelled: { full: "STOPPED BY YOU", short: "STOPPED" },
	permission: { full: "WAITING FOR CONFIRMATION", short: "CONFIRM" },
	question: { full: "QUESTION FOR YOU", short: "QUESTION" },
	ended: { full: "SESSION ENDED", short: "ENDED" },
	stalled: { full: "SESSION STALLED", short: "STALLED" },
}

/**
 * Build the toast title. With `showSessionTitle` (default) the session title
 * shares the large title area: `READY · Fix login flow`. Without it the old
 * full label is returned unchanged.
 * @param {string} kind
 * @param {{title?:string}} ctx
 * @param {any} [config]
 * @returns {string}
 */
export function buildToastTitle(kind, ctx, config = {}) {
	const labels = TITLE_LABELS[kind] ?? { full: "", short: "" }
	if (config.showSessionTitle === false) return labels.full
	const session = shortenText(ctx?.title, config.sessionTitleChars ?? 40)
	if (!session) return labels.full
	return `${labels.short || labels.full} · ${session}`
}

/**
 * Build a one-line "recent steps" summary from session messages.
 *
 * Fetches the session timeline via `client.session.messages` and inspects
 * assistant message parts for tool invocations (`type === "tool"`). Returns the
 * labels of the most recent `maxSteps` tool steps, joined by " → ".
 *
 * The client is optional (older/injected test clients may not implement
 * `session.messages`); on any failure we return "" so the caller degrades
 * gracefully to title-only notifications.
 *
 * @param {{session: any} | undefined} client
 * @param {string} sessionID
 * @param {number} [maxSteps=3]
 * @returns {Promise<string>}
 */
export async function buildStepSummary(client, sessionID, maxSteps = 3) {
	return summaryFromMessages(await loadSessionMessages(client, sessionID), maxSteps)
}

/** Pure version of the step-summary builder, used when items are already loaded. */
function summaryFromMessages(items, maxSteps) {
	const limit = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 0
	if (limit === 0) return ""
	const labels = []
	for (let i = items.length - 1; i >= 0 && labels.length < limit; i--) {
		const item = items[i]
		const info = item?.info ?? item
		const parts = Array.isArray(item?.parts) ? item.parts : Array.isArray(info?.parts) ? info.parts : []
		for (let j = parts.length - 1; j >= 0 && labels.length < limit; j--) {
			const part = parts[j]
			// Prefer completed tool steps; also accept raw-by-name tool parts.
			if (part?.type !== "tool") continue
			const label = toolStepLabel(part)
			if (label) labels.push(label)
		}
	}
	if (labels.length === 0) return ""
	return Array.from(new Set(labels)).reverse().join(" → ")
}

/**
 * Classify how the session's latest run ended by inspecting the final assistant
 * message part state. This replaces the flaky 1.5s time-window "error suppresses
 * ready" heuristic with a robust state-based answer, independent of how long the
 * idle event arrives after the error.
 *
 * @param {{session: any} | undefined} client
 * @param {string} sessionID
 * @returns {Promise<"error"|"aborted"|"complete"|null>}
 */
export async function getLastRunOutcome(client, sessionID) {
	return lastRunOutcomeFromMessages(await loadSessionMessages(client, sessionID))
}

/** Pure version of the outcome classifier, used when items are already loaded. */
function lastRunOutcomeFromMessages(items) {
	// A run aborted before the model produced any output (e.g. ESC before it
	// started thinking) leaves the timeline trailing on a user/tool message
	// with no assistant reply. That is not a completed run: classify it as
	// "aborted" so it announces STOPPED BY YOU instead of a bogus READY.
	if (items.length > 0) {
		const tail = items[items.length - 1]
		const tailInfo = tail?.info ?? tail
		const tailRole = tailInfo?.role ?? tail?.role
		if (tailRole && tailRole !== "assistant") return "aborted"
	}
	// Scan from the newest message for the last assistant message with parts.
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]
		const info = item?.info ?? item
		const role = info?.role ?? item?.role
		if (role !== "assistant") continue

		// Message-level error: OpenCode writes an interrupt as `info.error`
		// (e.g. MessageAbortedError) on the assistant message itself, even when
		// no part carries it. Check it BEFORE the per-part scan so an empty
		// aborted assistant message (nParts=0) is still classified correctly.
		const msgErr = info?.error
		if (msgErr) {
			return classifyAssistantError(msgErr) === "aborted" ? "aborted" : "error"
		}

		const parts = Array.isArray(item?.parts) ? item.parts : Array.isArray(info?.parts) ? info.parts : []
		for (let j = parts.length - 1; j >= 0; j--) {
			const part = parts[j]
			const state = part?.state
			if (state?.error) {
				if (classifyAssistantError(state.error) === "aborted") return "aborted"
				return "error"
			}
			const st = String(state?.status ?? state?.state ?? state?.type ?? "").toLowerCase()
			if (st === "aborted" || st === "abort" || st === "interrupted" || st === "cancelled") return "aborted"
			if (st === "error" || st === "failed") return "error"
		}
		// A real assistant message with parts but no error/abort signal = finished.
		if (parts.length > 0) return "complete"
	}
	return "complete"
}

// ==========================================
// NOTIFICATION SENDER
// ==========================================

const DEDUPE_WINDOW_MS = 1500

/** Cross-instance suppression window for heartbeat backfill toasts (6h). */
const HEARTBEAT_DEDUPE_MS = 6 * 60 * 60 * 1000

/**
 * When the user interrupts a run (ESC), OpenCode aborts the in-flight request;
 * that teardown frequently surfaces as a SECOND `session.error` carrying a real
 * connection signature ("fetch failed: read ECONNRESET"). Without this, a plain
 * double-ESC fires a scary "NETWORK INTERRUPTED" toast on top of "STOPPED BY
 * YOU". A network/http error that lands within this window AFTER a user-cancel
 * for the SAME session is therefore treated as the abort tearing the connection
 * down, and its toast is suppressed.
 */
const NETWORK_AFTER_CANCEL_MS = 5_000

/**
 * A cross-instance dedupe store backed by a JSON file on disk.
 *
 * OpenCode loads plugins from BOTH the global plugins dir and the project
 * .opencode/plugins dir, so the same plugin can run as two instances (each
 * with its own in-memory state). Without a shared store, a single "done"
 * event produces TWO toasts. Persisting recent-notify timestamps to a file in
 * os.tmpdir() lets every instance see the same history and suppress dupes.
 * @param {string} filePath
 */
function createSharedDedupeStore(filePath) {
	return {
		/** @returns {Map<string, number>} */
		load() {
			try {
				const raw = fsSync.readFileSync(filePath, "utf8")
				return new Map(Object.entries(JSON.parse(raw)))
			} catch {
				return new Map()
			}
		},
		/** @param {Map<string, number>} map */
		save(map) {
			try {
				const tmp = `${filePath}.${process.pid}.tmp`
				fsSync.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)))
				fsSync.renameSync(tmp, filePath)
			} catch {
				// best effort
			}
		},
	}
}

/**
 * @typedef {Object} Dedupe
 * @property {(key:string)=>boolean} shouldSend
 */

/**
 * @param {ReturnType<typeof createSharedDedupeStore> | null} [store]
 * @param {number} [windowMs=DEDUPE_WINDOW_MS] suppress-repeat window
 * @returns {Dedupe}
 */
function createDedupe(store = null, windowMs = DEDUPE_WINDOW_MS) {
	// In-memory backing used when no shared store is provided, so state persists
	// across calls within this plugin instance (the shared store path is only for
	// cross-instance deduping — e.g. suppress windows that each copy tracks itself).
	const local = new Map()
	const asMap = () => (store ? store.load() : local)
	const saveIfStore = (map) => { if (store) store.save(map) }
	const purge = (map, now) => {
		for (const [k, ts] of map) {
			if (now - ts >= windowMs) map.delete(k)
		}
		return map
	}
	return {
		/** @returns {boolean} true if this notify should be sent (not recently sent) */
		shouldSend(key) {
			const now = Date.now()
			const map = purge(asMap(), now)
			let should = true
			if (key !== undefined && key !== null && now - (map.get(key) ?? 0) < windowMs) {
				should = false
			} else {
				map.set(key, now)
			}
			saveIfProvided(map)
			return should
		},
		/**
		 * True if `key` is still within its suppression window, WITHOUT writing
		 * anything new (read-only). Used to detect "this run already produced a
		 * terminal toast" — e.g. session.error claimed the run-token, so a late
		 * session.idle for the SAME run must not announce READY, regardless of how
		 * long after the error it arrives.
		 * @param {string|number|null|undefined} key
		 * @returns {boolean}
		 */
		isClaimed(key) {
			if (key === undefined || key === null) return false
			const now = Date.now()
			const map = purge(asMap(), now)
			return now - (map.get(key) ?? 0) < windowMs
		},
	}
	function saveIfProvided(map) {
		if (!store) return
		store.save(map)
	}
}

/**
 * Build the plugin.
 * @param {object} overrides - dependency injection for testing.
 */
export function createNotifyPlugin(overrides = {}) {
	const {
		// injectable runtime pieces
		platform = process.platform,
		homedir = os.homedir,
		env = process.env,
		// injectable notification backend
		sendNotification = (opts) => {
			// Self-hosted: named-pipe + -pipeName for reliable display, plus full
			// control over sound / banner / click-to-open (no node-notifier whitelist).
			sendWindowsToast(opts)
		},
		// injectable terminal detector
		detectTerminalImpl = () => {
			const detect = resolveDetectTerminal()
			if (!detect) return null
			return detect()
		},
		readConfig = loadConfig,
		beep = playInterruptionBeep,
		// Path of the cross-instance dedupe store (os.tmpdir by default). Set to
		// a unique temp path in tests to keep harnesses isolated from each other.
		dedupeStorePath = path.join(os.tmpdir(), "kdco-notify-win-dedupe.json"),
		// Injectable clock for deterministic heartbeat tests.
		now = () => Date.now(),
	} = overrides

	return async function NotifyPlugin(ctx, options = {}) {
		const { client } = ctx ?? {}

		const config = await readConfig(options)

		// Bootstrap the generic logger (once). Min level defaults to WARN so normal
		// running writes almost nothing; set logging.minLogLevel:"ALL" to capture
		// raw payloads + decisions as you debug.
		PluginLogger.init({ ...DEFAULT_CONFIG.logging, ...(config.logging ?? {}), configLoader: buildLoggingConfigLoader() })
		PluginLogger.info("notify", "L1002", "config source={} logging.enabled={} minLogLevel={}", resolveConfigPath() ?? "(defaults, no file)", config.logging?.enabled, config.logging?.minLogLevel)

		const dedupeStore = createSharedDedupeStore(dedupeStorePath)
		const questionDedupe = createDedupe(dedupeStore)
		const readyDedupe = createDedupe(dedupeStore)
		const permissionDedupe = createDedupe(dedupeStore)
		const errorDedupe = createDedupe(dedupeStore)
		// 15s in-memory window: a session.error must not be followed by a READY
		// toast even when the session.idle event arrives later than the 1.5s
		// readyDedupe window (the recurring "ESC → NETWORK INTERRUPT then READY"
		// bug). Kept in-memory (no shared store) so the shared file's per-instance
		// purge can't collide across dedupe windows — each OpenCode plugin copy
		// sees the same error event and independently suppresses its own READY.
		const readySuppressDedupe = createDedupe(null, 15_000)
		// Long-window dedupe so a heartbeat backfill can't be double-sent by the
		// global+project copies of the plugin sharing the same store file.
		const heartbeatDedupe = createDedupe(dedupeStore, HEARTBEAT_DEDUPE_MS)
		// Heartbeat state: sessions that were recently active but may have ended
		// silently (no session.error / session.idle event reached us).
		const activeSessions = new Map() // sessionID -> { lastActivity, lastWarned }
		// Timestamp of the most recent user-cancel per session, used to suppress a
		// network-looking error that's just the abort tearing down the request.
		const lastUserCancel = new Map() // sessionID -> epoch ms
		/**
		 * Shared per-run "this run got a terminal toast" claim. Keyed by the
		 * session's `time.updated` (stable once a run finishes) so READY/ERROR/
		 * CANCELLED and the heartbeat agree across plugin instances AND across
		 * run reuse of the same sessionID. Heartbeat won't re-notify a run that
		 * already produced a terminal toast, and a NEW run gets a fresh claim.
		 */
		const claimRunNotified = (updated, sessionID) => {
			const token = updated ? `hb:${sessionID}:${String(updated)}` : `hb:${sessionID}`
			heartbeatDedupe.shouldSend(token)
		}

		// Register a branded Start-Menu shortcut for the toast app icon (once).
		// Best-effort AND non-blocking: PowerShell shortcut validation can take
		// over a second, so it runs in the background and never delays the first
		// notification. A stale icon merely renders a toast without an icon.
		// The shortcut icon follows config.iconTheme so switching themes rebuilds it.
		ensureAppRegistration(resolveIconTheme(config.iconTheme).iconPath).catch(() => {})

		// Terminal is only used for logging/context on Windows (no focus-suppression like macOS).
		let terminal
		try {
			terminal = config.terminal || detectTerminalImpl() || null
		} catch {
			terminal = null
		}

		const buildNotifyOptions = ({ title, message, sound, theme, clickMode, clickProgram, clickArgs }) => ({
			title,
			message,
			sound,
			theme,
			iconTheme: config.iconTheme,
			showBanner: config.showBanner,
			clickMode,
			clickProgram,
			clickArgs,
		})

		const send = (opts) => {
			try {
				PluginLogger.debug("notify", "L3001", "send toast title={} theme={} clickMode={} clickProgram={}", opts.title, opts.theme, opts?.clickMode, opts?.clickProgram ?? "")
				sendNotification(buildNotifyOptions(opts))
			} catch (err) {
				PluginLogger.warn("notify", "L3002", "notification send failed: {}", err)
			}
		}

		const shouldNotifyParent = async (sessionID) => {
			if (config.notifyChildSessions) return true
			return isParentSession(client, sessionID)
		}

		/**
		 * Resolve the click-to-open plan for a notification.
		 *
		 * clickMode:
		 *   "off"     -> null (no click)
		 *   "program" -> spawn `clickProgram` + `clickArgs` via our pipe callback
		 *   "native"  -> `-application <clickProgram>` handled by SnoreToast
		 * Placeholders ({{title}}/{{cwd}}/{{sessionID}}) are substituted from the
		 * per-notification context.
		 */
		const resolveClickPlan = (cfg) => {
			const mode = cfg.clickMode ?? "off"
			if (mode === "off") return null
			if (!cfg.clickProgram) return null
			return {
				mode,
				target: { program: cfg.clickProgram, args: Array.isArray(cfg.clickArgs) ? cfg.clickArgs.map(String) : [] },
			}
		}

		// Resolve effective notification extras from config: global sound override
		// and click-to-open plan (substituted with the notification's context).
		const notifyExtras = (ctx = {}) => {
			const extras = {}
			if (config.soundOverride) extras.sound = config.soundOverride
			const plan = resolveClickPlan(config)
			if (plan) {
				extras.clickMode = plan.mode
				extras.clickProgram = substitutePlaceholders(plan.target.program, ctx)
				extras.clickArgs = plan.target.args.map((a) => substitutePlaceholders(a, ctx))
			}
			return extras
		}

		// Attach the human-readable model name (falling back to the ID) so
		// composeMessage()/the future content template can expose `{model}`.
		const attachModelName = async (conv) => ({
			...conv,
			modelName: await resolveModelName(client, conv?.provider, conv?.model),
		})

		// Compose the multi-line notification body. The session title lives in the
		// toast TITLE (large font); the body carries the identifying context:
		//   [2026-08-05 14:23:11]  project · agent · model · +12/-3 · 2 files
		//   <error message / permission title / fallback>
		//   You: <last user prompt excerpt>
		//   AI: <last assistant reply excerpt>
		//   Steps: Read file X → Bash ls            (ready / ended only)
		const composeMessage = ({ kind, ctx = {}, conv = {}, primary, fallback, steps }) => {
			const lines = []
			const meta = contextMetaBits(ctx, conv, config)
			const timestamp = config.showTimestamp !== false ? formatTimestamp() : ""
			const head = [timestamp, meta.join(" · ")].filter(Boolean).join("  ")
			if (head) lines.push(head)

			// With the session title promoted to the toast title, only show it in
			// the body when that promotion is disabled (preserves the old layout).
			if (config.showSessionTitle === false && ctx?.title) lines.push(shortenText(ctx.title, 80))

			if (primary) lines.push(primary)
			else if (fallback && kind !== "ready") lines.push(fallback)

			if (config.showPrompt !== false) {
				const prompt = shortenText(conv.prompt, config.promptChars ?? 80)
				if (prompt) lines.push(`You: ${prompt}`)
			}
			if (config.showReply !== false) {
				const reply = shortenText(conv.reply, config.replyChars ?? 100)
				if (reply) lines.push(`AI: ${reply}`)
			}
			if ((kind === "ready" || kind === "ended") && config.showSummary && config.summarySteps && config.summarySteps > 0) {
				if (steps) lines.push(`Steps: ${steps}`)
			}
			return lines.length > 0 ? lines.join("\n") : fallback || ""
		}

		// ---- content templates (optional override) ----
		//
		// Empty titleTemplate/bodyTemplate keeps the built-in layout above. When
		// set, `{name}` placeholders are substituted from the notification's data.
		// A line whose known placeholders are ALL empty is dropped when
		// `dropEmptyLines` is true (default), which keeps "You:"/"AI:" lines from
		// appearing with no value.
		const contentConfig = config.content ?? {}
		const customTitleTemplate =
			typeof contentConfig.titleTemplate === "string" ? contentConfig.titleTemplate.trim() : ""
		const rawBodyTemplate = contentConfig.bodyTemplate
		const customBodyTemplate = Array.isArray(rawBodyTemplate)
			? rawBodyTemplate.length > 0 ? rawBodyTemplate : null
			: typeof rawBodyTemplate === "string" && rawBodyTemplate.trim()
				? rawBodyTemplate
				: null
		const dropEmptyTemplateLines = contentConfig.dropEmptyLines !== false
		const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g

		const renderTemplateLine = (line, vars) => {
			const text = String(line ?? "")
			const matches = [...text.matchAll(PLACEHOLDER_RE)]
			let hasKnown = false
			let hasValue = false
			for (const match of matches) {
				const key = match[1]
				if (Object.prototype.hasOwnProperty.call(vars, key)) {
					hasKnown = true
					if (String(vars[key] ?? "").trim()) hasValue = true
				} else {
					// Unknown placeholders stay visible so typos are noticeable.
					hasValue = true
				}
			}
			const rendered = text.replace(PLACEHOLDER_RE, (full, key) =>
				Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : full,
			)
			if (dropEmptyTemplateLines && hasKnown && !hasValue) return null
			if (dropEmptyTemplateLines && !rendered.trim()) return null
			return rendered
		}

		const renderTemplateText = (template, vars) => {
			const rendered = renderTemplateLine(template, vars)
			if (rendered === null) return ""
			return rendered.replace(/\s+/g, " ").trim()
		}

		const renderBodyTemplate = (template, vars) => {
			const lines = Array.isArray(template) ? template : String(template).split(/\r?\n/)
			const out = []
			for (const line of lines) {
				const rendered = renderTemplateLine(line, vars)
				if (rendered === null) continue
				out.push(rendered)
			}
			return out.join("\n")
		}

		/**
		 * Build the placeholder map for one notification. `{model}` is the
		 * human-readable name; `{modelId}`/`{agentId}` keep the raw values.
		 */
		const buildTemplateVars = ({ kind, ctx = {}, conv = {}, primary, fallback, steps, sessionID, errorText, permissionTitle, questionText }) => {
			const labels = TITLE_LABELS[kind] ?? { short: "", full: "" }
			const timeParts = timestampParts()
			const modelId = String(conv.model ?? "")
			const modelName = String(conv.modelName ?? "") || modelId
			const modelShort = shortenModelName(modelName) || modelName
			const dir = String(ctx?.directory ?? ctx?.cwd ?? "").replace(/[\\/]+$/, "")
			const primaryText = String(primary ?? "")
			// For READY, don't inject the "Task complete" fallback into a custom
			// template (it would duplicate the title). It is still used when the
			// rendered body is completely empty.
			const fallbackText = kind === "ready" ? "" : String(fallback ?? "")
			const additions = Number(ctx?.summary?.additions)
			const deletions = Number(ctx?.summary?.deletions)
			const files = Number(ctx?.summary?.files)
			return {
				type: labels.short ?? "",
				typeFull: labels.full ?? "",
				sessionTitle: shortenText(ctx?.title, config.sessionTitleChars ?? 40),
				sessionId: sessionID ? String(sessionID) : "",
				project: dir ? path.basename(dir) : "",
				cwd: ctx?.directory ?? ctx?.cwd ?? "",
				agent: formatAgentName(conv?.agent),
				agentId: conv?.agent ? String(conv.agent) : "",
				model: modelName,
				modelName,
				modelShort,
				modelId,
				provider: conv?.provider ? String(conv.provider) : "",
				meta: config.showContext === false ? "" : contextMetaBits(ctx, conv, config).join(" · "),
				timestamp: config.showTimestamp !== false ? timeParts.timestamp : "",
				date: timeParts.date,
				time: timeParts.time,
				diff: buildDiffText(ctx?.summary),
				additions: Number.isFinite(additions) ? String(additions) : "",
				deletions: Number.isFinite(deletions) ? String(deletions) : "",
				files: Number.isFinite(files) ? String(files) : "",
				prompt: config.showPrompt !== false ? shortenText(conv?.prompt, config.promptChars ?? 80) : "",
				reply: config.showReply !== false ? shortenText(conv?.reply, config.replyChars ?? 100) : "",
				steps:
					(kind === "ready" || kind === "ended") && config.showSummary && config.summarySteps && config.summarySteps > 0
						? String(steps ?? "")
						: "",
				primary: primaryText,
				error: errorText ? String(errorText) : "",
				permissionTitle: permissionTitle ? String(permissionTitle) : "",
				question: questionText ? String(questionText) : "",
				fallback: fallbackText,
				status: primaryText || fallbackText,
			}
		}

		/** Render title/message, using the custom templates when configured. */
		const renderNotification = (args) => {
			const vars = buildTemplateVars(args)
			const title = customTitleTemplate
				? renderTemplateText(customTitleTemplate, vars) || buildToastTitle(args.kind, args.ctx, config)
				: buildToastTitle(args.kind, args.ctx, config)
			const message = customBodyTemplate
				? renderBodyTemplate(customBodyTemplate, vars) || String(args.fallback ?? "")
				: composeMessage(args)
			return { title, message }
		}

		// ---- handlers ----

		const handleSessionIdle = async (sessionID, info) => {
			if (!(await shouldNotifyParent(sessionID))) return
			if (isQuietHours(config)) return

			// A session.error (network / crash / ESC) just fired for this session:
			// don't let the idle that follows it re-announce READY. The 1.5s
			// readyDedupe window at the event layer catches the immediate pair;
			// this 15s window catches idles that arrive a few seconds later.
			if (readySuppressDedupe.isClaimed(`suppress:${sessionID}`)) {
				PluginLogger.debug("notify", "L2012", "idle suppressed (error seen within 15s) sessionID={}", sessionID)
				activeSessions.delete(sessionID)
				return
			}

			// Fetch the timeline and session context in parallel; the timeline drives
			// the run-outcome classification, the conversation context (prompt/reply/
			// agent) and the step summary from a single messages round-trip.
			const [messages, ctx] = await Promise.all([
				loadSessionMessages(client, sessionID),
				getSessionContext(client, sessionID, info),
			])
			const outcome = lastRunOutcomeFromMessages(messages)
			const conv = await attachModelName(conversationContextFromMessages(messages))

			// A run that ended in error must NOT announce READY later. This is the
			// robust (state-based) counterpart to the 1.5s time-window suppression.
			if (outcome === "error") {
				PluginLogger.debug("notify", "L2010", "idle suppressed (outcome=error) sessionID={}", sessionID)
				return
			}

			// Run-token claim: if THIS run already produced a terminal toast (a
			// session.error / STOPPED BY YOU claimed `hb:<sessionID>:<updated>`),
			// a session.idle that arrives AFTER the 1.5s dedupe window would
			// otherwise wrongly announce READY. Keyed by the run's `time.updated`
			// so a brand-new run of the same session still gets its READY.
			const runToken = ctx.updated ? `hb:${sessionID}:${String(ctx.updated)}` : null
			if (runToken && heartbeatDedupe.isClaimed(runToken)) {
				PluginLogger.info("notify", "L2011", "idle suppressed (run token already claimed) sessionID={} updated={}", sessionID, ctx.updated)
				activeSessions.delete(sessionID)
				return
			}

			if (outcome === "aborted" && config.notifyCancelled !== false) {
				activeSessions.delete(sessionID)
				claimRunNotified(ctx.updated, sessionID)
				const { title, message } = renderNotification({
					kind: "cancelled",
					ctx,
					conv,
					fallback: "Session stopped",
					sessionID,
				})
				send({
					title,
					message,
					sound: config.sounds.cancelled ?? config.sounds.idle,
					theme: "cancelled",
					...notifyExtras({ ...ctx, sessionID }),
				})
				return
			}

			activeSessions.delete(sessionID)
			claimRunNotified(ctx.updated, sessionID)
			const { title, message } = renderNotification({
				kind: "ready",
				ctx,
				conv,
				fallback: "Task complete",
				steps: summaryFromMessages(messages, config.summarySteps),
				sessionID,
			})
			send({
				title,
				message,
				sound: config.sounds.idle,
				theme: "ready",
				...notifyExtras({ ...ctx, sessionID }),
			})
		}

		const handleSessionError = async (sessionID, rawError) => {
			if (!(await shouldNotifyParent(sessionID))) return
			if (isQuietHours(config)) return

			const category = categorizeErrorEvent(rawError)
			const userCancelled = category === "user-cancel"
			const isNetwork = category === "network-interruption" || category === "http-error"

			// Diagnostic: capture the RAW error payload + the category we chose, so
			// an ESC being mislabeled as NETWORK (the recurring bug) can be fixed
			// from the log instead of guessed. Enabled via logging.minLogLevel:"ALL".
			PluginLogger.debug("notify", "L2001", "session.error raw={}", safeStringify(rawError))
			PluginLogger.info("notify", "L2002", "session.error categorized={} name={} text={} sessionID={}",
				category, String(rawError?.name ?? ""), (extractErrorMessage(rawError) ?? "").slice(0, 120), sessionID)

			const text = extractErrorMessage(rawError)
			const message = (text ?? "").slice(0, 100) || "Something went wrong"
			// One extra fetch gives the error toast the same identifying context as
			// a READY toast (project / last prompt), which matters most when several
			// agents fail around the same time.
			const [messages, ctx] = await Promise.all([
				loadSessionMessages(client, sessionID),
				getSessionContext(client, sessionID),
			])
			const conv = await attachModelName(conversationContextFromMessages(messages))
			const notificationKind = userCancelled ? "cancelled" : isNetwork ? "network" : "error"
			const primary = userCancelled ? undefined : shortenText(message, 120)
			const fallback = userCancelled ? "Session stopped" : "Something went wrong"
			// A failed session should NOT also announce "ready" moments later.
			// Mark the same session's ready key as recently-sent so any idle event
			// arriving within the dedupe window is suppressed.
			readyDedupe.shouldSend(`ready:${sessionID}`)
			// Also claim the 15s suppression window (and, via claimRunNotified
			// below, the per-run token) so a late idle is suppressed even when it
			// arrives after the 1.5s readyDedupe window has expired.
			readySuppressDedupe.shouldSend(`suppress:${sessionID}`)
			activeSessions.delete(sessionID)
			claimRunNotified(ctx.updated, sessionID)

			// A user stop takes priority over whatever network-looking error the
			// abort teardown throws afterwards — remember it so the follow-up
			// session.error ("fetch failed: read ECONNRESET") is not announced
			// as NETWORK INTERRUPTED.
			if (userCancelled) {
				lastUserCancel.set(sessionID, now())
			} else if (isNetwork && lastUserCancel.has(sessionID)) {
				const sinceCancel = now() - lastUserCancel.get(sessionID)
				if (sinceCancel >= 0 && sinceCancel < NETWORK_AFTER_CANCEL_MS) {
					PluginLogger.info("notify", "L2003",
						"network error {}ms after user-cancel suppressed sessionID={}", sinceCancel, sessionID)
					// The STOPPED BY YOU toast already fired (or is suppressed by
					// notifyCancelled:false); do not stack a NETWORK toast on top.
					return
				}
			}

			const { title, message: body } = renderNotification({
				kind: notificationKind,
				ctx,
				conv,
				primary,
				fallback,
				sessionID,
				errorText: userCancelled ? "" : message,
			})

			if (userCancelled && config.notifyCancelled !== false) {
				send({
					title,
					message: body,
					sound: config.sounds.cancelled ?? config.sounds.idle,
					theme: "cancelled",
					...notifyExtras({ ...ctx, sessionID }),
				})
				return
			}
			if (userCancelled) return
			if (isNetwork) {
				send({
					title,
					message: body,
					sound: config.sounds.network,
					theme: "network",
					...notifyExtras({ ...ctx, sessionID }),
				})
				beep(config.beepOnInterruption)
			} else {
				send({
					title,
					message: body,
					sound: config.sounds.error,
					theme: "error",
					...notifyExtras({ ...ctx, sessionID }),
				})
			}
		}

		const handlePermissionUpdated = async (props) => {
			if (isQuietHours(config)) return
			const sessionID = props?.sessionID ? String(props.sessionID) : null
			const [ctx, messages] = sessionID
				? await Promise.all([getSessionContext(client, sessionID), loadSessionMessages(client, sessionID)])
				: [{}, []]
			const conv = await attachModelName(conversationContextFromMessages(messages))
			const permissionTitle = shortenText(props?.title, 120) || undefined
			const { title, message: body } = renderNotification({
				kind: "permission",
				ctx,
				conv,
				primary: permissionTitle,
				fallback: "OpenCode needs your input",
				sessionID,
				permissionTitle,
			})
			send({
				title,
				message: body,
				sound: config.sounds.permission,
				theme: "permission",
				...notifyExtras({ ...ctx, sessionID }),
			})
		}

		const handleQuestionAsked = async (props) => {
			if (isQuietHours(config)) return
			const sessionID = props?.sessionID ? String(props.sessionID) : null
			const [ctx, messages] = sessionID
				? await Promise.all([getSessionContext(client, sessionID), loadSessionMessages(client, sessionID)])
				: [{}, []]
			const conv = await attachModelName(conversationContextFromMessages(messages))
			const questionText = shortenText(extractQuestionText(props), 120) || undefined
			const { title, message: body } = renderNotification({
				kind: "question",
				ctx,
				conv,
				primary: questionText,
				fallback: "OpenCode needs your input",
				sessionID,
				questionText,
			})
			send({
				title,
				message: body,
				sound: config.sounds.question ?? config.sounds.permission,
				theme: "question",
				...notifyExtras({ ...ctx, sessionID }),
			})
		}

		// ---- heartbeat (silent-stop watchdog) ----

		/** Record that a session is actively producing output right now. */
		const markActive = (sessionID) => {
			if (!sessionID) return
			const prev = activeSessions.get(sessionID)
			activeSessions.set(sessionID, { lastActivity: now(), lastWarned: prev?.lastWarned ?? 0 })
			// Bounded: never track more than this many recent sessions.
			if (activeSessions.size > 50) {
				const oldest = [...activeSessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0]
				if (oldest) activeSessions.delete(oldest[0])
			}
		}

		/**
		 * Poll sessions that went quiet past `stallSec` but never delivered a
		 * terminal event to the plugin. If one actually ended (idle/complete/error
		 * per `client.session.get`) but was never notified, we backfill a
		 * "SESSION ENDED" toast — closing the "stream died silently" gap that pure
		 * event handling can never see. Also (optionally) warns while a session is
		 * STILL running but idle-past-stall.
		 */
		const heartbeatTick = async () => {
			if (isQuietHours(config)) return
			const hb = config.heartbeat ?? {}
			const stallMs = (Number(hb.stallSec) || 120) * 1000
			const warn = !!hb.warnWhileStalled
			const at = now()
			for (const [sessionID, rec] of [...activeSessions.entries()]) {
				const staleFor = at - rec.lastActivity
				if (staleFor < stallMs) continue // still within the healthy window

				let state = null
				let updated = null
				try {
					const session = await client.session.get({ path: { id: sessionID } })
					const d = session?.data
					if (d) {
						updated = d?.time?.updated ?? null
						const status = typeof d.status?.type === "string" ? d.status.type : typeof d.status === "string" ? d.status : null
						const s = status?.toLowerCase()
						if (s && ["idle", "complete", "completed", "done", "error", "failed"].includes(s)) state = s
						else if (s && ["running", "busy", "pending", "working", "active"].includes(s)) state = "running"
						else if (d.time?.completed) state = "idle"
						else if (d.time?.updated) state = "running"
					}
				} catch {
					// ignore: leave this session for a later tick
				}

				if (state === "idle" || state === "error" || state === "failed" || state === "complete") {
					// Terminal, but we never got a terminal event -> backfill. The
					// per-run shared dedupe keeps global+project copies from double
					// sending and skips runs that already produced a terminal toast.
					const runToken = updated ? `hb:${sessionID}:${updated}` : `hb:${sessionID}`
					if (heartbeatDedupe.shouldSend(runToken)) {
						activeSessions.delete(sessionID)
						const ctx = await getSessionContext(client, sessionID)
						const messages = await loadSessionMessages(client, sessionID)
						const conv = await attachModelName(conversationContextFromMessages(messages))
						const { title, message: body } = renderNotification({
							kind: "ended",
							ctx,
							conv,
							fallback: "Session ended without a status event",
							steps: summaryFromMessages(messages, config.summarySteps),
							sessionID,
						})
						send({
							title,
							message: body,
							sound: config.sounds.idle,
							theme: "ready",
							...notifyExtras({ ...ctx, sessionID }),
						})
					}
					continue
				}

				if (state === "running" && warn) {
					// Still busy but silent past the stall -> telegraph the problem.
					if (at - rec.lastWarned >= stallMs) {
						const rec2 = activeSessions.get(sessionID)
						if (rec2) rec2.lastWarned = at
						if (heartbeatDedupe.shouldSend(`hb-stall:${sessionID}`)) {
							const ctx = await getSessionContext(client, sessionID)
							const messages = await loadSessionMessages(client, sessionID)
							const conv = await attachModelName(conversationContextFromMessages(messages))
							const { title, message: body } = renderNotification({
								kind: "stalled",
								ctx,
								conv,
								primary: "No output received — the run may be stuck or offline.",
								sessionID,
							})
							send({
								title,
								message: body,
								sound: config.sounds.network,
								theme: "network",
								...notifyExtras({ ...ctx, sessionID }),
							})
						}
					}
				}
				// Unknown state: keep tracking (next tick re-probes).
			}
		}

		const hbConfig = config.heartbeat ?? {}
		if (hbConfig.enabled !== false) {
			const intervalSec = hbConfig.intervalSec || 30
			const timer = setInterval(() => {
				heartbeatTick().catch(() => {})
			}, Math.max(1, intervalSec) * 1000)
			if (typeof timer?.unref === "function") timer.unref()
		}

		// ---- event wiring ----

		const toId = (v) => (typeof v === "string" && v.trim() ? v.trim() : null)

		return {
			"tool.execute.before": async (input) => {
				try {
					if (input?.sessionID) markActive(String(input.sessionID))
					if (input?.tool === "question") {
						// Use the SAME key shape as buildQuestionKey() so the
						// tool.execute.before path and the question.asked event path
						// dedupe against each other (one question -> one toast).
						const key = input?.sessionID
							? `question:${input.sessionID}:${input.callID ?? ""}`
							: "question"
						if (questionDedupe.shouldSend(key)) await handleQuestionAsked(input)
					}
				} catch (err) {
					console.warn("[kdco-notify-win] tool.execute.before error:", err)
				}
			},
			event: async ({ event }) => {
				// Wrap EVERYTHING in try/catch: an await that rejects here becomes
				// an unhandledRejection, which (Node 15+) terminates the whole
				// OpenCode CLI process. Swallow + log so a flaky session fetch or
				// a plugin bug can never crash the shell.
				try {
					const type = event?.type
					const props = event?.properties ?? {}

					// Raw event payload for diagnosis (only when logging.minLogLevel
					// allows DEBUG/ALL). Each branch below logs its own specifics.
					PluginLogger.debug("notify", "L1001", "event type={} payload={}", type ?? "", safeStringify(props, 1500))

					switch (type) {
					case "session.status": {
						// session.status fires for BOTH busy and idle transitions.
						// Track busy activity for the heartbeat; notify only on idle.
						const statusType = props?.status?.type
						const id = toId(props?.sessionID)
						if (id && (statusType === "busy" || statusType === "running" || statusType === "working" || statusType === "pending")) {
							markActive(id)
						}
						if (statusType !== "idle") break
						if (id && readyDedupe.shouldSend(`ready:${id}`)) {
							await handleSessionIdle(id, props?.info)
						}
						break
					}
					case "message.part.updated": {
						const id = toId(props?.sessionID)
						if (id) markActive(id)
						break
					}
					case "session.idle": {
						const id = toId(props?.sessionID)
						if (id && readyDedupe.shouldSend(`ready:${id}`)) {
							await handleSessionIdle(id, props?.info)
						}
						break
					}
					case "session.error": {
						const id = toId(props?.sessionID)
						if (id && errorDedupe.shouldSend(`error:${id}`)) {
							await handleSessionError(id, props?.error)
						}
						break
					}
					case "permission.updated":
					case "permission.asked": {
						const key = props?.id ? `permission:${props.id}` : "permission"
						if (permissionDedupe.shouldSend(key)) await handlePermissionUpdated(props)
						break
					}
					case "question.asked": {
						const key = buildQuestionKey(props)
						if (questionDedupe.shouldSend(key)) await handleQuestionAsked(props)
						break
					}
					}
				} catch (err) {
					console.warn("[kdco-notify-win] event handler error:", err)
				}
			},
			// Exposed for tests (and harmless to OpenCode, which ignores it).
			heartbeatTick,
		}
	}
}

function buildQuestionKey(props) {
	const id = props?.sessionID ? String(props.sessionID) : null
	const callID = props?.tool && typeof props.tool === "object" ? props.tool.callID : null
	if (id && callID) return `question:${id}:${callID}`
	if (props?.id) return `question:${id}:request:${props.id}`
	return "question"
}

/**
 * Best-effort extraction of the question text from a `question.asked` payload
 * (shapes vary across OpenCode versions and injection points).
 * @param {any} props
 * @returns {string}
 */
function extractQuestionText(props) {
	const direct = props?.question ?? props?.text ?? props?.title
	if (typeof direct === "string" && direct.trim()) return direct
	const first = Array.isArray(props?.questions) ? props.questions[0] : null
	if (typeof first === "string") return first
	if (first && typeof first === "object") {
		const value = first.question ?? first.text ?? first.label ?? first.header
		if (typeof value === "string" && value.trim()) return value
	}
	const fromTool = props?.tool?.input?.question ?? props?.tool?.input?.text
	if (typeof fromTool === "string" && fromTool.trim()) return fromTool
	return ""
}

// ==========================================
// PLUGIN EXPORT (V1 object form, official OpenCode standard)
// ==========================================
//
// OpenCode V1 expects `export default { id, server }` (or `{ id, tui }`).
// `id` is required for file plugins (resolvePluginId) and must match the
// deploy dir name (see README "ID consistency"). `server` receives the
// official opencode.json(c) `plugin` tuple options as its 2nd argument —
// those options are merged last (P1/P3, highest priority) into the config.
export default {
	id: PLUGIN_ID,
	server: async (ctx, options) => {
		return createNotifyPlugin()(ctx, options)
	},
}