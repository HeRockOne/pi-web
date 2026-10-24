import { NextResponse } from "next/server";
import { getAgentDir, type McpExposure } from "@earendil-works/pi-coding-agent";
import type {
  McpActionItemResult,
  McpActionResponse,
  McpErrorResponse,
  McpRefusalReason,
  McpResponse,
  McpScope,
  McpServerRef,
} from "@/lib/api-types";
import {
  insertMcpServer,
  isMcpConfigWriteError,
  removeMcpServer,
  setMcpServerEnabledInProject,
  setMcpServerExposure,
  setMcpServersEnabled,
  type McpConfigFileTarget,
  type McpEnabledOutcome,
} from "@/lib/mcp-config-file";
import { readMcpOverview, readMcpServerEntry } from "@/lib/mcp-config-read";
import { findWebPasswordField } from "@/lib/mcp-config-values";
import {
  isMcpEntryRefusal,
  mcpInternalsOrRefusal,
  mcpProjectTrustRefusal,
  readMcpServerConfig,
  validateMcpProject,
  type McpEntryRefusal,
} from "@/lib/mcp-entry-request";
import { holdRemovedEntry, returnRemovedEntry, takeRemovedEntry } from "@/lib/mcp-undo";
import type { PiSdkInternals } from "@/lib/pi-sdk-internals";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › MCP (ADR 0006). GET reads files only: it never spawns a server,
// opens a connection, or runs a `!command` value, so it lists an untrusted
// project's servers as safely as the global ones. Without `cwd` it lists the
// global file alone; Settings › MCP does not need a project.
//
// POST changes one file through `lib/mcp-config-file.ts` (locked, atomic, the
// SDK editor's bytes) and answers with the overview GET would give, so the
// panel replaces its listing without a second request. Open sessions apply a
// change at their next message, when their MCP host reads the files again.
// The `add` and `sign-out` actions follow in the later MCP phase-2 slices.

// `lib/mcp-import-core.ts` owns these in the MCP phase-2 port (Slice 3); the
// set-exposure action needs only this guard until then.
const MCP_EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];

function isMcpExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value);
}

type Project = { cwd: string; allowedRoots: Set<string> };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RefusalParams = Omit<McpErrorResponse, "error" | "reason">;

function refusal(status: number, reason: McpRefusalReason, error: string, params: RefusalParams = {}) {
  return NextResponse.json({ error, reason, ...params } satisfies McpErrorResponse, { status });
}

/** A typed refusal: the whole answer of a request, or one server's result in a bulk switch. */
class Refusal {
  constructor(
    readonly status: number,
    readonly reason: McpRefusalReason,
    readonly error: string,
    readonly params: RefusalParams = {},
  ) {}

  response() {
    return refusal(this.status, this.reason, this.error, this.params);
  }

  item(server: McpServerRef): McpActionItemResult {
    return { ...server, error: this.error, reason: this.reason };
  }
}

/** The shared checks of `lib/mcp-entry-request.ts`, as one of this route's refusals. */
function asRefusal(refused: McpEntryRefusal): Refusal {
  const { error, reason, ...params } = refused.body;
  return new Refusal(refused.status, reason, error, params);
}

/** The project folder the request names, checked as Test, sign-in and the trust route check it (`validateMcpProject()`). */
async function validateProject(value: unknown): Promise<Project | Refusal> {
  const result = await validateMcpProject(value);
  return isMcpEntryRefusal(result) ? asRefusal(result) : result;
}

// GET /api/mcp?cwd=<absolute project folder>
export async function GET(req: Request) {
  const value = new URL(req.url).searchParams.get("cwd");
  let project: Project | undefined;
  if (value !== null) {
    const result = await validateProject(value);
    if (result instanceof Refusal) return result.response();
    project = result;
  }

  try {
    return NextResponse.json((await readMcpOverview({ agentDir: getAgentDir(), project })) satisfies McpResponse);
  } catch (error) {
    return refusal(500, "internal", errorMessage(error));
  }
}

/**
 * Where a write to `scope` goes. A project file is written only while a
 * decision, exact or inherited, trusts the folder: the rule the MCP host reads
 * it by (`mayReadProjectConfigNow()`), never `trusted`, which a folder with no
 * trust-requiring resources gets with no decision at all.
 */
