# 改造计划：kdco/notify → Windows-only 零依赖 fork

> 依据原始记录（`doc-04 PROMPT：@kdco/notify Windows Fork`）与仓库现状制定。
> 目标：从「OCX facade 半成品源码」改造成「Windows 10/11 专用、零 OCX、手动 vendor 化」的可直接放进 `.opencode/plugins/` 的通知插件。

---

## 1. 现状诊断（已核实）

| 检查项 | 结果 |
|---|---|
| 构建工具 | **无** `package.json` / `tsconfig.json` / `bun.lockb` / `opencode.json`（纯 facade 仓库） |
| `src/notify.ts` 引用的 `./notify/status` | **不存在**（源码无法编译） |
| `src/notify.ts` 引用的 `./notify/title` | **不存在**（源码无法编译） |
| `src/kdco-primitives/cmux.ts` | **不存在**（`index.ts` / `notify/cmux.ts` 却 import 它） |
| `src/plugin/kdco-primitives/` | 与 `src/kdco-primitives/` 重复，仅 `index.ts` 少 7 行（cmux 相关导出被删） |
| `registry.json` | 引用不存在的 `src/kdco-notify.ts`（实际入口是 `src/notify.ts`） |

**结论**：`main` 分支是一个「fork 了一半就中断」的残缺状态，连编译都过不了。本次改造正是把它收敛成可用的 Windows 插件。

---

## 2. 目标形态

- **平台**：Windows 10/11 仅限。
- **安装**：手动把产物目录拷入 `.opencode/plugins/`，无需 OCX。
- **通知引擎**：`node-notifier` → SnoreToast（Windows Toast）。
- **交付物**：单文件 ESM 插件 `kdco-notify-win.js` + `package.json`（仅 `node-notifier`、`detect-terminal` 两个 runtime 依赖，离线可 `npm install` vendor 进 `node_modules`）。
- **保留能力**：任务完成 / 出错 / 权限请求 / 提问 Toast；静默时段；父会话过滤；1.5s 去重；终端检测。
- **裁剪内容**：全部 cmux、macOS alerter / 焦点检测 / osascript、Linux notify-send、`@opencode-ai/plugin`/`@opencode-ai/sdk` 类型依赖、以及其他未使用的 `kdco-primitives`（mutex/shell/temp/get-project-id/with-timeout）。

---

## 3. 新增核心能力：网络中断通知

原始记录末尾的关键问题——**插件能否在「明确中断（503/401/500 等）」与「隐式中断（响应到一半断开 / ECONNRESET）」时通知？**

结论与实现方式：

- **明确中断**：OpenCode 收到非 2xx 状态码时会把错误灌入 `session.error`。插件对 error 文本做分类，识别 `503/401/500/429/403` 等状态码。
- **隐式中断**：插件本身不发起请求、不消费响应体，无法直接监听 body 流；但 undici fetch 在中途断开时会把 `ECONNRESET / socket hang up / EPIPE / aborted / fetch failed` 等错误抛给调用方，同样会以 `session.error` 形式出现。因此**只要保证「任何 session.error（含网络中断特征）都触发通知」，两类中断就都能被覆盖**。
- 实现：新增 `classifyError()`，把错误分为 `network-interruption`（隐式）/ `http-error`（明确）/ `generic` 三类；网络/HTTP 错误用独立标题（如 *Network interrupted*）+ 独立声音通知，并保证父会话错误**必定**通知（不受终端焦点等条件误伤）。

> 边界说明：若 OpenCode 本身因断网而完全不产生任何事件（连 `session.error` 都不发），纯插件无法感知。这是插件模型的上限，已在实现注释中标注。

---

## 4. 目录结构（改造后）

```
opencode-notify/
├── README.md                 # 改写为 Windows fork 说明
├── PLAN.md                   # 本文档
├── LICENSE
├── dist/                     # 交付物（可直接 vendor 进 .opencode/plugins/）
│   └── kdco-notify-win/
│       ├── package.json         # deps: node-notifier, detect-terminal
│       ├── kdco-notify-win.js   # 单文件插件（唯一源码 + 交付物）
│       └── node_modules/        # npm install 生成（离线 vendor）
└── test/
    ├── notify.test.mjs         # 自测（注入假 notifier，无需真实二进制）
    └── demo.mjs                # demo：装入真实 node-notifier 弹一次 Toast
```

