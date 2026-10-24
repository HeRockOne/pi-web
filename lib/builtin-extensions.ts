import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
  type LoadedMcpConfig,
  type McpServerConfig,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { createPiWebMcpTransportFactory } from "./mcp-transport";

// pi registers these three as CLI built-ins; as an SDK host, pi-web loads them
// itself, under the CLI names. They register with `replaceable`, so a user
// extension supplying the same tool or command takes over, and `builtin`, so
// errors and diagnostics name them `builtin:<name>`.

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
  const value = environment.PI_WEB_DISABLE_MCP;
  if (value === undefined || value === "") return false;
  return platform === "win32"
    ? !["0", "false"].includes(value.toLowerCase())
    : !["0", "false"].includes(value);
}

/**
 * The built-in extensions pi-web loads into every normal session. `codemode`
 * and `tool_search` register inactive: a session reaches them through its
 * tool selection, `defaultTools`, or the MCP extension, which activates
 * `codemode` when a codemode-exposure server connects. The MCP extension
 * connects only the global `mcp.json` (see `loadGlobalMcpConfig`), waits
 * nothing at the first prompt (`startupWaitMs: 0`; tools appear as servers
 * connect), and never opens a browser: an OAuth URL belongs in the chat, not
 * in a browser on the server host a remote user never sees.
 */
export function createBuiltinExtensionFactories(options: { agentDir: string }): InlineExtension[] {
  const extensions: InlineExtension[] = [
    { name: "codemode", replaceable: true, builtin: true, factory: createCodemodeExtension() },
    { name: "tool-search", replaceable: true, builtin: true, factory: createToolSearchExtension() },
  ];
  if (!isMcpDisabledByEnvironment()) {
    extensions.push({
      name: "mcp",
      replaceable: true,
      builtin: true,
      factory: createMcpExtension({
        loadConfig: () => loadGlobalMcpConfig(options.agentDir),
        createTransport: createPiWebMcpTransportFactory(),
        startupWaitMs: 0,
        openUrl: () => {},
      }),
    });
  }
  return extensions;
}
