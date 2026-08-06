/**
 * Self-test for kdco-notify-win.js
 * =================================
 * Runs the plugin with injected fakes (fake notifier / client / clock) so no
 * real node-notifier binary or OpenCode instance is required.
 *
 * Run:  node test/notify.test.mjs
 */

import assert from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import * as net from "node:net"
import {
	createNotifyPlugin,
	classifyError,
	formatTimestamp,
	buildStepSummary,
	getLastRunOutcome,
	sendWindowsToast,
	buildSnoreToastArgs,
	parseActivationPayload,
	substitutePlaceholders,
} from "../dist/kdco-notify-win/kdco-notify-win.js"

let passed = 0
let failed = 0

// Assert a notification body starts with a [yyyy-MM-dd HH:mm:ss] timestamp line
// and contains the given expected content (anywhere in the body).
function assertBody(actual, expected) {
	assert.match(actual, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/)
	assert.ok(actual.includes(expected), `body ${JSON.stringify(actual)} should include ${JSON.stringify(expected)}`)
}

function test(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed += 1
			console.log(`  ok  - ${name}`)
		})
		.catch((err) => {
			failed += 1
			console.error(`  FAIL - ${name}`)
			console.error(`         ${err && err.message}`)
		})
}

function makeSessionClient(parentID) {
	const sessions = new Map()
	sessions.set("parent", { data: { title: "My Task", parentID: null } })
	sessions.set("child", { data: { title: "Sub Task", parentID: "parent" } })
	return {
		session: {
			get: async ({ path: { id } }) => sessions.get(id) ?? { data: null },
			messages: async ({ path: { id } }) => [
				{
					info: { id: `${id}-m1`, role: "assistant" },
					parts: [
						{ type: "tool", tool: "read", state: { title: "Read file /a.txt" } },
						{ type: "tool", tool: "bash", state: { title: "Bash ls" } },
					],
				},
				{
					info: { id: `${id}-m2`, role: "user" },
					parts: [{ type: "text", text: "hi" }],
				},
			],
		},
	}
}

async function makeHarness({ client, config, platform = "win32", clock = null, dedupeStorePath = null, now = null }) {
	const sent = []
	const beeps = []
	const notifierImpl = (opts) => sent.push(opts)
	const readConfig = async () => config
	let nowMs = clock ?? Date.now()
	const clockFn = now ?? (() => nowMs)

	const pluginFactory = createNotifyPlugin({
		platform,
		detectTerminalImpl: () => "Windows Terminal",
		sendNotification: notifierImpl,
		readConfig,
		beep: (flag) => {
			if (flag) beeps.push(1)
		},
		now: clockFn,
		dedupeStorePath: dedupeStorePath ?? path.join(os.tmpdir(), `kdco-notify-test-${Math.random().toString(36).slice(2)}.json`),
	})

	const pluginDone = await pluginFactory({ client })
	return {
		pluginDone,
		sent,
		beeps,
		// deterministic clock for quiet-hours / heartbeat tests
		setNow: (ms) => {
			nowMs = ms
		},
	}
}

const baseConfig = () => ({
	notifyChildSessions: false,
	sounds: { idle: "Glass", error: "Basso", permission: "Submarine", question: "Submarine", network: "Basso", cancelled: "Basso" },
	quietHours: { enabled: false, start: "22:00", end: "08:00" },
	beepOnInterruption: true,
	showTimestamp: true,
	showSummary: true,
	summarySteps: 3,
	themedIcons: true,
	soundOverride: "",
	clickMode: "off",
	clickProgram: "",
	clickArgs: [],
	notifyCancelled: true,
	heartbeat: { enabled: false, intervalSec: 30, stallSec: 120, warnWhileStalled: false },
})