> 说明：`dist/kdco-notify-win/kdco-notify-win.js` 作为**唯一源码与交付物**（Bun 可直接跑 ESM JS，无需任何 TS 工具链）。所有能力、误差分类逻辑、配置均内联于此，避免 TS/JS 双份漂移。维护时直接改此文件。

---

## 5. 分步实施

1. **建分支**：`git checkout -b dev`（已完成）。
2. **清理**：删除 `src/plugin/`、`registry.json`（OCX 专属）、旧 `src/notify.ts`、`src/notify/`、`src/kdco-primitives/`（全部为残缺/OCX 依赖）。
3. **实现**：编写 `dist/kdco-notify-win/kdco-notify-win.js`（含 `classifyError` 网络中断分类 + 保留全部原有通知逻辑）。
4. **vendor**：`dist/kdco-notify-win/package.json` 声明依赖，提供 `npm install` 命令生成 `node_modules`。
5. **自测**：`test/notify.test.mjs` 用注入假 `notifier`/`detectTerminal`/`client` 驱动插件，覆盖：idle 完成通知、error 通知、网络中断分类、父会话过滤、静默时段、去重、提问通知。
6. **验收**：对照下文清单逐项确认。

---

## 6. 自测与验收清单

- [x] `dev` 分支产物可被 Node/Bun 直接 import 且无编译错误。
- [x] 自测脚本全部通过（完成 / 出错 / 网络中断 / 父会话 / 静默 / 去重 / 提问）。
- [x] demo 脚本可驱动一次真实 `node-notifier` 弹出带品牌图标的 Toast。
- [x] 产物不含任何 cmux / macOS / Linux 引用（`grep -i cmux|darwin|osascript|notify-send` 为空）。
- [x] 依赖收敛为 `node-notifier` + `detect-terminal` 两个。
- [x] README 已更新为 Windows fork 说明与安装/配置。

> **已核实（2026-08-05）**：`git diff upstream/main main` 为空 —— fork 基线与原项目完全一致，`status.ts`/`title.ts`/`kdco-primitives/cmux.ts` 在原项目里**本来就不存在**，不是 fork 丢失。原项目自身的 `notify.ts` 就引用了这些不存在的模块（原项目不可运行）。
>
> **部署方式修正**：OpenCode 1.18.12 只自动加载 plugins 目录下的**直接 `.js`/`.ts` 文件**，不递归子目录包。插件必须单文件平铺到 plugins 根（见 `scripts/deploy.ps1`），此前按子目录 `kdco-notify-win/` 部署导致未加载（已实测确认）。

---

## 7. 参考文档

- `E:\vscode-workspace-temp\docs\dev\opencode-notify\2026-07-28-04-PROMPT：@kdco／notify Windows Fork — 项目规约与实现指引.md`
- `2026-07-28-01 / 02 / 05`（QQ 通知方案、通知套件搭建指南）
- `2026-07-28-03`（原始会话导出，任务完成提示配置）

---

## 8. 扩展轮（2026-08-05）：时间戳 + 步骤摘要 + 主题图标 + 声音/点击增强

> 记录在 fork 稳定（重复通知问题已修复并部署）之后的一轮功能扩展。完整排查经过见
> `E:\vscode-workspace-temp\docs\rec\2026-08-05-OpenCode通知插件重复通知排查与跨实例去重改造记录.md`。

### 需求

1. **主需求**：通知正文带 `[yyyy-MM-dd HH:mm:ss]` 时间戳行 + 最近会话步骤摘要（单行）。
2. **问题 01**：网络中断（error）与 READY FOR REVIEW（idle）会**同时**弹两个通知 —— 应在 error 后抑制同一 session 的后续 ready。
3. **扩 1**：按通知类型使用**不同颜色的主题 banner**（ready=绿 / error=橙 / network=红 / permission=黄 / question=蓝）。
4. **扩 2**：可配置自定义音频文件 + 预设系统铃声。
5. **扩 3**：点击通知跳转 Windows Terminal 并启动 `opencode` CLI。

### 实现方式

