# 上游 MCP + Code mode 移植规格（agegr/pi-web → 本仓库 1.4.0 基线）

调研基线：upstream/main = e533d9b（agegr/pi-web），本仓库 fork 点 0d1df12（v0.9.0），当前分支 chore/pi-base-1.4.0，SDK @earendil-works/pi-coding-agent **1.4.0**（package.json:47，仓库版本 0.13.2）。六个关键提交：ba044f9（内置扩展加载）、30fe218（per-session MCP host）、85f9cb1（SDK 未导出模块 + stdio 环境清洗）、73104ba（withExtensionTools → resolveActiveToolNames）、9dc822e（codemode 调用展示）、b8e0b71（SSE 嵌套事件瘦身）。
所有行号均已核对：上游行号基于 upstream/main 的文件；本仓库行号基于当前工作区文件。

---

## 一、三个内置扩展工厂如何传给 SDK

### 1.1 对象形状与 API 字段

工厂以 **InlineExtension** 形状传入 `createAgentSessionServices()` 的 `resourceLoaderOptions.extensionFactories` 数组。helper（lib/builtin-extensions.ts，upstream/main 全文）：

```ts
function builtin(name: string, factory: ExtensionFactory): InlineExtension {
  return { name, factory, replaceable: true, builtin: true };
}
const BUILTIN_EXTENSION_NAMES = ["codemode", "tool-search", "mcp"];
```

三个对象（与 pi CLI 的内置一致，名字也一致）：

| name | factory | 说明 |
| --- | --- | --- |
| `"codemode"` | `createCodemodeExtension()`（sandbox 自检通过时）或空工厂 | Code mode 脚本工具 |
| `"tool-search"` | `createToolSearchExtension()` | 工具发现 |
| `"mcp"` | `createMcpExtension({...})`（见二） | MCP 扩展本体 |

关键点：
- `replaceable: true, builtin: true` 让 SDK 的 DefaultResourceLoader 把它解析为 `builtin:<name>`，从而 `-builtin:<name>` 禁用、项目 settings 的 ±/! 覆盖、第三方扩展替换与 CLI 行为完全一致。
- 不可用的内置（如 codemode sandbox 自检失败）**保留条目、给空工厂**（`unavailableExtension`），这样 `builtin:<name>` 名字仍被占用，第三方替换语义不变。
- `createPiWebBuiltinExtensions({ agentDir, mcpHost? }): Promise<{ extensions: InlineExtension[], mcpHost?: McpHost }>` 是唯一入口：`Promise.all([checkCodemodeSandbox(), loadMcpRuntime()])` 后组装；mcpHost 存在时再把 `mcpHost.extension()`（hidden 内联扩展，见二）追加到数组尾部。

传给 SDK 的调用点（upstream lib/rpc-manager.ts:2585-2624）：

```ts
services = await createAgentSessionServices({
  cwd, agentDir, settingsManager,
  resourceLoaderOptions: {
    extensionFactories: [
      ...(builtins?.extensions ?? []),        // ← 内置三工厂 + pi-web-mcp-host
      createReadOnlyMcpPolicyExtension(),
      createProjectCommandBashExtension({ cwd, settings }),
      createSubagentExtension(...),
    ],
    extensionsOverride: (base) => preferUserBashExtension(preferPiWebSubagentExtension(base)),
  },
});
```

且 **chatOnly / subagent session 不加载**（`builtins = subagentResources || chatOnly ? undefined : await createPiWebBuiltinExtensions({ agentDir })`，行 2554-2556）。

### 1.2 pi 1.2.0 的 hack（pi-sdk-internals.ts）在 1.4.0 的取舍

上游 85f9cb1 建 lib/pi-sdk-internals.ts（442 行）来加载 SDK **未导出**的模块（pathToFileURL 动态 import + webpackIgnore/turbopackIgnore，保证与 SDK 同一模块实例、`instanceof` 成立）：

