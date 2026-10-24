# C — Upstream diff: installed 0.87.1 → candidate 1.4.0

Owner: teammate `upstream-diff` · shared task `task-3` · date 2026-10-23
Scope: what actually changed in the four embedded `@earendil-works` packages between the installed 0.87.1 and the candidate 1.4.0.
This file contains **no host-usage assessment** (which pi-web call sites use which symbol) — that belongs to the sibling scout tasks.

## 0. Method and evidence classes

DETERMINISTIC (tarball-verified). Everything below marked [T] was read out of the published npm tarballs:
- `npm pack @earendil-works/<pkg>@<ver>` into `C:\Users\Sophia\AppData\Local\Temp\pi-upgrade\tarballs`, extracted to `earendil-works-<pkg>-<ver>\package\` for pi-coding-agent, pi-ai, pi-agent-core, pi-tui at **0.87.1** and **1.4.0**.
- Files inspected: `package.json`, `dist/index.d.ts` + every `dist/**/*.d.ts` (file inventory + named/star export sets), `CHANGELOG.md`, `README.md`, `docs/`, `files` field.
- Registry: `npm view <pkg> dist-tags --json`, `npm view <pkg>@<ver> dependencies --json`, and the intermediate-version probes 0.99.0/0.99.1/0.99.2/1.0.0–1.0.4/1.1.0/1.2.0/1.3.0.

UNVERIFIED (web). `pi.dev/changelog/releases/1.0.0` and web-search hits are used **only** for the semver narrative in section 7 and are labelled there. No breaking-change claim in section 8 rests on a web source.

Caveat: the tarball is authoritative for the published surface. A locally installed `node_modules` copy can differ from the tarball (the `files` allowlist changed), so do not treat `node_modules` as ground truth.

## 1. Version table

| package | installed | newest at the 1.4.0 line | published at 1.4.0 | engines (both versions) | tarball size 0.87.1 → 1.4.0 |
|---|---|---|---|---|---|
| @earendil-works/pi-coding-agent | 0.87.1 | **1.4.0** | yes | node >=22.19.0 | 7 329 151 → 7 612 554 B |
| @earendil-works/pi-ai | 0.87.1 | **1.4.0** | yes | node >=22.19.0 | 838 330 → 836 597 B |
| @earendil-works/pi-agent-core | 0.87.1 | **1.4.0** | yes | node >=22.19.0 | 994 229 → **62 440 B** (harness subtree deleted) |
| @earendil-works/pi-tui | 0.87.1 | **1.4.0** | yes | node >=22.19.0 | 593 797 → 527 191 B |

Registry facts [T]:
- `dist-tags` for all six `@earendil-works` packages (pi-coding-agent, pi-ai, pi-agent-core, pi-tui, pi-telemetry, chord) are `latest=1.4.0`. The first four also carry `legacy-node20=0.74.2` (irrelevant: pi-web requires node >=22.19.0).
- **Newest common version across all four = 1.4.0. No fallback to an older common version is needed.**
- 1.4.0 pulls two **new runtime packages** into the tree: `@earendil-works/pi-mcp@1.4.0` and `@earendil-works/pi-codemode@1.4.0` (both first appeared in 0.99.0), plus `quickjs-wasi@3.6.2` and `brace-expansion@5.0.12`.
- Version chain 0.87.1 → 1.4.0: 0.99.0, 0.99.1, 0.99.2, 1.0.0, 1.0.1, 1.0.2, 1.0.3, 1.0.4, 1.1.0, 1.2.0, 1.3.0, 1.4.0.
- **node engines floor is unchanged at node >=22.19.0 in every one of the four packages at every version from 0.87.1 to 1.4.0.** [T]

## 2. package.json diffs (0.87.1 → 1.4.0) [T]

### pi-coding-agent
- `bin`: `{ "pi": "dist/bundle/cli.js" }` — unchanged.
- `exports`: 0.87.1 = `".", "./rpc-entry", "./client" (source: ./src/client/index.ts), "./experimental/plugin" (source: ./src/experimental/plugin.ts)` → 1.4.0 = `".", "./rpc-entry"` **only**. `./client` and `./experimental/plugin` are gone.
- `files`: dropped `npm-shrinkwrap.json`; added `schemas`. 1.4.0 ships `schemas/keybindings.schema.json`, `models.schema.json`, `settings.schema.json`, `theme.schema.json`.
- `dependencies`: removed `@earendil-works/chord`; added `@earendil-works/pi-codemode@1.4.0`, `@earendil-works/pi-mcp@1.4.0`, `quickjs-wasi@3.6.2`, `brace-expansion@5.0.12`.
- `devDependencies`: dropped `@earendil-works/pi-client`, `pi-protocol`, `pi-server`.
- Build: 1.4.0 `build:unbundled` uses `tsc -p tsconfig.build.json` (0.87.1 used `tsgo`).
- `repository`: `git+https://github.com/earendil-works/pi.git`, `directory: packages/coding-agent`; MIT; author Mario Zechner.

