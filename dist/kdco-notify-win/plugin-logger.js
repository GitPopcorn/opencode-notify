import fs from "fs";
import path from "path";

/**
 * PluginLogger — generic logging system for kdco-notify-win.
 *
 * Modeled on the reference `plugin-logger.js` used by the windows-gbk-encoding-fix
 * plugin, but self-contained: the only external dependency it is allowed to touch
 * is a user-supplied `configLoader` callback (used for optional hot reload).
 *
 * Defaults:
 *   - logDir:             %TEMP%\kdcokenny-notify-win
 *   - log file:           {yyyy-MM-dd}-kdcokenny-notify-win.log  (daily rollover)
 *   - minLogLevel:        "WARN"   (stricter default: minimal disk writes)
 *   - retention:          30 days
 *
 * Usage:
 *   PluginLogger.init(config?.logging)      // once, early
 *   PluginLogger.info("notify", "L1001", "toast sent title={} theme={}", title, theme)
 *   PluginLogger.warn("notify", "L1002", "quiet hours {} start={}", q.enabled, q.start)
 *
 * `{}` in the template are SLF4J-style placeholders; a trailing Error object is
 * rendered with its stack; TRACE-level logs may append a trailing data object.
 *
 * @class PluginLogger
 */
class PluginLogger {
	/** 等级数值映射 (数值越大越严重; ALL/TRACE 都是 0 = 全部输出) */
	static #LEVEL_VALUES = { ALL: 0, TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, NO: 99 };

	/** 等级标签 (固定宽度 5 字符) */
	static #LEVEL_LABELS = { TRACE: "TRACE", DEBUG: "DEBUG", INFO: "INFO ", WARN: "WARN ", ERROR: "ERROR" };

	/** 模块名填充宽度 */
	static #MODULE_PAD = 24;

	/** 配置 */
	static #config = null;

	/** 日志行缓冲区 */
	static #buffer = [];

	/** 自上次同步 checkpoint 以来的日志条数 */
	static #checkpointCounter = 0;

	/** 当前日志文件路径 */
	static #logFilePath = null;

	/** 当前日志文件日期字符串 (YYYY-MM-DD) */
	static #currentDate = null;

	/** 定时器句柄 */
	static #flushTimer = null;

	/** 是否已初始化 */
	static #initialized = false;

	/** 日志目录 */
	static #logDir = null;

	/** 已注册 process exit flush */
	static #exitFlushRegistered = false;

	/** 可选热更新 loader: () => { version, config } */
	static #configLoader = null;

	/** 上次读取 configLoader 的版本号 */
	static #lastConfigVersion = -1;

	/**
	 * 初始化日志系统
	 * @param {Object} [config] loggingConfig 配置对象，null/undefined 时使用全默认值
	 * @param {Function} [config.configLoader] 可选热更新回调: () => ({version, config})
	 */
	static init(config) {
		if (!config) { config = {}; }

		// STEP 1: 合并默认值
		PluginLogger.#config = {
			minLogLevel: config.minLogLevel || "WARN",
			moduleLogLevels: config.moduleLogLevels || {},
			logDir: config.logDir || null,
			logRetentionDays: config.logRetentionDays || 30,
			logFlushMode: config.logFlushMode || "hybrid",
			logSyncCheckpointInterval: config.logSyncCheckpointInterval || 5,
			logBufferMaxEntries: config.logBufferMaxEntries || 100,
			logBufferFlushIntervalMs: config.logBufferFlushIntervalMs || 500,
		};
		PluginLogger.#configLoader = typeof config.configLoader === "function" ? config.configLoader : null;
		PluginLogger.#lastConfigVersion = -1;

		// STEP 2: NO 模式 → 不创建目录和文件，仅保留 ERROR console 兜底
		if (PluginLogger.#config.minLogLevel === "NO") {
			PluginLogger.#initialized = true;
			return;
		}