| internals 成员 | 来源模块 | 1.4.0 是否已导出 | 结论 |
| --- | --- | --- | --- |
| `createCodemodeExtension` / `createToolSearchExtension` / `createMcpExtension` | SDK 根 | **是**（node_modules …/pi-coding-agent/dist/index.d.ts:30-34 实证：`export { createCodemodeExtension }`、`export { createMcpExtension, type McpExtensionOptions, type McpTransportFactory }`、`export { createToolSearchExtension }`；另导出类型 CodemodeToolDetails、LoadedMcpConfig、McpExposure、McpServerConfig、McpServerEntry、RegisteredMcpServer） | **不再需要 hack**，直接根导入（上游 builtin-extensions.ts 本来就如此写） |
| `McpServerConnection`、`createDefaultTransport` | dist/extensions/mcp/runtime.js（经 runtime.lazy 懒加载） | **否**（仅 dist/extensions/mcp/runtime.d.ts 内部导出，根 index 不转发） | hack 仍需要 |
| `loadMcpConfig` / `addMcpServerConfig` / `updateMcpServerConfig` / `removeMcpServerConfig` | dist/extensions/mcp/config.js | **否**（根 index 只转发类型 LoadedMcpConfig 等） | hack 仍需要 |
| `validateMcpServerConfig` / `getMcpToolExposure` | dist/core/mcp-servers.js | **否**（只转发类型 RegisteredMcpServer） | hack 仍需要 |
| `signInMcpServer` / `McpOAuthCredentialStore` / `McpSignInCancelledError` | dist/extensions/mcp/oauth.js（runtime 再转发） | **否** | hack 仍需要（一期不用 OAuth 可不取这几个成员） |
| `resolveConfigValueOrThrow` / `resolveHeadersOrThrow` / `getConfigValueEnvVarNames` / `isCommandConfigValue` | dist/core/resolve-config-value.js | **否** | hack 仍需要 |
| `StdioTransport` | @earendil-works/pi-mcp | pi-mcp 根已直接导出（pi-mcp/dist/index.d.ts:6 `export { StdioTransport, type StdioTransportOptions } from "./transports/stdio.ts"`），**但实例身份必须与 SDK 用的 pi-mcp 同副本**，上游仍通过 findPackageJSON 从 SDK 的依赖里解析 | 保留上游做法；**本仓库 package.json 未直接声明 pi-mcp**（上游 package.json:55 声明了），一期应补 `"@earendil-works/pi-mcp": "1.4.0"` 直接依赖，或保留 internals 里"从 SDK 依赖解析"的路径 |

**结论：1.4.0 消掉的只是"工厂本身要 hack"的问题；lib/pi-sdk-internals.ts 整体仍需移植**（MCP host 与 transport 依赖它），校验链（PI_PACKAGE_DIR 拒绝、realpath 一致、createMcpExtension 第二副本检查、sharesStdioTransport probe）原样保留。任一校验失败 → MCP 整体关闭（`{ok:false, reason}`），**绝不回退**到传全量 env 的默认 transport。

---

## 二、mcp factory / McpHost / stdio 环境清洗

### 2.1 loadConfig 返回空 + startupWaitMs: 0（确切写法）

lib/builtin-extensions.ts（upstream/main）：

```ts
const mcpFactory = createMcpExtension({
  loadConfig: createMcpExtensionConfigLoader(mcp.internals, agentDir),
  createTransport: mcpHost.wrapTransportFactory(createPiWebMcpTransportFactory(mcp.internals)),
  startupWaitMs: 0,
  openUrl: () => {},            // /mcp 登录不在服务器主机开浏览器
});

function createMcpExtensionConfigLoader(internals, agentDir) {
  return (ctx) => {
    let autoEnableCodemode: boolean | undefined;
    try {
      autoEnableCodemode = internals.loadMcpConfig({
        agentDir, cwd: ctx.cwd, projectTrusted: mayReadProjectConfig(ctx.cwd),
      }).autoEnableCodemode;
    } catch { /* 配置坏了也不拦 session_start */ }
    return { servers: [], errors: [], ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }) };
  };
}
```

**理由**（ba044f9 提交信息 + ADR 0006）：
- Pi Web 自己决定会话连哪些服务器（经 McpHost + `pi.registerMcpServer()`），extension 的 `session_start` 若自己连 mcp.json 会在 fan-out 场景（browsing/切换/auto-naming/fork 建 wrapper 但不 prompt）连全部服务器、liveness lease 永不回收。
- extension 自己的 startup wait **忽略 Stop**；loadConfig 返回空 → 无服务器可连 → startup wait 永不武装，Stop 语义由 wrapper 控制。
- 保留 `autoEnableCodemode`（mcp.json 里的开关）是它唯一有用的输出。