| 能力 | 手段 |
|---|---|
| 时间戳 | `formatTimestamp()` → `[yyyy-MM-dd HH:mm:ss]`，`composeMessage` 首行。可用 `showTimestamp:false` 关闭。 |
| 步骤摘要 | `buildStepSummary(client, sessionID, maxSteps)` 走 OpenCode SDK `client.session.messages`，从最新消息往前收集 assistant 工具 part 的 `title`/`state.title`，去重后用 ` → ` 拼接成一行。`showSummary` / `summarySteps` 控制。 |
| 问题 01 | `handleSessionError` 里先把 `ready:${sessionID}` 标记进跨实例去重表，后续 idle 触发的 ready 直接被去重吞掉。 |
| 主题图标 | `THEMED_BANNERS` 映射 theme→PNG；`gen-notify-assets.py` 按 `themes` 字典为每个主题生成一条同款布局、不同强调色竖条 + 副标题的 banner。`themedIcons:false` 可回退到通用 banner。 |
| 自定义声音 / 点击 | 改为**自托管发送器**：不再依赖 node-notifier 的白名单。`sendWindowsToast` 照抄 node-notifier 的命名管道机制（`net.createServer` + 唯一 `\\.\pipe\notifierPipe-<uuid>` 作为 `-pipeName`，保证稳定显示），同时用 `buildSnoreToastArgs` 自由拼装 `-s`（预设/音频文件）、`-application`/`-la`（点击跳转）等 node-notifier 白名单本会丢弃的参数。`node-notifier` 包仅作 `snoretoast-x64.exe` 二进制的来源保留。 |

### 新增配置

```json
{
  "showTimestamp": true,
  "showSummary": true,
  "summarySteps": 3,
  "themedIcons": true,
  "soundOverride": "",
  "clickProgram": "",
  "clickArgs": []
}
```

### 状态

- [x] 37 项自测全绿（含时间戳格式、步骤摘要、error 抑制 ready、主题透传、声音覆盖、点击参数透传，以及自托管发送器的 `-pipeName` 唯一性 / 参数齐全性 / 非 Windows 跳过）。
- [x] 5 张主题 banner + 通用 banner 由 `scripts/gen-notify-assets.py` 生成。
- [x] 部署到全局 `~/.config/opencode/plugins/` 与项目 `.opencode/plugins/`，hash 与源码一致。
- [x] `test/demo.mjs` 用真实 SnoreToast 弹窗验证（时间戳 + 摘要 + ready 主题 banner）。
- [x] 自托管 `sendWindowsToast` 已用真实 vendored `snoretoast-x64.exe` 弹窗验证（含 `-pipeName`）。

---

## 9. 扩展轮（2026-08-06）：点击跳转修复 + ESC 取消类别 + 心跳兜底

> 覆盖四个需求：点击通知跳转 Windows Terminal、NETWORK 后偶发 READY 的根治、ESC 打断单独通知、静默中断补通知。

### 9.1 点击通知跳转（根因 + 修复）

- **根因**：`sendWindowsToast` 总是建命名管道并传 `-pipeName`，而 SnoreToast 的 `-application` 语义是「仅当管道不存在时才启动程序」。管道始终存在、且 server 完全忽略写入的数据并 1500ms 后关闭 → 点击只把 `action=activate` 写进没人读的管道，无任何效果。
- **修复**：管道连接读取激活回调（`utf16le`/`utf8` 双解码，命中 `activate/clicked`），在进程内 `spawn(clickProgram)`；仅当配置了点击目标时才保持管道直到 SnoreToast 退出（30s 兜底），无点击目标路径与旧行为完全一致。
- **`clickMode`**（`helper` 默认 / `simple` / `off`）：helper 走 `jump-to-opencode.ps1`——已有 wt.exe 则聚焦匹配窗口，无 wt.exe 才开新 tab；helper 失败回退 simple（`wt.exe -d <cwd> opencode`）。`clickArgs` 支持 `{{title}}/{{cwd}}/{{sessionID}}` 占位符。
- **精确 tab 定位**：WT 无稳定公开 CLI 可按标题聚焦任意 tab，helper 只能聚焦「标题匹配的窗口」+ 兜底新 tab，已在 README 声明为尽力而为。
- 默认路径（无点击配置）字节级不变；`releasePipeAfter` 对测试假 spawn（无 `child.on`）防空，避免破坏注入式单测。

### 9.2 READY-after-NETWORK 根治（状态驱动，替代 1.5s 时间窗）

