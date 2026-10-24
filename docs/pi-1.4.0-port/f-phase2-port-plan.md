# MCP Phase-2 移植计划（upstream/main → chore/pi-base-1.4.0）

调研日期：2026-10-24。前提：我们已在 pi SDK 1.4.0，phase-1（a4c5b36）已注册 builtin codemode / tool-search / mcp 扩展、只读全局 mcp.json、清洗版 transport、codemode 视图、PI_WEB_DISABLE_MCP。

## 0. 三个决定性结论

1. **不移植 lib/mcp-host.ts（1106 行，SKIP）。** 1.4.0 的 `createMcpExtension(options)` 已内置上游当年用 host 手写的全部职责：`loadConfig`（全局+可信项目合并）、`createTransport`（我们已有清洗版工厂）、`credentials`（默认 mcp-auth.json）、`openUrl`、`updateConfig`（/mcp 修改落盘）、`startupWaitMs`。上游要 host 是因为 1.2.0 SDK 的扩展 loadConfig 为空壳。已验证 1.4.0 `dist/extensions/mcp/index.js:972` 在 `session_start` 调 loadConfig（每会话一次）。
2. **SDK 内部模块仍可加载，方式不变。** 1.4.0 的 package.json `exports` 只开放 `.` 与 `./rpc-entry`（已实测：包说明符深导入报 `ERR_PACKAGE_PATH_NOT_EXPORTED`），但上游 `lib/pi-sdk-internals.ts` 用 `getPackageDir()`（1.4.0 仍导出）+ **file URL**（`webpackIgnore/turbopackIgnore`）加载 `dist/extensions/mcp/{runtime,config,oauth}.js`、`dist/core/mcp-servers.js`、`dist/core/resolve-config-value.js`——全部路径与成员在 1.4.0 均存在（已逐一核对 d.ts 与文件系统）。`CONFIG_DIR_NAME`、`getAgentDir`、`ModelRegistry`、`SettingsManager` 也仍在公开导出里。→ pi-sdk-internals 近乎 COPY。
3. **无新依赖。** `proper-lockfile@4.1.2` 我们已有；上游其余 import 全部来自 SDK 公开导出或其自有文件。上游 i18n 机制与我们的完全同构（hooks/useI18n.tsx + lib/i18n/messages/{en,zh-CN,zh-TW}.ts），样式同为 app/settings.css 类名约定——两条最大的"适配成本"都不存在。

## 1. 文件逐一判定

### 1a. 内部加载与纯工具（Slice 1 核心）

| 上游文件 | 行数 | 判定 | 要点 |
|---|---|---|---|
| lib/pi-sdk-internals.ts | 339 | **ADAPT(轻)** | 逐成员核对 1.4.0：McpServerConnection/createDefaultTransport(runtime)、StdioTransport(pi-mcp 经 findPackageJSON)、loadMcpConfig/add/update/removeMcpServerConfig(config)、validateMcpServerConfig/getMcpToolExposure(mcp-servers)、signInMcpServer/McpOAuthCredentialStore/McpSignInCancelledError(oauth)、resolveConfigValueOrThrow/resolveHeadersOrThrow/getConfigValueEnvVarNames/isCommandConfigValue(resolve-config-value)——全部在。类型微调：1.4.0 `McpOAuthCredentialStore` 构造器是 `(backend?, lockDir?)`；`McpServerConnection` 选项多了 `onChange`/`log`（可选，不影响）；`McpOAuthSettings` 已含 `authServerMetadataUrl`。需按 1.4.0 跑一遍 pin 测试。 |
| lib/mcp-config-key.ts | 69 | COPY-AS-IS | 纯 HMAC/canonicalJson，无 SDK 依赖。 |
| lib/mcp-json-error.ts | 93 | COPY-AS-IS | 纯。 |
| lib/mcp-secrets.ts | 524 | COPY-AS-IS | 纯，浏览器 importer 也用（client-safe）。 |
| lib/mcp-server-display.ts | 128 | COPY-AS-IS | 依赖 display-path（一并拷）。 |
| lib/mcp-tool-display.ts | 43 | COPY-AS-IS | 纯。 |
| lib/display-path.ts | 22 | COPY-AS-IS | 我们没有此共享模块（各组件本地散落 shortenPath）；作为 Slice 1 基建拷入。 |
| lib/stacked-dialog.ts | 202 | COPY-AS-IS | Escape 分层（capture 相位 stopPropagation）、focusModalPanel/focusIfLost/focusAfterChange。McpConfig/McpSignIn/ProjectTrustDialog 都依赖。 |
| lib/regular-file.ts | 61 | COPY-AS-IS | 已自带 Windows 处理：`O_NONBLOCK/O_NOFOLLOW || 0`（Win 无 FIFO，退化安全）。 |
| components/settings-ui-helpers.ts | 29 | COPY-AS-IS | projectTrustReloadKey 等。 |