### 2.2 McpHost 公共 API（lib/mcp-host.ts，upstream 1106 行）

```ts
type McpHostOptions = {
  agentDir: string;
  internals: Pick<PiSdkInternals, "loadMcpConfig">
    & Partial<Pick<PiSdkInternals, "isCommandConfigValue" | "validateMcpServerConfig">>;
  codemodeAvailable: () => boolean;      // codemode 不可用时 codemode 暴露降级 deferred
  mayReadProjectConfig?: (cwd: string) => boolean;  // 默认 mayReadProjectConfigNow
  idleMs?: number;        // 默认 PI_WEB_MCP_IDLE_MS=10min，0=禁用
  promptWaitMs?: number;  // 默认 10_000
  replaceWaitMs?: number; // 默认 5_000
};

class McpHost {
  constructor(options: McpHostOptions);
  extension(): InlineExtension;   // { name: "pi-web-mcp-host", hidden: true, factory }
                                  // factory: (pi) => { old.dispose(); current = new HostInstance(pi, options); }
  wrapTransportFactory(factory: McpTransportFactory): McpTransportFactory; // 按 attempt 匹配/拒绝 abandoned/跟踪 transport
  dispose(): void;                // wrapper destroy 时一次性调用
  prepareForPrompt(signal: AbortSignal, opts?: { wait?: boolean }): Promise<void>;
  serverStates(): ...;            // 连接状态（一期可只留内部用）
  release(): void;                // 空闲注销
}
```

**注册/注销时机**：
- HostInstance 订阅 `session_start`（检查 /mcp 命令仍属 builtin:mcp，被第三方替换则整个 host 不活跃）、`before_agent_start`（clearIdle + void sync()，兜底绕过 wrapper 的 prompt 路径）、`agent_start`/`agent_end`（runActive 标记 + clearIdle/armIdle）、`session_shutdown`（dispose 兜底）。
- `sync()`：串行队列；`desiredServers(ctx)`（每次重新读项目信任——**绝不用 ctx.isProjectTrusted()**，它在构建时固定；`internals.loadMcpConfig({agentDir, cwd, projectTrusted})`；enabled===false 跳过；不可信项目的 .pi/mcp.json 条目只报 not-trusted，≤100 条、≤1MiB、O_NOFOLLOW）；与现有 attempt 按 canonicalJson(config) 比较，变了才 unregister→register（`pi.registerMcpServer(name, config)` / `pi.unregisterMcpServer(name)`）。
- unregister 前最多等 replaceWaitMs=5s 让 attempt started（extension 加载 MCP runtime 后才 assign connection，早 unregister 关不到）；等不到记 abandoned，之后 wrapTransportFactory 对它 refuseAbandoned。
- `prepareForPrompt(signal, {wait})`：clearIdle → sync()（Promise.race([sync, aborted])）→ 若 wait：对 declaresTools（direct 暴露）且未 settled 且未 waited 的 attempt 等 promptWaitMs=10s，超时标记 waited 不再等。
- Nothing connects until a prompt：注册 ≠ 连接，SDK 在 run 前才连。

**rpc-manager 里的触发点（上游 lib/rpc-manager.ts:896-925）**——"哪个调用点在 before prompt 触发、确切位置与方式"：在 prompt 命令处理块里、`pendingPromptCount += 1` 之后、`this.inner.prompt(...)` 之前：

```ts
if (this.mcpHost && !this.inner.isStreaming) {
  const controller = new AbortController();
  const waited = this.mcpHost.prepareForPrompt(controller.signal, { wait: ... })
    .catch((error) => console.error("[pi-web] MCP servers could not be prepared:", ...))
    .then(() => {
      if (!controller.signal.aborted) return;
      finishPrompt();
      throw new Error(MCP_WAIT_STOPPED_MESSAGE); // 消息未发送，退回输入框
    });
  const wait = { controller, done: waited.then(() => undefined, () => undefined) };
  this.mcpPromptWait = wait;
  try { await waited; } finally { if (this.mcpPromptWait === wait) this.mcpPromptWait = null; }
}
```

