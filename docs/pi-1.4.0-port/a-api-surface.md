# A. Coupling surface: pi-web -> `@earendil-works/*` (complete inventory)

Shared task **task-1**, owner `api-surface`. Repo: `C:\Users\Sophia\Downloads\Compressed\pi-web-main`.
Baseline: pi-web 0.13.2; all four `@earendil-works/*` runtime deps pinned to **0.87.1** (`package.json:45-48`).
Scope: **static coupling** — every place pi-web source reaches into the embedded pi packages, and how badly a version bump hurts. Runtime/protocol behaviour is out of scope here.

## 0. Method and coverage

* Walked the whole repo (`.ts .tsx .js .jsx .mjs .cjs .json .md .ps1 .yml .yaml`), excluding `node_modules`, `.next`, `.git`, `test-results`, `.codegraph`, `.pi-upgrade-scout`.
* Grepped for `@earendil-works/`, `pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, `pi-telemetry`, `chord`; every hit was then read in context and classified.
* Multi-line import blocks were expanded upward, so a statement's reported line is its first line.
* Result: **93 statements in 64 distinct files** — 47 source files, 2 config files (`next.config.ts`, `package.json`), 15 test/bench files.
* Tooling note: `rg` is not installed here; GNU `grep -rn --exclude-dir=...` was used. Extractor + classifiers: `C:\Users\Sophia\AppData\Local\Temp\pi-upgrade\{extract,counts,kind2,geninv}.mjs`.

## 1. Blast radius (files touching each package)

| package | source | config | test/bench | total | runtime (value) files | type-only files |
|---|---|---|---|---|---|---|
| `@earendil-works/pi-coding-agent` | 45 | 2 | 14 | **61** | 35 | 11 |
| `@earendil-works/pi-ai` | 11 | 2 | 2 | **15** | 6 | 6 |
| `@earendil-works/pi-agent-core` | 8 | 2 | 0 | **10** | 0 | 8 |
| `@earendil-works/pi-tui` | 1 | 2 | 0 | **3** | 1 | 0 |
| `@earendil-works/chord` | 0 | 0 | 0 | **0** | 0 | 0 |
| `@earendil-works/pi-telemetry` | 0 | 0 | 0 | **0** | 0 | 0 |
| `@earendil-works/pi-ai/compat` (subpath) | 1 | 0 | 0 | 1 | 1 | 0 |
| `@earendil-works/pi-ai/providers/all` (subpath) | 1 | 0 | 0 | 1 | 1 | 0 |

Unique files touching *any* pi package: **64** (47 source + 2 config + 15 test/bench).

**Statement-level split (source files only, no tests/config):**

| class | statements | distinct files | breaks at |
|---|---|---|---|
| VALUE (runtime `import`) | 29 | 28 | runtime (`ERR_MODULE_NOT_FOUND`, renamed/removed export) |
| MIXED (value + `type` in one statement) | 12 | 12 | runtime + compile |
| TYPE-only (`import type`) | 25 | 19 | compile (`tsc --noEmit`) only |
| DYNAMIC (`await import(...)`, `import.meta.resolve`) | 2 | 1 (`app/api/sessions/[id]/export/route.ts`) | runtime |

=> **36 of the 47 source files have runtime coupling** (35 import a runtime value statically; `app/api/sessions/[id]/export/route.ts` does it dynamically). The remaining **11 source files touch pi only through `import type`** and can therefore break `tsc --noEmit` without breaking the running app: `app/api/agent/new/route.ts`, `app/api/auth/login/[provider]/route.ts`, `app/api/sessions/[id]/auto-name/route.ts`, `lib/agent-event-wire.ts`, `lib/api-types.ts`, `lib/exact-system-prompt.ts`, `lib/model-catalog-refresh.ts`, `lib/pi-types.ts`, `lib/provider-listing-runtime.ts`, `lib/session-tool-selection.ts`, `lib/startup-preferences.ts`.

Notable: `@earendil-works/pi-agent-core` is **never value-imported** — 8 files, all `import type { ThinkingLevel }` / `AgentMessage` / `Agent`. It is the cheapest package to bump.

## 2. Subpath imports (the most fragile class)

`package.json` of the installed 0.87.1 exposes, for `pi-coding-agent`:

```jsonc
"exports": {
  ".":                       { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./rpc-entry":            { "import": "./dist/bundle/rpc-entry.js" },
  "./client":               { "source": "./src/client/index.ts" },
  "./experimental/plugin":  { "source": "./src/experimental/plugin.ts" }
}
```

`./client` and `./experimental/plugin` are **`source`-only** — Node cannot resolve them at runtime and TypeScript cannot type them without a bundler that honours `source`. pi-web uses neither (good).

**Subpaths pi-web actually imports:**

| subpath | site | symbols | exposure |
|---|---|---|---|
| `@earendil-works/pi-ai/compat` | `app/api/models-config/test/route.ts:5` | `completeSimple` (value), `AssistantMessage` (type) | real export (`"./compat"`), but a *compat* module is by definition allowed to change |
| `@earendil-works/pi-ai/providers/all` | `lib/enabled-models-runtime.ts:3` | `getBuiltinProviders` (value) | wildcard export `"./providers/*"` -> `dist/providers/*.js`; the file name is not a named export, so a re-shuffle of `dist/providers/` silently breaks it |

No use of `/rpc-entry`, `/client`, `/experimental/plugin`, `/node`, `/harness/context`, `/harness/env/nodejs`, `/harness/runtime/reducer`, `/harness/session`, `/harness/session/testing`, `/experimental/pico3`, `/oauth`, `/api/*`, `/utils/*`, `/bedrock-provider`, `/bun-oauth`. **pi-web talks to the SDK in-process (or via `dist/cli.js`) and never through the packaged RPC entry.**

## 3. Deep couplings a bump is most likely to break

### D1 — Export-HTML: literal patching of pi's generated template (highest risk)
`app/api/sessions/[id]/export/route.ts` (282 lines) does three separate things that all depend on pi's *internal* file layout:

* `:15-17` declares `type PiCodingAgentModule = { getPackageDir: () => string }` and `:23-26` does `await import("@earendil-works/pi-coding-agent")` -> `getPackageDir()`;
* `:49` `candidates.add(join(packageDir, "dist", "cli.js"))`, `:57` `import.meta.resolve("@earendil-works/pi-coding-agent")` fallback, `:64-68` fallback `join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")`;
* `:220` `execFile(process.execPath, [cliPath, "--export", filePath, outputPath])` with `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, 30 s timeout — depends on the `--export` CLI flag;
* `:236` fallback importer `join(packageDir, "dist", "core", "export-html", "index.js")` -> `exportFromFile`;
* `:124-215` `patchExportHtml()` performs **exact-string replacement of three functions copied out of pi's `template.js`** — `sortChildren` (`:143-148`), `mapNodes` (`:166-170`), `markActive` (`:184-191`) — and **throws** when a match count is not exactly 1: `"Failed to patch exported HTML: <name> expected 1 match, found <matches>"` (`:135`).

Verified at 0.87.1: `dist/cli.js` exists, `dist/core/export-html/{index.js,template.js}` exists, and `template.js` contains `function sortChildren` at line 102, `function mapNodes` at 160, `function markActive` at 189. Any rename, minification, extraction or reformat of those three functions turns session export into a hard 500.

### D2 — pi-tui cursor marker, hardcoded with no import
`lib/ansi.ts:3` `const TUI_CURSOR_MARKER_RE = /\x1B_pi:c\x07/g;` (used at `:6`, `:63`). This is an **undocumented pi-tui wire constant**; pi-web never imports pi-tui for it, so a change is invisible to the compiler and the typechecker.

### D3 — Subclassing + constructor casts of `Theme`, and pi-tui keybindings
`lib/rpc-manager.ts:174-199` defines `class PlainTextTheme extends Theme` overriding `fg`, `bg`, `strikethrough`, `getFgAnsi`, `getBgAnsi`, `getThinkingBorderColor`, `getBashModeBorderColor`, and reaches into the constructor signature via `as ConstructorParameters<typeof Theme>[0]` / `[1]` (`:178-179`). `:200` builds `new TuiKeybindingsManager(TUI_KEYBINDINGS)` from `pi-tui` (`:3`). `:1989` calls `initTheme()` with the comment *"Some extensions access the SDK's global theme even outside the terminal UI."* Any change to `Theme`'s abstract members, constructor arity, or `TUI_KEYBINDINGS`' shape breaks the web UI's extension surface.

### D4 — Internal `agent.state.*` field access (fields, not methods)
| site | access |
|---|---|
| `lib/rpc-manager.ts:278` | `this.inner.agent.state?.streamingMessage` |
| `lib/rpc-manager.ts:695-697` | `agent.state?.systemPrompt`, `agent.state?.thinkingLevel ?? "off"` |
| `lib/rpc-manager.ts:821` | `this.inner.agent.state.thinkingLevel = "xhigh"` (assignment) |
| `lib/rpc-manager.ts:1802` | `existing.inner.agent.state?.thinkingLevel` |
| `lib/subagent-runtime.ts:156` | `parent.inner.agent.state?.thinkingLevel` |
| `hooks/useAgentSession.ts:1194`, `:2038` | client reads `d.state?.systemPrompt` from the RPC payload |

`systemPrompt` is already known to be a **getter replayed from the transcript since 0.86** — `lib/rpc-manager-shutdown.test.mjs:61` *"never run since reopen) replay an empty agent.state.systemPrompt"*, `:267` `Object.defineProperty(inner.agent.state, "systemPrompt", { get: ... })`, `lib/rpc-manager.test.mjs:438` *"Pi 0.86 replays agent.state.systemPrompt from the transcript: assigning it throws"*. `agent.state` is a public-ish but unstructured escape hatch: field renames are silent at type level (it is `any`-shaped via the SDK's `state`), and `thinkingLevel` is **assigned** directly at `:821`.

### D5 — Private/prototype surface pinned by tests
`lib/rpc-manager-extension-ui.test.mjs:20-23` copies `AgentSession.prototype.prompt`, **`AgentSession.prototype._tryExecuteExtensionCommand`** (underscore-private), `.abort`, `.waitForIdle` onto a fake session; `:24-28` fakes `_extensionRunner` with `getCommand`/`createCommandContext`/`emitError`. `lib/rpc-manager.ts` reads `inner.extensionRunner` 7x and `inner.bindExtensions` 3x. A rename or removal of `_tryExecuteExtensionCommand` / `_extensionRunner` fails the test suite immediately (a useful early-warning tripwire, but also a hard migration task).

### D6 — Hand-written session-creation option bags
`lib/rpc-manager.ts:2025-2060` calls `createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: { noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles, systemPrompt, systemPromptOverride, appendSystemPrompt, extensionFactories, extensionsOverride }, resourceLoaderReloadOptions })` and `:2101-2110` calls `createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel, scopedModels, tools, excludeTools })`. The same two calls are duplicated in `lib/subagent-runtime.ts:178` / `:240` and `lib/model-runtime.ts:20` (`createAgentSessionServices({ cwd: agentDir, agentDir })` — no `settingsManager`). A comment at `lib/rpc-manager.ts:1986` records a past break: *"Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances."* Every one of the ~13 option keys is an independent breakage point.

### D7 — Wire-event union, structurally dissected
`lib/agent-event-wire.ts:1` type-imports `JsonAgentSessionEvent` and then derives everything by `Extract<...>` on the event union: `JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>`, `JsonToolCallStartEvent = Extract<JsonAssistantMessageEvent, { type: "toolcall_start" }>`. `toolCallMetadata()` reads `event.partial.content[event.contentIndex].type === "toolCall"` and `block.id ?? block.toolCallId`, `block.name ?? block.toolName` — i.e. it already defends against two historical namings. `OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end"])`. Consumers: `lib/agent-event-stream.ts:5`, `lib/agent-event-connection.ts:1`, `lib/streaming-message.ts:1,9`, `hooks/useAgentSession.ts:25`. Any rename of an event `type` string or of `partial.content[]` fields breaks the live UI stream at compile time (good) or silently at runtime (if the union widens).

### D8 — Exact system prompt via `before_agent_start`
`lib/exact-system-prompt.ts` (32 lines) — `:1` `import type { InlineExtension }`; `:8-13` documents the 0.86 migration: *"Pi 0.86 moved the prompt into the session transcript: agent.state.systemPrompt is replayed from persisted system messages and can no longer be assigned ... The one supported way for a host to send an exact prompt is a before_agent_start handler returning systemPrompt."* The factory returns `(pi) => pi.on("before_agent_start", ...) -> { systemPrompt }`. This is the **only** supported host hook pi-web relies on for prompt control; `hooks/useAgentSession.ts:1194,2038` and `lib/rpc-manager.ts:695` still *read* `agent.state.systemPrompt`, so the two mechanisms must stay consistent.

### D9 — Config-level coupling
* `next.config.ts:9-10` reads `join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json")` to derive `piVersion` -> `NEXT_PUBLIC_PI_VERSION` (`:85`). The path is hardcoded and bypasses package resolution (works only with a flat npm layout).
* `next.config.ts:26-34` `serverExternalPackages: ["node-pty", "undici", "web-push", "@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]` — pi packages are **not bundled**, so their own `dependencies` must resolve at runtime from `node_modules`.
* There is **no `transpilePackages`** key and **no tsconfig `paths` entry** for any pi package (`tsconfig.json`: `moduleResolution: "bundler"`, `paths: { "@/*": ["./*"] }`, `skipLibCheck: true`). pi-web therefore consumes the **published `dist/`** JS + `.d.ts`, never `src/` — except for the two `source`-only subpaths, which it does not use.
* `package.json:45-48` pins all four packages to exact `0.87.1` (no `^`), so `npm install` cannot drift; a bump is always explicit. `chord` and `pi-telemetry` are **not declared** — they arrive transitively.

### D10 — Environment variables and on-disk layout shared with pi
`PI_OFFLINE` is read in `lib/model-catalog-refresh.ts:72` (`process.env.PI_OFFLINE !== undefined` — *"pi reads any PI_OFFLINE value, empty included"*, `:70`), `lib/plugin-updates.ts:183` (`/^(1|true|yes)$/i`) and `:214`; `PI_CODING_AGENT_DIR` in `lib/model-catalog-refresh.integration.test.mjs:12`. Session/settings files are read from `~/.pi/agent/**` (settings.json, models-store.json, sessions) and `.pi/settings.json` per project — pi-web re-implements that layout (`lib/types.ts` mirrors the `.jsonl` session format) rather than importing it.

### D11 — `Type` re-exported from pi-ai
`lib/ask-extension.ts:1` and `lib/subagent-extension.ts:1` do `import { Type } from "@earendil-works/pi-ai"` — a **runtime value** (typebox re-export) used to declare tool schemas, together with `defineTool` from `pi-coding-agent` (`lib/ask-extension.ts:2`, `lib/subagent-extension.ts:2`). `lib/ask-extension.test.mjs:12-19` stubs `Type` (`Object`, `Array`, `String`, `Boolean`, `Optional`) and `:26-29` strips all `@earendil-works/*` imports out of `lib/ask-extension.ts` with a regex before loading it — so the test proves nothing about the real `Type` shape.

## 4. Local type modules: re-exported or hand-copied?

| module | pi imports | content | verdict |
|---|---|---|---|
| `lib/pi-types.ts` (204 lines) | `:1-8` `import type { AgentSessionEvent, BashOperations, SessionManager, SettingsManager, SlashCommandInfo, Theme }` from pi-coding-agent; `:9` `type { AgentMessage as PiAgentMessage }` from pi-agent-core; `:10` `type { ImageContent, TextContent }` from pi-ai | only the leaf types are re-used; the session-facing interfaces are **hand-written structural mirrors**: `AgentSessionLike` (`:130-204`), `ExtensionUiContextLike` (`:99-128`), `ExtensionRunnerLike` (`:80-88`), `ResourceLoaderLike` (`:75-78`), `PromptTemplateLike`/`SkillLike` (`:63-73`), `ContextUsage`/`ModelLike`/`ToolInfo`/`SessionStatsInfo` | **hybrid — hand-copied, must be re-audited by hand each bump** |
| `lib/api-types.ts` (153 lines) | `:1` `import type { ResourceDiagnostic }` from pi-coding-agent | rest hand-written (`SkillInfo`, `SkillsResponse` with `diagnostics: ResourceDiagnostic[]`, ...) | **hand-copied wrapper** |
| `lib/types.ts` (409 lines) | **none** | `:1` comment *"// Types mirrored from pi-mono coding-agent session-manager"*; hand-copies `SessionHeader`, `SessionEntryBase`, `TextContent`, `ImageContent`, `ThinkingContent`, `ToolCallContent`, `AssistantMessage`, `AgentUsage`, `UserMessage` | **100% hand-copied and deliberately divergent** — its `ImageContent` is `{ type: "image", source: { type, media_type, data, url } }`, which is **not** pi-ai's `ImageContent`; its `TextContent` is `{ type: "text", text }` |

**Why this matters for the bump:** these three modules are imported by ~36 files (`lib/types.ts` alone ~30, `lib/api-types.ts` ~20, `lib/pi-types.ts` 5). Because the shapes are copied by hand, **a change in the pi packages produces no compiler error** in any of those consumers — the mirror just silently drifts. The version-specific comments in `lib/pi-types.ts:144` (*"Pi >= 0.86 exposes it as a getter"*) and `:148` show this drift has already required manual maintenance. `lib/pi-types.ts:166` also models `prompt(..., preflightResult?: (success: boolean) => void)`, and `preflightResult` is exercised in 11 places in `lib/rpc-manager-shutdown.test.mjs` (e.g. `:77`, `:264`).

## 5. Value vs type — what breaks when

* **Runtime values (29 pure + 12 mixed statements, 36 files)** — break with `ERR_MODULE_NOT_FOUND` / `is not a function` at server start or on first request: `getAgentDir` (24 refs), `SessionManager` (13), `SettingsManager` (11), `createAgentSessionServices` (4), `createAgentSessionFromServices` (2), `initTheme` (2), `Theme` (2), `DefaultResourceLoader` (3), `DefaultPackageManager` (2), `defineTool` (2), `Type` (2), `parseFrontmatter` (2), `loadSkillsFromDir`, `buildContextEntries`, `convertToLlm`, `createBashToolDefinition`, `createLocalBashOperations`, `resolveModelScopeWithDiagnostics` (2), `getBuiltinProviders`, `getSupportedThinkingLevels`, `normalizeContext`, `completeSimple`, `createAssistantMessageEventStream`, `ModelRuntime` (10), `ProjectTrustStore`, `hasTrustRequiringProjectResources`, `KeybindingsManager as TuiKeybindingsManager`, `TUI_KEYBINDINGS`, `getPackageDir` (dynamic).
* **Type-only (25 statements, 19 files)** — fail `node_modules/.bin/tsc --noEmit` only; the app still runs. Cheapest class to fix, but note `skipLibCheck: true` hides errors *inside* pi's own `.d.ts`.
* **`SessionManager` static API used** (runtime, spread across 13 files): `SessionManager.open` (18 sites), `.create` (8), `.listAll` (4), `.list` (3), `.inMemory` (1); instance: `getEntries` (4), `isPersisted` (3), `getSessionDir` (3), `getCwd` (3), `appendCustomEntry` (3), `getSessionFile` (2), `getEntry` (2), `getBranch` (2), `getSessionName`, `getSessionId`, `getLeafId`, `buildSessionContext`, `appendSessionInfo`.
* **`AgentSession` instance API used** (runtime): `prompt`, `abort`, `steer`, `followUp`, `subscribe`, `dispose`, `reload`, `navigateTree`, `setModel`, `setThinkingLevel`, `setSessionName`, `setAutoCompactionEnabled`, `setAutoRetryEnabled`, `setActiveToolsByName` (2), `getActiveToolNames` (3), `getAllTools`, `getContextUsage`, `getSessionStats`, `getLastAssistantText`, `getSteeringMessages`, `getFollowUpMessages`, `executeBash`, `abortBash`, `bindExtensions` (3), `extensionRunner` (7), `agent` (7), `model` (6), `sessionManager` (9), `sessionId` (5), `sessionFile` (5), `isStreaming` (5), `isCompacting` (4), `isBashRunning` (7), `pendingMessageCount`, `promptTemplates`, `resourceLoader` (2), `settingsManager` (2), `modelRuntime` (3), `supportsThinking`, `thinkingLevel`, `systemPrompt`, plus shutdown-time `shutdown`/`isAlive`/`isRunning`/`destroy`/`hasSuppressedCompletionNotifications`.
* pi-web also implements a **28-command RPC switch** over that API (`lib/rpc-manager.ts:562-985`): `prompt, abort, get_state, set_model, fork, fork_branch, clone, navigate_tree, set_thinking_level, compact, set_session_name, get_session_stats, get_last_assistant_text, set_auto_compaction, clear_queue, steer, follow_up, get_tools, get_commands, set_tools, reload, abort_compaction, extension_ui_response, extension_ui_input, set_auto_retry, bash, abort_bash`.
* **Dynamic imports**: `app/api/sessions/[id]/export/route.ts:23-25` and `:56-57` (`import.meta.resolve`). Six test/bench files load the SDK through `jiti.import("@earendil-works/pi-coding-agent")` (`app/api/sessions/runtime-route.test.mjs:26`, `lib/enabled-models-runtime.test.mjs:25`, `lib/session-list-scanner.bench.mjs:12`, `lib/session-list-scanner.test.mjs:10`, `lib/session-reader.test.mjs:22`, `lib/session-stats.test.mjs:7`).
* No `require()` of a pi package anywhere; no `monkey-patching` of pi objects at runtime (the only prototype access is in tests, D5).

## 6. Top 10 riskiest coupling points (ranked)

| # | risk | site | why |
|---|---|---|---|
| 1 | Export-HTML patch of pi's private template | `app/api/sessions/[id]/export/route.ts:124-215` (+`:135`, `:143-148`, `:166-170`, `:184-191`) | exact-string replacement of `sortChildren`/`mapNodes`/`markActive` from `dist/core/export-html/template.js`; **throws** on any mismatch, and no test can see it coming |
| 2 | pi `dist/` layout + CLI flag hardcoded | `app/api/sessions/[id]/export/route.ts:49,57,64-68,220,236` | depends on `dist/cli.js`, `--export`, `dist/core/export-html/index.js`, `getPackageDir()` |
| 3 | Session-creation option bags | `lib/rpc-manager.ts:2025-2060` + `:2101-2110`; duplicated `lib/subagent-runtime.ts:178,240`; `lib/model-runtime.ts:20` | ~13 option keys (`resourceLoaderOptions.{noExtensions,noSkills,noPromptTemplates,noThemes,noContextFiles,systemPrompt,systemPromptOverride,appendSystemPrompt,extensionFactories,extensionsOverride}`, `excludeTools`, `scopedModels`, `tools`, ...); already broke once at v0.68.0 (comment `lib/rpc-manager.ts:1986`) |
| 4 | `Theme` subclass + `ConstructorParameters` casts + pi-tui keybindings | `lib/rpc-manager.ts:3,174-200,1989` | extends an SDK class, casts its constructor tuple, instantiates `TuiKeybindingsManager(TUI_KEYBINDINGS)`; type-level only until an extension actually renders |
| 5 | `agent.state.*` internals (esp. assigned `thinkingLevel`) | `lib/rpc-manager.ts:278,695-697,821,1802`; `lib/subagent-runtime.ts:156`; `hooks/useAgentSession.ts:1194,2038` | unstructured escape hatch; `:821` **writes** `agent.state.thinkingLevel`; `systemPrompt` semantics already changed at 0.86 |
| 6 | Private `AgentSession` prototype surface pinned by tests | `lib/rpc-manager-extension-ui.test.mjs:20-23` (`_tryExecuteExtensionCommand`), `:24-28` (`_extensionRunner`); used at `lib/rpc-manager.ts` `extensionRunner` x7, `bindExtensions` x3 | underscore-private names; a rename breaks tests and extension-command dispatch |
| 7 | Event-union structural dissection | `lib/agent-event-wire.ts:1-119` (consumers `lib/agent-event-stream.ts:5`, `lib/agent-event-connection.ts:1`, `lib/streaming-message.ts:1,9`, `hooks/useAgentSession.ts:25`) | `Extract<JsonAgentSessionEvent, {type:...}>` on `message_update`/`toolcall_start`; reads `partial.content[i]`, `block.id ?? block.toolCallId` |
| 8 | Exact-prompt contract | `lib/exact-system-prompt.ts:1,8-13` | only supported host hook (`before_agent_start` returning `{ systemPrompt }`); paired with the `agent.state.systemPrompt` reads at `lib/rpc-manager.ts:695` and `hooks/useAgentSession.ts:1194,2038` |
| 9 | Version read + non-bundled externals | `next.config.ts:9-10`, `:26-34`; `package.json:45-48` | hardcoded `node_modules/@earendil-works/pi-coding-agent/package.json` path; `serverExternalPackages` requires the new packages' own transitive deps (e.g. `chord`, `pi-telemetry`, `@anthropic-ai/sdk`, `openai`) to be installable and flat-resolvable |
| 10 | pi-tui cursor marker + `pi-ai/providers/all` + `/compat` | `lib/ansi.ts:3`; `lib/enabled-models-runtime.ts:3`; `app/api/models-config/test/route.ts:5` | invisible-string coupling (no import at all) plus a wildcard subpath (`dist/providers/all.js`) and a module literally named *compat* |

**Runner-up (11-15):** `lib/pi-types.ts:130-204` hand-written `AgentSessionLike` (mirror drift, no compiler error); `lib/plugin-updates.ts:5-9` + `app/api/plugins/route.ts:4-11` (`DefaultPackageManager`, `PackageSource`/`ResolvedPaths`/`ResolvedResource` — package-manager internals); `lib/session-title.ts:3` (`normalizeContext` + `getSupportedThinkingLevels`); `lib/project-command-env.ts:1` (`createBashToolDefinition`, `createLocalBashOperations`); `lib/skills-service.ts:1` + `lib/project-trust.ts:1` (`DefaultResourceLoader`, `ProjectTrustStore`, `hasTrustRequiringProjectResources`); `lib/ask-extension.ts:1` / `lib/subagent-extension.ts:1` (`Type` from pi-ai is a **runtime value**).

## 7. Confirmed negatives (things that make the bump cheaper)

* **No `chord`, no `pi-telemetry`** anywhere in pi-web source — 0 hits; they are only transitive deps and are not in `package.json`.
* **No use of the unstable `pi-coding-agent` subpaths** `/client`, `/experimental/plugin`, `/rpc-entry`.
* **No use of `pi-agent-core` runtime values** — 8 files, all `import type` (`ThinkingLevel`, `AgentMessage`, `Agent`).
* **`pi-tui` is touched by exactly one source file** (`lib/rpc-manager.ts:3`, `KeybindingsManager`/`TUI_KEYBINDINGS`) plus `next.config.ts`/`package.json`. The `lib/ansi.ts` cursor-marker regex is the only other pi-tui dependency and it has no import.
* **`components/*.tsx` have no pi imports** — only two comments (`components/ChatInput.tsx:363`, `components/MessageView.tsx:373`, both about the pi-ai on-disk format). Client components consume pi data through `lib/types.ts` / `lib/agent-event-wire.ts` mirrors.
* **Zero hits** in `bin/`, `scripts/`, `docs/`, `.github/`, `e2e/`, `hooks/` (directly), `public/`.
* **No `transpilePackages`, no tsconfig `paths`** for pi packages — pi-web is a pure `dist/` consumer, so a bump cannot break a `src/` build.
* **No runtime monkey-patching** of pi classes; `AgentSession.prototype` is only read in a test harness.

## 8. What this implies for a 0.87.1 -> 1.4.0 bump

1. The typecheck (`node_modules/.bin/tsc --noEmit`) covers only ~19 type-only files plus the mixed ones; **`skipLibCheck: true` means it will not validate pi's own `.d.ts`**, and the ~36 files that import those hand-written mirrors (`lib/types.ts`, `lib/pi-types.ts`, `lib/api-types.ts` and their importers) get **no compiler signal at all**. A runtime smoke test of `/api/sessions`, `/api/models`, extension UI and export is mandatory, not optional.
2. The export route (`app/api/sessions/[id]/export/route.ts`) should be treated as **expected to break** and re-derived against the 1.4.0 `template.js` / `dist` layout.
3. `createAgentSessionServices` / `createAgentSessionFromServices` option bags (`lib/rpc-manager.ts:2025`, `:2101`; `lib/subagent-runtime.ts:178`, `:240`) are the single biggest source of runtime breakage across the app; `node_modules/.bin/tsc --noEmit` will catch removed keys only because they are passed as object literals to a typed function.
4. `@earendil-works/pi-ai/providers/all` (`lib/enabled-models-runtime.ts:3`) and `@earendil-works/pi-ai/compat` (`app/api/models-config/test/route.ts:5`) must be re-verified against the new `exports` map first — they are the only subpath dependencies.
5. Add `chord` / `pi-telemetry` to the review checklist: they are invisible in `package.json` today but will be installed by the new pi packages, and `serverExternalPackages` (`next.config.ts:26-34`) does not list them.

---

## Appendix — complete import inventory

Legend: **bold** = runtime value, `type X` = type-only import, MIXED = one statement carrying both. Line numbers are the first line of the statement; multi-line import blocks are expanded upward to their `import {` line. Config rows are de-duplicated: `next.config.ts:26-34` and `package.json:45-48` are each listed once per package table because a single statement references all four packages.

#### pi-coding-agent — source + config (50 statements)

| file:line | kind | imported symbols (value / type) |
|---|---|---|
| `app/api/models-config/test/route.ts:6` | VALUE | **`ModelRuntime`** |
| `app/api/models/enabled/route.ts:3` | MIXED | **`getAgentDir`**, **`SettingsManager`**, `type ModelRuntime` |
| `app/api/models/route.ts:3` | MIXED | **`createAgentSessionServices`**, **`getAgentDir`**, `type SettingsManager` |
| `app/api/plugins/route.ts:4-11` | MIXED | **`DefaultPackageManager`**, **`getAgentDir`**, **`SettingsManager`**, `type PackageSource`, `type ResolvedPaths`, `type ResolvedResource` |
| `app/api/project-trust/route.ts:4` | VALUE | **`getAgentDir`** |
| `app/api/sessions/[id]/auto-name/route.ts:2` | TYPE | `type AgentSession` |
| `app/api/sessions/[id]/context/route.ts:2` | VALUE | **`SessionManager`** |
| `app/api/sessions/[id]/export/route.ts:23-25` | DYN | **dynamic** — async function getPiPackageDir(): Promise<string \| null> { try { const { getPackageDir } = (await import("@earendil-works/pi-coding-agent")) as PiCodi |
| `app/api/sessions/[id]/export/route.ts:56-57` | DYN | **dynamic** — if (typeof resolver === "function") { const indexUrl = await resolver("@earendil-works/pi-coding-agent"); |
| `app/api/sessions/[id]/route.ts:4` | VALUE | **`SessionManager`** |
| `app/api/skills/install/route.ts:2` | VALUE | **`getAgentDir`** |
| `app/api/skills/route.ts:5` | VALUE | **`getAgentDir`** |
| `lib/agent-event-wire.ts:1` | TYPE | `type JsonAgentSessionEvent` |
| `lib/api-types.ts:1` | TYPE | `type ResourceDiagnostic` |
| `lib/ask-extension.ts:2-6` | MIXED | **`defineTool`**, `type InlineExtension`, `type LoadExtensionsResult` |
| `lib/enabled-models-runtime.ts:5-9` | MIXED | **`resolveModelScopeWithDiagnostics`**, **`SettingsManager`**, `type ModelRuntime` |
| `lib/exact-system-prompt.ts:1` | TYPE | `type InlineExtension` |
| `lib/http-dispatcher.ts:5` | VALUE | **`getAgentDir`** |
| `lib/model-catalog-refresh.ts:1` | TYPE | `type ModelRuntime` |
| `lib/model-discovery-auth.ts:4` | VALUE | **`ModelRuntime`** |
| `lib/model-runtime.ts:1-5` | MIXED | **`createAgentSessionServices`**, **`getAgentDir`**, `type ModelRuntime` |
| `lib/model-scope.ts:2-6` | MIXED | **`resolveModelScopeWithDiagnostics`**, `type ModelRuntime`, `type ScopedModel` |
| `lib/models-config-store.ts:3` | VALUE | **`getAgentDir`** |
| `lib/pi-types.ts:1-8` | TYPE | `type AgentSessionEvent`, `type BashOperations`, `type SessionManager`, `type SettingsManager`, `type SlashCommandInfo`, `type Theme` |
| `lib/plugin-updates.ts:5-9` | VALUE | **`DefaultPackageManager`**, **`getAgentDir`**, **`SettingsManager`** |
| `lib/powershell-settings.ts:3` | VALUE | **`getAgentDir`** |
| `lib/project-command-env.ts:1-8` | MIXED | **`createBashToolDefinition`**, **`createLocalBashOperations`**, **`getAgentDir`**, `type BashOperations`, `type InlineExtension`, `type LoadExtensionsResult` |
| `lib/project-trust.ts:1` | VALUE | **`hasTrustRequiringProjectResources`**, **`ProjectTrustStore`** |
| `lib/provider-credential-store.ts:4` | VALUE | **`getAgentDir`** |
| `lib/provider-listing-runtime.ts:1` | TYPE | `type ModelRuntime` |
| `lib/rpc-manager.ts:2` | VALUE | **`createAgentSessionFromServices`**, **`createAgentSessionServices`**, **`getAgentDir`**, **`initTheme`**, **`SessionManager`**, **`SettingsManager`**, **`Theme`** |
| `lib/rpc-manager.ts:20` | TYPE | `type SlashCommandInfo` |
| `lib/session-list-scanner.ts:10` | VALUE | **`getAgentDir`** |
| `lib/session-reader.ts:1-4` | VALUE | **`SessionManager`**, **`getAgentDir`** |
| `lib/session-title.ts:12` | TYPE | `type AgentSession` |
| `lib/session-tool-selection.ts:1` | TYPE | `type SessionManager` |
| `lib/skill-frontmatter.ts:1` | VALUE | **`parseFrontmatter`** |
| `lib/skills-service.ts:1` | VALUE | **`DefaultResourceLoader`**, **`getAgentDir`** |
| `lib/startup-preferences.ts:2` | TYPE | `type SettingsManager` |
| `lib/subagent-extension.ts:2-7` | MIXED | **`defineTool`**, `type ExtensionContext`, `type InlineExtension`, `type LoadExtensionsResult` |
| `lib/subagent-runtime.ts:2-10` | MIXED | **`createAgentSessionFromServices`**, **`createAgentSessionServices`**, **`getAgentDir`**, **`initTheme`**, **`SessionManager`**, **`SettingsManager`**, `type ModelRuntime` |
| `lib/subagent-settings.ts:3` | VALUE | **`getAgentDir`** |
| `lib/subagents.ts:2` | VALUE | **`getAgentDir`** |
| `lib/usage-balances.ts:17` | VALUE | **`getAgentDir`** |
| `lib/usage-stats.ts:18` | VALUE | **`getAgentDir`** |
| `lib/web-push.ts:1` | VALUE | **`SessionManager`** |
| `lib/web-themes.ts:3` | VALUE | **`getAgentDir`** |
| `next.config.ts:9-10` | CFG | _(reads `node_modules/@earendil-works/pi-coding-agent/package.json` → `NEXT_PUBLIC_PI_VERSION`, emitted at `next.config.ts:85`)_ |
| `next.config.ts:26-34` | CFG | _(`serverExternalPackages` lists `pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`)_ |
| `package.json:45-48` | CFG | _(exact pins: all four pi packages at `0.87.1`)_ |

#### pi-coding-agent — tests/bench (14 statements)

| file:line | kind | imported symbols (value / type) |
|---|---|---|
| `app/api/sessions/runtime-route.test.mjs:26` | TEST | _(test harness — const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");…)_ |
| `lib/enabled-models-runtime.test.mjs:25` | TEST | _(test harness — const { SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");…)_ |
| `lib/project-command-env.test.mjs:4-8` | TEST | _(test harness — import { DefaultResourceLoader, createLocalBashOperations, getAgentDir, } from "@earendil-works/pi-coding-agen…)_ |
| `lib/project-trust.test.mjs:7` | TEST | _(test harness — import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";…)_ |
| `lib/provider-credential-store.test.mjs:8` | TEST | _(test harness — import { ModelRuntime } from "@earendil-works/pi-coding-agent";…)_ |
| `lib/rpc-manager-extension-ui.test.mjs:3` | TEST | _(test harness — import { AgentSession } from "@earendil-works/pi-coding-agent";…)_ |
| `lib/rpc-manager.test.mjs:6` | TEST | _(test harness — import { SessionManager } from "@earendil-works/pi-coding-agent";…)_ |
| `lib/session-list-scanner.bench.mjs:12` | TEST | _(test harness — const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");…)_ |
| `lib/session-list-scanner.test.mjs:10` | TEST | _(test harness — const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");…)_ |
| `lib/session-reader.test.mjs:22` | TEST | _(test harness — const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");…)_ |
| `lib/session-stats.test.mjs:7` | TEST | _(test harness — const { buildContextEntries } = await jiti.import("@earendil-works/pi-coding-agent");…)_ |
| `lib/session-title.test.mjs:4` | TEST | _(test harness — import { convertToLlm } from "@earendil-works/pi-coding-agent";…)_ |
| `lib/skill-frontmatter.test.mjs:6` | TEST | _(test harness — import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";…)_ |
| `lib/startup-preferences.test.mjs:6` | TEST | _(test harness — import { SettingsManager } from "@earendil-works/pi-coding-agent";…)_ |

#### pi-ai — source + config (12 statements)

| file:line | kind | imported symbols (value / type) |
|---|---|---|
| `app/api/auth/login/[provider]/route.ts:1` | TYPE | `type AuthEvent`, `type AuthPrompt` |
| `app/api/models/enabled/route.ts:4` | TYPE | `type Api`, `type Model` |
| `app/api/models/route.ts:4` | VALUE | **`getSupportedThinkingLevels`** |
| `lib/ask-extension.ts:1` | VALUE | **`Type`** |
| `lib/enabled-models-runtime.ts:4` | TYPE | `type Api`, `type Model` |
| `lib/model-scope.ts:7` | TYPE | `type Api`, `type Model` |
| `lib/pi-types.ts:10` | TYPE | `type ImageContent`, `type TextContent` |
| `lib/provider-credential-store.ts:3` | TYPE | `type Credential` |
| `lib/session-title.ts:3-11` | MIXED | **`getSupportedThinkingLevels`**, **`normalizeContext`**, `type Api`, `type AssistantMessage`, `type Context`, `type Model`, `type SimpleStreamOptions` |
| `lib/subagent-extension.ts:1` | VALUE | **`Type`** |
| `next.config.ts:26-34` | CFG | _(`serverExternalPackages` lists `pi-ai`)_ |
| `package.json:45-48` | CFG | _(exact pin `0.87.1`)_ |

#### pi-ai — tests (2 statements)

| file:line | kind | imported symbols (value / type) |
|---|---|---|
| `lib/ask-extension.test.mjs:4-5` | TEST | _(test harness — /** * The extension module imports `@earendil-works/pi-ai` / `-pi-coding-agent` for…)_ |
| `lib/session-title.test.mjs:3` | TEST | _(test harness — import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";…)_ |

#### pi-agent-core — source + config (10 statements)

| file:line | kind | imported symbols (value / type) |
|---|---|---|
| `app/api/agent/new/route.ts:2` | TYPE | `type ThinkingLevel` |
| `lib/model-scope.ts:1` | TYPE | `type ThinkingLevel` |
| `lib/pi-types.ts:9` | TYPE | `type AgentMessage as PiAgentMessage` |
| `lib/rpc-manager.ts:1` | TYPE | `type ThinkingLevel` |
| `lib/session-title.ts:2` | TYPE | `type Agent`, `type AgentMessage`, `type ThinkingLevel` |
| `lib/startup-preferences.ts:1` | TYPE | `type ThinkingLevel` |
| `lib/subagent-runtime.ts:1` | TYPE | `type ThinkingLevel` |
| `lib/subagents.ts:1` | TYPE | `type ThinkingLevel` |
| `next.config.ts:26-34` | CFG | _(`serverExternalPackages` lists `pi-agent-core`)_ |
| `package.json:45-48` | CFG | _(exact pin `0.87.1`)_ |

#### pi-tui — source + config (3 statements)

| file:line | kind | imported symbols (value / type) |
|---|---|---|
| `lib/rpc-manager.ts:3` | VALUE | **`KeybindingsManager as TuiKeybindingsManager`**, **`TUI_KEYBINDINGS`** |
| `next.config.ts:26-34` | CFG | _(`serverExternalPackages` lists `pi-tui`)_ |
| `package.json:45-48` | CFG | _(exact pin `0.87.1`)_ |
