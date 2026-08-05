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

const plugin = await createNotifyPlugin({})({
	client: {
		session: {
			get: async () => ({ data: { title: "demo task", parentID: null } }),
		},
	},
})

console.log("Dispatching real session.idle -> expect a Windows Toast ...")
await plugin.event({ event: { type: "session.idle", properties: { sessionID: "demo" } } })
console.log("Done. (If no toast appeared, run `npm install` inside dist/kdco-notify-win.)")