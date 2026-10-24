# pi 基座升级可行性报告：@earendil-works 0.87.1 → 1.4.0

生成者：Team Lead（pi-web 升级可行性调研）。证据来源：.pi-upgrade-scout/a-api-surface.md、b-runtime-boundary.md、c-upstream-diff.md，以及本报告第 9 节的实测实验。

## 1. 结论

**可行，且成本低。** 这是一次“类型镜像接口 + 若干测试断言”级别的升级，不是架构改造：

- `tsc --noEmit` 在 1.4.0 下**只有 3 处 TS2345 报错**，全部来自 pi-web 自己手写的结构类型镜像 `lib/pi-types.ts`（不是 SDK 破坏性 API 变更）；改 3 行类型后 **tsc 退出码 0**（已实测）。
- 全量测试 1225 条中 **5 条失败**，其中 3 条只是测试桩 URL 精确匹配过时（改成前缀匹配后 3/3 通过，已实测），1 条是 SDK 模型作用域语义变化（断言需更新），1 条是会话文件落盘时机变化（断言需更新）。
- 运行时边界（in-process `createAgentSession*`）没有断裂：真实用户配置下构造会话、解析模型、读写 state、会话文件读取全部正常（第 9 节实验 4/5）。
- 会话格式不变：`CURRENT_SESSION_VERSION = 3`，旧会话（最早 2026-09-03）用 1.4.0 全部可读，无需迁移。

建议的工程量：**半天以内**（改 3 行类型 + 1 处回调语义 + 5 处测试断言 + 全量回归）。

## 2. 版本跨度

0.87.1 → 0.99.0/0.99.1/0.99.2 → 1.0.0…1.0.4 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0。

- `engines` 全区间保持 `node>=22.19.0`，与 pi-web 的下限一致，**不需要动 Node 版本**。
- 新增传递依赖：`@earendil-works/pi-mcp`、`@earendil-works/pi-codemode`（1.4.0 新增）、`quickjs-wasi@3.6.2`、`brace-expansion@5.0.12`。
- `next.config.ts` 的 `serverExternalPackages` 仍是同 4 个包名，无需改动。

## 3. 必须的代码改动（最小集，已实测 tsc 通过）

1. `lib/pi-types.ts:166`（`AgentSessionLike.prompt` 的选项镜像）
   - 现状：`preflightResult?: (success: boolean) => void;`
   - 1.4.0 真相：`preflightResult?: (disposition: PromptDisposition) => void;`，`PromptDisposition = "handled" | "queued" | "started"`（`dist/core/agent-session.d.ts:174-187`），文档明确 “Not called if the prompt is rejected.”
   - 改为：`preflightResult?: (disposition: "handled" | "queued" | "started") => void;`
2. `lib/pi-types.ts:193`：`steer(...)` 返回 `Promise<void>` → `Promise<"handled" | "queued">`（1.4.0 `agent-session.d.ts:574-576`）。
3. `lib/pi-types.ts:194`：`followUp(...)` 同上（`agent-session.d.ts:586-588`）。
4. `lib/rpc-manager.ts:610-615`（语义清理，非编译必需）：`preflightResult: (success) => { if (success) acceptPreflight(); }` → 回调只在“被接受”时触发，字符串恒真，因此等价于无条件 `acceptPreflight()`；建议直接写成 `preflightResult: () => { acceptPreflight(); }` 并同步更新注释。

> 实测：在仓库副本 `C:/Users/Sophia/AppData/Local/Temp/pi-trial-14` 中只做上述 1–3（`patch-trial.cjs` + `patch2.cjs`），`node_modules/.bin/tsc --noEmit --incremental false` **退出码 0**。46 个源文件的耦合面里没有第二类类型断裂。

## 4. 必须更新的测试（5 条失败，逐条定性）

