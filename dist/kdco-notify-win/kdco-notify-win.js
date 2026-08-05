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
 *  - Quiet-hours suppression
 *  - Parent-session filtering (no sub-task spam) + 1.5s dedupe windows
 *  - Network interruption detection: explicit HTTP errors (503/401/500/429/...)
 *    and implicit mid-stream disconnects (ECONNRESET / socket hang up / aborted / fetch failed / ...)
 *    get a distinct "Network interrupted" title + optional system beep.
 *
 * Install (offline-friendly):
 *   1. Copy this whole `kdco-notify-win/` folder into `.opencode/plugins/`
 *   2. `cd kdco-notify-win && npm install`   (vendors node-notifier + detect-terminal into node_modules)
 *   3. Restart OpenCode.
 *
 * Config file: `~/.config/opencode/kdco-notify.json` (see README / DEFAULT_CONFIG below).
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

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

function resolveNotifier() {
	return tryRequire("node-notifier")
}

function resolveDetectTerminal() {
	return tryRequire("detect-terminal")
}

// ==========================================
// BRANDED WINDOWS TOAST (node-notifier path)
// ==========================================
//
// Direct SnoreToast invocation proved unreliable (silent exit, no toast). The
// stable path is node-notifier, which passes a -pipeName (named pipe callback)
// that lets SnoreToast actually display. We keep branding by passing:
//   - appID: "OpenCode.Notify"  -> Windows resolves the toast icon from the
//     Start-Menu shortcut registered for this appID
//   - icon: banner PNG          -> hero image shown in the toast body

const APP_ID = "OpenCode.Notify"
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(PLUGIN_DIR, "assets")
const BANNER_PATH = path.join(ASSETS_DIR, "opencode-notify-banner.png")
const ICON_PATH = path.join(ASSETS_DIR, "opencode-notify.ico")

/**
 * Register a Start Menu shortcut for the appID so Windows displays our icon.
 * Idempotent + best-effort. Also writes the AppUserModelID property onto the
 * shortcut (required for Windows to map the appID to the shortcut icon).
 */