function writeTarget(scope: McpScope, project: Project | undefined, agentDir: string): McpConfigFileTarget | Refusal {
  if (scope === "global") return { scope: "global", agentDir };
  if (!project) return new Refusal(400, "invalid-request", "A project server needs the project's cwd");
  const refused = mcpProjectTrustRefusal(project.cwd, agentDir, "The project is not trusted, so its .pi/mcp.json is not changed");
  if (refused) return asRefusal(refused);
  return { scope: "project", cwd: project.cwd, allowedRoots: project.allowedRoots };
}

/** A writer refusal as the route answers it: 409 for a file state the user can fix, 500 for anything else. */
function writeRefusal(error: unknown): Refusal {
  if (isMcpConfigWriteError(error)) {
    const params = { path: error.path, ...(error.serverName !== undefined ? { name: error.serverName } : {}) };
    if (error.reason === "unreadable") return new Refusal(500, "internal", error.message, params);
    return new Refusal(409, error.reason, error.message, params);
  }
  return new Refusal(500, "internal", errorMessage(error));
}

/**
 * MCP off means the panel is read-only: the operator turned it off for this
 * server (nothing in the browser may override that, and the pi CLI reads the
 * same files), or the SDK's MCP modules cannot load, so nothing can be
 * checked. `-builtin:mcp` does not: it is a setting a project may reverse, and
 * whether a global switch worked must not depend on the folder Settings shows.
 */
async function mcpWritable(): Promise<PiSdkInternals | Refusal> {
  const internals = await mcpInternalsOrRefusal("changes no MCP server");
  return isMcpEntryRefusal(internals) ? asRefusal(internals) : internals;
}

function readScope(value: unknown): McpScope | undefined {
  return value === "global" || value === "project" ? value : undefined;
}

function readName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : undefined;
}

const MAX_BULK_SERVERS = 500;

function readServerList(value: unknown): McpServerRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_SERVERS) return undefined;
  const servers = new Map<string, McpServerRef>();
  for (const item of value) {
    const scope = isRecord(item) ? readScope(item.scope) : undefined;
    const name = isRecord(item) ? readName(item.name) : undefined;
    if (!scope || name === undefined) return undefined;
    servers.set(`${scope}\0${name}`, { scope, name });
  }
  return [...servers.values()];
}

async function overviewResponse(agentDir: string, project: Project | undefined, extra: Omit<McpActionResponse, keyof McpResponse> = {}) {
  try {
    const overview = await readMcpOverview({ agentDir, project });
    return NextResponse.json({ ...overview, ...extra } satisfies McpActionResponse);
  } catch (error) {
    return refusal(500, "internal", errorMessage(error));
  }
}

/** Turning on an entry that references PI_WEB_PASSWORD is refused: Pi Web would not connect it, and the pi CLI would send the password. */
function webPasswordRefusal(_internals: PiSdkInternals) {
  void _internals; // our findWebPasswordField resolves the SDK parsers itself; the parameter keeps the upstream call shape
  return (_name: string, entry: Record<string, unknown>) => (findWebPasswordField(entry) ? ("web-password" as const) : undefined);
}

/** Why the writer left one server as it was, as a 409; undefined when it now says what was asked. */
function outcomeRefusal(outcome: McpEnabledOutcome<"web-password">, path: string): Refusal | undefined {
  const name = outcome.name;
  switch (outcome.outcome) {
    case "missing":
      return new Refusal(409, "server-missing", `${path} does not define MCP server "${name}"`, { path, name });
    case "not-an-object":
      return new Refusal(409, "entry-not-object", `${path} defines MCP server "${name}" as something other than an object, so it has nothing to switch`, { path, name });
    case "refused":
      return new Refusal(409, "web-password", `"${name}" references PI_WEB_PASSWORD, so Pi Web does not turn it on`, { name });
    default:
      return undefined;
  }
}

async function switchServer(
  agentDir: string,
  project: Project | undefined,
  internals: PiSdkInternals,
  server: McpServerRef,
  enabled: boolean,
) {
  const target = writeTarget(server.scope, project, agentDir);
  if (target instanceof Refusal) return target.response();
  try {
    const { value: [outcome], path } = await setMcpServersEnabled(
      target,
      [server.name],
      enabled,
      enabled ? webPasswordRefusal(internals) : undefined,
    );
    const refused = outcomeRefusal(outcome, path);
    if (refused) return refused.response();
  } catch (error) {
    return writeRefusal(error).response();
  }
  return overviewResponse(agentDir, project);
}

/**
 * How one server's tools reach the model. Nothing connects because of it:
 * open sessions register the changed entry again at their next message, so
 * an entry that references PI_WEB_PASSWORD may change too, and stays off.
 */