- 旧逻辑只用 `DEDUPE_WINDOW_MS=1500` + 精确 sessionID 抑制 ready，重试/延迟超过窗口即失效 → 「NETWORK 后又 READY」是真实可达路径（非不可能）。
- 新逻辑 `getLastRunOutcome()` 读末尾 assistant part 状态：`state.error` → error（抑制 READY）；`AbortError`/`status:'aborted'` 等 → aborted；否则 complete。`handleSessionIdle` 三态化。对任意延迟与 session 跨 run 复用均免疫。
- 保留原 1.5s 抑制作为双保险；无法读取消息时回退旧行为。

### 9.3 ESC 打断单独通知

- 用户 ESC → OpenCode 直接转 idle（无 error）→ 旧逻辑弹 READY。现在检测到 `aborted` 结局 → 独立 **STOPPED BY YOU** + 灰色 banner（`themes` 字典新增 `cancelled`，flat/legacy 两套重新生成）。`notifyCancelled:false` 回退 READY。
- 说明：`aborted` 的确切 part 状态取值需在真实 OpenCode 事件流中核对；当前同时匹配 `state.error.name`（AbortError/UserInterrupt/Stop 等）与 `state.status` 两种信号，若真实取值不同可回退按键特征判定。

### 9.4 心跳兜底（静默中断补通知）

- 事件驱动无法感知「OpenCode 不发任何事件」的静默死亡 → 新增 watchdog：`session.status busy`/`message.part.updated`/`tool.execute.*` 更新 `activeSessions` 活动时间；每 `intervalSec`(30s, `unref()`) 对超过 `stallSec`(默认 120s) 无活动的 session 轮询 `client.session.get` 真实状态。
  - 终态但未通知 → 补发 **SESSION ENDED**（正文标注未收到结束信号）。
  - 仍在 running 且 `warnWhileStalled:true` → **SESSION STALLED** 警告（默认关，避免长 thinking 误报）。
- 跨实例去重：以 `hb:<id>:<time.updated>`（run 级 token，6h 窗口）在共享 dedupe 文件中声明，READY/ERROR/CANCELLED 处理时同样声明该 token → 全局+项目双实例不会重复补发，且新 run 因 updated 变化可获得全新 token。
- 默认开启（`heartbeat.enabled:true`）。

### 9.5 全局核验与问题记录

- [x] 默认无点击路径字节级不变；`node test/notify.test.mjs` 56 项全绿（含管道点击集成、outcome 分类、超窗抑制、CANCELLED、心跳补发/不补发/跨实例去重、占位符）。
- [x] `scripts/deploy.ps1` 增加复制 `jump-to-opencode.ps1`。
- 已知问题（暂不排查）：一次 `INTERNET INTERRUPT` 未通知，最近一次 NETWORK toast 为 12:00:00；已记录，与心跳方向相关。

## 10. 部署回归轮（2026-08-06）：`-la` 致命参数 + 事件处理器崩溃 + ESC 误报 NETWORK

> 部署后实测发现三个回归，全部修复，测试 66 项全绿。

### 10.1 通知不弹 + CLI 打印 SnoreToast 帮助手册（根因：`-la`）

- **实测**：逐参数探测 vendored `snoretoast-x64.exe`：`-appID/-t/-m/-p/-s/-pipeName/-application` 均 OK；一旦带 `-la` → 退出码 `-1`（0xFFFFFFFF），且解析器打印 usage 帮助。`execFileSync` 下 exit `null`=0 成功、`4294967295`=-1 失败。
- **为什么影响所有通知**：默认 `clickMode:"helper"` 总配置 clickArgs → `buildSnoreToastArgs` 总拼接 `-application ... -la <args>` → 每条通知都触发 SnoreToast 解析失败 → 从不显示 toast，只弹帮助。
- **修复**：`buildSnoreToastArgs` 不再向 SnoreToast 转发 `-application`/`-la`。点击激活完全由插件自己的命名管道回调（`spawnClick`）承担，SnoreToast 只接收安全参数子集。

### 10.2 连续 ESC 让 OpenCode CLI 闪退（根因：unhandledRejection）

- `event` 与 `tool.execute.before` 处理器是 async，内部 `await`（session fetch / composeMessage 等）一旦 reject 即成为 unhandledRejection —— Node 15+ 默认 unhandled-rejections 会**终止整个进程**。连续 ESC 并发触发 `session.error` 显著提高命中概率。
- **修复**：两个处理器整体包 try/catch，任何异常 log + 吞掉，永不外抛；heartbeat 定时器原本已有 `.catch()`。