### pi-ai
- `exports`: gained `"./models"` → `{ types: ./dist/models.d.ts, import: ./dist/models.js }`.
- `dependencies`: `@anthropic-ai/sdk` 0.124.0 → 0.129.0; `openai` 6.40.0 → 7.19.0; `@earendil-works/pi-telemetry` ^0.87.1 → 1.4.0. (Two transitive **major** bumps: openai 6 → 7.)
- `sideEffects` unchanged.

### pi-agent-core
- `exports`: 0.87.1 = `".", "./node", "./harness/context", "./experimental/pico3", "./harness/env/nodejs", "./harness/runtime/reducer", "./harness/session", "./harness/session/testing", "./package.json"` → 1.4.0 = `".", "./package.json"` **only**.
- `dependencies`: 0.87.1 = `{ @earendil-works/chord ^0.87.1, @earendil-works/pi-ai ^0.87.1, @earendil-works/pi-telemetry ^0.87.1, diff 8.0.4, ignore 7.0.8, typebox 1.3.27, yaml 2.9.0 }` → 1.4.0 = `{ @earendil-works/pi-ai 1.4.0, typebox 1.3.27 }` only.

### pi-tui
- No `exports` map; `main` `dist/index.js` and `types` `./dist/index.d.ts` unchanged.
- `dependencies`: gained `marked-cjk-friendly@0.1.2`.

## 3. Public API diff — dist/index.d.ts [T]

### pi-coding-agent — purely additive at the root
0 named exports removed; **25 added**: RegisteredMcpServer, QuietStartup, formatReadLineRange, ModelRoute, ModelRouteReason, ModelRouteRequest, VIRTUAL_MODEL_STATE_ENTRY, VirtualModelDefinition, VirtualModelStateData, CodemodeExtensionOptions, createCodemodeExtension, CodemodeStoreEntryData, CodemodeToolDetails, LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry, createMcpExtension, McpExtensionOptions, McpTransportFactory, createToolSearchExtension, ThemeAppearance, ThemeBg, ThemeStyle, ThemeToken.
New module re-exports: `core/mcp-servers.ts`, `core/virtual-models.ts`, `core/tools/render-utils.ts`, `extensions/codemode/{index,tool}.ts`, `extensions/mcp/{config,index}.ts`, `extensions/tool-search/index.ts`.
d.ts count 216 → 251.

### pi-ai — additive at the root, but two star-exported modules deleted
- star re-exports REMOVED: `./images-models.ts`, `./utils/assistant-message-frame.ts`. ADDED: `./utils/identity.ts`.
- named ADDED: `PI_AI_VERSION` (from `./utils/version.ts`). index.d.ts still 36 lines.
- The removed modules' symbols are gone from the whole 1.4.0 dist (grep over all `*.d.ts`, zero hits): `ImagesProvider`, `ImagesModels`, `MutableImagesModels`, `createImagesModels`, `AssistantMessageFrame`, `AssistantMessageFrameEncoder`, `reduceAssistantMessageFrames`.
- `types.d.ts` named-export set is IDENTICAL in both versions (no message/event type renames).
- d.ts count 182 → 200.