Stop 分支（inner.abort() 之前）撤回等待：`if (this.mcpPromptWait) { wait.controller.abort(); await wait.done; }`。
wrapper options：`mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">`；`disposeMcpHost()` 在 destroy() 最开头一次性调 `this.mcpHost?.dispose()`（先于 session_shutdown 事件）。
**为什么在 wrapper 而不在 before_agent_start**：SDK 的 before_agent_start 在 run 已无 abort signal 之后跑，Stop 无法中止；wrapper 的等待可被 Stop 打断并拒绝未发送的消息。上游后来加了 `mcpPromptPreparation(message, extensionCommandCandidates())`（lib/mcp-command.ts）：另一扩展的命令 → 跳过等待；builtin /mcp → 注册但不等待；普通消息 → 等待。一期可用 30fe218 的原始形态（所有 prompt 都等待），不必移植 mcp-command.ts。

### 2.3 stdio 环境变量清洗（lib/mcp-transport.ts，upstream 113 行）

createPiWebMcpTransportFactory(internals, {baseEnvironment?, platform?}) 返回 (entry, cwd, authProvider) =>：
1. `findWebPasswordReference(config, internals)` 命中 PI_WEB_PASSWORD 引用 → throw "…references PI_WEB_PASSWORD, which Pi Web does not pass to MCP servers"。
2. `transport = internals.createDefaultTransport(entry, cwd, authProvider)`；`"url" in entry.config` 直接返回（HTTP 不改）。
3. 非 `StdioTransport` 实例 → throw "the SDK did not create a stdio transport"。
4. 校验 SDK 构造的 env 只含 config.env 声明的键，多出即 throw（防 SDK 未来夹带）。
5. 最终 `new internals.StdioTransport({ ...stdioOptions, env: serverEnvironment(baseEnvironment ?? process.env, configured, platform), inheritEnv: false })`。

serverEnvironment()：`sanitizeProjectCommandEnvironment(base, platform)` 打底 + config.env 叠加（win32 大小写不敏感替换）。
**清洗清单**（本地 lib/project-command-env.ts:37 `sanitizeProjectCommandEnvironment` 已存在，直接复用）：PI_WEB_PASSWORD、PORT、NODE_ENV、NEXT_*（Next.js dev/prod 变量）等项目 bash 同款黑名单。
**理由**：MCP 服务器代表项目运行，与项目 bash 命令同环境；SDK 默认 stdio 传**整个 process.env**（含 PI_WEB_PASSWORD），绝不接受；`inheritEnv: false` 是硬前提。

---

## 三、codemode 调用的数据层形状与 codemode-view 转换

### 3.1 数据层

- 嵌套调用：codemode 脚本经 `ctx.executeTool()` 调其他工具，SDK 给这些 `tool_execution_*` 事件 `parentToolCallId`，toolCallId 形如 `<parent>/<n>`；**模型永远看不到它们作为 tool call**，父调用的 partialResult 已含全部调用。
- 判定（agent-event-wire.ts:59-65）：`type ∈ {tool_execution_start, tool_execution_update, tool_execution_end} && typeof parentToolCallId === "string" && !== ""`。
- SSE 投影差异（b8e0b71，agent-event-wire.ts:34-117 + agent-event-stream.ts）：
  - 嵌套 start 瘦身为 {type, toolCallId, toolName, parentToolCallId}；嵌套 update **整体丢弃**（return null）；嵌套 end 不带 result、只带 {type, toolCallId, toolName, isError, parentToolCallId}。
  - 所有 `tool_execution_end` 一律去 result（浏览器只读 id，bash result 的 structuredContent 可达 1MiB）。
  - `entry_appended` 丢弃（codemode `store()` 写入可达 1MiB）。
  - codemode 的 `tool_execution_update` partialResult.details.calls 截断到最新 **CODEMODE_SNAPSHOT_CALL_LIMIT=200** 条 + `omittedCalls` 计数（脚本每次发布**全部**已发生的调用，不截断则线流量随调用数平方增长）。
  - 非助手角色的 message_start 瘦身为 {role}；系统消息（prompt+loadout）整体丢弃。
  - agent-event-stream.ts：`tool_execution_update` 按 toolCallId 合并（150ms 窗口最新胜），转发 end 前丢 pending update。
- codemode 进度快照形状（镜像 SDK `CodemodeToolDetails`/`CodemodeNestedCall`，SDK 1.4.0 导出类型 CodemodeToolDetails，index.d.ts:31）：`{ code?: string, calls?: [{ id, name, args, status: "running"|"ok"|"error"|"cancelled", durationMs?, error?, cost? }], omittedCalls?: number }`，外层再包 {type:"text", text:"Script completed…Wall time…Output:"} 头。

