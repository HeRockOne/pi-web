import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type InlineExtension,
  type LoadedMcpConfig,
  type McpServerConfig,
  type McpServerEntry,
  type McpTransportFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { McpAuthRequiredError } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { mcpConfigKey, mcpEntryConfigKey } from "./mcp-config-key";
import { isMcpOverrideEntry, mcpOverrideRefusal } from "./mcp-override";
import { recordMcpStatus } from "./mcp-status";
import { createPiWebMcpTransportFactory } from "./mcp-transport";
import { loadPiSdkInternals, type PiSdkInternals } from "./pi-sdk-internals";
import { hasParentDirectorySegment, isPathWithinRoots, resolveRealRoots } from "./path-security";
import { mayReadProjectConfigNow } from "./project-trust";
import { PROJECT_SETTINGS_MAX_BYTES, readRegularFileText } from "./regular-file";

// The built-in extensions the pi CLI prepends from a module the SDK does not
// export (ADR 0006, "Loading"). Normal sessions load them under the CLI's
// names, so `-builtin:<name>`, project overrides, `noExtensions`, and
// replacement by a third-party extension that registers `/mcp`, `codemode`,
// or `tool_search` behave as in the CLI. Chat-only sessions load none of
// them; a subagent only what its profile turns on.

export const MCP_DISABLE_VARIABLE = "PI_WEB_DISABLE_MCP";

/** How many project entries an untrusted project's session reports, at most. */
const MCP_UNTRUSTED_REPORT_MAX = 100;

/** A project `.pi/mcp.json` larger than this is not parsed for the report. */
const MCP_PROJECT_CONFIG_MAX_BYTES = 1024 * 1024;

