import type { McpExposure, ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "./subagents";

export interface SubagentProfilesResponse {
  profiles: SubagentProfile[];
}

export interface SubagentSettingsResponse {
  enabled: boolean;
}

export interface ShellToolSettingsResponse {
  isWindows: boolean;
  powerShellEnabled: boolean;
}

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface ProjectTrustStatus {
  requiresTrust: boolean;
  trusted: boolean;
  /**
   * The nearest decision `trust.json` records for this folder or an ancestor,
   * null when there is none. Read for a folder that requires no trust too, so
   * a fresh folder (no decision anywhere) can be told from one inside a
   * trusted or untrusted tree. Optional here: Pi Web's older trust reporter
   * (`lib/project-trust.ts`) does not fill it yet.
   */
  decision?: boolean | null;
  /** The folder that decision is recorded for, as `trust.json` keys it (its real path). */
  decisionPath?: string;
  /** The decision is recorded for an ancestor, so every folder below it shares it. */
  inherited?: boolean;
  /**
   * Set only for a folder that requires no trust when `trust.json` could not
   * be read; `decision` is then null although one may exist. A folder that
   * requires trust reports the failure as an error instead.
   */
  decisionError?: string;
}

export interface AppUpdateResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export interface PushConfigResponse {
  publicKey: string;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginStandaloneExtensionInfo extends PluginResourceInfo {
  kind: "extension";
  scope: PluginScope;
  enabled: boolean;
}

export type PluginUpdateState =
  | "update-available"
  | "up-to-date"
  | "unsupported"
  | "error";

export interface PluginUpdateResult {
  source: string;
  scope: PluginScope;
  displayName: string;
  type: "npm" | "git";
  state: PluginUpdateState;
  message?: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  canCheckForUpdates: boolean;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  standaloneExtensions: PluginStandaloneExtensionInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
  projectResourcesLoaded: boolean;
}

// ---------------------------------------------------------------------------
// Settings › MCP (ADR 0006). Every refusal carries `{ error, reason }`: `error`
// is an English diagnostic, `reason` a code the panel translates.
// ---------------------------------------------------------------------------

export type McpScope = "global" | "project";
export type McpTransportKind = "stdio" | "http";
/** What a project entry may change of the global server of its name (the SDK's `OVERRIDE_KEYS`). */
export type McpOverrideKey = "enabled" | "exposure" | "toolExposure";

/** A value the SDK resolves before it connects: a stdio `env` value, an HTTP header, or `oauth.clientSecret`. */
export interface McpConfigFieldRef {
  kind: "env" | "header" | "oauth-client-secret";
  /** The variable or header name; absent for `oauth.clientSecret`. */
  name?: string;
}

/**
 * A value that reads environment variables of the process connecting the
 * server (`${NAME}` or `$NAME`), named without expanding anything: a stdio
 * server gets them in its environment, an HTTP server in a header or in the
 * OAuth client secret it is sent.
 */
export interface McpVariableReference extends McpConfigFieldRef {
  variables: string[];
}

export type McpConfigFileProblemReason =
  /** The file is not JSON. */
  | "unparsable"
  /** Not an object with an `mcpServers` object. */
  | "invalid-shape"
  /** `autoEnableCodemode` is set to something other than a boolean; the servers still load. */
  | "auto-enable-codemode-invalid"
  /** A project file that is a symbolic link to nothing. */
  | "link-dangling"
  /** A project file whose real path is outside the folders Pi Web may read. */
  | "link-outside"
  /** Not a regular file (a directory, a FIFO, a device). */
  | "not-a-file"
  /** A project file larger than 1 MiB. */
  | "too-large"
  /** A project file that declares more servers than Pi Web lists (`MCP_PROJECT_MAX_SERVERS`, 200). */
  | "too-many-servers"
  | "unreadable";

export interface McpConfigFileProblem {
  reason: McpConfigFileProblemReason;
  error: string;
}

export interface McpConfigFileInfo {
  scope: McpScope;
  /** `<agent-dir>/mcp.json` or `<cwd>/.pi/mcp.json`, as the SDK names it. */
  path: string;
  /** Where the path leads when it, or a folder above it, is a symbolic link. */
  realPath?: string;
  exists: boolean;
  /** A problem other than `auto-enable-codemode-invalid` means no server of the file is listed. */
  problems: McpConfigFileProblem[];
  autoEnableCodemode?: boolean;
}

/**
 * One `mcpServers` entry, described from the file without resolving anything:
 * no `${VAR}` is expanded and no `!command` runs. Literal env and header
 * values are never included, and URL and argument parts that look like
 * secrets are masked.
 */
export interface McpServerInfo {
  name: string;
  scope: McpScope;
  sourcePath: string;
  /**
   * Identifies the entry's content, to tell a changed entry from the one a
   * status was recorded for: an HMAC of its canonical JSON under a per-process
   * key (`mcpConfigKey()`), never the JSON, which holds literal values.
   */
  configKey: string;
  enabled: boolean;
  /** False when the SDK's validator was unavailable; nothing below was checked. */
  validated: boolean;
  /** The SDK's reason for refusing the entry; it never connects. */
  invalidError?: string;
  /**
   * The entry is not a JSON object (`"name": "text"`), so it has no `enabled`
   * to switch: `enabled` reads true, pi refuses it, and it can only be removed.
   */
  notAnObject?: true;
  /**
   * What a connection uses: HTTP whenever the entry has a `url` key, as the
   * SDK's transport decides, even where the validator took it for stdio
   * (`type: "stdio"` beside a `url`). An entry with `invalidError` never
   * connects and gets the validator's reading (none for legacy SSE).
   */
  transport?: McpTransportKind;
  exposure?: McpExposure;
  /** How many tools `toolExposure` gives an exposure of their own, by exact name or pattern; absent when none. */
  toolExposureCount?: number;
  /** The entry's `description`, as written: what pi lists the server with in the system prompt. */
  description?: string;
  command?: string;
  args?: string[];
  /** The configured working directory, relative to the session's. */
  cwd?: string;
  envNames: string[];
  url?: string;
  headerNames: string[];
  /** An HTTP server without an `Authorization` header or `auth` signs in with OAuth when it answers 401. */
  usesOAuth: boolean;
  /** An HTTP server's `auth.provider`: it sends that pi provider's token (signed in under Settings › Models) instead of using OAuth. */
  authProvider?: string;
  /**
   * Whether `mcp-auth.json` holds an access token for the server (by its name
   * and URL, else the record older versions kept by URL alone, as the SDK
   * reads it); absent when unknown or not an OAuth server.
   */
  signedIn?: boolean;
  /**
   * Whether `mcp-auth.json` holds anything for the server: tokens, or what a
   * sign-in stores before any token (a dynamic client registration, the PKCE
   * verifier and state), which a cancelled or expired sign-in leaves behind.
   * Sign out removes all of it. Absent when unknown or not an OAuth server.
   */
  oauthStateStored?: boolean;
  /** Values that run a shell command on every connection. */
  commandFields: McpConfigFieldRef[];
  /** Values that read the host's environment variables on every connection; a `!command` is in `commandFields` instead. */
  variableReferences: McpVariableReference[];
  /** The value that references `PI_WEB_PASSWORD`; Pi Web refuses to connect such an entry. */
  webPasswordField?: McpConfigFieldRef;
  /** Some of `command`, `args` or `url` was masked. */
  masked: boolean;
  /** A global entry the project file defines too; the project's replaces it while the project is trusted. */
  shadowedByProject?: boolean;
  /** The project entry that replaces a global entry of its name while the project is trusted; the counterpart of `shadowedByProject`. */
  replacesGlobal?: boolean;
  /**
   * A project entry without `command`, `url` or `type`: it changes only
   * `enabled`, `exposure` and `toolExposure` of the global server of its name
   * (pi 1.0.1), and `keys` are the ones it sets. While pi loads it, the fields
   * above describe the global server with those changes, which is what
   * sessions in the project connect.
   */
  override?: { keys: McpOverrideKey[] };
  /** A global entry the project's override changes while the project is trusted; the counterpart of `override`. */
  overriddenByProject?: boolean;
  /**
   * The last known connection state, from a test or an open session
   * (`lib/mcp-status.ts`): only while it was recorded for this entry as the
   * file holds it now (same `configKey`).
   */
  status?: McpServerStatus;
}

/** How a connection test ended (`POST /api/mcp/test`). */
export type McpTestState = "connected" | "needs-auth" | "failed";

/** One tool a tested server listed. */
export interface McpTestTool {
  name: string;
  /** The first line of its description (or title), shortened. */
  description?: string;
  /** The server marks it read-only (`annotations.readOnlyHint`). */
  readOnly: boolean;
  /** How it reaches the model under the entry's `exposure` and `toolExposure`. */
  exposure: McpExposure;
}

/**
 * What a connection test found. Literal env and header values, `!command`
 * texts, what they resolved to, and the secret parts of the command, the
 * arguments and the URL are masked in `error`, `stderr`, the tools'
 * descriptions and `serverInfo`.
 */
export interface McpTestResult {
  state: McpTestState;
  /** Why it failed, as the SDK words it, without the stderr tail (`stderr`); at most 2,000 characters. */
  error?: string;
  /** The last 2,000 characters a stdio server wrote to stderr, when it did not connect. */
  stderr?: string;
  /** The server did not answer within the test's deadline, and Pi Web stopped the test. */
  timedOut?: boolean;
  /** Another test of a server that runs a shell command held the queue past the deadline, so this one never started. */
  queueTimedOut?: boolean;
  /** At most `MCP_TEST_MAX_TOOLS`, in the server's order; `toolCount` counts all of them. */
  tools: McpTestTool[];
  toolCount: number;
  /** Present when the server offers resources, which pi lists only when a resource tool asks. */
  resources?: true;
  serverInfo?: { name: string; version: string; title?: string };
  /** The folder a stdio server ran in. */
  cwd?: string;
  /** From connecting to the result, without any wait in the queue. */
  durationMs: number;
  /** How long it waited for other tests of servers that run a shell command, when it did. */
  queuedMs?: number;
  /** When it finished, in milliseconds since the epoch. */
  testedAt: number;
  /** The connection a Settings sign-in made right after it stored new tokens (`lib/mcp-sign-in.ts`), not a Test. */
  afterSignIn?: true;
}

/**
 * What an open session's MCP host last saw of a server (`lib/mcp-host.ts`):
 * - `connecting`: the session opened a connection that has not finished;
 * - `connected`: its tools are registered in the session;
 * - `needs-auth`: the server asked for an OAuth sign-in;
 * - `failed`: the connection ended before the server was ready;
 * - `disconnected`: a connection that was ready dropped (a stdio server
 *   exited); the session connects again at the next call to one of its tools;
 * - `conflict`: another extension of the session registered an MCP server of
 *   that name first, so the session does not connect this entry;
 * - `not-trusted`: the project's `.pi/mcp.json` declares it, and the session
 *   did not read the file because no decision trusted the project.
 */
export type McpSessionState =
  | "connecting"
  | "connected"
  | "needs-auth"
  | "failed"
  | "disconnected"
  | "conflict"
  | "not-trusted";

/**
 * A server's state as a session's MCP host recorded it. Sessions report what
 * they see as it happens, and the latest report wins, whichever session made
 * it: a global stdio server runs once per session, each in its own folder,
 * so `cwd` says which one this is. Masked like a test's messages.
 */
export interface McpSessionStatus {
  origin: "session";
  state: McpSessionState;
  sessionId: string;
  /** The session's folder: a stdio server runs relative to it, and it is the MCP root the server is sent. */
  cwd: string;
  /** When the session saw it, in milliseconds since the epoch. */
  updatedAt: number;
  /** `failed`: why, as far as the transport says; at most 2,000 characters. */
  error?: string;
  /** `failed` / `disconnected`, stdio: the last 2,000 characters the server wrote to stderr. */
  stderr?: string;
  /** `conflict`: the extension whose server of that name the session kept. */
  conflict?: string;
  /**
   * `connected`: when the session closed that connection itself (it went
   * idle, ended, or reloaded), so the record says what it saw, not that it
   * still holds one. A closed report reads like an untested entry's row.
   */
  closedAt?: number;
}

/** A server's last known connection state: the newest of a test (`origin: "test"`) and an open session's report. */
export type McpServerStatus = ({ origin: "test" } & McpTestResult) | McpSessionStatus;
