// STUB — a later slice of the MCP phase-2 port replaces this with the upstream
// add pane, which needs lib/mcp-import.ts and components/mcp-add-helpers.ts.
// Until then the pane renders nothing; only the request type McpConfig.tsx
// sends through its action runner is defined here.

import type { McpActionRequest } from "./mcp-config-helpers";

export type McpAddActionRequest = Extract<McpActionRequest, { action: "add" }>;

export function McpAddServer(_props: Record<string, unknown>) {
  void _props;
  return null;
}