async function setServerExposure(
  agentDir: string,
  project: Project | undefined,
  server: McpServerRef,
  exposure: McpExposure,
) {
  const target = writeTarget(server.scope, project, agentDir);
  if (target instanceof Refusal) return target.response();
  try {
    const { value: outcome, path } = await setMcpServerExposure(target, server.name, exposure);
    const refused = outcomeRefusal(outcome, path);
    if (refused) return refused.response();
  } catch (error) {
    return writeRefusal(error).response();
  }
  return overviewResponse(agentDir, project);
}

/**
 * Turns a global server on or off in the panel's project alone, as `/mcp`'s
 * "Enable / Disable in this project" does: an override entry in the project's
 * `.pi/mcp.json` (pi 1.0.1), written under any project write's checks. The
 * global entry must be one pi loads, since an override of anything else is
 * skipped; turning on one that references PI_WEB_PASSWORD is refused, as its
 * switch would be. Remove on the override's row goes back to the global value.
 */
async function switchServerInProject(
  agentDir: string,
  project: Project | undefined,
  internals: PiSdkInternals,
  name: string,
  enabled: boolean,
) {
  const target = writeTarget("project", project, agentDir);
  if (target instanceof Refusal) return target.response();
  if (target.scope !== "project") return refusal(500, "internal", "No project file to write to");
  const read = readMcpServerEntry({ agentDir, scope: "global", name });
  if (!read.ok) {
    const params = { path: read.path, ...(read.reason === "server-missing" ? { name } : {}) };
    if (read.reason === "unreadable") return refusal(500, "internal", read.error, params);
    return refusal(409, read.reason, read.error, params);
  }
  const global = readMcpServerConfig({ agentDir, internals, scope: "global", name });
  if (typeof global === "string") return refusal(409, "server-invalid", global, { name });
  if (enabled && findWebPasswordField(global.config)) {
    return refusal(409, "web-password", `"${name}" references PI_WEB_PASSWORD, so Pi Web does not turn it on`, { name });
  }
  try {
    const { value: outcome, path } = await setMcpServerEnabledInProject(target, name, enabled);
    const refused = outcomeRefusal(outcome, path);
    if (refused) return refused.response();
  } catch (error) {
    return writeRefusal(error).response();
  }
  return overviewResponse(agentDir, project);
}

/**
 * The group switch: every server asked for, one write per file, and a result
 * per server, so one the route refuses (removed meanwhile, not an object,
 * referencing PI_WEB_PASSWORD, in an untrusted project, in a file that no
 * longer parses) keeps the rest from failing.
 */
async function switchServers(
  agentDir: string,
  project: Project | undefined,
  internals: PiSdkInternals,
  servers: McpServerRef[],
  enabled: boolean,
) {
  const results = new Map<string, McpActionItemResult>();
  const key = (server: McpServerRef) => `${server.scope}\0${server.name}`;
  for (const scope of ["global", "project"] as const) {
    const group = servers.filter((server) => server.scope === scope);
    if (group.length === 0) continue;
    const target = writeTarget(scope, project, agentDir);
    if (target instanceof Refusal) {
      for (const server of group) results.set(key(server), target.item(server));
      continue;
    }
    try {
      const { value: outcomes, path } = await setMcpServersEnabled(
        target,
        group.map((server) => server.name),
        enabled,
        enabled ? webPasswordRefusal(internals) : undefined,
      );
      for (const outcome of outcomes) {
        const server = { scope, name: outcome.name };
        results.set(key(server), outcomeRefusal(outcome, path)?.item(server) ?? server);
      }
    } catch (error) {
      const failure = writeRefusal(error);
      for (const server of group) results.set(key(server), failure.item(server));
    }
  }
  return overviewResponse(agentDir, project, { results: servers.map((server) => results.get(key(server)) ?? server) });
}

async function removeServer(agentDir: string, project: Project | undefined, server: McpServerRef) {
  const target = writeTarget(server.scope, project, agentDir);
  if (target instanceof Refusal) return target.response();
  let removed: Awaited<ReturnType<typeof removeMcpServer>>;
  try {
    removed = await removeMcpServer(target, server.name);
  } catch (error) {
    return writeRefusal(error).response();
  }
  const { token, expiresAt } = holdRemovedEntry({
    ...server,
    path: removed.path,
    ...(target.scope === "project" ? { cwd: target.cwd } : {}),
    entry: removed.value.entry,
    index: removed.value.index,
  });
  return overviewResponse(agentDir, project, {
    undo: { ...server, token, path: removed.path, expiresInMs: Math.max(0, expiresAt - Date.now()) },
  });
}

