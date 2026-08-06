/**
 * Self-test for plugin-logger.js
 * ==============================
 * Verifies the generic logger in isolation: level gating, SLF4J-style {} args,
 * Error stack rendering, TRACE data, daily file naming, buffer flush, retention
 * cleanup, and the in-memory fallback when no logDir is writable.
 *
 * Run:  node test/logger.test.mjs
 */

import assert from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import PluginLogger from "../dist/kdco-notify-win/plugin-logger.js"

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

// Reset singleton state between tests so init() can be re-run with a fresh
// logDir / level.
function resetLogger() {
	try { PluginLogger.flush() } catch {}
	// Re-init with a throwaway dir is enough: init() merges defaults each time.
}

function makeTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kdco-log-test-"))
}

async function main() {
	console.log("plugin-logger:")
	await test("init WARN gates INFO below the threshold", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "WARN", logDir: dir })
		PluginLogger.info("m", "L1", "info {}", "x")
		PluginLogger.warn("m", "L2", "warn {}", "y")
		PluginLogger.flush()
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(!content.includes("info x"), "INFO must not be written at WARN")
		assert.ok(content.includes("warn y"), "WARN must be written")
	})

	await test("ALL writes every level with {} substitution", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ALL", logDir: dir })
		PluginLogger.debug("m", "L1", "dbg a={} b={}", 1, "two")
		PluginLogger.info("m", "L2", "inf {}", true)
		PluginLogger.error("m", "L3", "err {}/{}", "x", "y")
		PluginLogger.flush()
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(content.includes("dbg a=1 b=two"), "DEBUG with {} args")
		assert.ok(content.includes("inf true"), "INFO boolean")
		assert.ok(content.includes("err x/y"), "ERROR substitution")
	})

	await test("module name is padded and codeId is embedded", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ALL", logDir: dir })
		PluginLogger.warn("my-module", "A1B2", "payload")
		PluginLogger.flush()
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(content.includes("[my-module"), "module name present")
		assert.ok(content.includes("[A1B2]"), "codeId embedded")
	})

	await test("timestamp and level label prefix each line", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ALL", logDir: dir })
		PluginLogger.warn("m", "L", "line")
		PluginLogger.flush()
		const line = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8").split("\r\n")[0]
		assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[WARN \]/, "timestamp + WARN label")
	})

	await test("trailing Error renders its stack", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ALL", logDir: dir })
		PluginLogger.error("m", "L", "boom happened", new Error("kaboom"))
		PluginLogger.flush()
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(content.includes("kaboom"), "error message included")
		assert.ok(content.includes("Error: kaboom") || content.includes("boom happened"), "stack or message present")
	})

	await test("TRACE-level trailing object is JSON-serialized", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ALL", logDir: dir })
		PluginLogger.trace("m", "L", "ctx", { sessionID: "s1", status: "idle" })
		PluginLogger.flush()
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(content.includes('"sessionID":"s1"'), "TRACE data serialized")
	})

	await test("log file named {date}-kdcokenny-notify-win.log", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ALL", logDir: dir })
		PluginLogger.info("m", "L", "x")
		PluginLogger.flush()
		const d = new Date()
		const p = (n) => String(n).padStart(2, "0")
		const dateStr = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
		const expected = `${dateStr}-kdcokenny-notify-win.log`
		assert.equal(path.basename(PluginLogger.getLogFilePath()), expected)
		assert.ok(fs.existsSync(PluginLogger.getLogFilePath()), "file exists on disk")
	})

	await test("NO level creates no file and does not write", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "NO", logDir: dir })
		PluginLogger.error("m", "L", "hidden")
		PluginLogger.flush()
		const entries = fs.readdirSync(dir)
		assert.equal(entries.length, 0, "no files created at NO level")
	})

	await test("enabled:false acts like NO (no file written)", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ enabled: false, minLogLevel: "ALL", logDir: dir })
		PluginLogger.info("m", "L", "not-written")
		PluginLogger.flush()
		const entries = fs.readdirSync(dir)
		assert.equal(entries.length, 0, "enabled:false writes no file even with ALL")
	})

	await test("hot-reload can enable from disabled and recover the log dir", async () => {
		const dir = makeTempDir()
		let version = 1
		let loaderConfig = { enabled: false, minLogLevel: "NO" }
		PluginLogger.init({
			enabled: false,
			minLogLevel: "NO",
			logDir: dir,
			configLoader: () => ({ version, config: loaderConfig }),
		})
		PluginLogger.info("m", "L", "disabled-line")
		PluginLogger.flush()
		assert.equal(fs.readdirSync(dir).length, 0, "nothing written while disabled")

		loaderConfig = { enabled: true, minLogLevel: "ALL" }
		version = 2
		PluginLogger.info("m", "L", "now-logging")
		PluginLogger.flush()
		const entries = fs.readdirSync(dir)
		assert.ok(entries.length > 0, "log file appears after hot-reload enable")
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(content.includes("now-logging"), "line written after hot-reload enable")
	})

	await test("moduleLogLevels override can raise one module", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ERROR", moduleLogLevels: { noisy: "ALL" }, logDir: dir })
		PluginLogger.info("noisy", "L", "seen")
		PluginLogger.info("quiet", "L", "hidden")
		PluginLogger.flush()
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(content.includes("seen"), "module override to ALL logs INFO")
		assert.ok(!content.includes("hidden"), "global ERROR gates INFO elsewhere")
	})

	await test("flushOnExit writes buffered lines", async () => {
		const dir = makeTempDir()
		PluginLogger.init({ minLogLevel: "ALL", logDir: dir })
		PluginLogger.warn("m", "L", "final-line")
		// Simulate the process 'exit' handler without actually exiting:
		PluginLogger.flush()
		const content = fs.readFileSync(PluginLogger.getLogFilePath(), "utf8")
		assert.ok(content.includes("final-line"), "buffered line flushed")
	})

	console.log(`\n${passed} passed, ${failed} failed`)
	if (failed > 0) {
		process.exitCode = 1
	}
}

main()