		// STEP 3: 确定日志目录
		PluginLogger.#logDir = PluginLogger.#config.logDir;
		if (!PluginLogger.#logDir) {
			const tempBase = process.env.TEMP || process.env.TMP || ".";
			PluginLogger.#logDir = path.join(tempBase, "kdcokenny-notify-win");
		}

		// STEP 4: 确保目录存在
		try {
			if (!fs.existsSync(PluginLogger.#logDir)) {
				fs.mkdirSync(PluginLogger.#logDir, { recursive: true });
			}
		} catch (_) {
			PluginLogger.#logDir = null;
		}

		// STEP 5: 清理旧日志
		if (PluginLogger.#logDir && PluginLogger.#config.logRetentionDays > 0) {
			PluginLogger.#cleanupOldLogs();
		}

		// STEP 6: 标记已初始化
		PluginLogger.#initialized = true;

		// STEP 7: 注册进程退出 flush (只注册一次)
		if (!PluginLogger.#exitFlushRegistered) {
			PluginLogger.#exitFlushRegistered = true;
			process.on("exit", function () {
				PluginLogger.flush();
			});
		}

		// STEP 8: 启动定时器
		if (PluginLogger.#logDir) {
			PluginLogger.#scheduleFlush();
		}
	}

	/**
	 * 可选热更新：调用注入的 configLoader，若版本号变化则刷新本地配置
	 */
	static #refreshConfigIfNeeded() {
		if (!PluginLogger.#configLoader) { return; }
		let current = null;
		try {
			current = PluginLogger.#configLoader();
		} catch (_) {
			return;
		}
		if (!current || current.version === undefined || current.version === PluginLogger.#lastConfigVersion) {
			return;
		}
		PluginLogger.#lastConfigVersion = current.version;
		const lc = current.config;
		if (lc) {
			const oldLevel = PluginLogger.#config.minLogLevel;
			PluginLogger.#config.minLogLevel = lc.minLogLevel || "WARN";
			PluginLogger.#config.moduleLogLevels = lc.moduleLogLevels || {};
			if (oldLevel && oldLevel !== PluginLogger.#config.minLogLevel) {
				if (PluginLogger.#isLevelEnabled("plugin-logger", "WARN")) {
					const logFilePath = PluginLogger.getLogFilePath();
					if (logFilePath) {
						const line = PluginLogger.#buildLine("WARN", "plugin-logger", "L0001",
							`minLogLevel hot-reloaded ${oldLevel} → ${PluginLogger.#config.minLogLevel} (version ${current.version})`, null);
						try { fs.appendFileSync(logFilePath, line + "\r\n", "utf8"); } catch (_) {}
					}
				}
			}
		}
	}

