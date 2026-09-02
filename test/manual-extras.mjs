/**
 * Layer-3 manual test: extended capabilities against the REAL sender.
 *
 * Temporarily writes `~/.config/opencode/kdco-notify.json` with:
 *   - soundOverride: a custom .wav (Alarm01) instead of a preset
 *   - clickProgram/clickArgs: open Windows Terminal on click
 * then fires ONE real ready toast and RESTORES the previous config file.
 *
 * What to verify by hand:
 *   - the toast plays Alarm01.wav, not the default Glass
 *   - clicking the toast opens Windows Terminal (`wt -d . opencode`)
 *
 * Run:  node test/manual-extras.mjs
 * Config backup/restore is automatic; the original file is untouched.
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createNotifyPlugin } from "../dist/kdco-notify-win/index.js"

const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "kdco-notify.json")
const BACKUP = path.join(os.tmpdir(), `kdco-notify-config-backup-${Date.now()}.json`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const baseConfig = {
	notifyChildSessions: false,
	sounds: { idle: "Glass", error: "Basso", permission: "Submarine", question: "Submarine", network: "Basso" },
	quietHours: { enabled: false, start: "22:00", end: "08:00" },
	beepOnInterruption: true,
	showTimestamp: true,
	showSummary: true,
	summarySteps: 3,
	themedIcons: true,
}

const WAV = "C:\\Windows\\Media\\Alarm01.wav"

async function main() {
	// ---- 1. backup existing config (if any) ----
	const hadConfig = fs.existsSync(CONFIG_PATH)
	if (hadConfig) fs.copyFileSync(CONFIG_PATH, BACKUP)

	const tempConfig = {
		...baseConfig,
		soundOverride: WAV,
		clickProgram: "wt.exe",
		clickArgs: ["-d", ".", "opencode"],
	}
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(tempConfig, null, 2), "utf8")
	console.log(`Temporary config written -> ${CONFIG_PATH}`)

	try {
		const sentBy = []
		// NOTE: readConfig is the REAL loader in this pass, so the plugin reads
		// the config file we just wrote (exercising soundOverride + clickProgram).
		const plugin = await createNotifyPlugin({
			sendNotification: (opts) => {
				import("../dist/kdco-notify-win/index.js")
					.then((m) => { m.sendWindowsToast(opts) })
					.catch(() => {})
				sentBy.push(opts)
			},
		})({ client: { session: { get: async () => ({ data: { title: "extras demo", parentID: null } }) } } })

		await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s-extras" } } })

		const o = sentBy[sentBy.length - 1]
		assert.equal(o.sound, WAV, "soundOverride should win over sounds.idle")
		assert.equal(o.clickProgram, "wt.exe", "clickProgram should pass through")
		assert.deepEqual(o.clickArgs, ["-d", ".", "opencode"], "clickArgs should pass through")
		console.log(`\nExtras toast dispatched: title=${o.title} sound=${o.sound} click=${o.clickProgram} ${o.clickArgs?.join(" ")}`)
		console.log("  -> expect: Alarm01.wav plays, clicking opens Windows Terminal.\n")
		await sleep(3000)
		console.log("ok - captured opts assert soundOverride + clickProgram (see toast to confirm sound/click).")
	} finally {
		// ---- 2. restore ----
		if (hadConfig) {
			fs.copyFileSync(BACKUP, CONFIG_PATH)
			fs.unlinkSync(BACKUP)
			console.log(`\nRestored original config -> ${CONFIG_PATH}`)
		} else {
			fs.unlinkSync(CONFIG_PATH)
			console.log(`\nRemoved temp config (none existed before) -> ${CONFIG_PATH}`)
		}
	}
}

main()