### 3.2 lib/codemode-view.ts 转换逻辑概要（130 行，可整体照抄）

- `codemodeScript(input)`：input.code 是 string 才返回（流式输入与第三方同名工具退回通用视图）。
- `codemodeCalls(details)`：details.calls 逐个防御式转 `CodemodeCallView`，`omitted = details.omittedCalls`。
- `stripCodemodeHeader(content)`：去首个 text 块的 `/^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/` 头。
- `formatCodemodeDuration`（<1000 → "Nms"，否则 "N.Ns"）、`formatCodemodeCost`（≥0.01 → toFixed(2)，否则 toPrecision(2)）、`codemodeTotalCost`（>1 个带 cost 求和否则 null）。
- `codemodeScriptPreview`：跳过空行与 `// @options:` 行取第一行。
- `getCodemodeProgress(partialResult)`：findLast(running) ?? at(-1)，args 截 120 字符——状态行显示最新调用。

### 3.3 展示层（components/CodemodeToolView.tsx 113 行）

`CODEMODE_VISIBLE_CALLS=20`（最新 20 可见，早的折叠按钮）；状态符号 …黄/✓绿/✗红/⊘dim；CallRow（图标+name+args 单行省略+duration+cost）；CodemodeCallList 标签/omittedCalls/totalCost。**嵌套调用永不作独立工具卡**——它们不以 tool call 到达模型，只是 codemode 卡内行。
MessageView 接线（9dc822e diff）：ToolCallBlock 里 `codemodeCode = toolName === "codemode" && !isStreamingInput ? codemodeScript(input) : null`；展开显示 CodemodeScript + CodemodeCallList；折叠行显示 scriptPreview + 调用数；运行中快照（result.content.length===0）不渲染通用结果区。

---

## 四、最小可行一期清单（逐文件：可抄 / 必改）

前置：package.json 补直接依赖 `"@earendil-works/pi-mcp": "1.4.0"`（上游 package.json:55 同款；本仓库当前只有传递依赖）。

### (a) normal session 加载三工厂

| 文件 | 动作 |
| --- | --- |
| lib/builtin-extensions.ts | **新建，可抄** upstream/main 版本（230 行）。含 checkCodemodeSandbox（"return 6 * 7"→须含"42"，10s 超时，Symbol.for 每进程一次）、unavailableExtension、PI_WEB_DISABLE_MCP。唯一取舍：内部 import 路径与 lib/mcp-json-error.ts 一并移植 |
| lib/pi-sdk-internals.ts | **新建，可抄** upstream/main 版本（442 行）。1.4.0 下校验链照旧通过（三工厂根导出恰好满足"无第二副本"检查）。OAuth 成员可先留在 MEMBERS 里不取用 |
| lib/mcp-transport.ts | **新建，可抄**（113 行）；复用本地 lib/project-command-env.ts:37 sanitizeProjectCommandEnvironment（已存在，签名核对后接入） |
| lib/rpc-manager.ts | **必改，≈6 行**（ba044f9 的 diff 原样适用）：import；行 2027 的 createAgentSessionServices 里 normal 分支 resourceLoaderOptions（本地行 2050-2065）改 `extensionFactories: [...builtins.extensions, createProjectCommandBashExtension(...), createSubagentExtension(...), createAskExtension(...)]`（本地无 createReadOnlyMcpPolicyExtension，一期可不加）；`const builtins = subagentResources || chatOnly ? undefined : await createPiWebBuiltinExtensions({ agentDir })` 放在 2027 之前 |

### (b) 全局 mcp.json 服务器经 McpHost 注册

