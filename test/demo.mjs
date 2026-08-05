/**
 * Demo: drive the plugin against a REAL node-notifier (SnoreToast) backend.
 *
 * Prereq: deps vendored in place:
 *   cd dist/kdco-notify-win && npm install
 *
 * Run:   node test/demo.mjs
 * Expected: a Windows Toast notification pops up.
 */
import { createNotifyPlugin } from "../dist/kdco-notify-win/kdco-notify-win.js"

const plugin = await createNotifyPlugin({
	readConfig: async () => ({
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
	}),
})({
	client: {
		session: {
			get: async () => ({ data: { title: "demo task", parentID: null } }),
			messages: async () => [
				{
					info: { id: "m1", role: "assistant", sessionID: "demo" },
					parts: [
						{ type: "tool", tool: "read", state: { title: "Read file /a.txt" } },
						{ type: "tool", tool: "bash", state: { title: "Bash ls" } },
					],
				},
			],
		},
	},
})

console.log("Dispatching real session.idle -> expect a Windows Toast ...")
await plugin.event({ event: { type: "session.idle", properties: { sessionID: "demo" } } })
console.log("Done. (If no toast appeared, run `npm install` inside dist/kdco-notify-win.)")