async function main() {
	console.log("classifyError:")
	await test("classify http-error (503)", () => {
		assert.equal(classifyError("503 Service Unavailable"), "http-error")
	})
	await test("classify http-error (401)", () => {
		assert.equal(classifyError("status code 401 unauthorized"), "http-error")
	})
	await test("classify network-interruption (ECONNRESET)", () => {
		assert.equal(classifyError("fetch failed: read ECONNRESET"), "network-interruption")
	})
	await test("classify network-interruption (socket hang up)", () => {
		assert.equal(classifyError("socket hang up"), "network-interruption")
	})
	await test("classify generic error", () => {
		assert.equal(classifyError("division by zero"), "generic")
	})
	await test("classify non-string -> generic", () => {
		assert.equal(classifyError(undefined), "generic")
	})

	console.log("plugin behaviors:")
	await test("session.idle notifies parent with title", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "READY FOR REVIEW")
		assertBody(h.sent[0].message, "My Task")
	})

	await test("child session idle is suppressed by default", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "child" } } })
		assert.equal(h.sent.length, 0)
	})

	await test("notifyChildSessions:true includes child", async () => {
		const cfg = { ...baseConfig(), notifyChildSessions: true }
		const h = await makeHarness({ client: makeSessionClient(), config: cfg })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "child" } } })
		assert.equal(h.sent.length, 1)
	})

	await test("session.error notifies with message", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({
			event: { type: "session.error", properties: { sessionID: "parent", error: "boom" } },
		})
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "SOMETHING WENT WRONG")
		assertBody(h.sent[0].message, "boom")
	})

	await test("network interruption uses distinct title + beep", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({
			event: { type: "session.error", properties: { sessionID: "parent", error: "fetch failed: read ECONNRESET" } },
		})
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "NETWORK INTERRUPTED")
		assert.equal(h.beeps.length, 1)
	})

	await test("quiet hours suppress notification", async () => {
		const cfg = { ...baseConfig(), quietHours: { enabled: true, start: "22:00", end: "08:00" } }
		const h = await makeHarness({ client: makeSessionClient(), config: cfg })
		// 02:00 is inside quiet hours
		const orig = Date
		global.Date = class extends Date {
			constructor(...a) {
				if (a.length === 0) super(0)
				else super(...a)
			}
			getHours() { return 2 }
			getMinutes() { return 0 }
		}
		try {
			await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		} finally {
			global.Date = orig
		}
		assert.equal(h.sent.length, 0)
	})

	await test("quiet hours off -> notifies", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent.length, 1)
	})

	await test("dedupe: same ready event within window sent once", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent.length, 1)
	})

	await test("cross-instance: two plugin instances sharing a store send only once", async () => {
		// Simulates global + project plugins dirs both loading the plugin.
		const sharedPath = path.join(os.tmpdir(), `kdco-notify-cross-${Math.random().toString(36).slice(2)}.json`)
		const a = await makeHarness({ client: makeSessionClient(), config: baseConfig(), dedupeStorePath: sharedPath })
		const b = await makeHarness({ client: makeSessionClient(), config: baseConfig(), dedupeStorePath: sharedPath })
		await a.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		await b.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(a.sent.length + b.sent.length, 1)
		fs.rmSync(sharedPath, { force: true })
	})

	await test("permission.updated notifies", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "permission.updated", properties: { id: "p1" } } })
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "WAITING FOR CONFIRMATION")
	})

	await test("question.asked notifies", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({
			event: { type: "question.asked", properties: { sessionID: "parent", tool: { callID: "c1" } } },
		})
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "QUESTION FOR YOU")
	})

	await test("plugin loads without vendored deps (graceful warn, no crash)", async () => {
		// Default factory must not throw at construction even if node-notifier missing.
		const factory = createNotifyPlugin({})
		const instance = await factory({ client: makeSessionClient() })
		assert.equal(typeof instance.event, "function")
	})

	console.log("busy/status/dedupe behaviors:")
	await test("session.status busy does NOT notify", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({
			event: { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } },
		})
		assert.equal(h.sent.length, 0)
	})

	await test("session.status idle DOES notify (deduped with session.idle)", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({
			event: { type: "session.status", properties: { sessionID: "parent", status: { type: "idle" }, info: { title: "My Task" } } },
		})
		await h.pluginDone.event({
			event: { type: "session.idle", properties: { sessionID: "parent" } },
		})
		assert.equal(h.sent.length, 1)
		assertBody(h.sent[0].message, "My Task")
	})

	await test("session.error deduped within window", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		const ev = () =>
			h.pluginDone.event({
				event: { type: "session.error", properties: { sessionID: "parent", error: "boom" } },
			})
		await ev()
		await ev()
		assert.equal(h.sent.length, 1)
	})

	await test("session.error object extracts readable message", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({
			event: {
				type: "session.error",
				properties: { sessionID: "parent", error: { name: "UnknownError", data: { message: "Model not found: X." } } },
			},
		})
		assertBody(h.sent[0].message, "Model not found: X.")
	})

	console.log("extended features:")
	await test("formatTimestamp produces [yyyy-MM-dd HH:mm:ss]", async () => {
		const d = new Date(2026, 7, 5, 9, 8, 7) // 2026-08-05 09:08:07 local
		assert.equal(formatTimestamp(d), "[2026-08-05 09:08:07]")
	})

	await test("ready message includes recent steps summary", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.ok(h.sent[0].message.includes("Steps:"), "should include Steps line")
		assert.ok(h.sent[0].message.includes("Read file /a.txt"), "should include tool title")
		assert.ok(h.sent[0].message.includes("Bash ls"), "should include second tool")
	})

	await test("buildStepSummary returns latest steps joined by arrow", async () => {
		const summary = await buildStepSummary(makeSessionClient(), "parent", 3)
		// Reverse order: most recent first -> Read file /a.txt then Bash ls
		assert.equal(summary, "Read file /a.txt → Bash ls")
	})

	await test("buildStepSummary returns empty when client lacks messages", async () => {
		const client = { session: {} }
		const summary = await buildStepSummary(client, "parent", 3)
		assert.equal(summary, "")
	})

	await test("summarySteps:0 disables summary line", async () => {
		const cfg = { ...baseConfig(), summarySteps: 0 }
		const h = await makeHarness({ client: makeSessionClient(), config: cfg })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.ok(!h.sent[0].message.includes("Steps:"), "should NOT include Steps line")
	})

	await test("showTimestamp:false removes timestamp line", async () => {
		const cfg = { ...baseConfig(), showTimestamp: false }
		const h = await makeHarness({ client: makeSessionClient(), config: cfg })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.ok(!/^\s*\[\d{4}-\d{2}-\d{2}/.test(h.sent[0].message), "message should not start with timestamp")
	})

	await test("session.error suppressses a later ready for same session", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({
			event: { type: "session.error", properties: { sessionID: "parent", error: "boom" } },
		})
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent.length, 1, "error should have suppressed the ready toast")
	})

	await test("ready notification carries ready theme", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent[0].theme, "ready")
	})

	await test("network error carries network theme + sound override wins", async () => {
		const cfg = { ...baseConfig(), soundOverride: "Notification.Mail" }
		const h = await makeHarness({ client: makeSessionClient(), config: cfg })
		await h.pluginDone.event({
			event: { type: "session.error", properties: { sessionID: "parent", error: "fetch failed: read ECONNRESET" } },
		})
		assert.equal(h.sent[0].theme, "network")
		assert.equal(h.sent[0].sound, "Notification.Mail")
	})

	await test("clickProgram is passed through as clickProgram", async () => {
		const cfg = { ...baseConfig(), clickMode: "simple", clickProgram: "wt.exe", clickArgs: ["-d", ".", "opencode"] }
		const h = await makeHarness({ client: makeSessionClient(), config: cfg })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent[0].clickProgram, "wt.exe")
		assert.deepEqual(h.sent[0].clickArgs, ["-d", ".", "opencode"])
	})

	await test("default (no override) uses per-kind sound", async () => {
		const h = await makeHarness({ client: makeSessionClient(), config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent[0].sound, "Glass")
	})

	console.log("run-outcome classification (state-driven READY/error/cancel):")
	await test("getLastRunOutcome -> error when final part carries state.error", async () => {
		const client = {
			session: {
				get: async () => ({ data: { title: "T", parentID: null } }),
				messages: async () => [
					{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", state: { error: { name: "FetchError", message: "503" } } }] },
				],
			},
		}
		assert.equal(await getLastRunOutcome(client, "parent"), "error")
	})

	await test("getLastRunOutcome -> aborted on AbortError", async () => {
		const client = {
			session: {
				get: async () => ({ data: { title: "T", parentID: null } }),
				messages: async () => [
					{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", state: { error: { name: "AbortError", message: "user interrupt" } } }] },
				],
			},
		}
		assert.equal(await getLastRunOutcome(client, "parent"), "aborted")
	})

	await test("getLastRunOutcome -> aborted on status aborted", async () => {
		const client = {
			session: {
				get: async () => ({ data: { title: "T", parentID: null } }),
				messages: async () => [
					{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", state: { status: "aborted" } }] },
				],
			},
		}
		assert.equal(await getLastRunOutcome(client, "parent"), "aborted")
	})

	await test("getLastRunOutcome -> complete on clean final part", async () => {
		const client = {
			session: {
				get: async () => ({ data: { title: "T", parentID: null } }),
				messages: async () => [
					{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
				],
			},
		}
		assert.equal(await getLastRunOutcome(client, "parent"), "complete")
	})

	await test("idle after error is suppressed even beyond the 1.5s window (state-driven)", async () => {
		const errorClient = {
			session: {
				get: async ({ path: { id } }) => ({ data: { title: "My Task", parentID: null } }),
				messages: async () => [
					{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", state: { error: { name: "FetchError", message: "fetch failed: read ECONNRESET" } } }] },
				],
			},
		}
		const h = await makeHarness({ client: errorClient, config: baseConfig() })
		// Error first (network toast), then idle arrives LONG after the dedupe
		// window would have expired. The state-based check must still suppress READY.
		await h.pluginDone.event({ event: { type: "session.error", properties: { sessionID: "parent", error: "fetch failed: read ECONNRESET" } } })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent.length, 1, "only the network toast, no READY")
		assert.equal(h.sent[0].title, "NETWORK INTERRUPTED")
	})

	await test("ESC/user-stop idle sends STOPPED BY YOU with cancelled theme", async () => {
		const abortClient = {
			session: {
				get: async ({ path: { id } }) => ({ data: { title: "My Task", parentID: null } }),
				messages: async () => [
					{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", state: { error: { name: "AbortError", message: "user interrupt" } } }] },
				],
			},
		}
		const h = await makeHarness({ client: abortClient, config: baseConfig() })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "STOPPED BY YOU")
		assert.equal(h.sent[0].theme, "cancelled")
	})

	await test("notifyCancelled:false falls back to READY", async () => {
		const abortClient = {
			session: {
				get: async ({ path: { id } }) => ({ data: { title: "My Task", parentID: null } }),
				messages: async () => [
					{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", state: { error: { name: "AbortError", message: "user interrupt" } } }] },
				],
			},
		}
		const cfg = { ...baseConfig(), notifyCancelled: false }
		const h = await makeHarness({ client: abortClient, config: cfg })
		await h.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "READY FOR REVIEW")
	})

	console.log("heartbeat watchdog:")
	await test("heartbeat backfills SESSION ENDED for a silently-ended session", async () => {
		let clock = 1_000_000
		const statusClient = {
			session: {
				get: async ({ path: { id } }) => ({ data: { title: "My Task", parentID: null, status: { type: "idle" } } }),
				messages: async () => [],
			},
		}
		const cfg = { ...baseConfig(), heartbeat: { enabled: true, intervalSec: 30, stallSec: 1, warnWhileStalled: false } }
		const h = await makeHarness({ client: statusClient, config: cfg, now: () => clock })
		await h.pluginDone.event({ event: { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } } })
		clock += 5000 // way past stallSec with zero activity
		await h.pluginDone.heartbeatTick()
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "SESSION ENDED")
		await h.pluginDone.heartbeatTick()
		assert.equal(h.sent.length, 1, "no duplicate backfill")
	})

	await test("heartbeat does NOT backfill when the session is still running", async () => {
		let clock = 1_000_000
		const statusClient = {
			session: {
				get: async () => ({ data: { title: "My Task", parentID: null, status: { type: "running" } } }),
				messages: async () => [],
			},
		}
		const cfg = { ...baseConfig(), heartbeat: { enabled: true, intervalSec: 30, stallSec: 1, warnWhileStalled: false } }
		const h = await makeHarness({ client: statusClient, config: cfg, now: () => clock })
		await h.pluginDone.event({ event: { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } } })
		clock += 5000
		await h.pluginDone.heartbeatTick()
		assert.equal(h.sent.length, 0)
	})

	await test("heartbeat SESSION STALLED warn fires only when warnWhileStalled", async () => {
		let clock = 1_000_000
		const statusClient = {
			session: {
				get: async () => ({ data: { title: "My Task", parentID: null, status: { type: "running" } } }),
				messages: async () => [],
			},
		}
		const cfg = { ...baseConfig(), heartbeat: { enabled: true, intervalSec: 30, stallSec: 1, warnWhileStalled: true } }
		const h = await makeHarness({ client: statusClient, config: cfg, now: () => clock })
		await h.pluginDone.event({ event: { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } } })
		clock += 5000
		await h.pluginDone.heartbeatTick()
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0].title, "SESSION STALLED")
	})

	await test("heartbeat does NOT backfill a run another instance already reported", async () => {
		let clock = 1_000_000
		const makeStatusClient = () => ({
			session: {
				get: async () => ({ data: { title: "My Task", parentID: null, status: { type: "idle" }, time: { updated: 5000 } } }),
				messages: async () => [],
			},
		})
		const sharedPath = path.join(os.tmpdir(), `kdco-notify-hb-${Math.random().toString(36).slice(2)}.json`)
		const cfg = { ...baseConfig(), heartbeat: { enabled: false, intervalSec: 30, stallSec: 1, warnWhileStalled: false } }
		const a = await makeHarness({ client: makeStatusClient(), config: cfg, now: () => clock, dedupeStorePath: sharedPath })
		const b = await makeHarness({ client: makeStatusClient(), config: cfg, now: () => clock, dedupeStorePath: sharedPath })
		// A reports READY for this run, which claims hb:<id>:<updated> in the
		// shared store. B never processed that idle (deduped) but still tracks the
		// session as active.
		await a.pluginDone.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
		await b.pluginDone.event({ event: { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } } })
		clock += 5000
		await b.pluginDone.heartbeatTick()
		assert.equal(b.sent.length, 0, "B must not backfill a run A already reported as READY")
		fs.rmSync(sharedPath, { force: true })
	})

	console.log("click-to-open (activation pipe + placeholders):")
	await test("parseActivationPayload recognizes utf16/utf8 activation text", async () => {
		assert.equal(parseActivationPayload("action=activate"), "activate")
		assert.equal(parseActivationPayload("action=clicked"), "activate")
		assert.equal(parseActivationPayload("action=timedout"), null)
		assert.equal(parseActivationPayload(""), null)
		assert.equal(parseActivationPayload("no tokens here"), null)
	})

	await test("substitutePlaceholders replaces title/cwd/sessionID", async () => {
		assert.equal(substitutePlaceholders("-t {{title}} -d {{cwd}} -s {{sessionID}}", { title: "My Task", cwd: "E:\\proj", sessionID: "abc" }),
			"-t My Task -d E:\\proj -s abc")
		assert.equal(substitutePlaceholders("{{title}}", {}), "")
	})

	await test("sendWindowsToast activation callback spawns clickProgram", async () => {
		const spawned = []
		const childHandlers = {}
		const fakeChild = {
			unref: () => {},
			on: (ev, fn) => { childHandlers[ev] = fn },
		}
		const spawn = (cmd, args) => {
			spawned.push({ cmd, args })
			return fakeChild
		}
		sendWindowsToast(
			{ title: "T", message: "M", clickProgram: "wt.exe", clickArgs: ["-d", ".", "opencode"] },
			{ platform: "win32", snoreToastExe: "C:\\snoretoast.exe", spawn },
		)
		await new Promise((r) => setTimeout(r, 80))
		const snore = spawned[0]
		const pipePath = snore.args[snore.args.indexOf("-pipeName") + 1]
		// Simulate the user clicking the toast: SnoreToast writes utf16le activation.
		await new Promise((resolve) => {
			const sock = net.connect(pipePath, () => {
				sock.write(Buffer.from("action=activate", "utf16le"))
				sock.end()
			})
			sock.on("error", () => resolve())
			setTimeout(resolve, 120)
		})
		await new Promise((r) => setTimeout(r, 100))
		assert.ok(spawned.length >= 2, "click should spawn the click program")
		assert.equal(spawned[1].cmd, "wt.exe")
		// Close the pipe server promptly by firing the child exit handler.
		if (childHandlers.exit) childHandlers.exit(0)
		await new Promise((r) => setTimeout(r, 20))
	})

	console.log("self-hosted SnoreToast sender:")
	await test("buildSnoreToastArgs includes -pipeName alongside -application + custom sound", async () => {
		const args = buildSnoreToastArgs(
			{
				title: "T",
				message: "M",
				sound: "C:\\sounds\\ding.wav",
				theme: "ready",
				clickProgram: "wt.exe",
				clickArgs: ["-d", ".", "opencode"],
			},
			"C:\\banner.png",
			"\\\\.\\pipe\\notifierPipe-abc",
			true,
		)
		// Everything node-notifier's whitelist would allow AND what it drops.
		assert.ok(args.includes("-pipeName"), "args should include -pipeName")
		assert.ok(args.includes("-application"), "args should include -application")
		assert.ok(args.includes("-la"), "args should include -la")
		assert.ok(args.includes("-p"), "args should include -p")
		assert.ok(args.includes("-appID"), "args should include -appID")
		assert.ok(args.includes("C:\\banner.png"), "banner should pass through")
		assert.ok(args.includes("wt.exe"), "click program should pass through")
		assert.equal(args[args.indexOf("-pipeName") + 1], "\\\\.\\pipe\\notifierPipe-abc")
	})

	await test("buildSnoreToastArgs normalizes bare sound to a working sound", async () => {
		// "Glass" is a node-notifier-era preset name; SnoreToast fails with a
		// bare name and shows NO toast. Non-"Notification." sounds are normalized
		// so a toast always displays AND chimes ("Notification.Default" is silent
		// on this system, so the fallback is the audible "Notification.Reminder").
		const args = buildSnoreToastArgs({ title: "T", message: "M", sound: "Glass" }, undefined, undefined, false)
		assert.ok(args.includes("-s"), "should include -s")
		assert.ok(args.includes("Notification.Reminder"), "bare name -> Notification.Reminder")
		assert.ok(!args.includes("Glass"), "raw 'Glass' must not reach SnoreToast")
	})

	await test("buildSnoreToastArgs keeps Notification.* sound", async () => {
		const args = buildSnoreToastArgs({ title: "T", message: "M", sound: "Notification.Mail" }, undefined, undefined, false)
		assert.ok(args.includes("Notification.Mail"), "Notification.* should pass through")
	})

	await test("buildSnoreToastArgs omits -s when no sound", async () => {
		const args = buildSnoreToastArgs({ title: "T", message: "M" }, undefined, undefined, false)
		assert.ok(!args.includes("-s"), "no -s without sound")
	})

	await test("buildSnoreToastArgs omits -pipeName when no pipe", async () => {
		const args = buildSnoreToastArgs({ title: "T", message: "M" }, undefined, undefined, false)
		assert.ok(!args.includes("-pipeName"), "no -pipeName without a pipe")
		assert.ok(!args.includes("-application"), "no -application without clickProgram")
	})

	await test("sendWindowsToast spawns with unique pipe path per call", async () => {
		const calls = []
		const spawn = (cmd, args, opts) => {
			calls.push(args[args.indexOf("-pipeName") + 1])
			return { unref: () => {} }
		}
		sendWindowsToast({ title: "T", message: "M" }, { platform: "win32", snoreToastExe: "C:\\snoretoast.exe", spawn })
		sendWindowsToast({ title: "T", message: "M" }, { platform: "win32", snoreToastExe: "C:\\snoretoast.exe", spawn })
		// spawn fires inside the named-pipe `listen` callback => wait a tick
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(calls.length, 2, "should have spawned twice")
		assert.notEqual(calls[0], calls[1], "pipe paths should differ per toast")
	})

	await test("sendWindowsToast no-ops off Windows", async () => {
		const result = sendWindowsToast(
			{ title: "T", message: "M" },
			{ platform: "darwin", snoreToastExe: "C:\\snoretoast.exe", spawn: () => { throw new Error("must not spawn") } },
		)
		assert.equal(result, false)
	})

	await test("sendWindowsToast picks legacy banner when iconTheme=legacy", async () => {
		let captured = null
		const spawn = (cmd, args) => {
			captured = args
			return { unref: () => {} }
		}
		sendWindowsToast(
			{ title: "T", message: "M", theme: "ready", iconTheme: "legacy" },
			{ platform: "win32", snoreToastExe: "C:\\snoretoast.exe", spawn },
		)
		await new Promise((r) => setTimeout(r, 60))
		const i = captured.indexOf("-p")
		assert.ok(i >= 0, "should pass a banner")
		assert.ok(captured[i + 1].includes(path.join("legacy", "legacy-banner-ready.png")), "legacy banner path")
	})

	await test("sendWindowsToast picks flat banner by default (no iconTheme)", async () => {
		let captured = null
		const spawn = (cmd, args) => {
			captured = args
			return { unref: () => {} }
		}
		sendWindowsToast(
			{ title: "T", message: "M", theme: "ready" },
			{ platform: "win32", snoreToastExe: "C:\\snoretoast.exe", spawn },
		)
		await new Promise((r) => setTimeout(r, 60))
		const i = captured.indexOf("-p")
		assert.ok(i >= 0, "should pass a banner")
		assert.ok(captured[i + 1].includes(path.join("assets", "opencode-notify-banner-ready.png")), "flat banner path")
	})

	console.log(`\n${passed} passed, ${failed} failed`)
	if (failed > 0) {
		process.exitCode = 1
	}
}

main()