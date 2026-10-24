import type { McpScope } from "@/lib/api-types";

// STUB — a later slice of the MCP phase-2 port replaces this with the upstream
// implementation, which needs lib/mcp-import.ts (the paste importer) and the
// trust-folder machinery. Only the draft shape McpConfig.tsx keeps between
// renders is defined here; the add pane itself renders nothing until then.

/** What the user has typed into the add pane; the panel keeps it while another row is shown. */
export interface McpAddDraft {
  text: string;
  /** "Enable pi mcp syntax": JSON values keep \`\${VAR}\`, \`\$\$\` and \`!command\` as written. */
  rawPi: boolean;
  /** Which of the paste's servers, in the importer's order. */
  server: number;
  /** The name typed, or undefined for the importer's. */
  name?: string;
  /** Field values typed, by field id. */
  values: Record<string, string>;
  /** Fields answered with a host variable instead: the variable's name as typed, by field id. */
  references: Record<string, string>;
  /** The paste's own literal secrets read from a host variable instead: the variable's name as typed, by label. */
  secretReferences: Record<string, string>;
  /** The scope picked, or undefined for the default. */
  scope?: McpScope;
}

export const EMPTY_MCP_ADD_DRAFT: McpAddDraft = { text: "", rawPi: false, server: 0, values: {}, references: {}, secretReferences: {} };
