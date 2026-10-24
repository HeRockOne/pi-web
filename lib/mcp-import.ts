// STUB: only the types Settings › MCP's helpers read. The full upstream
// paste importer (lib/mcp-import-core.ts) arrives with the later MCP slice
// that ports the add-server flow, and replaces this file wholesale.

/** A diagnostic the paste importer attaches to what it read. */
export interface McpImportNote {
  code: string;
  params?: Record<string, string | number>;
}

/** A config value a field fills in: a literal, or a reference to another field's value. */
export type McpImportFieldValue = string | { reference: string };

/** The exposures the SDK accepts, in the order the panel lists them. */
export const MCP_EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"];