	/**
	 * 判断某等级对某模块是否启用
	 * @param {string} moduleId
	 * @param {string} level
	 * @return {boolean}
	 */
	static #isLevelEnabled(moduleId, level) {
		PluginLogger.#refreshConfigIfNeeded();
		if (!PluginLogger.#config || PluginLogger.#config.minLogLevel === "NO") {
			return level === "ERROR";
		}
		const moduleLevel = PluginLogger.#config.moduleLogLevels[moduleId];
		const effLevel = moduleLevel === undefined || moduleLevel === "INHERIT" ? PluginLogger.#config.minLogLevel : moduleLevel;
		const levelVal = PluginLogger.#LEVEL_VALUES[level];
		const moduleVal = PluginLogger.#LEVEL_VALUES[effLevel];
		if (levelVal === undefined || moduleVal === undefined) { return false; }
		return levelVal >= moduleVal;
	}

	/**
	 * SLF4J 风格模板格式化：将 {} 替换为 args，支持 \{} 转义
	 * @param {string} template
	 * @param {Array} args
	 * @return {string}
	 */
	static #formatTemplate(template, args) {
		if (!template) { return ""; }
		let result = "";
		let argIndex = 0;
		let i = 0;
		while (i < template.length) {
			if (template[i] === "\\" && i + 1 < template.length) {
				const next = template[i + 1];
				if (next === "{") { result += "{}"; i += 3; continue; }
				if (next === "\\") { result += "\\"; i += 2; continue; }
				result += "\\" + next; i += 2; continue;
			}
			if (i + 1 < template.length && template[i] === "{" && template[i + 1] === "}") {
				if (argIndex < args.length) {
					const arg = args[argIndex];
					result += arg !== null && arg !== undefined ? String(arg) : "null";
					argIndex++;
				} else {
					result += "{}";
				}
				i += 2;
				continue;
			}
			result += template[i];
			i++;
		}
		return result;
	}

	/**
	 * 处理消息模板 + args，提取 Error 明细与 TRACE data
	 * @param {string} level
	 * @param {string} template
	 * @param {...*} args
	 * @return {{message:string, data:Object|null}}
	 */
	static #formatMessage(level, template, ...args) {
		let count = 0;
		if (template) {
			let ci = 0;
			while (ci < template.length) {
				if (template[ci] === "\\" && ci + 1 < template.length) {
					ci += 2; continue;
				}
				if (ci + 1 < template.length && template[ci] === "{" && template[ci + 1] === "}") {
					count++; ci += 2; continue;
				}
				ci++;
			}
		}
		const formatArgs = args.slice(0, count);
		let extraArgs = args.slice(count);
		let message = PluginLogger.#formatTemplate(template, formatArgs);
		if (extraArgs.length > 0) {
			const last = extraArgs[extraArgs.length - 1];
			if (typeof last === "object" && last !== null && last instanceof Error) {
				const errMsg = last.stack || last.message || String(last);
				message += " | " + errMsg.replace(/\n/g, "\n  ");
				extraArgs = extraArgs.slice(0, -1);
			}
		}
		let data = null;
		if (level === "TRACE" && extraArgs.length > 0) {
			const candidate = extraArgs[extraArgs.length - 1];
			if (typeof candidate === "object" && candidate !== null && !(candidate instanceof Error)) {
				data = candidate;
			}
		}
		return { message, data };
	}

	/** 构造单行日志 */
	static #buildLine(level, moduleId, codeId, message, data) {
		const d = new Date();
		const p = (n) => String(n).padStart(2, "0");
		const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds())}`;
		const levelLabel = PluginLogger.#LEVEL_LABELS[level] || "INFO ";
		const modulePadded = moduleId.padEnd(PluginLogger.#MODULE_PAD, " ");
		let line = `[${ts}] [${levelLabel}] [${modulePadded}] [${codeId}] ${message}`;
		if (data !== undefined && data !== null && level === "TRACE") {
			try {
				line += " | " + JSON.stringify(data);
			} catch (_) {
				line += " | [circular]";
			}
		}
		return line;
	}

	/**
	 * 获取当前日期对应的日志文件路径
	 * @return {string|null}
	 */
	static getLogFilePath() {
		return PluginLogger.#getLogFilePath();
	}

	static #getLogFilePath() {
		if (!PluginLogger.#logDir) { return null; }
		const d = new Date();
		const p = (n) => String(n).padStart(2, "0");
		const dateStr = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
		if (dateStr !== PluginLogger.#currentDate) {
			PluginLogger.#currentDate = dateStr;
			PluginLogger.#logFilePath = path.join(PluginLogger.#logDir, `${dateStr}-kdcokenny-notify-win.log`);
		}
		return PluginLogger.#logFilePath;
	}

	/** 同步追加写入文件 (含 try-catch 降级) */
	static #writeToFile(lines) {
		if (!lines || lines.length === 0) { return; }
		const filePath = PluginLogger.#getLogFilePath();
		if (!filePath) {
			for (const line of lines) {
				console.error("[plugin-logger] [FALLBACK] " + line);
			}
			return;
		}
		try {
			fs.appendFileSync(filePath, lines.join("\r\n") + "\r\n", "utf8");
		} catch (err) {
			for (const line of lines) {
				console.error("[plugin-logger] [FALLBACK] " + line);
			}
		}
	}

	/** 启动/重置定时 flush */
	static #scheduleFlush() {
		if (PluginLogger.#flushTimer) {
			clearInterval(PluginLogger.#flushTimer);
		}
		PluginLogger.#flushTimer = setInterval(function () {
			PluginLogger.#flushIfNeeded();
		}, PluginLogger.#config.logBufferFlushIntervalMs);
		if (PluginLogger.#flushTimer && typeof PluginLogger.#flushTimer.unref === "function") {
			PluginLogger.#flushTimer.unref();
		}
	}

	/** 需要时 flush (定时器回调) */
	static #flushIfNeeded() {
		if (PluginLogger.#buffer.length > 0) {
			PluginLogger.#writeToFile(PluginLogger.#buffer);
			PluginLogger.#buffer = [];
		}
	}

	/** 内部日志写入方法 */
	static #log(level, moduleId, codeId, template, ...args) {
		if (!PluginLogger.#isLevelEnabled(moduleId, level)) { return; }
		const formatted = PluginLogger.#formatMessage(level, template, ...args);
		const line = PluginLogger.#buildLine(level, moduleId, codeId, formatted.message, formatted.data);

		if (PluginLogger.#config && PluginLogger.#config.minLogLevel === "NO") {
			if (level === "ERROR") { console.error("[plugin-logger] " + line); }
			return;
		}
		if (!PluginLogger.#logDir) {
			if (level === "ERROR") { console.error("[plugin-logger] [FALLBACK] " + line); }
			return;
		}

		PluginLogger.#buffer.push(line);

		if (PluginLogger.#config.logFlushMode === "hybrid") {
			PluginLogger.#checkpointCounter++;
			if (PluginLogger.#checkpointCounter >= PluginLogger.#config.logSyncCheckpointInterval) {
				PluginLogger.#checkpointCounter = 0;
				PluginLogger.#flushIfNeeded();
			}
		} else if (PluginLogger.#config.logFlushMode === "sync") {
			PluginLogger.#flushIfNeeded();
		}

		if (PluginLogger.#buffer.length >= PluginLogger.#config.logBufferMaxEntries) {
			PluginLogger.#flushIfNeeded();
		}
	}

	// ===== ===== ===== ===== [公开 API] ===== ===== ===== =====

	static trace(moduleId, codeId, template, ...args) {
		PluginLogger.#log("TRACE", moduleId, codeId, template, ...args);
	}

	static debug(moduleId, codeId, template, ...args) {
		PluginLogger.#log("DEBUG", moduleId, codeId, template, ...args);
	}

	static info(moduleId, codeId, template, ...args) {
		PluginLogger.#log("INFO", moduleId, codeId, template, ...args);
	}

	static warn(moduleId, codeId, template, ...args) {
		PluginLogger.#log("WARN", moduleId, codeId, template, ...args);
	}

	static error(moduleId, codeId, template, ...args) {
		PluginLogger.#log("ERROR", moduleId, codeId, template, ...args);
	}

	/** 同步刷盘 */
	static flush() {
		PluginLogger.#flushIfNeeded();
	}

	/** 删除超过保留天数的旧日志文件 */
	static #cleanupOldLogs() {
		if (!PluginLogger.#logDir) { return; }
		const maxAgeMs = PluginLogger.#config.logRetentionDays * 24 * 60 * 60 * 1000;
		const now = Date.now();
		try {
			const entries = fs.readdirSync(PluginLogger.#logDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) { continue; }
				if (!entry.name.endsWith("-kdcokenny-notify-win.log")) { continue; }
				const fullPath = path.join(PluginLogger.#logDir, entry.name);
				try {
					const stat = fs.statSync(fullPath);
					if ((now - stat.mtimeMs) > maxAgeMs) {
						fs.unlinkSync(fullPath);
					}
				} catch (_) {}
			}
		} catch (_) {}
	}
}

export default PluginLogger;
