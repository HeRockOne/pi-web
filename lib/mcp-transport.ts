import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { McpServerConfig, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import {
  describeConfigField,
  findWebPasswordField,
  resolveConfigValue,
  WEB_PASSWORD_VARIABLE,
} from "./mcp-config-values";
import { sanitizeProjectCommandEnvironment } from "./project-command-env";

// MCP servers are started on behalf of a project like its bash commands, so
// they get the same environment: the server's own, without the variables that
// configure or guard this Next.js process (ADR 0006, "Safety → Environment").
// The SDK's default transport passes the whole `process.env` instead, and
// pi-coding-agent does not re-export it, so this factory builds the transports
// itself from pi-mcp's primitives.

export interface PiWebMcpTransportOptions {
  /** Environment stdio servers start from, before sanitizing. Defaults to `process.env` at connect time. */
  baseEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** A leading `~` expands to the home directory, as the SDK does for server commands. */
function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** The sanitized environment with the server's own `env` on top; a Windows name replaces any casing of itself. */
function serverEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  configured: Record<string, string>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(sanitizeProjectCommandEnvironment(baseEnvironment, platform))) {
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(configured)) {
    if (platform === "win32") {
      for (const existing of Object.keys(environment)) {
        if (existing.toUpperCase() === name.toUpperCase()) delete environment[existing];
      }
    }
    environment[name] = value;
  }
  return environment;
}

/** Resolve the server's own `env` and header values in this process, failing loudly on a missing variable. */
function resolveConfiguredValues(
  entry: { name: string },
  kind: string,
  values: Record<string, string> | undefined,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, raw] of Object.entries(values ?? {})) {
    const value = resolveConfigValue(raw);
    if (value === undefined) {
      throw new Error(
        `MCP server "${entry.name}" ${kind} "${name}" references a missing environment variable or a failed command`,
      );
    }
    resolved[name] = value;
  }
  return resolved;
}

/**
 * The transport factory pi-web gives the SDK's MCP connections. A stdio server
 * starts with `inheritEnv: false` from the sanitized environment, its `env`
 * values resolved like the SDK resolves them, with `~` in the command and
 * arguments expanded and its `cwd` resolved against the session. HTTP servers
 * use pi-mcp's transport with their header values resolved and the OAuth auth
 * provider passed through. It never falls back to the SDK's default transport.
 */
export function createPiWebMcpTransportFactory(options: PiWebMcpTransportOptions = {}): McpTransportFactory {
  const platform = options.platform ?? process.platform;
  return (entry, cwd, authProvider): McpTransport => {
    const config = entry.config as McpServerConfig;
    const field = findWebPasswordField(config);
    if (field) {
      throw new Error(
        `MCP server "${entry.name}" ${describeConfigField(field)} references ${WEB_PASSWORD_VARIABLE}, which Pi Web does not pass to MCP servers`,
      );
    }
    if ("url" in config) {
      const headers = resolveConfiguredValues(entry, "header", config.headers);
      return new StreamableHttpTransport({
        url: config.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(authProvider ? { authProvider } : {}),
      });
    }
    return new StdioTransport({
      command: expandTilde(config.command),
      args: config.args?.map(expandTilde),
      cwd: config.cwd ? resolve(cwd, expandTilde(config.cwd)) : isAbsolute(cwd) ? cwd : resolve(cwd),
      env: serverEnvironment(
        options.baseEnvironment ?? process.env,
        resolveConfiguredValues(entry, "env", config.env),
        platform,
      ),
      inheritEnv: false,
      stderr: "pipe",
    });
  };
}
