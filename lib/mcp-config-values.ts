import { execSync } from "node:child_process";

// Which values of an `mcp.json` entry pi resolves before it connects, and the
// PI_WEB_PASSWORD rule over them (ADR 0006, "Safety → Environment"). Mirrors
// the SDK's core/resolve-config-value.js, which pi-coding-agent does not
// re-export, so a resolution change upstream has to be re-ported here.
// Client-safe apart from `!command` execution: the MCP routes and the
// transport share this walk, so a change to which fields pi resolves is made
// once.

export const WEB_PASSWORD_VARIABLE = "PI_WEB_PASSWORD";

export type McpConfigFieldKind = "env" | "header" | "oauth-client-secret";

export interface McpConfigFieldRef {
  kind: McpConfigFieldKind;
  /** Entry name; absent for the OAuth client secret. */
  name?: string;
}

export interface McpResolvedConfigValue extends McpConfigFieldRef {
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEntries(value: unknown): [string, string][] {
  return isRecord(value)
    ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : [];
}

/**
 * The values pi resolves in this process before it connects: a stdio entry's
 * `env`, an HTTP entry's headers and `oauth.clientSecret`, told apart by
 * whether `url` is present. Anything else is used as written. Accepts an
 * entry the SDK has not validated: values that are not strings are skipped.
 */
export function resolvedConfigValues(config: unknown): McpResolvedConfigValue[] {
  if (!isRecord(config)) return [];
  if (!("url" in config)) {
    return stringEntries(config.env).map(([name, value]) => ({ kind: "env", name, value }));
  }
  const values: McpResolvedConfigValue[] = stringEntries(config.headers).map(([name, value]) => ({
    kind: "header",
    name,
    value,
  }));
  const clientSecret = isRecord(config.oauth) ? config.oauth.clientSecret : undefined;
  if (typeof clientSecret === "string") values.push({ kind: "oauth-client-secret", value: clientSecret });
  return values;
}

/** `env "KEY"`, `header "Name"` or `oauth.clientSecret`, for messages. */
export function describeConfigField(field: McpConfigFieldRef): string {
  if (field.kind === "oauth-client-secret") return "oauth.clientSecret";
  return `${field.kind} "${field.name}"`;
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

// Ported from the SDK's parseConfigValueTemplate: `${NAME}` and `$NAME`
// references, with `$$` and `$!` escaping a literal `$` and `!`.
function parseConfigValueTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const appendLiteral = (value: string) => {
    if (!value) return;
    const previous = parts[parts.length - 1];
    if (previous?.type === "literal") {
      previous.value += value;
      return;
    }
    parts.push({ type: "literal", value });
  };
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(config.slice(index));
      break;
    }
    appendLiteral(config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(nextChar);
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral("$");
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ type: "env", name });
      } else {
        appendLiteral(config.slice(dollarIndex, endIndex + 1));
      }
      index = endIndex + 1;
      continue;
    }
    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral("$");
    index = dollarIndex + 1;
  }
  return parts;
}

export function isCommandConfigValue(config: string): boolean {
  return config.startsWith("!");
}

export function getConfigValueEnvVarNames(config: string): string[] {
  if (isCommandConfigValue(config)) return [];
  const names: string[] = [];
  for (const part of parseConfigValueTemplate(config)) {
    if (part.type === "env" && !names.includes(part.name)) names.push(part.name);
  }
  return names;
}

// The SDK resolves commands with its configured shell on Windows and falls
// back to the default one; here the default shell covers both, with the same
// 10s timeout and trimmed stdout. Cached per process like the SDK.
const commandResultCache = new Map<string, string | undefined>();

function executeCommand(commandConfig: string): string | undefined {
  const cached = commandResultCache.get(commandConfig);
  if (commandResultCache.has(commandConfig)) return cached;
  let value: string | undefined;
  try {
    const output = execSync(commandConfig.slice(1), {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    value = output.trim() || undefined;
  } catch {
    value = undefined;
  }
  commandResultCache.set(commandConfig, value);
  return value;
}

/**
 * Resolve one config value in this process: `!command` runs and uses its
 * stdout, a template interpolates this process's environment, and a missing
 * variable resolves to undefined.
 */
export function resolveConfigValue(config: string): string | undefined {
  if (isCommandConfigValue(config)) return executeCommand(config);
  let resolved = "";
  for (const part of parseConfigValueTemplate(config)) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const value = process.env[part.name];
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The value of `config` that references `PI_WEB_PASSWORD`, or undefined.
 * Values resolve against this process's environment, which still holds the
 * password, so removing it from the server's environment is not enough. Names
 * compare case-insensitively, as Windows resolves them. A `!command` can read
 * the variable without a `$` reference, so any mention counts.
 */
export function findWebPasswordField(config: unknown): McpConfigFieldRef | undefined {
  for (const { value, ...field } of resolvedConfigValues(config)) {
    const references = isCommandConfigValue(value)
      ? value.toUpperCase().includes(WEB_PASSWORD_VARIABLE)
      : getConfigValueEnvVarNames(value).some((name) => name.toUpperCase() === WEB_PASSWORD_VARIABLE);
    if (references) return field;
  }
  return undefined;
}
