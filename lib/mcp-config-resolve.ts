import { execSync } from "node:child_process";

import { isCommandConfigValue, parseConfigValueTemplate } from "./mcp-config-values";

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
 * variable resolves to undefined. Server side only — the value walk itself is
 * the client-safe ./mcp-config-values.
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