### 10.3 ESC 误报 NETWORK INTERRUPTED（根因：错误分类顺序）

- 手动 ESC 走 `session.error`（裸 `AbortError`），其消息含 "aborted" → 旧 `classifyError` 先命中 `NETWORK_ERROR_HINTS` → 标为 network → 弹 NETWORK。
- **修复**：新增 `categorizeErrorEvent(error)`，**先按错误名判定**（`AbortError`/`UserInterrupt`/明说 user 的消息 → `user-cancel`），再对裸 `AbortError` 做「消息是否带连接特征」细分；仅当无中止特征时才落到原有消息启发式。`handleSessionError` 按类别路由：user-cancel → **STOPPED BY YOU**（灰 banner，`notifyCancelled:false` 时静默）；network/http → NETWORK INTERRUPTED/SOMETHING WENT WRONG；generic → SOMETHING WENT WRONG。
- 注意边界：真实网络中断若以「裸 AbortError 且无连接特征」形式到达，会被当作 user-cancel（尽力而为，README 已注明）。
- **测试**：新增 `categorizeErrorEvent` 6 例 + session.error 集成 4 例（AbortError→STOPPED BY YOU、user 消息→STOPPED BY YOU、notifyCancelled:false 静默、generic→SOMETHING WENT WRONG）；`buildSnoreToastArgs` 断言改为「不转发 -application/-la」；点击集成测试改用轮询等待（Windows 命名管道回调在套件环境下可能被推迟数秒，2000ms 断言改为 15s 窗口）。共 **66 passed, 0 failed**。

## 11. 收敛轮（2026-08-06）：点击机制三态化 + 通用日志系统 + ESC/READY 修复收尾

> 前一轮引入的 helper 脚本 + fallback 链被判定过度设计。用户拍板：把两种点击机制固化为两个不同 `clickMode`（`off`/`program`/`native`），删除 helper；同时补齐可热更新的文件日志系统，用插桩根治无法复现的 ESC 分类与 silent-stop READY 问题。

### 11.1 点击三态（决策点：两种机制 → 两个 clickMode）

- **`clickMode`**：`"off"`（默认，点击无动作）| `"program"`（管道回调 spawn `clickProgram`+`clickArgs`，支持 `{{title}}/{{cwd}}/{{sessionID}}` 占位符，宿主无关）| `"native"`（SnoreToast `-application` 直接拉起，无参数、不保管道、永远开新窗口）。两种非 off 模式都要求 `clickProgram` 非空。
- 默认改 `off`：未配置 `clickProgram` 时不再试图拼任何点击参数，杜绝重新引入 `-la` 式回归。
- **删除**：`jump-to-opencode.ps1`、`resolveFallbackTarget`、`clickFallback*`、helper/simple 计划；`scripts/deploy.ps1` 不再复制 helper 且清理目标残留。
- **`wt.exe -w 0`**（MS Learn 确认）：复用最近窗口（无则新建）、`-w -1`/`-w new` 新窗口、`-w <id/name>` 指定窗口。README 的 `program` 示例即 `wt.exe -w 0 -d {{cwd}} opencode` 实现「复用窗口回到目录」。

### 11.2 通用日志系统（新文件 `plugin-logger.js`）

- 按参考项目（agent 能力基线）对齐：`%TEMP%\kdcokenny-notify-win\{yyyy-MM-dd}-kdcokenny-notify-win.log`、默认 `minLogLevel:"WARN"`、SLF4J `{}` 模板、缓冲 flush（`unref` 定时器）、保留 30 天、`module`/`codeId`、Error stack、TRACE data JSON。
- `buildLoggingConfigLoader` 以 mtime 版本号检测配置变更实现**热更新**（改 `kdco-notify.json` 无需重启即生效）。
- 插桩点：`L1001` 事件原始 payload、`L2001/L2002` error 原始 + 分类、`L2010-L2012` idle 决策（15s 抑制命中 / run-token 占用 / 正常 READY）、`L3001/L3002` toast 发送。
- 测试：`test/logger.test.mjs` 新增 **10 项全绿**（等级门控、ALL 全写、{} 替换、模块/codeId、前缀格式、Error stack、TRACE data、文件名、NO 零文件、flushOnExit）。

### 11.3 ESC 分类防御性兜底 + silent-stop READY 双保险