| 文件 | 动作 |
| --- | --- |
| lib/mcp-host.ts | **新建，可抄** upstream/main 版本（1106 行；30fe218 初版 484 行 + 后续演进，直接抄终版）。一期可把 mayReadProjectConfig 固定为 () => false（项目信任 UI 未移植，全局 mcp.json 已够） |
| lib/rpc-manager.ts | **必改，5 处**（本地行号）：① 行 116-121 AgentSessionWrapperOptions 加 `mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">` + `export const MCP_WAIT_STOPPED_MESSAGE = …`；② 构造器（行 ~259）存 this.mcpHost、加 mcpPromptWait 字段；③ prompt 命令块行 603 `this.pendingPromptCount += 1;` 之后、行 604 `let prompt` 之前插入 30fe218 的等待块（所有 prompt 都 wait，一期不移植 mcp-command.ts）；④ 行 661 `await this.withFinalIdleReset(() => this.inner.abort())` 之前插入 mcpPromptWait abort 撤回块；⑤ destroy()/关闭路径开头调 disposeMcpHost()（对照上游 197-205）；⑥ 行 ~2144 wrapper 构造加 `...(builtins?.mcpHost ? { mcpHost: builtins.mcpHost } : {})`，builtins 从 (a) 处取得 |
| lib/mcp-json-error.ts | 可抄（scrubMcpLoadError，每进程每错误一次 warn） |

### (c) 工具经 withExtensionTools 生效 → 换成 resolveActiveToolNames

| 文件 | 动作 |
| --- | --- |
| lib/rpc-manager.ts | **必改**（73104ba 的 diff，本地行号）：本地 withExtensionTools 在 **202-213**（比上游旧版还老——无 exposure 过滤，把所有非 coding 工具全部塞进 active 集）；CODING_TOOL_NAMES 在 **171**（内容已与上游一致，不动）。改动：① 删 202-213，原位放入 DECLARABLE_EXPOSURES、TOOL_DISCOVERY_TOOL_NAMES、isActivatedOnRegistration、resolveActiveToolNames（代码全文见 73104ba diff，已逐行核对）；② 行 425-426 setActiveToolSelection 加第二参 `carry: readonly string[] = this.inner.getActiveToolNames()` 并改调 resolveActiveToolNames；③ 行 2133 改 `const initialToolNames = inner.getActiveToolNames(); inner.setActiveToolsByName(resolveActiveToolNames(inner, selectedToolNames ?? initialToolNames, initialToolNames))`（现有注释 2000-2005 恰好已解释为什么不传 allow-list，语义衔接顺滑）；④ navigate_tree / reload 的 navigateTreeKeepingToolSelection 部分（73104ba 后半）：一期**建议带上**（否则切分支后 codemode 丢失、Read-only pin 失效），改动点为本地 navigate_tree 命令 case 与 subagent controller 的 navigateTree；lib/pi-types.ts 若缺 ToolInfo.exposure 类型则补（73104ba +2 行） |

原理：SDK 初始 loadout 已含"注册时激活"的扩展工具与 defaultTools（`+codemode`）；resolveActiveToolNames 只替换 coding 工具集，携带已激活的扩展工具跨 set_tools/reload/navigate_tree，并尊重 defaultActive:false——这是 codemode/tool_search 不被 preset 挤掉的关键。

### (d) codemode 调用可读展示

| 文件 | 动作 |
| --- | --- |
| lib/codemode-view.ts | **新建，可抄**（130 行） |
| components/CodemodeToolView.tsx | **新建，可抄**（113 行；上游 9dc822e 时 125 行，以 upstream/main 终版为准） |
| components/MessageView.tsx | **必改**（9dc822e diff 适配）：本地锚点 ToolCallBlock 在 **1150**、isStreamingInput 在 1154、preview 行在 1200、通用 input pre 在 1221。按 9dc822e 的 diff 插入 codemodeCode/codemodeRunning/callCount/展开区/去头输出 |
| hooks/useAgentSession.ts | **一期可跳过 live 展示，只做最终结果**。9dc822e 依赖 activeToolResults 实时通道，本地 hooks/useAgentSession.ts 完全没有该机制（grep 0 命中；tool_execution_update 只更新 progress，本地行 1330-1345）。最终完成的调用列表来自 result.details，MessageView 接线后即可用。live 随跑随显留二期 |
| lib/agent-event-wire.ts | **必改，可抄**：本地版本无 isNestedToolExecutionEvent/parentToolCallId/CODEMODE_SNAPSHOT_CALL_LIMIT（grep 0 命中），把 upstream agent-event-wire.ts:34-117 整段移植（含 toClientToolExecutionEvent 改造）；同步在 useAgentSession 把 nested 事件排除出 running-tools 阶段（b8e0b71 的 hooks 部分），否则 codemode 卡会冒出一堆嵌套工具行 |
| i18n（en/zh-CN/zh-TW） | 补 codemode.status.* / codemode.calls / omittedCalls / showEarlierCalls / modelCost / callCount 键（9dc822e 各 +10） |