/**
 * Puts a removed entry back where it stood, under the same checks as any
 * write: a project entry's folder must still be allowed and trusted. The
 * entry is restored as it was, a PI_WEB_PASSWORD reference included, since
 * undo returns the file to what it held a moment ago; the panel shows such an
 * entry as refused. A name the file defines again since is never replaced.
 */
async function undoRemoval(agentDir: string, project: Project | undefined, token: string) {
  const held = takeRemovedEntry(token);
  if (!held) return refusal(410, "undo-unavailable", "Nothing to undo: the removal is unknown, already undone, or older than 60 seconds");
  const server = { scope: held.scope, name: held.name };
  let failure: Refusal | undefined;
  try {
    let heldProject: Project | undefined;
    if (held.scope === "project") {
      const result = await validateProject(held.cwd);
      if (result instanceof Refusal) failure = result;
      else heldProject = result;
    }
    if (!failure) {
      const target = writeTarget(held.scope, heldProject, agentDir);
      if (target instanceof Refusal) failure = target;
      else await insertMcpServer(target, held.name, held.entry, held.index);
    }
  } catch (error) {
    failure = isMcpConfigWriteError(error) && error.reason === "name-taken"
      ? new Refusal(409, "undo-name-taken", `${error.path} defines "${held.name}" again, so the removal is not undone`, {
          path: error.path,
          name: held.name,
        })
      : writeRefusal(error);
  }
  if (failure) {
    // Still undoable once the cause is fixed, for the time it has left.
    returnRemovedEntry(held);
    return failure.response();
  }
  return overviewResponse(agentDir, project, { restored: server });
}

// POST /api/mcp body: { action, cwd?, ... }
//   enable | disable | remove: { scope, name }
//   set-enabled: { enabled, servers: [{ scope, name }] } → per-server `results`
//   set-exposure: { scope, name, exposure }
//   set-in-project: { name, enabled } → a global server on or off in `cwd`'s project alone
//   undo: { token } (from a remove's `undo`)
// `cwd` is the panel's project: required for a project server, and the
// overview in the answer covers it. The `add` and `sign-out` actions follow
// in the later MCP phase-2 slices.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (!isRecord(body)) return refusal(400, "invalid-request", "Expected a JSON object");

  let project: Project | undefined;
  if (body.cwd !== undefined && body.cwd !== null) {
    const result = await validateProject(body.cwd);
    if (result instanceof Refusal) return result.response();
    project = result;
  }

  const internals = await mcpWritable();
  if (internals instanceof Refusal) return internals.response();
  const agentDir = getAgentDir();

  try {
    switch (body.action) {
      case "enable":
      case "disable":
      case "remove": {
        const scope = readScope(body.scope);
        const name = readName(body.name);
        if (!scope || name === undefined) return refusal(400, "invalid-request", "scope must be \"global\" or \"project\", and name a server name");
        if (body.action === "remove") return await removeServer(agentDir, project, { scope, name });
        return await switchServer(agentDir, project, internals, { scope, name }, body.action === "enable");
      }
      case "set-enabled": {
        const servers = readServerList(body.servers);
        if (typeof body.enabled !== "boolean" || !servers) {
          return refusal(400, "invalid-request", `enabled must be a boolean, and servers a list of 1 to ${MAX_BULK_SERVERS} { scope, name }`);
        }
        return await switchServers(agentDir, project, internals, servers, body.enabled);
      }
      case "set-exposure": {
        const scope = readScope(body.scope);
        const name = readName(body.name);
        if (!scope || name === undefined || !isMcpExposure(body.exposure)) {
          return refusal(400, "invalid-request", `scope must be "global" or "project", name a server name, and exposure one of ${MCP_EXPOSURES.join(", ")}`);
        }
        return await setServerExposure(agentDir, project, { scope, name }, body.exposure);
      }
      case "set-in-project": {
        const name = readName(body.name);
        if (name === undefined || typeof body.enabled !== "boolean") {
          return refusal(400, "invalid-request", "name must name a global server, and enabled be a boolean");
        }
        return await switchServerInProject(agentDir, project, internals, name, body.enabled);
      }
      case "undo": {
        if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 100) {
          return refusal(400, "invalid-request", "token must be the token a remove answered with");
        }
        return await undoRemoval(agentDir, project, body.token);
      }
      default:
        return refusal(400, "invalid-request", "action must be enable, disable, remove, set-enabled, set-exposure, set-in-project or undo");
    }
  } catch (error) {
    return refusal(500, "internal", errorMessage(error));
  }
}