- **ESC 分类**：不再依赖「实测 payload 才定稿」——`categorizeErrorEvent` 对 nameless 字符串加 `USER_STOP_TEXT_HINTS`（含裸 `aborted`、`user aborted`、`operation was aborted` 等），无真实网络特征 → `user-cancel`。字符串分类 3 例测试覆盖。
- **READY 抑制**：`readySuppressDedupe = createDedupe(null, 15_000)` 用**内存** 15s 窗（必须内存：共享 store 的 1.5s `readyDedupe` purge 会误删 suppress 条目）+ `handleSessionIdle` 开头按 run token（`hb:<sessionID>:<updated>`）claim 检查；error/cancelled 已占用则 idle 直接 return。`createDedupe` 的 `store=null` 回退改为**持久 local Map**（不能每次重建），并新增只读 `isClaimed(key)`。

### 11.4 核验

- [x] `node test/notify.test.mjs` **74 passed**（新增：native `-application` 2 例、字符串分类 3 例、ESC-string→STOPPED BY YOU 且 idle 不再补 READY、1.7s 后 15s 窗抑制、正常 idle 仍 READY；点击测试改用 `clickMode:"program"` + 默认 off 断言）。
- [x] `node test/logger.test.mjs` **10 passed**。
- [x] README 更新（clickMode 三态、`-w 0` 示例、logging 配置段、布局树/手动拷贝去 helper）。
- [ ] 重新部署两处目标并逐字节校验（含 `plugin-logger.js`、无 `jump-to-opencode.ps1` 残留）——下一步。
- [ ] 提交（分支 `dev`）。

## 12. 配置多级化轮（2026-08-06）：项目级 JSONC 配置高优先级 + 日志诊断就绪

> 用户在「重启后双击 ESC 仍弹 NETWORK INTERRUPT」的现场要求把日志等级提到 ALL，并指出：配置不能只放全局一份。项目级部署的插件应把**项目目录下的配置文件**作为高优先级实现；预期路径 `.opencode/plugins/config/kdco-notify.jsonc`；本仓库对应位置留一份带**每个配置详细注释**的范例。

### 12.1 配置解析（项目优先 + JSONC）

- **优先级**（首个存在的文件生效）：`<cwd>/.opencode/plugins/config/kdco-notify.jsonc` → `.../kdco-notify.json` → `~/.config/opencode/kdco-notify.jsonc` → `~/.config/opencode/kdco-notify.json`。`resolveConfigPath()` 遍历候选；`loadConfig`/`buildLoggingConfigLoader` 统一走它（日志热更新也随之切到项目文件）。
- **`parseJsonc`**（新导出，4 例测试）：状态机去除 `//`/`/* */` 注释、去除 `}`/`]` 前尾逗号、兼容 UTF-8 BOM；字符串字面量内的 `//`、`,}` 原样保留；坏 JSON 抛出。普通 `.json` 也走同一解析器（无害）。

### 12.2 日志 `enabled` 开关 + 热更新可恢复

- plugin-logger 新增 `enabled`（false ≡ `minLogLevel:"NO"`，不写文件、ERROR 仍落 console 兜底），并重构出幂等 `#ensureDir()`：`init` 全量重置（清 timer/buffer/logDir/initialized）后按等级建目录；热更新从 disabled→enabled 时能补齐目录与 flush 定时器（无需重启即可开 ALL 抓现场）。
- 新增 `L1002`：启动时记录实际生效的配置文件来源（`config source=... logging.enabled=... minLogLevel=...`）。
- 新增 2 例 logger 测试：`enabled:false` 零文件、热更新恢复目录。

### 12.3 范例配置

- 本仓库 `.opencode/plugins/config/kdco-notify.jsonc`：**每个配置项**带中文注释（含声音预置、点击三态、日志各档位、心跳参数）；诊断期间 `logging.enabled:true` + `minLogLevel:"ALL"`。
- `scripts/deploy.ps1`：项目级目标额外把范例拷到 `<target>\.opencode\plugins\config\kdco-notify.jsonc`，仅当目标不存在时写入（不覆盖用户改动）；全局目标不部署配置（沿用全局 `.json`）。

### 12.4 核验