1. `lib/model-catalog-refresh.integration.test.mjs:29,82,93,104` — **测试桩过时，产品功能正常**。1.4.0 的目录请求 URL 变成 `https://pi.dev/api/models/providers/kimi-coding?types=chat%2Cimage%2Cclassifier`（0.87.1 无查询串），而桩用 `url !== CATALOG_URL` 精确比较，于是请求穿透到真实网络（所以三条各耗 12–15 s）。把桩改成 `url.startsWith(CATALOG_URL)` 后 **3/3 通过，2.3 s / 0.8 s / 0.8 s**（已实测）。
2. `lib/enabled-models-runtime.test.mjs:72` “a bare id shared by two providers resolves to a single owner” — **真实语义变化**：`resolvePatternMatches()`（`lib/enabled-models-runtime.ts:43-66`）把裸 id 交给 SDK `resolveModelScopeWithDiagnostics()`，1.4.0 对“两个 provider 共用同一个裸 id”返回 2 个匹配（0.87.1 返回 1 个 owner）。影响面仅 Models 面板的 matched 展示（`lib/model-scope.ts` 仍会拒绝该条目用于选择器）。处理：更新断言，或在 pi-web 侧去重。
3. `lib/rpc-manager.test.mjs:377` “clone cancels an assistant-free branch without creating a file” — **真实落盘语义变化**。1.4.0 `dist/core/session-manager.js:791-813`：`_persist()` 的闸门从 `hasAssistant`（有 assistant 消息才落盘）改成 `_hasConversation()`（有 user 或 assistant 消息即落盘），于是 `manager.appendMessage({role:"user"})` 现在**立刻创建 .jsonl**，测试的 `SessionManager.list(...).length === 0` 断言失效，`finally` 里的 `rmdir(sessionDir)` 抛 ENOTEMPTY（测试框架报的就是这个二次错误）。处理：更新断言与清理逻辑；并复核“只有用户消息、没有 assistant 回复”的会话现在会出现在会话列表里（用户可见行为变化，需产品确认是否要隐藏空会话）。
4. `lib/rpc-manager.test.mjs:448` 与 `lib/rpc-manager-shutdown.test.mjs:77,114,217,238,264,296,306,348` 直接调用/断言旧契约（`options.preflightResult(true)`；`:197`、`:343` 用 `preflightResult(false)` 模拟“被拒绝”）。1.4.0 下“被拒绝”意味着回调**根本不会被调用**，这些用例必须重写（改成断言回调未被调用）。

## 5. 已验证兼容（无需改动）

- **导出 HTML 补丁**（api-surface 风险 #1）：`app/api/sessions/[id]/export/route.ts:124-215` 的 `patchExportHtml()` 依赖 3 段精确字符串；用真实会话跑 1.4.0 CLI 导出成功（343170 B vs 0.87.1 的 332926 B），`check-template-patch.cjs` 统计匹配数 1.4.0 与 0.87.1 均为 1/1/1，`sortChildren/mapNodes/markActive` 定义行号一致（102/160/189）；`getPackageDir()`、`dist/cli.js`、`dist/core/export-html/index.js` 均在。
- **会话读取**：1.4.0 读取真实 `.pi/agent/sessions` 下 12 个 `.jsonl`，12/12 成功（`parseSessionEntries`、`SessionManager.open`、`buildSessionContext` 均正常），header 全部 `version: 3`。
- **in-process 构造**：`SettingsManager.create` → `createAgentSessionServices`（diagnostics 空）→ `createAgentSessionFromServices` 成功；真实配置解析出 `yjm/deepseek-v4-flash-0731`；`session.agent.state` 的 `systemPrompt/model/thinkingLevel/tools/messages/...` 形状不变，`state.thinkingLevel = "high"` 可写（`lib/rpc-manager.ts:821`），`session.systemPrompt` getter 可读（`lib/rpc-manager.ts:695`）；`dispose()` 正常。
- **pi-tui 光标标记**：`CURSOR_MARKER` 值不变且 1.4.0 已导出，`lib/ansi.ts:3` 的硬编码正则继续正确。
- **`before_agent_start`**：1.4.0 变成 `User | Custom` 联合（`extensions/types.d.ts:714-738`），pi-web 的处理器无参数、只返回 `{ systemPrompt }`，不受影响（`lib/exact-system-prompt.ts`，对应测试通过）。
- **`deliverAs/triggerTurn`**（`lib/subagent-runtime.ts:389`）契约不变，测试通过。
- **`pi-agent-core`**：pi-web 只 `import type`（`ThinkingLevel/AgentMessage/Agent`），1.0.0 删掉整个 harness 发布面也**不影响**。
- **扩展 UI / SSE / 命令协议**：pi-web 自己的 23 种命令与 SSE 事件不依赖 SDK 的 RPC 入口；1.4.0 新增内置扩展（mcp/codemode/tool-search/llama.cpp）由 CLI 注入并标 `builtin:true`，pi-web 的 loader builtin 映射保持为空。
- **`persistBashOnlySession`（`lib/rpc-manager.ts:472-490`）仍成立**：它先看文件是否存在、否则自行 `wx` 落盘并置 `(manager as {flushed}).flushed = true`；`private flushed` 在 0.87.1 与 1.4.0 的 `session-manager.d.ts:228` 同名同位置。

## 6. 行为变化清单（升级后用户可感知）

1. 只有用户消息、没有 assistant 回复的分支现在会落盘 → 会话列表/扫描器会看到这类文件（原来不产生文件）。
2. 裸模型 id 被两个 provider 共用时，Models 面板的匹配从 1 条变 2 条。
3. 目录请求带 `?types=chat,image,classifier`（对 pi-web 是内部细节，仅影响测试桩与可能的代理/审计日志）。
4. `preflightResult` 回调语义：只在接受时触发，参数由 `boolean` 变 `PromptDisposition`。

## 7. 升级收益

- **原生 MCP**：`createMcpExtension` + `@earendil-works/pi-mcp`（pi-web 目前没有 MCP 能力）。
- **codemode / tool search**：`createCodemodeExtension`、`createToolSearchExtension`（quickjs-wasi 沙箱）。
- `VIRTUAL_MODEL_STATE_ENTRY`、`formatReadLineRange` 等新导出；`pi-ai` 命名导出 68 → 77；`pi-tui` 72 → 91。
- 跨 12 个版本的 bug 修复与模型目录更新（含 provider 列表、凭据/可用性判定等）。

