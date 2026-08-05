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
import { createNotifyPlugin, classifyError, formatTimestamp, buildStepSummary, sendWindowsToast, buildSnoreToastArgs } from "../dist/kdco-notify-win/kdco-notify-win.js"

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

async function makeHarness({ client, config, platform = "win32", clock = null, dedupeStorePath = null }) {
	const sent = []
	const beeps = []
	const notifierImpl = (opts) => sent.push(opts)
	const readConfig = async () => config
	let nowMs = clock ?? Date.now()

	const pluginFactory = createNotifyPlugin({
		platform,
		detectTerminalImpl: () => "Windows Terminal",
		sendNotification: notifierImpl,
		readConfig,
		beep: (flag) => {
			if (flag) beeps.push(1)
		},
		dedupeStorePath: dedupeStorePath ?? path.join(os.tmpdir(), `kdco-notify-test-${Math.random().toString(36).slice(2)}.json`),
	})

	const pluginDone = await pluginFactory({ client })
	return {
		pluginDone,
		sent,
		beeps,
		// deterministic clock for quiet-hours tests
		setNow: (ms) => {
			nowMs = ms
		},
	}
}

const baseConfig = () => ({
	notifyChildSessions: false,
	sounds: { idle: "Glass", error: "Basso", permission: "Submarine", question: "Submarine", network: "Basso" },
	quietHours: { enabled: false, start: "22:00", end: "08:00" },
	beepOnInterruption: true,
	showTimestamp: true,
	showSummary: true,
	summarySteps: 3,
	themedIcons: true,
	soundOverride: "",
	clickProgram: "",
	clickArgs: [],
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
		const cfg = { ...baseConfig(), clickProgram: "wt.exe", clickArgs: ["-d", ".", "opencode"] }
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