- [x] `node test/notify.test.mjs` **78 passed**（+4 parseJsonc）；`node test/logger.test.mjs` **12 passed**（+2 enabled/热恢复）。
- [ ] 部署两处目标 + 逐字节校验 + 确认项目目标已带配置；提交。
- 现场待办：重启后在项目里双击 ESC，读 `%TEMP%\kdcokenny-notify-win\{date}-kdcokenny-notify-win.log` 的 `L2001/L2002`（原始 error payload + 分类）定位为何仍判 NETWORK——若 payload 是「含 aborted 又含连接特征」的 nameless 字符串，`USER_STOP_TEXT_HINTS` 会被网络签名分支盖过，届时按真实字符串调整 hint 优先级。

## 13. 双击 ESC 误报 NETWORK 根治轮（2026-08-06）：取消后网络连带抑制

> 真实 payload（日志 L2001/L2002）证实了机制：双击 ESC 产生**两个** `session.error`——先 `This operation was aborted`（判 user-cancel → STOPPED BY YOU），随后 `fetch failed: read ECONNRESET`（第二次 ESC 把进行中的请求撕掉，undici 上报连接重置）→ 判 network → 又弹 NETWORK INTERRUPTED。

### 13.1 修复

- 新增 `NETWORK_AFTER_CANCEL_MS = 5_000` 与按 session 的 `lastUserCancel` 时间戳（`Map`）。
- `handleSessionError`：判定 user-cancel 时记录 `lastUserCancel[sid]=now()`；随后判为 network/http 的 error 若与上次 user-cancel 相隔 `< 5s`，记 `L2003` 并直接返回（STOPPED BY YOU 已发或按 `notifyCancelled:false` 静默，绝不再堆 NETWORK）。
- 真实网络中断（无前置 user-cancel，或距上次取消 >5s）仍正常弹 NETWORK，不受影响。

### 13.2 核验

- [x] `node test/notify.test.mjs` **81 passed**（新增 3 例：双击抑制、超窗不抑制、无取消仍弹）。
- [x] 已部署两处并逐字节一致（项目目标配置保留不改）。
- [x] 本处修复体现到 README。
- 现场待二次确认：重启后实际双击 ESC，应只出 STOPPED BY YOU（或静默），日志出现 `L2003 ...ms after user-cancel suppressed`。

### 13.3 真实根因（现场日志 L2001/L2002）+ 分类展开

- **真实 payload（用户实际双击 ESC）**：`{"name":"MessageAbortedError","data":{"message":"Aborted"}}` → 之前 `name.includes("aborterror")` 太窄：`MessageAbortedError`=「aborted」+「error」，**不含**「aborterror」（中间多一个 `d`），于是落到 `classifyError("aborted")`，而 `NETWORK_ERROR_HINTS` 含 `"aborted"` → 判 **network → NETWORK INTERRUPTED**。
- **修复**：`if (name.includes("aborterror"))` → `if (name.includes("abort"))`（同一 `explicitNetwork` 守卫：正文含真实连接特征仍判 network）。覆盖 `AbortError` / `MessageAbortedError` / `abortederror` / `useraborted` 等。
- 现场确认：`L2011 idle suppressed (run token already claimed)` —— READY 抑制在真实场景已生效（双击 ESC 不再重复 READY）。
- `L2003`（取消后 5s 网络连带抑制）保留作双保险；本次真正修复是上面的分类展开。

### 13.4 配置命名收敛（`kdco-notify-win.jsonc` + 全局 JSONC）

- 用户要求：项目级配置文件命名统一为 **`kdco-notify-win.jsonc`**（与插件同名，避免与其他工具的 `kdco-notify.json` 混淆），全局配置也换成 **JSONC** 以支持注释。
- `resolveConfigPath` 候选顺序改为：项目 `kdco-notify-win.jsonc` → `.json` → 旧名 `kdco-notify.jsonc`/`.json`（legacy 兼容）→ 全局 `kdco-notify-win.jsonc` → `.json` → 旧名。
- 仓库范例 `kdco-notify.jsonc` 重命名为 `.opencode/plugins/config/kdco-notify-win.jsonc`；`deploy.ps1` 改拷新名、写入目标时移除旧名 `kdco-notify.jsonc/.json` 残留（防旧配置遮蔽）。
- 全局：新建 `~/.config/opencode/kdco-notify-win.jsonc`（完整注释模板，承继原 `{"iconTheme":"legacy"}`，`logging.enabled:false` 避免全局刷盘），并删除旧 `~/.config/opencode/kdco-notify.json`。
- 验证：两处部署逐字节一致；`E:\vscode-workspace-temp` 下 `resolveConfigPath()` 正确返回项目 `kdco-notify-win.jsonc`；两个 jsonc 均能过 `parseJsonc`；notify 81 / logger 12 全绿。