### 1b. 配置读写与状态（Slice 2）

| 上游文件 | 行数 | 判定 | 要点 |
|---|---|---|---|
| lib/mcp-config-file.ts | 534 | **ADAPT(轻)** | 仅 import `type McpExposure`（1.4.0 公开导出✓）。自研编辑器语义按 SDK add/update/remove 逐字节对齐（测试钉住）——1.4.0 该三函数仍在 `dist/extensions/mcp/config.js`，pin 测试可继续跑（测试经 internals 或 file URL 取 SDK 版）。 |
| lib/mcp-override.ts | 37 | COPY-AS-IS | 纯。 |
| lib/mcp-undo.ts | 105 | COPY-AS-IS | globalThis store（Symbol.for("pi-web:mcp-undo")）。 |
| lib/mcp-status.ts | 217 | **ADAPT(中)** | 结构保留（Symbol.for("pi-web:mcp-status:by-config")，500 上限，scope\0sourcePath\0name + configKey 两层 Map）。删除/闲置 host 专属部分：recordMcpHostInactive（hostInactive 记录，源于第三方 /mcp 接管——我们无 host，可留 API 不写入）；session 侧写入者改为我们的 transport 工厂观测（见 §2.3）。 |
| lib/mcp-config-read.ts | 933 | **ADAPT(轻)** | `CONFIG_DIR_NAME`✓公开导出；其余依赖 pi-sdk-internals（Slice 1 已给）。注意其只读文件、绝不连服务器的约束（GET 安全性）保持原样。 |
| lib/mcp-entry-request.ts | 236 | COPY-AS-IS | `getAgentDir`✓1.4.0 导出（我们也可以换成自家 agentDir 解析，但没必要）。 |
| lib/mcp-test.ts | 703 | **ADAPT(轻)** | `ModelRegistry`✓1.4.0 导出；签名未变。20s deadline/15s 请求超时/!command 队列（Symbol.for("pi-web:mcp-test-command-queue")）/flight 合并（pi-web:mcp-test-flights）/createTestRedactor 全部照搬。 |
| lib/mcp-sign-in.ts | 693 | **ADAPT(轻)** | `signInMcpServer` 1.4.0 签名一致（多 `signal`，上游已用）；flow 注册表/TTL 5min/paste 校验/写护栏照搬。 |
| lib/mcp-sign-out.ts | 124 | **ADAPT(轻)** | `class GuardedCredentialStore extends internals.McpOAuthCredentialStore`——1.4.0 该类可继承✓。 |
| lib/mcp-add.ts | 221 | COPY-AS-IS | 仅 type imports。 |
| lib/mcp-import.ts / -core / -json / -cli / -links | 471/1230/655/732/193 | COPY-AS-IS | 纯代码（客户端预览 + 服务端复解析同源）。mcp-import-cli 是 SDK `cli.js` 语法的移植，integration 测试对比真 `runMcpCommand`——该函数不在公开导出，测试需经 internals 加载器补一条 `runMcpCommand: dist/extensions/mcp/cli.js`（1.4.0 文件在✓）。 |
| lib/codemode-settings.ts | 395 | COPY-AS-IS | `SettingsManager`✓；Code mode 选择/inlineBudget 的读写与项目 override 判定。 |