### 建议落地顺序

(a)+(c) 先行（纯 rpc-manager/内置加载，风险低、`+codemode` 立即生效）→ (b)（MCP host，改动集中在 wrapper 生命周期）→ (d)（纯前端）。每步后跑 `node_modules/.bin/tsc --noEmit` + `npm run lint` + 全量测试；上游对应测试文件（builtin-extensions、mcp-host、pi-sdk-internals、mcp-transport、codemode-view、CodemodeToolView 各 .test.mjs）一并移植作回归。

---

## 五、一期不做的项与理由

1. **Settings › MCP 面板 / routes / paste import / test connection**（ADR P2）：纯 UI 工程，依赖共享设置组件先行；McpHost 在无面板时已完整工作（全局 mcp.json 自动生效）。项目 mcp.json 授权 UI 也在其中——一期 mayReadProjectConfig 固定 false，项目条目只会报 not-trusted，安全无虞。
2. **OAuth 登录流**（signInMcpServer、credential store、needs-auth 面板）：需要 oauth 模块成员 + 面板；openUrl: () => {} 已保证不会在服务器主机开浏览器。需 OAuth 的服务器一期表现为 failed/needs-auth 状态，不阻塞其他服务器。
3. **项目信任与 mcp.json 的授权写回**：mayReadProjectConfig 固定 false 已覆盖安全面；信任 reload 机制（projectTrustReloadOptions）本地已有，等面板一起做。
4. **斜杠命令 /mcp 拦截与 per-session 开关**：上游 /mcp 面板只渲染于 tui，Web 端本就不可用；mcpPromptPreparation 的命令判定一期用"所有 prompt 都等待"替代。
5. **undo 与 secrets 管理**（config editor 的 add/update/removeMcpServerConfig 写回、原子锁写）：internals 已加载但一期无 UI 入口；mcp.json 手工编辑即生效（每次 prompt 前按 canonical JSON 重同步）。
6. **codemode-settings.ts（Code mode 偏好面板、projectCodemodePreference）**：P2 设置组件的一部分；`+codemode` 经 defaultTools 已可用。
7. **subagent MCP / createSubagentCodemodeExtension / prepareMcpForRun**：subagent 直 prompt 路径；normal session 一期覆盖主场景。
8. **per-tool exposure / registry search / TOML/YAML**（ADR P3）。
9. **lib/agent-event-stream.ts 的 150ms 合并**：性能优化，事件量在一期负载下可接受；建议二批带上（可整体照抄）。

## 附：已核对本仓库现状（截至本规格）

- lib/rpc-manager.ts:171 `CODING_TOOL_NAMES = ["read","bash","powershell","edit","write","grep","find","ls"]`（与上游一致）。
- lib/rpc-manager.ts:202-213 旧版 withExtensionTools（把所有非 coding 工具无差别加入 active 集，无 exposure/hidden 过滤——**比上游 73104ba 之前更激进**，加载 codemode 后会把 codemode、tool_search 甚至 hidden 工具全部声明给模型，73104ba 的替换是硬前提）。
- lib/rpc-manager.ts:425-426 setActiveToolSelection(toolNames)（单参）。
- lib/rpc-manager.ts:2027 createAgentSessionServices / 2103 createAgentSessionFromServices（与上游同构，本地行号见上）；normal 分支 extensionFactories 在 2050-2065。
- lib/rpc-manager.ts:603 prompt 等待块插入点；661 abort 撤回插入点；2144 wrapper 构造。
- AgentSessionWrapperOptions 在 lib/rpc-manager.ts:116-121。
- 本地已有：lib/agent-event-wire.ts（无 nested 支持）、lib/agent-event-stream.ts（无合并）、lib/project-command-env.ts（sanitizeProjectCommandEnvironment:37 可复用）。
- 本地无：lib/mcp-host.ts、lib/pi-sdk-internals.ts、lib/mcp-transport.ts、lib/builtin-extensions.ts、lib/codemode-view.ts、components/CodemodeToolView.tsx、hooks/useAgentSession 的 activeToolResults。
- SDK 导出面实证：node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:30-34（三工厂+类型）、:11（RegisteredMcpServer 类型）；pi-mcp 1.4.0 dist/index.d.ts:6（StdioTransport）。