async function ensureAppRegistration() {
	if (process.platform !== "win32") return
	const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
	const shortcutPath = path.join(
		appData, "Microsoft", "Windows", "Start Menu", "Programs",
		"OpenCode Notify.lnk",
	)
	try {
		const fsSync = moduleRequire("node:fs")
		if (fsSync.existsSync(shortcutPath)) return // already registered
		const psScript = [
			"$ws = New-Object -ComObject WScript.Shell",
			`$s = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
			`$s.TargetPath = '${process.execPath.replace(/'/g, "''")}'`,
			`$s.IconLocation = '${ICON_PATH.replace(/'/g, "''")},0'`,
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

/**
 * Send a branded Windows Toast via node-notifier.
 * @param {{title:string, message:string, sound?:string}} opts
 * @param {object} overrides - test overrides: {notifier?, bannerPath?}
 */
function sendBrandedToast(opts, overrides = {}) {
	const notifier = overrides.notifier ?? resolveNotifier()
	if (!notifier || process.platform !== "win32") return false

	const toastOptions = {
		title: opts.title,
		message: opts.message,
		appID: APP_ID,
	}
	// Hero image (banner) makes the toast look professional.
	try {
		const fsSync = moduleRequire("node:fs")
		if (fsSync.existsSync(overrides.bannerPath ?? BANNER_PATH)) {
			toastOptions.icon = overrides.bannerPath ?? BANNER_PATH
		}
	} catch {
		// ignore
	}

	try {
		notifier.notify(toastOptions)
		return true
	} catch {
		return false
	}
}

// ==========================================
// CONFIG
// ==========================================

const DEFAULT_CONFIG = {
	notifyChildSessions: false,
	sounds: {
		idle: "Glass",
		error: "Basso",
		permission: "Submarine",
		question: "Submarine",
		network: "Basso",
	},
	quietHours: {
		enabled: false,
		start: "22:00",
		end: "08:00",
	},
	/** Network-interruption errors also play a system beep (Windows SnoreToast ignores custom sounds). */
	beepOnInterruption: true,
}

const CONFIG_PATH = () => path.join(os.homedir(), ".config", "opencode", "kdco-notify.json")

async function loadConfig() {
	try {
		const content = await fs.readFile(CONFIG_PATH(), "utf8")
		const userConfig = JSON.parse(content)
		return {
			...DEFAULT_CONFIG,
			...userConfig,
			sounds: { ...DEFAULT_CONFIG.sounds, ...userConfig.sounds },
			quietHours: { ...DEFAULT_CONFIG.quietHours, ...userConfig.quietHours },
		}
	} catch {
		// Missing or invalid config -> defaults
		return DEFAULT_CONFIG
	}
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

async function getSessionTitle(client, sessionID) {
	try {
		const session = await client.session.get({ path: { id: sessionID } })
		return session?.data?.title ? String(session.data.title).slice(0, 50) : "Task"
	} catch {
		return "Task"
	}
}

// ==========================================
// NOTIFICATION SENDER
// ==========================================

const DEDUPE_WINDOW_MS = 1500

/**
 * @typedef {Object} NotifyScreen
 * @property {(opts:any)=>void} notify
 */

function createDedupe() {
	const recent = new Map()
	return {
		/** @returns {boolean} true if this notify should be sent (not recently sent) */
		shouldSend(key) {
			const now = Date.now()
			for (const [k, ts] of recent) {
				if (now - ts >= DEDUPE_WINDOW_MS) recent.delete(k)
			}
			if (key !== undefined && key !== null && now - (recent.get(key) ?? 0) < DEDUPE_WINDOW_MS) {
				return false
			}
			recent.set(key, now)
			return true
		},
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
			const sentBranded = sendBrandedToast(opts)
			if (sentBranded) return
			// Last-resort fallback: plain node-notifier if branding is unavailable.
			const notifier = resolveNotifier()
			if (notifier) {
				notifier.notify(opts)
				return
			}
			console.warn("[kdco-notify-win] node-notifier not installed; run `npm install` in this folder.")
		},
		// injectable terminal detector
		detectTerminalImpl = () => {
			const detect = resolveDetectTerminal()
			if (!detect) return null
			return detect()
		},
		readConfig = loadConfig,
		beep = playInterruptionBeep,
	} = overrides

	return async function NotifyPlugin(ctx) {
		const { client } = ctx ?? {}

		const config = await readConfig()
		const questionDedupe = createDedupe()
		const readyDedupe = createDedupe()
		const permissionDedupe = createDedupe()

		// Register a branded Start-Menu shortcut for the toast app icon (once).
		try {
			await ensureAppRegistration()
		} catch {
			// best effort
		}

		// Terminal is only used for logging/context on Windows (no focus-suppression like macOS).
		let terminal
		try {
			terminal = config.terminal || detectTerminalImpl() || null
		} catch {
			terminal = null
		}

		const buildNotifyOptions = ({ title, message, sound }) => ({ title, message, sound })

		const send = (opts) => {
			try {
				sendNotification(buildNotifyOptions(opts))
			} catch (err) {
				console.warn("[kdco-notify-win] notification failed:", err)
			}
		}

		const shouldNotifyParent = async (sessionID) => {
			if (config.notifyChildSessions) return true
			return isParentSession(client, sessionID)
		}

		// ---- handlers ----

		const handleSessionIdle = async (sessionID) => {
			if (!(await shouldNotifyParent(sessionID))) return
			if (isQuietHours(config)) return

			const title = await getSessionTitle(client, sessionID)
			send({ title: "Ready for review", message: title, sound: config.sounds.idle })
		}

		const handleSessionError = async (sessionID, rawError) => {
			if (!(await shouldNotifyParent(sessionID))) return
			if (isQuietHours(config)) return

			const kind = classifyError(rawError)
			const isNetwork = kind === "network-interruption" || kind === "http-error"

			const message = rawError?.slice(0, 100) || "Something went wrong"
			if (isNetwork) {
				send({
					title: "Network interrupted",
					message,
					sound: config.sounds.network,
				})
				beep(config.beepOnInterruption)
			} else {
				send({ title: "Something went wrong", message, sound: config.sounds.error })
			}
		}

		const handlePermissionUpdated = async () => {
			if (isQuietHours(config)) return
			send({
				title: "Waiting for you",
				message: "OpenCode needs your input",
				sound: config.sounds.permission,
			})
		}

		const handleQuestionAsked = async () => {
			if (isQuietHours(config)) return
			send({
				title: "Question for you",
				message: "OpenCode needs your input",
				sound: config.sounds.question ?? config.sounds.permission,
			})
		}

		// ---- event wiring ----

		const toId = (v) => (typeof v === "string" && v.trim() ? v.trim() : null)

		return {
			"tool.execute.before": async (input) => {
				if (input?.tool === "question") {
					const key = `${input?.sessionID}:${input?.callID}`
					if (questionDedupe.shouldSend(key)) await handleQuestionAsked()
				}
			},
			event: async ({ event }) => {
				const type = event?.type
				const props = event?.properties ?? {}

				switch (type) {
					case "session.status":
					case "session.idle": {
						const id = toId(props?.sessionID)
						if (id && readyDedupe.shouldSend(`ready:${id}`)) {
							await handleSessionIdle(id)
						}
						break
					}
					case "session.error": {
						const id = toId(props?.sessionID)
						const raw = typeof props?.error === "string" ? props.error : props?.error ? String(props.error) : undefined
						if (id) await handleSessionError(id, raw)
						break
					}
					case "permission.updated":
					case "permission.asked": {
						const key = props?.id ? `permission:${props.id}` : "permission"
						if (permissionDedupe.shouldSend(key)) await handlePermissionUpdated()
						break
					}
					case "question.asked": {
						const key = buildQuestionKey(props)
						if (questionDedupe.shouldSend(key)) await handleQuestionAsked()
						break
					}
				}
			},
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

// ==========================================
// PLUGIN EXPORT
// ==========================================

export default createNotifyPlugin()