### 1c. API 路由（Slice 2/3/4）

| 上游文件 | 行数 | 判定 | 要点 |
|---|---|---|---|
| app/api/mcp/route.ts | 664 | **ADAPT(轻)** | import 全部可用（getAgentDir✓、invalidateModelsCache✓ 我们有 lib/models-cache.ts）。action：enable/disable/remove/set-enabled/set-exposure/set-in-project/undo/add/sign-out。 |
| app/api/mcp/test/route.ts | 37 | COPY-AS-IS | |
| app/api/mcp/sign-in/route.ts | 48 | COPY-AS-IS | |
| app/api/mcp/sign-in/[flowId]/route.ts | 59 | COPY-AS-IS | 目录名含 `[flowId]`，拷贝时注意 Windows 路径。 |
| app/api/project-trust/route.ts | 101 | **ADAPT** | 在我们现有 route（67 行）上加 `mcpFile`/`mcpServers`（readProjectMcpServers，来自 mcp-config-read），保持我们现有返回形状为超集。 |

### 1d. UI（Slice 2/3/4）

| 上游文件 | 行数 | 判定 | 要点 |
|---|---|---|---|
| components/mcp-config-helpers.ts | 1516 | COPY-AS-IS | 纯 helper + i18n key 字面量表（翻译测试依赖）。 |
| components/McpConfig.tsx | 2259 | **ADAPT(轻)** | 依赖均已在计划内：display-path、stacked-dialog、settings-ui-helpers、SettingsUi 增量、mcp-config-helpers、i18n keys。路径别名 `@/` 与我们一致。 |
| components/McpAddServer.tsx + mcp-add-helpers.ts | 657+762 | **ADAPT(轻)** | 同上；额外用 mcp-import 的类型。 |
| components/McpSignIn.tsx + mcp-sign-in-helpers.ts | 312+390 | **ADAPT(轻)** | 依赖 OAuthPastePanel、SettingsUi.ConfigButton/ConfigDetailGridRow。 |
| components/OAuthPastePanel.tsx | 93 | COPY-AS-IS | |
| components/SettingsUi.tsx 增量 | — | **ADAPT** | 我们缺：ConfigSidebarGroupSwitch/GroupStatus、ConfigDetailGrid/GridRow、ConfigScopeTag/ScopeSwitch/SaveTarget、addSourceKeySubmits、ConfigAddSource*、ConfigNotice、ConfigTrustNotice、ConfigFooterStatus。从上游 diff 拷增量（我们的 SettingsUi 与上游同源，冲突小）。 |
| lib/settings-navigation.ts | — | **ADAPT** | SETTINGS_SECTION_VALUES 加 "mcp"（首个、非 PROJECT_SECTIONS）；上游同名文件即模板。 |
| components/SettingsPanel.tsx | — | **ADAPT** | 新增 MCP 分页、projectTrustReloadKey 就地重载、focusModalPanel 布局 effect。 |
| components/AppShell.tsx | — | **ADAPT(小)** | 把 projectTrust 状态与 openProjectTrustDialog 经 SettingsPanel 传入 McpConfig（AppShell 已有整套 trust 状态，仅加透传）。 |
| components/ProjectTrustDialog.tsx | 上游 446 / 我们 147 | **ADAPT(大)** | 以上游版为底替换：加项目 MCP 服务器清单（replacesGlobal、mcpOverrideNotice、PI_WEB_PASSWORD 警示）；i18n 用 trust.mcp.* + 共享 mcp.*。 |
| lib/i18n/messages/{en,zh-CN,zh-TW}.ts | — | **ADAPT** | 追加上游全部 mcp.*/trust.mcp.* keys（上游三语齐备，直接拷 key 块；注意我们的 key 排序/分组惯例）。 |
| app/settings.css | — | **ADAPT** | 追加 .oauth-paste-*（~L243-301）、.mcp-*（~L2044-2343）、.project-trust-*（~L2344-2619）三段；先 grep 我们文件确认无类名冲突。 |
| hooks/useKeyboardShortcuts.ts | — | **ADAPT(小)** | 全局 Stop 快捷键跳过 defaultPrevented 的 Escape（配合 stacked-dialog）。 |
| hooks/useAgentSession.ts / ChatInput.tsx | — | **ADAPT(小)** | 裸 /mcp 打开 Settings：bareMcpOpensSettings()（见 lib/mcp-command.ts）、流式中 sendQueued 先问 handler、Enter 立即提交 built-in。上游逻辑散在其 hook/ChatInput，按我们两文件结构重排（上游 hooks/useAgentSession.ts 无 mcp 专属行，逻辑在 composer 处理链）。 |
| lib/mcp-command.ts | 89 | COPY-AS-IS | 无 import，浏览器可加载；isBuiltinMcpCommand/bareMcpOpensSettings/mcpPromptPreparation。 |
| lib/mcp-read-only-policy.ts | 96 | **ADAPT(小)** | 只读会话拦截无 readOnlyHint 的 MCP 工具；依赖我们已有的 lib/session-tool-selection.ts、lib/subagents.ts（SDK_BUILTIN_TOOLS）；在 rpc-manager 的 extensionFactories 里注册该 policy 扩展。 |

