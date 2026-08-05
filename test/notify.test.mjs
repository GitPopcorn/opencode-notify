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
import { createNotifyPlugin, classifyError } from "../dist/kdco-notify-win/kdco-notify-win.js"

let passed = 0
let failed = 0

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
		assert.equal(h.sent[0].message, "My Task")
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
		assert.equal(h.sent[0].message, "boom")
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
		assert.equal(h.sent[0].message, "My Task")
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
		assert.equal(h.sent[0].message, "Model not found: X.")
	})

	console.log(`\n${passed} passed, ${failed} failed`)
	if (failed > 0) {
		process.exitCode = 1
	}
}

main()