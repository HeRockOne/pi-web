export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
  sourceInfo?: {
    path: string;
    source: string;
    scope?: string;
    origin?: string;
    baseDir?: string;
  };
}

export const TOOL_PRESET_VALUES = ["none", "read-only", "default", "full"] as const;
export type ToolPreset = typeof TOOL_PRESET_VALUES[number];

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

export function getPresetFromToolNames(toolNames: readonly string[]): ToolPreset {
  if (toolNames.length === 0) return "none";

  const active = toolNames
    .map((name) => name === "powershell" ? "bash" : name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_READ_ONLY].sort().join(",")) return "read-only";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "read-only") return [...PRESET_READ_ONLY];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}

// Session-level extension tools pi registers inactive (`defaultActive: false`):
// the presets only cover the coding tools, so these get their own switches in
// the tool dropdown and ride along with every preset selection.
export const SYSTEM_TOOL_TOGGLE_NAMES = ["codemode", "tool_search"] as const;

const SYSTEM_TOOL_TOGGLE_SET = new Set<string>(SYSTEM_TOOL_TOGGLE_NAMES);

export function isSystemToolToggle(name: string): boolean {
  return SYSTEM_TOOL_TOGGLE_SET.has(name);
}

export function getSystemToolToggles(tools: ToolEntry[]): ToolEntry[] {
  return tools.filter((tool) => SYSTEM_TOOL_TOGGLE_SET.has(tool.name));
}

export function mergeToolSelection(
  presetToolNames: readonly string[],
  toggles: readonly ToolEntry[],
): string[] {
  const enabled = toggles.filter((tool) => tool.active).map((tool) => tool.name);
  return [...new Set([...presetToolNames, ...enabled])];
}