### pi-agent-core — the big one
- star re-exports REMOVED (12): `./harness/agent-harness.ts`, `./harness/context.ts`, `./harness/messages.ts`, `./harness/prompt-templates.ts`, `./harness/result.ts`, `./harness/session/index.ts`, `./harness/skills.ts`, `./harness/system-prompt.ts`, `./harness/tools/index.ts`, `./harness/utils/shell-output.ts`, `./harness/utils/truncate.ts`, `./search/index.ts`.
- **122 named exports REMOVED, 0 added.** Representative groups: `uuidv7` (pi-ai re-export); all telemetry types + `createTypedSpanStarter`/`defineTelemetrySchema`/`InMemoryTelemetryContext`/`NOOP_TELEMETRY_CONTEXT`; `BranchPreparation`/`BranchSummaryResult`/`collectEntriesForBranchSummary`/`generateBranchSummary`/`prepareBranchEntries`; `CompactionPreparation`/`CompactResult`/`compact`/`estimateContextTokens`/`estimateTokens`/`findCutPoint`/`generateSummary`/`generateSummaryWithUsage`/`shouldCompact`/`serializeConversation`; `AgentHarness*` types; `BranchSummaryError`/`CompactionError`/`ExecutionEnv`/`ExecutionError`/`FileError`/`FileSystem`/`Shell`/`Skill`/`err`/`ok`/`toError`/`getOrThrow`/`getOrUndefined`; `applyShellOutputUpdate`; `LaneSnapshotReduction`/`reduceLaneSnapshot`; `AiSpan`/`HarnessSpan` telemetry schema consts.
- `index.d.ts` 27 lines → **5 lines**: it now re-exports only `./agent.ts`, `./agent-loop.ts`, `./proxy.ts`, `setDefaultStreamFn`, `./types.ts`.
- `types.d.ts` named-export set IDENTICAL in both versions.
- d.ts count 116 → **6**.

### pi-tui
- named REMOVED: `parseOsc11BackgroundColor`.
- 34 ADDED: backgroundAnsi, Color, ColorMixSpace, colorToHex, colorToOkhsl, colorToOklch, colorToRgb, foregroundAnsi, IndexedColor, indexedColor, mixColors, OkhslChannels, OklchChannels, OklchColorValue, okhslColor, oklchColor, parseColor, RgbColorValue, rgbColor, styleText, styleTextWithAnsi, TerminalColorMode, TextAttributes, TextStyle, ImageTranscoder, setImageTranscoder, oklabToOkhslLightness, formatProgramStatus, ProgramStatus, isAppleTerminalSession, TerminalColors, getTerminalColorMode, renderFakeCursor, WheelScrollLines.
- d.ts count 42 → 46.

## 4. d.ts file-inventory deltas [T]

- **pi-coding-agent** removed: `core/provider-attribution.d.ts`, `modes/interactive/components/daxnuts.d.ts`, `modes/interactive/theme/theme-json.d.ts`. Added: `core/{client-identity,key-id-schema,keybindings-schema,mcp-servers,nested-tool-calls,settings-defaults,settings-schema,virtual-models}.d.ts`, `extensions/codemode/*` (execute, execute.lazy, index, renderer, tool, worker), `extensions/mcp/*` (cli, cli.lazy, config, index, log, oauth, resources, runtime, runtime.lazy, tools, ui), `extensions/tool-search/{index,tool}`, `modes/interactive/components/{auth-url,easter-egg-3d,easter-egg-3d.lazy,pi-logo,radius-login-selector,themed-text}`, `modes/interactive/program-status-reporter`, `theme/{system-theme,theme-schema,theme-tokens}`, `utils/output-files`.
- **pi-ai** removed: `auth/oauth/oauth-page`, `image-models.generated`, `images-models`, `providers/azure-openai-responses(+.models)`, `providers/openrouter-images`, `utils/assistant-message-frame`, `utils/pi-user-agent`. Added: `api/{azure-openai-config,classifier-shared,cloudflare-workers-ai-system-one(+.lazy),llama-cpp-classify(+.lazy),openai-decisions(+.lazy),system-one-shared,typesafe-system-one(+.lazy)}`, `auth/oauth/{callback-server,openai-chatgpt}`, `providers/{azure,azure.models,compat-schema,model-schema,openrouter-api,typesafe,typesafe.models}`, `telemetry`, `utils/{identity,model-operations,models-error,oauth-page,version}`.
- **pi-agent-core** removed the ENTIRE `harness/` tree: `harness/agent-harness`, `harness/compaction/*`, `config`, `context`, `env/nodejs`, `events`, `execution/*`, `hooks`, `messages`, `pico3/*` (~20 files), `prompt-templates`, `result`, `runtime/*` incl. `runtime/drive/*`, `session/*` incl. `jsonl/*` and `testing/*`, `skills`, `system-prompt`, `telemetry`, `tools/*`, `types`, `utils/*`; plus `dist/node.d.ts` and `dist/search/index.d.ts`. **Nothing added** — only `agent`, `agent-loop`, `proxy`, `stream-fn`, `types` remain.
- **pi-tui** added `colors.d.ts`, `oklab.d.ts`, `program-status.d.ts`, `wheel-scroll.d.ts`.

