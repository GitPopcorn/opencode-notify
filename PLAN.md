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