export type BuiltinFeatureStatus = { available: true } | { available: false; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the global `mcp.json` from the agent directory. Phase 1 reads no
 * project file: a project's `.pi/mcp.json` runs code from the repository, so
 * it waits for pi-web's project trust gating (upstream ADR 0006). Servers the
 * SDK would reject are reported in `errors` instead of thrown, as the SDK's
 * own loader does.
 */
export function loadGlobalMcpConfig(agentDir: string, readFile: typeof readFileSync = readFileSync): LoadedMcpConfig {
  const path = join(agentDir, "mcp.json");
  let parsed: unknown;
  try {
    const raw = readFile(path, "utf-8");
    parsed = JSON.parse(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { servers: [], errors: [] };
    return {
      servers: [],
      errors: [`mcp.json could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { servers: [], errors: ["mcp.json must hold a JSON object"] };
  }
  const record = parsed as Record<string, unknown>;
  const servers: McpServerEntry[] = [];
  const errors: string[] = [];
  const rawServers = record.mcpServers;
  if (rawServers !== undefined) {
    if (typeof rawServers !== "object" || rawServers === null || Array.isArray(rawServers)) {
      errors.push('mcp.json "mcpServers" must hold a JSON object');
    } else {
      for (const [name, value] of Object.entries(rawServers)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          errors.push(`mcp.json server "${name}" must hold a JSON object`);
          continue;
        }
        const config = value as Record<string, unknown>;
        if (config.command === undefined && config.url === undefined) {
          errors.push(`mcp.json server "${name}" needs a "command" or a "url"`);
          continue;
        }
        servers.push({ name, config: config as unknown as McpServerConfig, source: path, scope: "global" });
      }
    }
  }
  return {
    servers,
    errors,
    ...(typeof record.autoEnableCodemode === "boolean" ? { autoEnableCodemode: record.autoEnableCodemode } : {}),
  };
}

/**
 * Whether the operator turned MCP off for this pi-web process. Read when a
 * session is created, so a restart applies a change.
 */
export function isMcpDisabledByEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const value = environment[MCP_DISABLE_VARIABLE];
  if (value === undefined || value === "") return false;
  return platform === "win32"
    ? !["0", "false"].includes(value.toLowerCase())
    : !["0", "false"].includes(value);
}

/**
 * Whether the operator turned MCP off for the whole server, however it is
 * spelled: any value other than empty, `0`, or `false` counts. A switch
 * that guards a server should not be undone by spelling `yes` instead of
 * `1`. Unlike `isMcpDisabledByEnvironment()` this is platform-independent,
 * as Settings' report of the switch must be.
 */
export function isMcpDisabledByOperator(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[MCP_DISABLE_VARIABLE]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

// ---------------------------------------------------------------------------
// Code mode sandbox self-test
// ---------------------------------------------------------------------------

const SELF_TEST_SCRIPT = "return 6 * 7";
const SELF_TEST_OUTPUT = "42";
const SELF_TEST_TIMEOUT_MS = 10_000;

export interface CodemodeSelfTestOptions {
  timeoutMs?: number;
  /** The codemode tool to run; tests replace it. Defaults to the SDK's. */
  createDefinition?: () => Promise<ToolDefinition>;
}

/**
 * The SDK's codemode tool definition, taken from its public extension factory.
 * Only `registerTool` is used while loading; the stubs cover what a script
 * without tool calls, store writes, or `models` reaches at run time.
 */
async function sdkCodemodeDefinition(): Promise<ToolDefinition> {
  let definition: ToolDefinition | undefined;
  const pi = {
    registerTool: (tool: ToolDefinition) => {
      definition = tool;
    },
    getSettings: () => ({}),
    getAllTools: () => [],
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  await createCodemodeExtension({ models: false })(pi);
  if (!definition) throw new Error("the codemode extension registered no tool");
  return definition;
}

function resultText(result: { content?: readonly { type: string; text?: string }[] }): string[] {
  return (result.content ?? []).flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []));
}

/**
 * Run one script through the SDK's codemode tool, with the QuickJS sandbox in
 * its worker thread exactly as a session runs it. The worker and the wasm file
 * are resolved from the SDK's own files at run time, which a bundled or
 * relocated install can break; when that happens the tool would fail every
 * call, so pi-web does not offer it.
 */
export async function runCodemodeSelfTest(options: CodemodeSelfTestOptions = {}): Promise<BuiltinFeatureStatus> {
  const timeoutMs = options.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the sandbox did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const run = (async () => {
      const definition = await (options.createDefinition ?? sdkCodemodeDefinition)();
      // Without a session context the script reaches no tools, store, or models.
      return await definition.execute("pi-web-self-test", { code: SELF_TEST_SCRIPT }, controller.signal, undefined, undefined as never);
    })();
    // A run that settles after the timeout must not surface as an unhandled rejection.
    run.catch(() => {});
    const result = await Promise.race([run, timedOut]);
    const text = resultText(result);
    if ((result as { isError?: boolean }).isError) {
      return { available: false, reason: `the self-test script failed: ${text.join(" ").trim() || "no output"}` };
    }
    if (!text.some((line) => line.trim() === SELF_TEST_OUTPUT)) {
      return { available: false, reason: `the self-test script returned ${JSON.stringify(text.join(" ").trim())}` };
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

// Hot reload re-evaluates this module; globalThis keeps one self-test per process.
const CODEMODE_SANDBOX_KEY: symbol = Symbol.for("pi-web.codemodeSandbox");

/** The sandbox self-test, run once per server process on the first normal session. */
export function checkCodemodeSandbox(): Promise<BuiltinFeatureStatus> {
  const store = globalThis as Record<symbol, Promise<BuiltinFeatureStatus> | undefined>;
  return (store[CODEMODE_SANDBOX_KEY] ??= runCodemodeSelfTest().then((status) => {
    if (!status.available) console.warn(`[pi-web] Code mode is off: ${status.reason}`);
    return status;
  }));
}

export type CodemodeSandboxPeek = { checked: false } | ({ checked: true } & BuiltinFeatureStatus);

const NOT_SETTLED: unique symbol = Symbol("not settled");

/**
 * The self-test's result once it has settled, without ever starting it: the
 * first normal session runs it, and Settings only reports what it found. A
 * test still running, or not started since the server did, is `checked:
 * false`. A promise that has already settled wins the race against one
 * resolved now, because their reactions run in the order they were attached.
 */
export async function peekCodemodeSandbox(): Promise<CodemodeSandboxPeek> {
  const store = globalThis as Record<symbol, Promise<BuiltinFeatureStatus> | undefined>;
  const pending = store[CODEMODE_SANDBOX_KEY];
  if (!pending) return { checked: false };
  const settled = await Promise.race([pending, Promise.resolve(NOT_SETTLED)]);
  return settled === NOT_SETTLED ? { checked: false } : { checked: true, ...settled };
}

export const BUILTIN_EXTENSION_NAMES = ["codemode", "tool-search", "mcp"] as const;

export type BuiltinExtensionName = typeof BUILTIN_EXTENSION_NAMES[number];

export interface BuiltinExtensionSwitch {
  enabled: boolean;
  /** The settings file whose `extensions` entry turns it off. */
  settingsPath?: string;
  /**
   * What the global settings alone make of it. Present only when a trusted
   * project's `extensions` list was read; otherwise the switch itself is the
   * global answer. A global setting, such as Code mode's Always on, is weighed
   * against this, never against whichever project Settings was opened from.
   */
  global?: { enabled: boolean; settingsPath?: string };
}

/**
 * A settings file's `extensions` list, read as SettingsManager reads it: a
 * byte-order mark is allowed, and a file that does not parse counts as empty.
 * A FIFO or a device there throws instead of blocking the server on a read
 * nothing answers, as does a project file past `PROJECT_SETTINGS_MAX_BYTES`.
 */
function readSettingsExtensions(path: string, maxBytes?: number): string[] | undefined {
  const text = readRegularFileText(path, maxBytes);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  const extensions = typeof parsed === "object" && parsed !== null ? (parsed as { extensions?: unknown }).extensions : undefined;
  return Array.isArray(extensions) ? extensions.filter((entry): entry is string => typeof entry === "string") : undefined;
}

type SettingsScope = "global" | "project";

async function resolveBuiltinSwitches(
  options: { agentDir: string; cwd: string; projectTrusted: boolean },
  lists: Partial<Record<SettingsScope, string[]>>,
  paths: Record<SettingsScope, string>,
): Promise<Record<BuiltinExtensionName, BuiltinExtensionSwitch>> {
  const { agentDir, cwd, projectTrusted } = options;
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock: (scope, fn) => {
      const extensions = lists[scope];
      fn(extensions ? JSON.stringify({ extensions }) : undefined);
    },
  };
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.fromStorage(storage, { projectTrusted }),
    builtinExtensions: [...BUILTIN_EXTENSION_NAMES],
  });
  // Nothing is missing without packages; skip rather than install if that ever changes.
  const resolved = await packageManager.resolve(async () => "skip");
  const switches = {} as Record<BuiltinExtensionName, BuiltinExtensionSwitch>;
  for (const name of BUILTIN_EXTENSION_NAMES) {
    const resource = resolved.extensions.find((extension) => extension.path === `builtin:${name}`);
    const enabled = resource?.enabled ?? true;
    switches[name] = enabled
      ? { enabled }
      : { enabled, settingsPath: resource?.metadata.scope === "project" ? paths.project : paths.global };
  }
  return switches;
}

/**
 * Whether the `extensions` settings leave each built-in on, read from the
 * files as the session's resource loader would: `-builtin:mcp` (or a `!`
 * pattern matching it) in the global settings turns it off, and a matching
 * `+`, `-` or `!` entry in a trusted project's settings overrides that. The
 * SDK's package manager decides, so its pattern rules apply exactly; it is
 * given only the two `extensions` lists, never `packages`, so it cannot
 * install or even look up a package. It still scans the extension, skill,
 * prompt and theme folders it auto-discovers, which only reads them. When a
 * trusted project has a list of its own, the global list is resolved a second
 * time on its own for each switch's `global` answer.
 */
export async function readBuiltinExtensionSwitches(options: {
  agentDir: string;
  /** Without one, only the global settings count. */
  cwd?: string;
  projectTrusted: boolean;
}): Promise<Record<BuiltinExtensionName, BuiltinExtensionSwitch>> {
  const { agentDir } = options;
  const projectTrusted = options.cwd !== undefined && options.projectTrusted;
  const cwd = options.cwd ?? agentDir;
  const paths = {
    global: join(agentDir, "settings.json"),
    project: join(cwd, CONFIG_DIR_NAME, "settings.json"),
  };
  const global = readSettingsExtensions(paths.global);
  // The project file is the repository's, read by a GET: capped, and never a FIFO.
  const project = projectTrusted ? readSettingsExtensions(paths.project, PROJECT_SETTINGS_MAX_BYTES) : undefined;
  const switches = await resolveBuiltinSwitches({ agentDir, cwd, projectTrusted }, { global, project }, paths);
  if (project === undefined) return switches;
  const globalSwitches = await resolveBuiltinSwitches({ agentDir, cwd, projectTrusted: false }, { global }, paths);
  for (const name of BUILTIN_EXTENSION_NAMES) switches[name].global = globalSwitches[name];
  return switches;
}
// ---------------------------------------------------------------------------
// MCP: what a session connects, and what it reports
// ---------------------------------------------------------------------------

/**
 * Whether an error means the server needs the user to sign in: the HTTP
 * transport throws `McpAuthRequiredError` when a server answers 401 and no
 * sign-in can refresh it, and the OAuth flow throws
 * `McpOAuthAuthorizationRequiredError` when the user has to authorize (again)
 * in a browser pi-web never opens.
 */
export function isMcpAuthRequiredError(error: unknown): boolean {
  if (error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError) return true;
  // A duplicate module instance, or a subclass the SDK adds later, still names the class.
  return error instanceof Error && (error.name === "McpAuthRequiredError" || error.name === "McpOAuthAuthorizationRequiredError");
}

/**
 * The project `.pi/mcp.json` entries, read as defensively as the trust
 * decision reads the project: the path may not climb out with `..`, the
 * file may not be a symlink out of the project, and a file that grows while
 * it is read, is not a regular file, or is past 1 MiB counts as nothing. A
 * session reports these names only to say the project is not trusted, so an
 * unreadable file has nothing to report.
 */
export function untrustedProjectServerEntries(cwd: string): [string, unknown][] {
  const path = join(cwd, CONFIG_DIR_NAME, "mcp.json");
  try {
    if (hasParentDirectorySegment(path)) return [];
    const realPath = realpathSync(path);
    if (!isPathWithinRoots(realPath, resolveRealRoots(new Set([cwd])))) return [];
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
    const fd = openSync(realPath, flags);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MCP_PROJECT_CONFIG_MAX_BYTES) return [];
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, length);
        if (read <= 0) break;
        length += read;
      }
      // A byte past the size the file had when it was opened: it grew while it was read.
      if (length > stat.size) return [];
      const parsed: unknown = JSON.parse(buffer.toString("utf8", 0, length));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
      const servers = (parsed as Record<string, unknown>).mcpServers;
      if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
      return Object.entries(servers);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

/**
 * The config key the row of a project entry is keyed by, as
 * `GET /api/mcp` describes it: an override that would load is keyed by the
 * merged entry it stands for, anything else by the entry as written, both
 * validated where the SDK's validator accepts them.
 */
export function projectEntryConfigKey(
  internals: Pick<PiSdkInternals, "validateMcpServerConfig"> | undefined,
  name: string,
  value: unknown,
  global: McpServerEntry | undefined,
): string {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  const merged =
    record !== undefined &&
    isMcpOverrideEntry(record) &&
    mcpOverrideRefusal(name, record, global !== undefined) === undefined
      ? { ...((typeof global?.config === "object" && global.config !== null ? global.config : {}) as unknown as Record<string, unknown>), ...record }
      : value;
  const validated = internals?.validateMcpServerConfig?.(name, merged);
  return mcpEntryConfigKey(merged, typeof validated === "string" ? undefined : validated);
}

/**
 * Reports the project's servers as `not-trusted`: an untrusted project's
 * session connects none of them, and Settings shows why per entry, keyed the
 * way the listing keys each row. Best effort: a file that cannot be read
 * safely has no rows to report.
 */
function recordUntrustedProjectStatuses(options: {
  internals: Pick<PiSdkInternals, "validateMcpServerConfig">;
  cwd: string;
  sessionId: string;
  globalServers: readonly McpServerEntry[];
}): void {
  const entries = untrustedProjectServerEntries(options.cwd);
  if (entries.length === 0) return;
  const sourcePath = join(options.cwd, CONFIG_DIR_NAME, "mcp.json");
  const now = Date.now();
  for (const [name, value] of entries.slice(0, MCP_UNTRUSTED_REPORT_MAX)) {
    const global = options.globalServers.find((server) => server.name === name);
    try {
      recordMcpStatus(
        { scope: "project", sourcePath, name },
        projectEntryConfigKey(options.internals, name, value, global),
        { origin: "session", state: "not-trusted", sessionId: options.sessionId, cwd: options.cwd, updatedAt: now },
      );
    } catch {
      // A report must never break the session's start.
    }
  }
}

function sessionIdOf(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId() ?? "";
  } catch {
    return "";
  }
}

/** Characters of a transport's stderr tail kept with a failure report. */
const MCP_STATUS_STDERR_CHARS = 2000;

/** Characters of an error message kept with a failure report. */
const MCP_STATUS_ERROR_CHARS = 2000;

function stdioTail(transport: unknown): { stderr?: string } {
  const stderr = (transport as { stderr?: unknown }).stderr;
  if (typeof stderr !== "string" || stderr.length === 0) return {};
  return { stderr: stderr.slice(-MCP_STATUS_STDERR_CHARS) };
}

/**
 * Wraps the transport factory so each connection of this session reports what
 * it sees to Settings' status store: `connecting` when the transport is
 * built, `connected` or `failed` (or `needs-auth`) from how `start`
 * ends, `failed` again if an error arrives mid-session, and `disconnected`
 * when it closes. The report is keyed like Settings' rows are, by the entry's
 * file, name, and validated config, so the dot lands on the row the file
 * holds now.
 */
export function wrapTransportFactoryForSession(
  create: McpTransportFactory,
  session: { cwd: string; sessionId: string },
): McpTransportFactory {
  return (entry, cwd, authProvider) => {
    const transport = create(entry, cwd, authProvider);
    const statusEntry = {
      scope: entry.scope === "project" ? ("project" as const) : ("global" as const),
      sourcePath: entry.source,
      name: entry.name,
    };
    const configKey = mcpConfigKey(entry.config);
    const record = (state: string, extra: Record<string, unknown> = {}) => {
      try {
        recordMcpStatus(statusEntry, configKey, {
          origin: "session",
          state,
          sessionId: session.sessionId,
          cwd: session.cwd,
          updatedAt: Date.now(),
          ...extra,
        } as Parameters<typeof recordMcpStatus>[2]);
      } catch {
        // A report must never break the connection.
      }
    };
    const failureExtra = (error: unknown): Record<string, unknown> => ({
      ...(error instanceof Error && error.message ? { error: error.message.slice(0, MCP_STATUS_ERROR_CHARS) } : {}),
      ...stdioTail(transport),
    });
    record("connecting");
    const originalStart = transport.start.bind(transport);
    transport.start = async () => {
      try {
        await originalStart();
        record("connected");
      } catch (error) {
        record(isMcpAuthRequiredError(error) ? "needs-auth" : "failed", failureExtra(error));
        throw error;
      }
    };
    const originalOnError = transport.onError.bind(transport);
    transport.onError = (listener) =>
      originalOnError((error) => {
        record(isMcpAuthRequiredError(error) ? "needs-auth" : "failed", failureExtra(error));
        listener(error);
      });
    // A transport may or may not emit its own close event on an explicit
    // close(); whichever source reports first wins, exactly once.
    const closeListeners = new Set<() => void>();
    let closed = false;
    const originalOnClose = transport.onClose.bind(transport);
    transport.onClose = (listener) => {
      closeListeners.add(listener);
      return originalOnClose(() => {
        if (closed) return;
        closed = true;
        record("disconnected");
        listener();
      });
    };
    const originalClose = transport.close.bind(transport);
    transport.close = async () => {
      try {
        await originalClose();
      } finally {
        if (!closed) {
          closed = true;
          record("disconnected");
          for (const listener of closeListeners) listener();
        }
      }
    };
    return transport;
  };
}

/**
 * `loadConfig` for the session's MCP extension: what the SDK's own loader
 * reads, global first and the project file only while the project is
 * trusted, read fresh per session start with
 * `mayReadProjectConfigNow()` — never a cached decision, and fail-closed
 * when the trust store cannot be read. An untrusted project's entries are
 * reported as `not-trusted` instead of connected.
 */
function loadSessionMcpConfig(
  internals: PiSdkInternals,
  agentDir: string,
  ctx: ExtensionContext,
  session: { cwd: string; sessionId: string },
): LoadedMcpConfig {
  let projectTrusted = false;
  try {
    projectTrusted = mayReadProjectConfigNow(ctx.cwd, agentDir);
  } catch {
    projectTrusted = false;
  }
  session.cwd = ctx.cwd;
  session.sessionId = sessionIdOf(ctx);
  const loaded = internals.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted });
  if (!projectTrusted) {
    try {
      recordUntrustedProjectStatuses({
        internals,
        cwd: ctx.cwd,
        sessionId: session.sessionId,
        globalServers: loaded.servers.filter((server) => server.scope !== "project"),
      });
    } catch {
      // A report must never break the session's start.
    }
  }
  return loaded;
}

const MCP_WARNED_KEY: symbol = Symbol.for("pi-web.mcpInternalsWarned");

/**
 * The session's MCP extension. The SDK's factory is created inside an async
 * wrapper because pi-web's config loader and transports need the SDK
 * internals, which load asynchronously; a factory may return a promise. When
 * the internals are unavailable the extension registers nothing and the
 * session starts without MCP servers, warned about once per process.
 */
function sessionMcpExtensionFactory(options: { agentDir: string; cwd: string }): ExtensionFactory {
  return async (pi) => {
    const internals = await loadPiSdkInternals();
    if (!internals.ok) {
      const store = globalThis as Record<symbol, string | undefined>;
      if (store[MCP_WARNED_KEY] !== internals.reason) {
        store[MCP_WARNED_KEY] = internals.reason;
        console.warn(`[pi-web] MCP is off: ${internals.reason}`);
      }
      return;
    }
    const session = { cwd: options.cwd, sessionId: "" };
    await createMcpExtension({
      loadConfig: (ctx) => loadSessionMcpConfig(internals, options.agentDir, ctx, session),
      createTransport: wrapTransportFactoryForSession(createPiWebMcpTransportFactory(internals), session),
      startupWaitMs: 0,
      openUrl: () => {},
    })(pi);
  };
}

/**
 * The built-in extensions pi-web loads into every normal session. `codemode`
 * and `tool_search` register inactive: a session reaches them through its
 * tool selection, `defaultTools`, or the MCP extension, which activates
 * `codemode` when a codemode-exposure server connects. Creating them also
 * runs the code mode sandbox self-test once per process, which Settings
 * reports without ever running it itself.
 *
 * The MCP extension connects the global `mcp.json` and, while the session's
 * project is trusted, its `.pi/mcp.json` (`loadSessionMcpConfig`), waits
 * nothing at the first prompt (`startupWaitMs: 0`; tools appear as servers
 * connect), reports every connection's state for Settings, and never opens a
 * browser: an OAuth URL belongs in the chat, not in a browser on the server
 * host a remote user never sees.
 */
export function createBuiltinExtensionFactories(options: { agentDir: string; cwd: string }): InlineExtension[] {
  void checkCodemodeSandbox();
  const extensions: InlineExtension[] = [
    { name: "codemode", replaceable: true, builtin: true, factory: createCodemodeExtension() },
    { name: "tool-search", replaceable: true, builtin: true, factory: createToolSearchExtension() },
  ];
  if (!isMcpDisabledByEnvironment()) {
    extensions.push({
      name: "mcp",
      replaceable: true,
      builtin: true,
      factory: sessionMcpExtensionFactory(options),
    });
  }
  return extensions;
}