### 1e. 项目信任与 loadConfig 合并

| 上游文件 | 行数 | 判定 | 要点 |
|---|---|---|---|
| lib/project-trust.ts | 448 | **ADAPT(大)** | 我们现有 49 行版仅 requiresTrust/trusted。移植上游的：decision/decisionPath/inherited（区分"精确信任/继承信任/显式 false/无决定"）、mayReadProjectConfigNow()（= requiresTrust && decision===true，**每次同步重读**，绝不用 getProjectTrustStatus().trusted）、fresh-folder 机制（trustFreshFolderAndWrite、freshFolderTrustBreadth：BFS 4 层、>2000 拒、禁 home/根/agent 目录/已知根/会继承的项目，链锁 Symbol.for("pi-web:fresh-folder-trust-locks")）。保留我们现有导出（getProjectTrustStatus/trustProject/projectTrustReloadOptions——rpc-manager:2092 在用）并让新实现向后兼容（trusted = decision===true）。trust.json 仍以 SDK `ProjectTrustStore`（与 pi CLI 共享）为唯一事实源。 |
| lib/builtin-extensions.ts（我方） | — | **ADAPT** | loadConfig 升级（§3.1）；createBuiltinExtensionFactories 签名加 cwd（rpc-manager:2072 调用处 sessionCwd 在作用域内）。 |
| lib/project-trust.test.mjs 等测试 | — | COPY | 按 slice 随主文件拷。 |

### 1f. SKIP

| 文件 | 理由 |
|---|---|
| lib/mcp-host.ts（1106）| 1.4.0 builtin 扩展已覆盖其职责；改由 loadConfig 合并 + transport 工厂观测 + （可选）写路径触发会话重载（§2.4）。 |
| lib/mcp-host.test.mjs / .integration.test.mjs、lib/mcp-read-only-policy.integration.test.mjs、lib/subagent-mcp.integration.test.mjs、lib/subagent-codemode-scope.integration.test.mjs | 钉的是 host/wrapper 行为；按 §2 新设计重写或降级。 |
| demo/components/ProjectTrustDialog.tsx | demo 样例。 |

## 2. OAuth 登录如何落在我们的 1.4.0 builtin 扩展上

### 2.1 扩展选项（builtin-extensions.ts 现状 → 目标）

