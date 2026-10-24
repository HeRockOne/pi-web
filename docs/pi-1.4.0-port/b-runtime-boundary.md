# B. Runtime / Process Boundary: pi-web vs embedded pi coding agent

Scope: task-2. Question answered: what breaks even when TypeScript still compiles.
Method: static inspection of pi-web source (read-only) + byte-level comparison of the
published 0.87.1 and 1.4.0 tarballs extracted at
C:/Users/Sophia/AppData/Local/Temp/pi-upgrade/tarballs
(packages: @earendil-works/pi-coding-agent, pi-ai, pi-agent-core, pi-tui).
No install, build or test was run (repo is read-only for this scout); every claim below is
backed by file:line in pi-web or by a d.ts / compiled-JS comparison in the tarballs.

## 0. Headline

The pi agent is NOT a child process. pi-web imports the four pi packages **in-process** as ESM
and drives an AgentSession object through its own HTTP/SSE layer. Consequences:

- There is no CLI argv, no stdio JSONL framing, no rpc-entry protocol, no version handshake.
- pi-web's "RPC" (lib/rpc-manager.ts:561-993) is pi-web's own command vocabulary, not pi's
  upstream RPC mode (dist/modes/rpc/rpc-mode.js exists upstream but is unused here).
- Therefore an upgrade is a **library API + runtime-semantics** upgrade, not a process
  protocol upgrade. TypeScript catches renames; it does NOT catch changed callback semantics
  (see risk H1) or changed on-disk write timing (H2).

Verified absence (repo-wide grep, excluding node_modules/.next/.git):
- "@earendil-works/pi-coding-agent/rpc-entry": 0 hits
- "@earendil-works/pi-coding-agent/client": 0 hits
- "@earendil-works/pi-coding-agent/experimental/plugin": 0 hits
- "pi-telemetry", "chord": 0 hits
- spawn/exec of a "pi" binary: 0 hits

## 1. HOW the agent is started

In-process import, no spawn:
- lib/rpc-manager.ts:25 comment: startRpcSession() creates an AgentSession in-process.
- docs/ARCHITECTURE.md:9-22 diagram: Browser -> Next.js Server -> AgentSession (in-process);
  POST /api/agent/[id] -> startRpcSession() -> createAgentSession(); SSE events ->
  session.subscribe().
- lib/rpc-manager.ts:1940-2164 startRpcSession:
  - :1961-1964  SessionManager.open(sessionFile, undefined) or SessionManager.create(cwd, undefined)
  - :1989       initTheme() (skipped when chatOnly)
  - :1990       agentDir = getAgentDir()
  - :2017       SettingsManager.create(sessionCwd, agentDir)
  - :2025-2069  createAgentSessionServices({cwd, agentDir, settingsManager,
                resourceLoaderOptions:{noExtensions,noSkills,noPromptTemplates,noThemes,
                noContextFiles,systemPrompt,systemPromptOverride,appendSystemPrompt,
                extensionFactories}, extensionsOverride, resourceLoaderReloadOptions})
  - :2064-2066  extensionsOverride = preferUserBashExtension(preferPiWebAskExtension(
                preferPiWebSubagentExtension(base)))
  - :2101-2109  createAgentSessionFromServices({services, sessionManager, model?,
                thinkingLevel?, scopedModels?, tools?: string[], excludeTools?})
  - :2131       inner.setActiveToolsByName(withExtensionTools(inner, selectedToolNames ?? inner.getActiveToolNames()))
  - :1993 comment: since v0.68.0 session creation expects string[] tool names instead of Tool[] instances.

The only spawned process in the server is Next.js itself:
- bin/pi-web.js:5-10 node-version gate (bin/node-version.js:3 MIN_NODE_VERSION = "22.19.0");
  :48 require.resolve("next/dist/bin/next");
  :84-88 spawn(process.execPath, [nextBin, "start", "-p", port, "-H", hostname], env with
  PI_WEB_HOSTNAME, stdio ["inherit","pipe","inherit"]).
- bin/prepare-terminal.js:1-14 postinstall chmod of node-pty spawn-helper (darwin only).