### 13.5 双击 ESC 修复落地（2026-08-06）

- [x] `categorizeErrorEvent` 展开 `name.includes("abort")`（13.3 根因）。
- [x] `node test/notify.test.mjs` **83 passed**（+2：真实 `MessageAbortedError` payload → user-cancel、带真实连接特征的 `MessageAbortedError` → network）；logger 12 passed。
- [x] 部署两处 + 逐字节校验。
- 现场复测：重启后双击 ESC → 只弹 STOPPED BY YOU（或静默），日志应见 `L2002 categorized=user-cancel name=messageabortederror`。

## 14. 架构迁移轮（2026-09-02）：config 可管理 + P1–P7 配置链 + 目录部署

> 依据 `E:\vscode-workspace-temp\docs\tech\2026-09-02-[OpenCode]...大全整理.md` §6 推荐架构。用户核心目的排序：**纯离线 + 各自负责 + 易迁移组装**；官方标准只是顺带。本轮彻底放弃"零配置自动发现"，改为 **opencode.jsonc 显式注册**（屏蔽 = 删/注释 `plugin` 条目，不再删文件）。

### 14.1 目标架构（P1–P7 配置链）

```
P1+P3  opencode.json(c) `plugin` 元组 options   ← 官方通道，server 第二参数，最高优先级
P2     项目 .opencode/plugins/config/kdco-notify-win.jsonc
P5     全局 ~/.config/opencode/kdco-notify-win.jsonc（P4 路径弃用，全局文件保留 P5）
P6     插件内置 <plugin-dir>/config/kdco-notify-win.jsonc（bundled 默认）
P7     代码 DEFAULT_CONFIG
```

- 深合并：自低向高逐键（对象递归、数组整体替换），`deepMerge()` 新导出（4 例测试）。
- 热更：仅 `logging` 段（`buildLoggingConfigLoader` 改为基于整条链的 mtime 版本号）；其余配置重启生效（闭包架构下全配置热更收益/风险比不佳，README 已声明）。

### 14.2 落地改动

- [x] `dist/kdco-notify-win/kdco-notify-win.js` → **`index.js`**（`git mv` 保留历史）+ package.json `main` 同步。
- [x] 导出改 **V1 对象形态** `export default { id: "kdco-notify-win", server: async (ctx, options) => ... }`（id 与部署目录名一致）。
- [x] `server` 接收官方元组 options，作为最高优先级合并进配置链。
- [x] 配置解析重写：`resolveConfigLayers()` / `loadConfig(options)` / `deepMerge()` / `configVersion()`；`resolveConfigPath()` 保留（取最高层文件，供热更/日志）。
- [x] deploy.ps1 改**目录部署**：整个 `dist/kdco-notify-win/` → `plugins/kdco-notify-win/` 子目录（index.js + plugin-logger + package.json + node_modules + assets + config/）；清理旧的平铺残留（`kdco-notify-win.js` / `plugin-logger.js` / `jump-to-opencode.ps1`）；输出 opencode.jsonc 注册提示（file:// URL）。
- [x] 新增 bundled 默认 `dist/kdco-notify-win/config/kdco-notify-win.jsonc`（P6，纯默认 + 注释，`logging.enabled:false` 避免刷盘）。
- [x] README 重写 Install（config-managed 目录部署 + opencode.jsonc 注册示例）与 Configuration（P1–P7 链表 + 元组 options 示例 + 深合并语义）。
- [x] 测试：import 路径改 `index.js`；新增 `deepMerge` / `resolveConfigLayers` / `loadConfig` 链测试。

### 14.3 待办 / 现场

- [ ] 重新部署全局 + 项目两处，验证 `opencode.jsonc` 注册后 Status 面板正确显示插件名（依赖 OpenCode 上游 W1 修复，Windows file:// basename bug）。
- [ ] 提交本轮改动（分支 `dev`）。
- 说明：`%USERPROFILE%` 全局目录自始至终未在本轮被脚本写入（deploy 未执行，仅改仓库内文件）。