`createMcpExtension({ loadConfig, createTransport, startupWaitMs: 0, openUrl })`：
- `credentials`：**继续不传**。SDK 默认 `<agentDir>/mcp-auth.json`（含 per-server refresh 锁，proper-lockfile）；路由侧 sign-in/test 用 internals 的 `McpOAuthCredentialStore` 指向同一文件——SDK 承诺"运行中的会话在下一轮请求读到新令牌"（cli.d.ts 明文），无需把 store 实例塞进会话。
- `openUrl(url)`：扩展自带的 `/mcp login` 流（模型在聊天里触发）会用它。设计：**globalThis 注册表** `Symbol.for("pi-web:mcp-open-url")`：`Map<sessionId, { url, at }`，openUrl 闭包在 createBuiltinExtensionFactories 里按会话生成（需把 sessionIdRef 传进来，ask 扩展已有同款 askWrapperRef 先例 rpc-manager:1994）。新增 `GET /api/mcp/open-url?sessionId=` 轮询端点；ChatWindow 出横幅"服务器请求授权"，按钮在**用户浏览器** `window.open(url)`（dev 5566/prod 30141 与用户同机时 loopback 回调自然打通）。
- `promptForRedirectUrl` 的粘贴兜底：LAN/远程访问时 loopback 回调不可达，扩展内置流会等满 5 分钟——已知限制，记入风险；主 UX 是 Settings 的路由式登录（下一节），不依赖扩展流。
- `updateConfig(entry, patch)`：接 lib/mcp-config-file.ts 的写入路径（按 entry.source/entry.override 选文件），让聊天里 `/mcp` 的 enable/disable/exposure 持久化。Slice 4 可选项。

### 2.2 Settings 的登录主路径（照搬上游）

上游方案本就不经过扩展实例：`POST /api/mcp/sign-in`（origin/JSON/cwd/trust/mcp-off 检查 → `readMcpServerConfig()` 取清单版条目 → 起 flow 立即返回）+ `GET /api/mcp/sign-in/[flowId]` 每秒轮询；flow 在 globalThis（`Symbol.for("pi-web:mcp-sign-in")`，randomUUID，5min TTL/60s keep），内部用 internals.McpServerConnection（我们的清洗 transport 工厂）+ `signInMcpServer({ serverUrl, store, settings, challenge, prompt, signal })` + reconnect；`promptForRedirectUrl` 由 OAuthPastePanel 的粘贴应答（redirect-invalid/state-mismatch/denied/no-code 校验）。**与 1.4.0 兼容性好：全部 API 在 oauth.d.ts 原样存在。** 会话侧凭据下一轮自动生效。

### 2.3 无 host 时会话侧状态怎么来（Settings 状态点的降级方案）

上游的 connecting/connected/failed/needs-auth 来自 host 包 transport。我们等价实现**零 SDK 内部**：
- createBuiltinExtensionFactories 已按会话构造（rpc-manager:2072），把 `createPiWebMcpTransportFactory()` 包一层会话闭包：transport start/error/close 时以 `origin:"session"` 写 recordMcpStatus（keyed scope\0sourcePath\0name + configKey，configKey 从 loadConfig 返回的条目算）。
- `needs-auth` 判定：捕获 error.name === "McpOAuthAuthorizationRequiredError" / "McpAuthRequiredError"（字符串匹配，用 pin 测试钉住 1.4.0 错误名；上游用 SDK 未导出的 needsSignIn()，我们用名字等价替代）。
- `not-trusted`：我们自己就是 loadConfig——项目不可信时直接为项目文件里的名字写 not-trusted 记录（上限 100），比上游还直接。
- 失去的能力（接受，记入文档）：prepareForPrompt 的 10s 等待/停发语义、10min idle release、conflict 记录（registerMcpServer 冲突我们制造不出来——唯一注册者是我们）、hostInactive。1.4.0 扩展自身已有"首 prompt 等 direct 工具服务器、codemode/tool_search 按需等"的语义（index.d.ts 明文，startupWaitMs 默认 10s；我们保持 0 与 phase-1 一致）。

### 2.4 配置修改何时生效（与上游最大的行为差）

已验证 1.4.0 扩展只在 `session_start` 调一次 loadConfig（index.js:971-972），`mcp_servers_change` 只处理扩展注册的服务器——**运行中会话不会感知 mcp.json 文件修改**（上游靠 host 每 prompt 重读重注册）。缓解：写入路由（POST /api/mcp）成功后触发该 cwd 的 open 会话软重载（我们拥有 rpc-manager 的 wrapper 生命周期，project-trust 路由已有"重建 wrapper"先例）；做不到时 UI 注明"新会话生效"。列入 Slice 4 可选项。