Other subprocesses are unrelated to the agent:
- lib/node-cli.ts:25-66 + lib/npx.ts:24-30: npm/npx run as process.execPath +
  node_modules/npm/bin/<name>-cli.js (Windows npm.cmd cannot be spawned shell-less since
  Node 20.12 / CVE-2024-27980). Used by lib/plugin-updates.ts and lib/skill-updates.ts
  ("npx skills add ... --agent pi").
- lib/terminal-manager.ts:80-90 spawns the user's SHELL (win32 ComSpec / $SHELL -l), not pi.
- lib/file-index.ts, lib/git-changes.ts, lib/worktree.ts: git/file helpers only.

Import style that the upgrade must preserve: all four pi packages are "type":"module" with
main ./dist/index.js and are statically imported from pi-web's TS (Next compiles them);
pi-web's own package.json has no "type":"module" (bin/*.js stay CJS).

## 2. RPC / event protocol pi-web assumes

Two layers, both pi-web-owned.

### 2a. Command layer (HTTP POST /api/agent/[id])
- lib/agent-client.ts:32 POST /api/agent/{encodeURIComponent(sessionId)}, JSON body;
  response {success:true,data} or {error,code,accepted}.
- lib/agent-client.ts:22-26 isPromptRejectedError: code === "prompt_rejected" && accepted === false.
- Command type strings dispatched in AgentSessionWrapper.send()
  (lib/rpc-manager.ts:561-993): prompt, steer, follow_up, get_state, get_session_stats,
  get_last_assistant_text, get_tools, get_commands, set_tools, reload, abort_compaction,
  extension_ui_response, extension_ui_input, set_auto_retry, bash, abort_bash, navigate_tree,
  set_thinking_level, compact, set_session_name, set_auto_compaction, clear_queue, fork, clone.
  default: throw new Error("Unsupported command: " + type) at :992.
- SESSION_REPLACEMENT_COMMAND_TYPES = Set(["fork","clone"]) (:153);
  COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT (:154-162);
  shouldWaitForExtensions(type) = prompt|steer|follow_up|get_commands|get_state (:409-415).

### 2b. Event layer (SSE GET /api/agent/[id]/events)
- pi-web subscribes with session.subscribe(listener) (docs/ARCHITECTURE.md:22).
- Event names pi-web keys on:
  - IDLE_RESET_EVENT_TYPES = Set(["agent_end","agent_settled","auto_compaction_end","compaction_end"])
    (lib/rpc-manager.ts:123-128)
  - agent_settled -> notifyAgentRunCompleteIfIdle (lib/rpc-manager.ts:309);
    hooks/useAgentSession.ts:1204 case "agent_settled", :1232 completion transition
  - compaction_start AND auto_compaction_start both handled
    (hooks/useAgentSession.ts:1371-1372; docs/ARCHITECTURE.md:148-149)
  - prompt_done / agent_start / agent_settled semantics: docs/ARCHITECTURE.md:151-155
- Wire projection lib/agent-event-wire.ts:
  - :26-29 OMITTED_EVENT_TYPES = Set(["turn_start","turn_end"]) -> toClientAgentEvent returns null
  - :58-62 isSystemMessageEvent drops message_start/message_end whose message.role === "system"
    (comment: Pi >= 0.86 appends prompt + tool loadout as system messages)
  - :65-110 toClientAgentEvent; :35-55 message_update projection (drops "partial", injects
    {id, toolName} from partial.content[contentIndex] block.type === "toolCall",
    id from block.id|block.toolCallId, name from block.name|block.toolName);
    tool_execution_update -> {type, toolCallId, toolName, partialResult}; agent_end -> {type}
  - :112-119 isEventIncludedInSnapshot
- SSE framing lib/agent-event-stream.ts:101-103 ("data: " + JSON.stringify(data) + "\n\n"),
  heartbeat ":" comment every HEARTBEAT_INTERVAL_MS = 30_000 (:15,:177);
  envelope events {type:"connected",sessionId,isStreaming} (:146-150),
  {type:"startup_error",errorMessage:"Failed to start agent: ..."} (:158-161),
  {type:"message_start",message:snapshot} (:153), {type:"session_shutdown"} -> cleanup(true) (:122-124).