## 5. Session format and RPC entry — stable [T]

- `CURRENT_SESSION_VERSION = 3` in **both** 0.87.1 and 1.4.0 → the on-disk `.jsonl` session format version is unchanged. Existing sessions remain loadable.
- `migrations.d.ts` exports the same 4 functions in both: `migrateAuthToAuthJson`, `migrateSessionsFromAgentRoot`, `showDeprecationWarnings`, `runMigrations`.
- `dist/bundle/rpc-entry.js` is still shipped, `./rpc-entry` is still in `exports`, and `rpc-entry.d.ts` is byte-identical in both (it contains only `export {}`) → **the RPC entry path is stable across the whole chain**.
- `session-manager.d.ts` 406 → 415 lines: ADDED `SessionManager.getEntryCount(): number`; ADDED private `_hasConversation` (a session file is only created once the session holds a user/assistant message; setup-only entries stay in memory — issue #10000). No removals.
- `settings-manager.d.ts` 346 → 250 lines: the settings type definitions MOVED into a new `./settings-schema.ts`. `settings-manager` still re-exports `BranchSummarySettings`, `CacheWarmingMode`, `CodemodeMode`, `CodemodeSettings`, `CompactionModelOverride`, `CompactionSettings`, `DefaultProjectTrust`, `FullscreenExitOutput`, `ImageSettings`, `MarkdownSettings`, `MermaidRenderingMode`, `PackageSource`, `ProviderRetrySettings`, `QuietStartup`, `RetrySettings`, `SessionShareDestination`, `Settings`, `TerminalSettings`, `ThinkingBudgetsSettings`, `TransportSetting`, `TuiMode`, `WarningSettings`; ADDED `CACHE_WARMING_MODES`, `DEFAULT_TOOL_NAMES`, `isToolModifier(entry)`.
- `core/sdk.d.ts`: `CreateAgentSessionOptions.tools` is now an allowlist of names OR `*` patterns; a list containing only `+name`/`-name` entries acts as modifiers on `defaultTools` (mixing modifiers with plain entries throws); `excludeTools` accepts patterns; MCP tools stay registered for codemode/tool_search unless an entry starts with `mcp__`.
- `core/agent-session.d.ts`: `AgentSessionEvent.agent_settled` gains a **required** `aborted: boolean`; `tool_execution_start/update/end` gain optional `parentToolCallId`; `PromptOptions.preflightResult` now receives `PromptDisposition` (`"handled" | "queued" | "started"`) **instead of a boolean**; `AgentSessionConfig` gains `usesDefaultTools` and `defaultToolModifiers`; `allowedToolNames`/`excludedToolNames` accept patterns.

## 6. Version-chain step attribution [T]

| step | what it introduced |
|---|---|
| 0.99.0 | pi-coding-agent gains `quickjs-wasi@3.6.2` + `@earendil-works/pi-mcp@^0.99.0` + `pi-codemode@^0.99.0`; codemode/tool_search/MCP become built-in extensions; virtual models; system theme (new default); `provider_stream_event` extension event; `ctx.executeTool()` nested calls with `parentToolCallId`; `+name/-name` defaultTools entries. Build switched from the TypeScript native preview to TypeScript 7.0 / ES2024. |
| 1.0.0 | **pi-agent-core loses the entire harness subtree**, the `chord` + `pi-telemetry` + `diff` + `ignore` + `yaml` deps, and all harness subpath exports (only `"."` + `"./package.json"` remain). Default TUI mode becomes fullscreen. MCP OAuth credentials stored per server name+URL. |
| 1.0.1 | pi-coding-agent adds `brace-expansion@5.0.12` (GHSA advisory); `npm-shrinkwrap.json` removed from the published package. |
| 1.2.0 | pi-coding-agent **removes `./client` and `./experimental/plugin`** exports, removes `@earendil-works/chord`, removes the `pi-client`/`pi-protocol`/`pi-server` devDeps. |
| 1.3.0 | internal pi deps switch from `^x` ranges to **exact pins** (`pi-ai`/`pi-mcp`/`pi-tui`/`pi-codemode`/`pi-agent-core` `"1.3.0"`). |
| every step | `engines: node >=22.19.0` unchanged. |

## 7. Semver story — was 0.99 → 1.0 an intentional breaking release?

Deterministic [T]:
- The `CHANGELOG.md` shipped inside the pi-coding-agent 1.4.0 tarball (6 365 lines) has a `### Breaking Changes` section for **only two versions in the whole 0.87.1 → 1.4.0 range**: **1.2.0** (line 115) and **1.0.3** (line 250). Section headings inside the range (lines 3–507) are: 1.4.0 (3) New Features/Added/Changed/Fixed; 1.3.0 (59) same; 1.2.0 (105) New Features/**Breaking**/Added/Changed/Fixed/**Removed**; 1.1.0 (168); 1.0.4 (220); 1.0.3 (243) New Features/**Breaking**/Added/Changed/Fixed; 1.0.2 (268); 1.0.1 (278) New Features/Added/Changed/Fixed/**Removed**; 1.0.0 (322) New Features/Added/Changed/Fixed — **no Breaking and no Removed**; 0.99.2 (368); 0.99.1 (408); 0.99.0 (426).
- No migration guide ships in the tarball. `docs/` contains no `migration`/`upgrade` document; the string "migrat" appears only in `docs/mcp.md` and `docs/session-format.md`, unrelated to package upgrades. `README.md` has no upgrade section.
- Therefore, from the package's own release notes, **0.99 → 1.0 was not announced as a breaking release**. Yet pi-agent-core 1.0.0 did delete its whole published harness surface (see section 6 and BC1–BC3). The version numbers are therefore **not a reliable guide**: the real breakage is in the pi-agent-core package surface, not in the coding-agent changelog.

UNVERIFIED (web, not from the tarball):
- `https://pi.dev/changelog/releases/1.0.0` mirrors the 1.0.0 changelog section exactly (New Features / Added / Changed / Fixed, no breaking section); it frames 1.0.0 as a milestone ("Fullscreen by default", "Leaner codemode", "Image generation in codemode", "MCP OAuth hardening"). This supports, but does not prove, "milestone 1.0, not a breaking release".
- A third-party post (`developersdigest.tech/blog/pi-1-0-release-guide-mcp-codemode-pi-durable`) was found by search but could not be fetched (network error); treat any claim from it as unverified.
- The upstream repo `github.com/earendil-works/pi` resolves (HTTP 200) and DeepWiki has an index for it (topics incl. "Agent Loop and Agent Core (pi-agent-core)", "Durable Harness API (packages/durable)", "Chord Replication Runtime (packages/chord)"). I did **not** use DeepWiki prose as evidence for any diff above.

## 8. Breaking-change list (0.87.1 → 1.4.0), with evidence

| # | step | change | evidence (file + symbol) | class |
|---|---|---|---|---|
| BC1 | 1.0.0 | pi-agent-core `exports` shrinks from 9 subpaths to 2 (`"."`, `"./package.json"`); `./node`, `./harness/*`, `./experimental/pico3` all gone | pi-agent-core `package.json` `exports` | import path break |
| BC2 | 1.0.0 | pi-agent-core root entry loses **122 named exports** and 12 star re-export modules; `index.d.ts` 27 → 5 lines | pi-agent-core `dist/index.d.ts` | symbol break |
| BC3 | 1.0.0 | pi-agent-core drops `chord`, `pi-telemetry`, `diff`, `ignore`, `yaml` deps | pi-agent-core `package.json` `dependencies` | transitive/dep break |
| BC4 | 1.2.0 | pi-coding-agent `exports` drops `./client` and `./experimental/plugin` | pi-coding-agent `package.json` `exports` | import path break (published-tarball impact nil: see note) |
| BC5 | 1.2.0 | pi-coding-agent drops `@earendil-works/chord`; devDeps `pi-client`/`pi-protocol`/`pi-server` gone | pi-coding-agent `package.json` | dep break |
| BC6 | 1.0.1 | `npm-shrinkwrap.json` removed from the published package → transitive deps of pi-coding-agent are no longer pinned for npm installs | pi-coding-agent `files` + CHANGELOG 1.0.1 `### Removed` (line 318) | supply-chain/behavior |
| BC7 | 1.2.0 | `before_agent_start` also fires for `pi.sendMessage(..., { triggerTurn: true })` runs; `BeforeAgentStartEvent` is now a union on `messageType` (`"user"` carries `prompt`+`images`, `"custom"` carries `message` and no `prompt`); handlers must check `event.messageType === "user"`. Session also counts as busy during `before_agent_start`: `ctx.isIdle()` is false, `pi.sendMessage()` queues, `pi.sendUserMessage()` requires `deliverAs` | CHANGELOG 1.2.0 `### Breaking Changes` (lines 115–119); type in pi-coding-agent `dist/extensions/...` / `core/agent-session.d.ts` | runtime/type break |
| BC8 | 1.2.0 | Themes are now schema-validated at startup; theme `$schema` moved to `https://pi.dev/schemas/theme.schema.json`; reusable colors must move under `vars`; unsupported metadata rejected | CHANGELOG 1.2.0 `### Breaking Changes` (line 117) | config-file break |
| BC9 | 1.0.3 | Azure provider renamed `azure-openai-responses` → `azure`; rename the key in `auth.json`, `models.json` and `settings.json` (`defaultProvider`, `enabledModels` patterns, `modelThinkingLevels` keys). Old-provider sessions fall back to another model on resume and lose prompt cache. `AZURE_OPENAI_*` env vars unchanged | CHANGELOG 1.0.3 `### Breaking Changes` (line 250–252) | config break |
| BC10 | ≤0.99 | pi-ai deletes `images-models` and `utils/assistant-message-frame`: `ImagesProvider`, `ImagesModels`, `MutableImagesModels`, `createImagesModels`, `AssistantMessageFrame`, `AssistantMessageFrameEncoder`, `reduceAssistantMessageFrames` gone from the whole dist | pi-ai `dist/index.d.ts` star re-exports + grep over `dist/**/*.d.ts` | symbol break |
| BC11 | ≤1.4.0 | pi-tui removes `parseOsc11BackgroundColor` (replaced by the new `TerminalColors`/`getTerminalColorMode`/`parseColor` API) | pi-tui `dist/index.d.ts` named exports | symbol break |
| BC12 | 1.4.0 | `generateSummary()` / `generateSummaryWithUsage()` **ignore** their `reserveTokens` parameter (summary requests use the model output limit) | CHANGELOG 1.4.0 `### Changed` (line 24) | behavioral |
| BC13 | 1.4.0 | Provider attribution headers now come from pi-ai client identity; extensions' `before_provider_headers` no longer see OpenRouter / NVIDIA NIM / OpenCode attribution headers (returning `null` still removes one) | CHANGELOG 1.4.0 `### Changed` (line 21) | behavioral |
| BC14 | 1.3.0 | `kimi-coding` provider now uses OpenAI Chat Completions at `https://api.kimi.com/coding/v1`; `models.json` overrides of the `kimi-coding` base URL must now include `/v1` | CHANGELOG 1.3.0 `### Changed` (line 74) | config break |
| BC15 | 1.4.0 | `AgentSessionEvent.agent_settled` gains a **required** `aborted: boolean`; `PromptOptions.preflightResult` now receives `PromptDisposition` instead of a `boolean` | pi-coding-agent `dist/core/agent-session.d.ts` | type break (source) |
| BC16 | 1.4.0 | pi-ai `dependencies`: `openai` 6.40.0 → **7**.19.0, `@anthropic-ai/sdk` 0.124.0 → 0.129.0 | pi-ai `package.json` | transitive major bump |
| BC17 | 0.99.0 | build moved from the TypeScript native preview to TypeScript 7.0 / ES2024 target | CHANGELOG 0.99.0 `### Changed` (line 463) | toolchain only (no runtime API effect) |

Note on BC4: the 0.87.1 published tarball contains **no `src/` directory** and excludes `dist/client` and `dist/experimental` (its `files` list is dist, docs, examples, containerization.md, CHANGELOG.md, npm-shrinkwrap.json), and both subpaths were declared with a `source` condition only. So `./client` and `./experimental/plugin` were **never resolvable from the published 0.87.1 package** — removing them breaks nothing that worked via npm, but it does break a repo that imported them from a source checkout.

Also changed but **not** breaking for a root-level consumer: pi-coding-agent gains codemode / MCP / tool-search extensions, virtual models, theme tokens and the `schemas/` directory; pi-ai gains `./models` and classifier/azure/typesafe provider modules; pi-tui gains the whole colors API, image transcoding, wheel scroll and program status.

## 9. Compatibility verdict per package

| package | verdict | reason |
|---|---|---|
| pi-coding-agent | **mostly drop-in at the root; needs code change only for the two deleted subpaths and for BC7/BC9/BC15 if the host touches them** | 0 removed root named exports; `./client` + `./experimental/plugin` gone at 1.2.0 (never resolvable from the published tarball); `agent_settled` now requires `aborted`; `preflightResult` callback signature changed |
| pi-ai | **needs code change if the host used images-models or assistant-message-frame; otherwise drop-in** | root named exports purely additive (`PI_AI_VERSION`, `./models`) but 2 star-exported modules and their 7 symbols are gone; openai 6 → 7 is a transitive major |
| pi-agent-core | **needs code change if the host imports anything beyond the bare root** | exports map 9 → 2 subpaths, 122 root exports removed, harness subtree deleted entirely |
| pi-tui | **drop-in unless the host called `parseOsc11BackgroundColor`** | 1 export removed, 34 added, `main`/`types` unchanged |

Cross-cutting: node >=22.19.0 already satisfied (unchanged floor), session `.jsonl` version 3 unchanged, RPC entry stable.

## 10. Residual unknowns / limits of this task

- Whether pi-web actually imports any removed symbol or subpath (`ImagesProvider`, `AssistantMessageFrame*`, `parseOsc11BackgroundColor`, `@earendil-works/pi-agent-core/harness/*`, `pi-coding-agent/client`, `pi-coding-agent/experimental/plugin`) is **not** assessed here — it is host-usage work for the sibling tasks.
- `docs/` grew 39 → 45 files (new: `codemode.md`, `mcp.md`, `models-configuration.md`, `virtual-models.md`, plus the previously existing `packages.md` was rewritten) — this is documentation, not API.
- The `settings-manager` type move (`settings-schema.ts`) keeps re-exports, so it is source-compatible for `import { Settings } from "…"` consumers.
- Not verified by me: whether the upstream repo publishes a separate migration guide outside the npm tarball. Web sources checked (pi.dev changelog 1.0.0 page) showed none.

## 11. Reproduction commands

    cd C:\Users\Sophia\AppData\Local\Temp\pi-upgrade\tarballs
    npm pack @earendil-works/pi-coding-agent@0.87.1 ; npm pack @earendil-works/pi-coding-agent@1.4.0
    npm pack @earendil-works/pi-ai@0.87.1 ; npm pack @earendil-works/pi-ai@1.4.0
    npm pack @earendil-works/pi-agent-core@0.87.1 ; npm pack @earendil-works/pi-agent-core@1.4.0
    npm pack @earendil-works/pi-tui@0.87.1 ; npm pack @earendil-works/pi-tui@1.4.0
    npm view @earendil-works/pi-coding-agent dist-tags --json
    npm view @earendil-works/pi-coding-agent versions --json
    # diff: package.json, dist/index.d.ts export sets, dist/**/*.d.ts file inventory, CHANGELOG.md