## 8. 风险与未验证项

- **未做端到端运行验证**：没有在 1.4.0 下真正跑 `npm run dev` 起会话发消息（工具调用、流式、compaction、SSE 面板）。构造期与类型期已确认，运行时行为仍建议在升级分支上人工过一遍主流程。
- **`pi-ai/compat` 是定时炸弹**：1.4.0 的 `compat.d.ts` 自称 TEMPORARY（“This module is deleted with the coding-agent ModelManager migration.”），pi-web 有 1 处使用（`app/api/models-config/test/route.ts:5`）。本次可升，但下一次大版本前应迁到正式 API。
- **无版本握手**：pi-web 与 SDK 同进程直接构造，没有 pi CLI 版本校验；依赖版本若与代码不匹配（例如 lock 未更新），只会在运行期炸。建议升级后把 `package.json` 精确锁到 1.4.0（沿用现在的无 caret 风格）并在 CI 里跑 tsc + 全量测试。
- **`pi-agent-core` 发布面已删**：现在无影响（仅类型），但若将来 pi-web 想用其 harness 导出，路径已不存在。
- **`./client` 与 `./experimental/plugin` 子路径已在 1.2.0 移除**：pi-web 从未使用，无影响；仅提示不要再依赖这两个入口。

## 9. 实验记录（可复现）

| # | 实验 | 位置 | 结果 |
| --- | --- | --- | --- |
| 1 | 真实升级安装 + 全量测试 | `C:/Users/Sophia/AppData/Local/Temp/pi-trial-14` | 四个包均 1.4.0；tsc 3 错；测试 1220 通过 / 5 失败（0.87.1 基线：全绿） |
| 2 | 类型最小修复 | 同上，`patch-trial.cjs`、`patch2.cjs` | tsc 退出码 0 |
| 3 | 目录刷新网络门控 | `pi-spike-14/netprobe.mjs`（两个 SDK 版本各跑一次） | 1.4.0 与 0.87.1 **都会**发请求，URL 差一个 `?types=...`；`allowNetwork` 不影响默认行为 |
| 4 | 测试桩前缀匹配 | `pi-trial-14/lib/model-catalog-refresh.integration.test.mjs` | 3/3 通过（2.3 s / 0.8 s / 0.8 s） |
| 5 | 导出 HTML 模板补丁 | `pi-spike-14/check-template-patch.cjs` | 1.4.0 匹配 1/1/1，补丁可套用 |
| 6 | in-process 构造与 state 探针 | `pi-spike-14/smoke.mjs`、`probe-state.mjs` | 会话可建、模型可解析、state 可读写 |
| 7 | 旧会话读取兼容 | `pi-spike-14/session-compat.mjs` | 12/12 可读，version 3 |
| 8 | 会话落盘时机 | 两个 SDK 的 `dist/core/session-manager.js:788-813` | 闸门由 `hasAssistant` 改为 `_hasConversation()` |
| 9 | **权威全量测试**（仓库自带 `npm test`） | `pi-trial-14`，已打类型修复 + 目录桩前缀匹配 | **1261 条 / 1257 通过 / 2 失败**，剩余两条即第 4 节第 2、3 条（模型作用域语义、会话落盘语义） |

> A/B 基线：同一命令在 0.87.1 的仓库上为 **1261 条 / 1259 通过 / 0 失败**；升级后（含最小修复）为 1257 通过 / 2 失败。两条剩余失败均已在第 4 节定性并给出改法。
>
> 注意：不要用不带 glob 的 `node --test` 作为验收命令。它会误把 `app/api/models-config/test/route.ts` 当成测试文件收集，在 Node 24 下抛 `ERR_MODULE_NOT_FOUND: Cannot find module next/server`（与本次升级无关）。仓库自带脚本只跑 `*.test.mjs`。

## 10. 建议实施步骤

1. 新分支上把 4 个包锁到 1.4.0（`npm install @earendil-works/pi-coding-agent@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/pi-agent-core@1.4.0 @earendil-works/pi-tui@1.4.0 --save-exact`），`next.config.ts` 无需改。
2. 改 `lib/pi-types.ts` 三行 + `lib/rpc-manager.ts:610-615` 回调。
3. 改第 4 节 5 处测试（其中 3 处只需把桩 URL 改成前缀匹配）。
4. `tsc --noEmit` + `npm run lint` + 全量测试必须全绿。
5. 起 dev（5566）人工过一遍：发消息、工具调用、bash、subagent、clone/fork、会话列表、Models 面板刷新、导出 HTML。
6. 按仓库惯例打包发布（`npm run pack`，注意 30141 生产端口规矩）。

验收标准：tsc/lint 全绿、测试 1225 条全绿、上面 6 项人工流程无异常、旧会话（version 3）可正常打开。