- Client side lib/agent-event-connection.ts:144-157: JSON.parse(message.data); expects
  "connected" (ready) and "startup_error" (errorMessage).
- Extension UI round-trip: extension_ui_response / extension_ui_input commands + uiContext
  (lib/pi-types.ts:99-128).

## 3. Session .jsonl schema pi-web assumes

Docs: docs/SESSION-FORMAT.md:8 location ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl;
:11 header {"type":"session","version":3,"id","timestamp","cwd","parentSession"};
:12-17 model_change{provider,modelId}, message{role}, compaction{summary,firstKeptEntryId,tokensBefore},
session_info{name}; :20 entryIds[] parallel to messages[].

Code:
- lib/types.ts:1 "Types mirrored from pi-mono coding-agent session-manager";
  :4-11 SessionHeader {type:"session", version?, id, timestamp, cwd, parentSession?};
  :13-18 SessionEntryBase {type,id,parentId,timestamp};
  :246-338 entry union: message, thinking_level_change, model_change, usage, compaction,
  branch_summary, custom, custom_message, label, session_info, context_edit.
- Message roles lib/types.ts:53-133: user, assistant, toolResult, custom, bashExecution, system
  (SystemMessage has sections?: Record<string,string|null>, toolsAdded?, toolsRemoved? --
  Pi >= 0.86 prompt/tool-loadout transcript messages, never rendered).
- Tool call shape mismatch: file format {type:"toolCall",id,name,arguments} vs
  ToolCallContent {type:"toolCall",toolCallId,toolName,input,rawInput?} (lib/types.ts:42-49),
  normalized by lib/normalize.ts normalizeToolCalls() (docs/ARCHITECTURE.md:131-132).
- lib/session-reader.ts:397-406 header must be first JSON line with type === "session";
  :20 SESSION_HEADER_MAX_BYTES = 64*1024; :413-421 getLatestModelChange;
  :423-446 getSessionSettings; :540-567 sliceActiveBranch (parentId walk);
  :644-707 entryToUiMessage (message, compaction, branch_summary, custom_message; system -> null);
  :249-299 findSessionPathById (filename suffix "_" + sessionId + ".jsonl").
- lib/session-list-scanner.ts:111-115 header check; :41,:224-226 index file
  <agentDir>/pi-web-session-index.json version 1 (size+mtimeMs fingerprint);
  :298-372 listSessionsIncremental; :359-363 comment "Since pi 0.86 the SDK reads files
  newest-mtime first".
- Write paths: lib/rpc-manager.ts:472-490 persistBashOnlySession writes
  [manager.getHeader(), ...manager.getEntries()] JSON lines with flag "wx" and sets
  manager.flushed = true; :1843-1896 getRpcSessionInfos reads getHeader()/getEntries()/getSessionName().
- lib/session-path.ts:3-11 sessionPathKey (win32 normalize+lowercase).
- pi-web custom entry types: "pi-web:tool-selection" (docs/ARCHITECTURE.md:135),
  SUBAGENT_META_TYPE / SUBAGENT_RESULT_TYPE appended via sessionManager.appendCustomEntry
  (lib/subagent-runtime.ts:235, :335), appendSessionInfo (:236).

Upstream 0.87.1 vs 1.4.0 on-disk compatibility:
- SESSION_VERSION = 3 in BOTH (dist/core/session-manager.d.ts).
- SessionEntry union byte-identical; SessionManager class + getHeader/getEntries/getSessionName/
  getCwd/buildSessionContext/appendCustomEntry/appendSessionInfo/open/create unchanged.
