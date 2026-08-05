/**
 * Manual 5-way test: fire EVERY notification kind against the REAL SnoreToast
 * backend (self-hosted sender). A real Windows Toast pops for each scenario;
 * between toasts the script sleeps so you can see the banner color, hear the
 * sound, and read the body. It also captures the exact opts passed to the
 * sender and asserts the internals (theme / sound / title / timestamp / body).
 *
 * Run:  node test/manual-all.mjs
 *
 * Expected order on screen:
 *   1. READY FOR REVIEW        (green banner)   session.idle
 *   2. SOMETHING WENT WRONG    (orange banner)  session.error (generic)
 *   3. NETWORK INTERRUPTED     (red banner, beep) session.error (ECONNRESET)
 *   4. WAITING FOR CONFIRMATION(yellow banner)  permission.updated
 *   5. QUESTION FOR YOU        (blue banner)    question.asked
 */
import assert from "node:assert"
import { createNotifyPlugin } from "../dist/kdco-notify-win/kdco-notify-win.js"

// Sleep so each toast is visible (and cross toasts don't crowd the action center).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const config = {
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
}

// Fake client that only needs to support what this manual pass touches:
// session.get (title) and session.messages (step summary).
const makeClient = () => ({
	session: {
		get: async ({ path: { id } }) => ({ data: { title: `task ${id}`, parentID: null } }),
		messages: async ({ path: { id } }) => [
			{
				info: { id: `${id}-m1`, role: "assistant" },
				parts: [
					{ type: "tool", tool: "read", state: { title: "Read file /a.txt" } },
					{ type: "tool", tool: "bash", state: { title: "Bash ls" } },
				],
			},
			{ info: { id: `${id}-m2`, role: "user" }, parts: [{ type: "text", text: "hi" }] },
		],
	},
})

let seen = [] // opts captured from the real sender
let passed = 0
let failed = 0

const expect = (name, fn) =>
	Promise.resolve()
		.then(fn)
		.then(() => { passed += 1; console.log(`  ok   - ${name}`) })
		.catch((e) => { failed += 1; console.error(`  FAIL - ${name}: ${e?.message}`) })

const bodyOk = (opts) => {
	assert.match(opts.message, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/, "body starts with timestamp")
}

async function main() {
	// sendNotification wraps the real self-hosted sender, capturing opts for
	// assertions without duplicating the display path.
	const sentBy = []
	const plugin = await createNotifyPlugin({
		readConfig: async () => config,
		sendNotification: (opts) => {
			// Re-inject through the real sender (same as the default wiring).
			import("../dist/kdco-notify-win/kdco-notify-win.js")
				.then((m) => { m.sendWindowsToast(opts) })
				.catch(() => {})
			sentBy.push(opts)
		},
	})({ client: makeClient() })

	const fire = (payload) => plugin.event({ event: payload })

	console.log("=== 5-way manual toast test (watch your screen) ===\n")

	// 1. READY
	await expect("ready -> READY FOR REVIEW / green / Glass", async () => {
		await fire({ type: "session.idle", properties: { sessionID: "s-ready" } })
		const o = sentBy[sentBy.length - 1]
		assert.equal(o.title, "READY FOR REVIEW")
		assert.equal(o.theme, "ready")
		assert.equal(o.sound, "Glass")
		bodyOk(o)
		assert.ok(o.message.includes("task s-ready"), "body includes session title")
		assert.ok(o.message.includes("Steps:"), "ready body includes step summary")
	})
	await sleep(2200)

	// 2. ERROR (generic)
	await expect("error -> SOMETHING WENT WRONG / orange / Basso", async () => {
		await fire({ type: "session.error", properties: { sessionID: "s-err", error: "boom" } })
		const o = sentBy[sentBy.length - 1]
		assert.equal(o.title, "SOMETHING WENT WRONG")
		assert.equal(o.theme, "error")
		assert.equal(o.sound, "Basso")
		bodyOk(o)
	})
	await sleep(2200)

	// 3. NETWORK
	await expect("network -> NETWORK INTERRUPTED / red / Basso + beep", async () => {
		await fire({ type: "session.error", properties: { sessionID: "s-net", error: "fetch failed: getaddrinfo ECONNRESET" } })
		const o = sentBy[sentBy.length - 1]
		assert.equal(o.title, "NETWORK INTERRUPTED")
		assert.equal(o.theme, "network")
		assert.equal(o.sound, "Basso")
		bodyOk(o)
	})
	await sleep(2200)

	// 4. PERMISSION
	await expect("permission -> WAITING FOR CONFIRMATION / yellow / Submarine", async () => {
		await fire({ type: "permission.updated", properties: { id: "perm-1" } })
		const o = sentBy[sentBy.length - 1]
		assert.equal(o.title, "WAITING FOR CONFIRMATION")
		assert.equal(o.theme, "permission")
		assert.equal(o.sound, "Submarine")
		bodyOk(o)
	})
	await sleep(2200)

	// 5. QUESTION
	await expect("question -> QUESTION FOR YOU / blue / Submarine", async () => {
		await fire({ type: "question.asked", properties: { sessionID: "s-q", id: "q-1" } })
		const o = sentBy[sentBy.length - 1]
		assert.equal(o.title, "QUESTION FOR YOU")
		assert.equal(o.theme, "question")
		assert.equal(o.sound, "Submarine")
		bodyOk(o)
	})
	await sleep(2200)

	console.log(`\n${passed} passed, ${failed} failed`)
	console.log("Captured send opts (5 expected):")
	for (const o of sentBy) console.log(`  - ${o.title}  [${o.theme}]  sound=${o.sound}`)
	if (failed > 0) process.exitCode = 1
}

main()