## 3. 项目级 mcp.json + 信任门设计

### 3.1 loadConfig 合并（builtin-extensions.ts）

```ts
loadConfig: (ctx) => {
  const global = loadGlobalMcpConfig(agentDir);            // 现有函数保留
  const trust = mayReadProjectConfigNow(cwd, agentDir);     // 每次调用重读 trust.json（上游规则）
  if (!trust.ok) { /* 为项目文件里的名字写 not-trusted 记录(≤100)，返回全局 */ }
  const project = readProjectMcpConfig(cwd);                // 复用 mcp-config-read 的解析/链接规则
  return mergeMcpConfigs(global, project);                  // 项目同名替换全局；无 command/url/type 的条目
                                                            // 只覆盖 enabled/exposure/toolExposure（override 语义，
                                                            // 1.4.0 SDK 同款）；拒绝项目条目带 url+auth；命名空间
                                                            // 冲突（a-b/a_b）后到者跳过并记 error；别名
                                                            // codemode-deferred→codemode；autoEnableCodemode 项目优先。
}
```
mergeMcpConfigs 建议直接抽自上游 lib/mcp-config-read.ts 的 loadMcpConfig 等价逻辑（其清单读取与合并已按 SDK 逐条对齐并有契约测试），避免二次实现。entry.source/scope/projectConfig 字段照 SDK LoadedMcpConfig 形状返回，updateConfig/override 落盘依赖它。

### 3.2 信任 UX

- GET /api/project-trust 返回扩展形状（mcpFile/mcpServers/replacesGlobal/override 提示），ProjectTrustDialog（上游版）在 Trust 按钮上列出"信任后将运行这些仓库提供的命令/URL"，PI_WEB_PASSWORD 条目显示警示而非安慰。
- Add 到项目（Slice 3）：写目标必须 decision===true；fresh folder 走 trustFolder 单步（trustFreshFolderAndWrite：先 breadth 守卫、再链锁内复查 hasTrustRequiringProjectResources/hasTrustRelevantEntries/getEntry，先 set(true) 再写文件，失败回滚 set(null)）。
- 信任决定变化到已开会话：上游规则保留——扩展的 loadConfig 在 session_start 才读，我们的 loadConfig 每次连接前不重读（无 host），所以项目信任翻转后需要会话重载才生效；UI 文案与 /api/project-trust 重建 wrapper 的现有机制衔接。

## 4. 实施顺序（4 个 slice，约 50 文件含测试）

### Slice 1 — 内部加载与纯基建（~15 文件）
精确拷贝清单（含 .test.mjs）：
1. lib/pi-sdk-internals.ts + 测试（按 1.4.0 校准）
2. lib/mcp-config-key.ts + 测试
3. lib/mcp-json-error.ts + 测试
4. lib/mcp-secrets.ts + 测试
5. lib/mcp-server-display.ts + 测试
6. lib/mcp-tool-display.ts + 测试
7. lib/display-path.ts
8. lib/stacked-dialog.ts（+测试若上游有）
9. lib/regular-file.ts + 测试
10. components/settings-ui-helpers.ts + 测试
11. SettingsUi.tsx 增量（ConfigDetailGrid/GridRow、ConfigScope*、ConfigAddSource*、ConfigNotice、ConfigTrustNotice、ConfigFooterStatus、ConfigSidebarGroup*）
12. 三份 i18n 追加 mcp.* 基础 keys（Slice 2/3/4 各自再补）
验证：node --test 全绿 + tsc --noEmit；手工用 node -e file-URL 试载 internals 打印成员。