- 1.4.0 ONLY addition of note: a new session file is created only once the session contains a
  user or assistant message (setup entries stay in memory; upstream issue #10000); private
  _hasConversation and new getEntryCount() were added. See risk H2.

## 4. Extension / plugin / hook APIs pi-web installs or consumes

pi-web injects InlineExtension factories (all hidden:true) through resourceLoaderOptions.extensionFactories:
- lib/ask-extension.ts: HOST_ASK_EXTENSION_NAME "pi-web-ask", path "<inline:pi-web-ask>";
  pi.registerTool(defineTool({name:"ask", executionMode:"sequential", parameters: Type.Object(...),
  execute(toolCallId, params, signal, onUpdate, ctx) uses ctx.hasUI})) (:35-116);
  preferPiWebAskExtension removes legacy "pi-ask" owners (:124-150).
- lib/subagent-extension.ts: HOST_SUBAGENT_EXTENSION_NAME "pi-web-subagents";
  registers "Agent" (executionMode:"parallel"), get_subagent_result, steer_subagent;
  LEGACY_SUBAGENT_PACKAGE_NAME "pi-subagents".
- lib/project-command-env.ts: HOST_EXTENSION_NAME "pi-web-project-command-environment";
  registers a bash tool built from createBashToolDefinition + createProjectCommandBashOperations
  wrapping createLocalBashOperations ({exec(command,cwd,executionOptions)}), injects
  <agentDir>/bin into PATH and sanitizes env (:27-113); preferUserBashExtension (:115-132).
- lib/exact-system-prompt.ts: only supported host prompt override is
  pi.on("before_agent_start", () => ({systemPrompt})) (:26-29); agent.state.systemPrompt is
  read-only and replayed from persisted system messages since 0.86.
- lib/chat-only.ts:6-18 CHAT_ONLY_RESOURCE_LOADER_OPTIONS.

Consumed runner/UI contracts:
- lib/rpc-manager.ts:349-394 ensureExtensionsBound -> inner.bindExtensions({uiContext,
  mode:"rpc", commandContextActions, shutdownHandler, onError}); fallback
  inner.extensionRunner.setUIContext?.(uiContext,"rpc") at :384.
- lib/rpc-manager.ts:888-915 get_commands uses extensionRunner.getRegisteredCommands(),
  inner.promptTemplates, inner.resourceLoader.getSkills();
  :1037-1040 and :1066 emit {type:"session_shutdown",reason:"quit"}.
- lib/pi-types.ts:80-88 ExtensionRunnerLike; :99-128 ExtensionUiContextLike (select/confirm/
  input/editor/notify/onTerminalInput/setStatus/setWorkingMessage/setWorkingVisible/
  setWorkingIndicator/setHiddenThinkingLabel/setWidget/setFooter/setHeader/setTitle/custom/
  pasteToEditor/setEditorText/getEditorText/addAutocompleteProvider/setEditorComponent/
  getEditorComponent/theme/getAllThemes/getTheme/setTheme/getToolsExpanded/setToolsExpanded).
- lib/custom-ui-terminal.ts:28 createHeadlessCustomUiTui(requestRender, 92, 40) headless TUI shim.
- lib/pi-types.ts:75-78 ResourceLoaderLike (getSkills, getAgentsFiles).
- Skills/plugins: lib/skills-service.ts:17 new DefaultResourceLoader + reload(projectTrustReloadOptions)
  + getSkills(); lib/plugin-updates.ts DefaultPackageManager; lib/project-trust.ts:23-48 trust gate
  (hasTrustRequiringProjectResources, ProjectTrustStore) -- docs/ARCHITECTURE.md:177-182.
- lib/subagent-runtime.ts:2-10 imports createAgentSessionServices/FromServices, SessionManager,
  SettingsManager, ModelRuntime, getAgentDir, initTheme; uses
  parent.inner.sessionManager.buildSessionContext() (:109), SessionManager.create(cwd, undefined,
  {parentSession}) (:214), inner.sendCustomMessage(..., {deliverAs:"followUp", triggerTurn:true}) (:384-389).
- Telemetry: none. pi-ai 1.4.0 pulls @earendil-works/pi-telemetry@1.4.0 transitively; pi-web makes
  no telemetry calls. lib/usage-stats.ts reads <agentDir>/analytics/usage.jsonl produced by an
  external pi-tracker extension, not by pi-web.

1.4.0 extension-API delta that matters:
- ExtensionUIContext, ExtensionContext (head), ExtensionBindings, ExtensionMode,
  ExtensionAPI.on overloads for before_agent_start, defineTool, registerTool: unchanged.
- ToolDefinition gains optional outputSchema/exposure/namespace/reachesTools/annotations/defaultActive
  (exposure defaults to "direct", so pi-web tools stay model-visible).
- execute() ctx widened ExtensionContext -> ExtensionToolContext (superset: adds tools, executeTool).
- InlineExtension gains optional replaceable/builtin only.
- NEW built-in extensions exist upstream: llama.cpp, codemode, tool-search, mcp. They are injected
  by the CLI (chunk-MM3LKT73.js: extensionFactories = [...builtInExtensions, ...options.extensionFactories]),
  and DefaultResourceLoader only treats a factory with builtin === true as a built-in
  (isBuiltinExtension: typeof input != "function" && input.builtin === true). pi-web's inline
  extensions have no builtin flag, so they stay normal factories; pi-web's loader therefore has an
  EMPTY builtin map, and any user settings entry "builtin:mcp" would surface
  "Unknown built-in extension: builtin:mcp" (loadExtensionPaths). See M2.
- Removed upstream subpaths (unused by pi-web): pi-coding-agent ./client and ./experimental/plugin;
  pi-agent-core ./node and all ./harness/* (tarball shrank 994KB -> 62KB). pi-web imports only the
  package root for both.

## 5. Node / platform assumptions

- Node floor does NOT move: all four pi packages have engines {"node":">=22.19.0"} in 0.87.1 AND
  1.4.0; pi-web package.json:14-16 engines node >=22.19.0; bin/node-version.js:3 MIN_NODE_VERSION
  "22.19.0".
- pi-web pins the four packages exactly (no caret) at "0.87.1" (package.json:45-48);
  node-pty "1.2.0-beta.15" (:56); next 16.3.6 (:55); postinstall node bin/prepare-terminal.js (:31);
  test script uses node --experimental-strip-types --test (:40).
- Module format: all four pi packages "type":"module", main ./dist/index.js; pi-web has no
  "type":"module" (bin/*.js CJS). Static ESM named imports from TS compiled by Next.
- Verified export surfaces in 1.4.0: pi-coding-agent exports "." and "./rpc-entry";
  pi-ai exports ".", "./models" (new), "./compat", "./providers/*", "./api/*", "./utils/*",
  "./oauth", "./bedrock-provider", "./bun-oauth"; pi-agent-core ".", "./package.json";
  pi-tui has no exports map (subpaths open).
- Subpaths pi-web actually uses still work in 1.4.0: pi-ai/compat exports completeSimple and
  AssistantMessage; pi-ai/providers/all exports getBuiltinProviders; pi-coding-agent root exports
  getPackageDir (used via dynamic import in app/api/sessions/[id]/export/route.ts:25).
- Agent dir: PI_CODING_AGENT_DIR env var handled identically in both versions
  (dist/config.js getAgentDir: process.env[ENV_AGENT_DIR] -> expandTildePath, else
  homedir()/CONFIG_DIR_NAME/agent).
- NEW transitive deps in pi-coding-agent 1.4.0 (install/platform risk on Windows):
  @earendil-works/pi-codemode@1.4.0, @earendil-works/pi-mcp@1.4.0, quickjs-wasi@3.6.2 (WASM),
  @silvia-odwyer/photon-node@0.3.4 (native image lib), chalk@6.0.0 (ESM-only), minimatch@10.2.6,
  jiti@2.7.0, cross-spawn@7.0.6, undici@8.10.2, typebox@1.3.27, grok-mermaid@0.2.3,
  highlight.js@10.7.3, hosted-git-info@9.0.3, ignore@7.0.8, diff@8.0.4, yaml@2.9.0.
  pi-ai 1.4.0 deps include @earendil-works/pi-telemetry@1.4.0, openai@7.19.0,
  @anthropic-ai/sdk@0.129.0, @google/genai@2.21.0, @aws-sdk/client-bedrock-runtime@3.1127.0.
- lib/http-dispatcher.ts:184 installs pi-web's own global undici Dispatcher (patches globalThis.fetch)
  and is independent of pi's HTTP stack; DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000 (:7).

## 6. Ranked boundary points

### HIGH

H1. preflightResult boolean -> PromptDisposition (silent runtime behavior change)
- pi-web: lib/rpc-manager.ts:612-614 preflightResult: (success) => { if (success) acceptPreflight(); };
  declared lib/pi-types.ts:166 as (success: boolean) => void.
- 0.87.1 runtime: preflightResult?.(true) is called only in the two no-run branches
  (extension command handled; input handler swallowed the prompt) plus true on accept.
- 1.4.0 runtime: preflightResult?.("handled") in those two branches, "queued" when queued during
  streaming, "started" when a run begins (dist/core/agent-session.js, bundle chunk-MM3LKT73.js);
  upstream rpc-mode.js does not test truthiness: preflightResult: (disposition) => { preflightSucceeded = true; ... }.
- Impact: every disposition is a non-empty string, so pi-web's if (success) is ALWAYS true.
  acceptPreflight() (lib/rpc-manager.ts:582-588) sets preflightAccepted = true and
  agentRunNeedsCompletion = true and resolves the POST admission promise. For a "handled" prompt
  (extension command such as /clear, or an input handler that swallowed the message) no agent run
  will ever start, yet pi-web now waits for completion bookkeeping that only clears on
  agent_settled (lib/rpc-manager.ts:309) with the idle reset at :599.
- TypeScript cannot catch this: the callback param is typed in pi-web's own local interface and is
  a string at runtime.
- Existing tests encode the old contract and will need updating:
  lib/rpc-manager.test.mjs:278 (options.preflightResult?.(true)),
  lib/rpc-manager.test.mjs:448 (assert.match on the literal source
  "preflightResult: (success) => { ... if (success) acceptPreflight();"),
  lib/rpc-manager-shutdown.test.mjs:77,114,197,217,238,264,296,306,343,348,378.
- Fix shape: treat only "started" (and deliberately "queued") as accepted; do not set
  agentRunNeedsCompletion for "handled".

H2. Session file is no longer created eagerly (#10000)
- pi-web creates a session and immediately treats sessionFile as real:
  lib/rpc-manager.ts:1961-1964 SessionManager.create/open; :472-490 persistBashOnlySession writes
  the file itself with flag "wx" and forces manager.flushed = true;
  :1843-1896 getRpcSessionInfos reads getHeader()/getEntries();
  lib/session-list-scanner.ts:298-372 + lib/session-reader.ts:249-299 assume the .jsonl exists
  to be discovered/read; export route app/api/sessions/[id]/export/route.ts:25 reads it.
- 1.4.0 dist/core/session-manager.d.ts: a new session file is created only once the session
  contains a user or assistant message (setup entries stay in memory; private _hasConversation).
- Impact: chat-only / bash-only / freshly created sessions can have no file until a real message
  lands; anything that stats or opens sessionFile right after creation can see a missing path, and
  persistBashOnlySession's "wx" write plus flushed = true assumption needs re-verification.
- Fix shape: verify create/open + first-message write ordering under 1.4.0; add a test that
  creates a session, runs a bash-only flow, then reads the file.

### MEDIUM

M1. Tool inventory and tool-selection semantics widen.
- lib/rpc-manager.ts:202-213 withExtensionTools unions resolveShellTools(toolNames,
  settingsManager.getDefaultTools()) with every non-coding name from session.getAllTools();
  lib/tool-presets.ts:24 BUILTIN_TOOL_NAMES = PRESET_FULL + "powershell".
- 1.4.0 adds AgentSessionConfig.usesDefaultTools/defaultToolModifiers, allows patterns in
  allowedToolNames/excludedToolNames, adds settings-manager DEFAULT_TOOL_NAMES,
  isToolModifier/getToolListError/applyToolModifiers (+name/-name syntax), and new tool
  exposures. Any MCP/codemode/tool-search tool that becomes visible flows into pi-web's active
  tool set and its persisted "pi-web:tool-selection" entry (docs/ARCHITECTURE.md:135).
- Action: re-run tool-list UI/preset tests against 1.4.0; confirm the model-facing tool list is
  unchanged for a default install.

M2. Built-in extensions and "builtin:" paths.
- pi-web's DefaultResourceLoader has an empty builtin map (only factories with builtin === true
  register as builtins; pi-web passes none), so upstream built-ins llama.cpp/codemode/tool-search/mcp
  do not load through pi-web -- but a shared ~/.pi/agent settings file written by the pi CLI
  (which injects builtInExtensions in main()) can contain "builtin:mcp", and pi-web's
  loadExtensionPaths then reports "Unknown built-in extension: builtin:mcp".
- Also lib/rpc-manager.ts:2064-2066 conflict-replacement helpers (preferPiWebAskExtension,
  preferPiWebSubagentExtension, preferUserBashExtension) predate the new replaceable flag.

M3. New native/WASM transitive dependencies.
- pi-coding-agent 1.4.0 adds quickjs-wasi 3.6.2 and @silvia-odwyer/photon-node 0.3.4 (native),
  plus chalk 6 (ESM-only) and the two new @earendil-works/pi-codemode/pi-mcp packages.
- Risk: install/build failures or slow first run on Windows; all four pi packages must be bumped
  together (they pin each other at exact 1.4.0) or npm will duplicate pi-ai/pi-agent-core.

M4. Theme constructor typing (compile-time only, runtime absorbed).
- lib/rpc-manager.ts:174-197 PlainTextTheme extends Theme and passes its colors through
  as ConstructorParameters<typeof Theme>[0]/[1] with mode "truecolor".
- 1.4.0 changes the constructor types (fgColors/bgColors are now Pick of ThemeColorValues,
  ColorMode renamed TerminalColorMode, pi-tui Color replaces RgbColor) while all five token keys
  pi-web passes (muted, text, thinkingXhigh, searchMatchText, selectedBg) still exist in
  THEME_TOKENS (57 keys). Theme methods pi-web overrides are unchanged.

### LOW

L1. Every named import still resolves. Programmatic check of the repo's 51 named imports:
  pi-coding-agent 32 names, pi-ai 14, pi-agent-core 3, pi-tui 2 -- 0 missing in 1.4.0.
L2. AgentSession public API: 0 removed / 0 changed; only routedModel() and getCallableToolNames() added.
L3. Session layer: SESSION_VERSION 3 both, SessionEntry union byte-identical, SessionManager API unchanged.
L4. agent-session-services.d.ts identical -> createAgentSessionServices/createAgentSessionFromServices
  option shapes unchanged; DefaultResourceLoaderOptions additive only (new disabledBuiltinExtensions).
L5. resolveModelScopeWithDiagnostics, ModelRuntime (additive), initTheme, SlashCommandInfo,
  JsonAgentSessionEvent, createBashToolDefinition, createLocalBashOperations, BashOperations,
  getAgentDir, DefaultPackageManager, getPackageDir all unchanged/present.
L6. Event additions are additive: agent_settled gains required aborted (pi-web never reads it) and
  events are wrapped with parentToolCallId (pi-web's projection builds explicit objects and drops it).
L7. pi-web's model compat hack is still valid: lib/rpc-manager.ts:814-825 checks
  inner.model.compat?.thinkingFormat === "deepseek"; "deepseek" is still in the 1.4.0 union.
L8. Node floor, ESM/CJS split, node-pty postinstall and the npm/npx invocation workaround are unaffected.
L9. Removed subpaths (pi-coding-agent ./client, ./experimental/plugin; pi-agent-core ./harness/*, ./node)
  are not referenced anywhere in pi-web.

## 7. Residual unknowns / recommended verification

- Everything above is static (d.ts + compiled-JS reading). Recommended dynamic checks after a
  scratch install of 1.4.0: tsc --noEmit; the rpc-manager suites
  (lib/rpc-manager.test.mjs, lib/rpc-manager-shutdown.test.mjs) which currently assert the old
  preflightResult shape; a bash-only/chat-only session file test for H2; and a smoke run of the
  agent-new -> prompt -> SSE flow to confirm tool list, commands list and event names.
- Not examined dynamically: how ExtensionToolContext behaves for pi-web's ask/subagent tools
  (expected safe: superset type), and whether any pi-web behaviour depends on the 0.87.1
  preflight boolean meaning "no run started".
- pi-web's own docs to update on any bump: docs/ARCHITECTURE.md:148-153 (event generations),
  docs/SESSION-FORMAT.md (unchanged for version 3, but the eager-file note is worth adding).