### Slice 2 — 配置文件读写 + GET /api/mcp + Settings › MCP 骨架（~14 文件）
mcp-override、mcp-status（裁剪版）、mcp-config-file(+test)、mcp-config-read(+test)、mcp-entry-request、mcp-undo(+test)、codemode-settings(+test)、app/api/mcp/route.ts（先只放 enable/disable/remove/set-enabled/set-exposure/undo，add/sign-out 后置）+ route-write.test、settings-navigation 加 "mcp"、SettingsPanel 分页、McpConfig + mcp-config-helpers、settings.css 三段、AppShell 透传。

### Slice 3 — 信任门 + 项目文件 + Add/导入（~16 文件）
project-trust.ts 大改(+test)、project-trust route 扩展、ProjectTrustDialog 替换、builtin-extensions loadConfig 合并 + rpc-manager 传 cwd(+测试)、mcp-add(+test)、mcp-import 五件套(+tests + integration)、McpAddServer + mcp-add-helpers(+tests)、route 的 add action。

### Slice 4 — Test / Sign-in / 策略与收尾（~12 文件）
mcp-test(+route+test)、mcp-sign-in(+2 routes+test)、mcp-sign-out(+test)、OAuthPastePanel、McpSignIn + mcp-sign-in-helpers(+tests)、mcp-command(+test)、useAgentSession/ChatInput 裸 /mcp、mcp-read-only-policy 接线、openUrl 注册表 + /api/mcp/open-url（可选）、updateConfig 接线（可选）、写后软重载（可选）。

## 5. 风险与未决问题

1. **运行中会话不热加载 mcp.json**（§2.4）——1.4.0 扩展仅 session_start 读；需写后软重载或明示"新会话生效"。这是与上游 UX 的最大差异。
2. **needs-auth 靠 error.name 字符串**——SDK 未导出 needsSignIn()；1.4.0 错误名需 pin 测试钉住，SDK 升级会碎（可接受，与上游 internals 契约测试同级）。
3. **mcp-import-cli 的 integration 测试**需要真 runMcpCommand——给 internals 加载器加一条 dist/extensions/mcp/cli.js 成员，或测试自行 file-URL 加载。
4. **SettingsUi/CSS/i18n 合并冲突**——三处都是我们与上游分叉过的共享文件；按增量 diff 拷，拷前 grep 类名/ key 冲突。
5. **project-trust.ts 是共享文件大改**——rpc-manager、skills、AppShell 多处调用现有三个导出；新实现必须保持旧签名兼容（trusted = decision===true 语义差要在调用点审一遍：旧的 trusted 对"无需信任的目录"为 true，新 decision 也为 true，但 unreadable store 时上游抛错而我们旧版返回 false——按上游 fail-closed 语义改，注意 trust-unreadable 的 UI 路径）。
6. **Windows 实机验证**——上游 O_NOFOLLOW/O_NONBLOCK 有 |0 兜底，但 link 规则（realPath、dangling、盘符大小写）要在 Windows 实测；我们 lib/paths.ts 的 samePath/isPathWithinRoots 与上游 lib/paths.ts 实现可能不同，mcp-config-read 里的路径判定要对照我们的 path-security.ts 审查。
7. **扩展内建 /mcp 命令的 UI 是 TUI 的**——web 会话里模型/用户跑 /mcp 会走扩展的 TUI 通知（ctx.ui.notify），我们只有 chat 通知桥；登录主路径走 Settings 路由，聊天路径只是横幅（§2.1）。
8. **测试基座**——上游 node --test + ${PI_CODING_AGENT_DIR} 临时目录模式与我们一致；integration 测试会起真 stdio 子进程，Windows 上 SIGTERM/SIGKILL 语义不同（2.5s SIGKILL 断言可能要放宽）。
9. **上游 0.12.2 与我们 0.13.2 的其他分叉**（如 lib/paths、request-security、models-cache 接口）——每个 COPY 文件 import 处逐一对照，已列在表中 ADAPT(轻) 项。

## 6. Slice 1 之后立刻可做的验证

- `node -e` file-URL 加载 pi-sdk-internals 并断言 16 个成员 → MCP 可用性从"待验证"变"已验证"。
- GET /api/mcp（Slice 2 完成后）对只读全局文件出完整清单——不碰会话、零风险上线面。
