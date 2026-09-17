// Breaks a composed pi system prompt into labeled sections and counts
// tokens exactly with js-tiktoken (OpenAI o200k_base — the same encoding
// pi's model stack uses). Client-safe: js-tiktoken/lite is pure JS and
// the rank table ships as plain data; no Node/SDK imports.
//
// When tool hints (from get_tools) are supplied, guideline bullets are
// attributed to the plugin that registered them via exact string match
// against each tool's promptGuidelines.

import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
export interface PromptSection {
  key: string;
  labelKey?: string;
  label?: string;
  detail?: string;
  text?: string;
  chars: number;
  tokens: number;
  children?: PromptSection[];
}

export interface ToolHint {
  name: string;
  promptGuidelines?: string[];
  source?: string;
}

export interface SystemPromptAnalysis {
  sections: PromptSection[];
  segments: Array<{
    key: string;
    labelKey?: string;
    label?: string;
    start: number;
    end: number;
  }>;
  totalChars: number;
  totalTokens: number;
}

const DEFAULT_BASE_PREFIX = "You are an expert coding assistant operating inside pi";
const TOOLS_HEADER = "\nAvailable tools:\n";
const TOOLS_TAIL = "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";
const GUIDELINES_HEADER = "\n\nGuidelines:\n";
const CONTEXT_OPEN = "<project_context>";
const CONTEXT_CLOSE = "</project_context>";
const CONTEXT_FILE_PATTERN = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions";
const SKILLS_CLOSE = "</available_skills>";
const SKILL_BLOCK_PATTERN = /<skill>[\s\S]*?<\/skill>/g;
const SKILL_NAME_PATTERN = /<name>([^<]*)<\/name>/;
const CWD_HEADER = "\nCurrent working directory: ";
const DOCS_INTRO = "Pi documentation (read only when";

let _tiktoken: Tiktoken | undefined;
function tiktoken(): Tiktoken {
  if (!_tiktoken) _tiktoken = new Tiktoken(o200kBase);
  return _tiktoken;
}

/**
 * Exact token count using js-tiktoken (OpenAI o200k_base, the same encoding
 * pi's model stack uses), client-safe: the rank table ships as plain data.
 */
export function estimateTokensOf(text: string): number {
  return tiktoken().encode(text, [], []).length;
}

function baseLabelKey(prompt: string): string {
  return prompt.startsWith(DEFAULT_BASE_PREFIX) ? "system.section.base" : "system.section.custom";
}

function toSection(part: Pick<PromptSection, "key" | "labelKey" | "label" | "detail"> & { chars: number; text?: string }): PromptSection {
  return {
    key: part.key,
    labelKey: part.labelKey,
    label: part.label,
    detail: part.detail,
    text: part.text,
    chars: part.chars,
    tokens: part.text !== undefined ? estimateTokensOf(part.text) : Math.ceil(part.chars / 4),
  };
}

function childrenFromSpans(spans: Array<Pick<PromptSection, "key" | "labelKey" | "label" | "detail"> & { chars: number; text?: string }>): PromptSection[] | undefined {
  if (spans.length === 0) return undefined;
  const children = spans.map(toSection).sort((a, b) => b.tokens - a.tokens);
  return children;
}

/**
 * Splits a composed system prompt into sections: base/persona, the tools
 * block, the guidelines zone (attributed per plugin when tool hints are
 * given), per-file project context, skills, and the working-directory tail.
 * Marker scaffolding the labels cannot account for lands in "other", so
 * sum(top-level sections) always equals the whole prompt.
 */
export function analyzeSystemPrompt(prompt: string, tools: ToolHint[] = []): SystemPromptAnalysis {
  const totalChars = prompt.length;
  if (totalChars === 0) {
    return { sections: [], segments: [], totalChars: 0, totalTokens: 0 };
  }

  const guidelineToTool = new Map<string, ToolHint>();
  for (const tool of tools) {
    for (const guideline of tool.promptGuidelines ?? []) {
      if (!guidelineToTool.has(guideline)) guidelineToTool.set(guideline, tool);
    }
  }
  const toolSourceByName = new Map<string, string | undefined>();
  for (const tool of tools) toolSourceByName.set(tool.name, tool.source);

  interface Group {
    key: string;
    labelKey?: string;
    label?: string;
    detail?: string;
    chars: number;
    text: string;
  }
  const newGroup = (part: Omit<Group, "chars" | "text">): Group => ({ ...part, chars: 0, text: "" });
  const spans: Array<Pick<PromptSection, "key" | "labelKey" | "label" | "detail"> & { start: number; end: number; children?: PromptSection[] }> = [];

  // Skills block (appended after project context, before the cwd tail),
  // with one child per skill entry.
  const skillsStart = prompt.indexOf(SKILLS_HEADER);
  let skillsEnd = -1;
  if (skillsStart >= 0) {
    const close = prompt.indexOf(SKILLS_CLOSE, skillsStart);
    if (close >= 0) {
      skillsEnd = close + SKILLS_CLOSE.length;
      const block = prompt.slice(skillsStart, skillsEnd);
      const groups: Array<Pick<PromptSection, "key" | "label" | "detail"> & { chars: number; text: string }> = [];
      SKILL_BLOCK_PATTERN.lastIndex = 0;
      for (let match = SKILL_BLOCK_PATTERN.exec(block); match; match = SKILL_BLOCK_PATTERN.exec(block)) {
        const name = SKILL_NAME_PATTERN.exec(match[0])?.[1] ?? "skill";
        groups.push({ key: `skill:${name}`, label: name, chars: match[0].length, text: match[0] });
      }
      spans.push({
        key: "skills",
        labelKey: "system.section.skills",
        start: skillsStart,
        end: skillsEnd,
        children: childrenFromSpans(groups),
      });
    }
  }

  // Working-directory tail (last line of the prompt). Extension-injected
  // sections (deepseek router, ACP context rules, etc.) may be appended
  // after the cwd line; the cwd span stops at the first such marker so
  // injected content lands in "other" instead of inflating cwd.
  const cwdStart = prompt.lastIndexOf(CWD_HEADER);
  if (cwdStart >= 0 && (skillsStart < 0 || cwdStart > skillsStart)) {
    const injectionMarkers = [
      "<!-- pi-deepseek-router:start -->",
      "<!-- ", "\nACP context management\n", "\n## DeepSeek Router\n"
    ];
    let cwdEnd = totalChars;
    for (const marker of injectionMarkers) {
      const at = prompt.indexOf(marker, cwdStart);
      if (at >= 0 && at < cwdEnd) cwdEnd = at;
    }
    spans.push({
      key: "cwd",
      labelKey: "system.section.cwd",
      start: cwdStart,
      end: cwdEnd,
      detail: prompt.slice(cwdStart + CWD_HEADER.length, cwdEnd),
    });
  }

  // Project context block: one group with a child per wrapped file; the
  // wrapper scaffolding is counted in the group itself.
  const contextStart = prompt.indexOf(CONTEXT_OPEN);
  if (contextStart >= 0 && (skillsStart < 0 || contextStart < skillsStart)) {
    const contextEnd = prompt.indexOf(CONTEXT_CLOSE, contextStart);
    if (contextEnd >= 0) {
      const blockEnd = contextEnd + CONTEXT_CLOSE.length;
      const block = prompt.slice(contextStart, blockEnd);
      const groups: Array<Pick<PromptSection, "key" | "label" | "detail"> & { chars: number }> = [];
      CONTEXT_FILE_PATTERN.lastIndex = 0;
      for (let match = CONTEXT_FILE_PATTERN.exec(block); match; match = CONTEXT_FILE_PATTERN.exec(block)) {
        groups.push({
          key: `context:${match[1]}`,
          label: match[1],
          chars: match[0].length,
        });
      }
      spans.push({
        key: "context",
        labelKey: "system.section.context",
        start: contextStart,
        end: blockEnd,
        children: childrenFromSpans(groups),
      });
    }
  }

  // Head of the prompt: template intro, tools block, then the guidelines
  // zone where pi core bullets mix with extension-injected ones.
  const headEnd = [contextStart, skillsStart, cwdStart]
    .filter((v) => v >= 0)
    .reduce((a, b) => Math.min(a, b), totalChars);
  const baseSpan = (start: number, end: number) => ({
    key: "base",
    labelKey: baseLabelKey(prompt),
    start,
    end,
  });

  const carves: Array<Pick<PromptSection, "key" | "labelKey" | "label" | "detail"> & { start: number; end: number; children?: PromptSection[] }> = [];
  const toolsStart = prompt.indexOf(TOOLS_HEADER);
  const toolsTailIdx = toolsStart >= 0 ? prompt.indexOf(TOOLS_TAIL, toolsStart) : -1;
  const toolsEnd = toolsTailIdx >= 0 ? toolsTailIdx + TOOLS_TAIL.length : -1;
  if (toolsStart >= 0 && toolsEnd > toolsStart && toolsStart < headEnd) {
    const blockStart = toolsStart + 1;
    const block = prompt.slice(blockStart, toolsEnd);
    const lines = block.split("\n");
    const groups: Array<Pick<PromptSection, "key" | "label" | "detail"> & { chars: number; text: string }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      const toolMatch = /^- ([^:]+): /.exec(lines[i]);
      if (!toolMatch) continue;
      const name = toolMatch[1].trim();
      groups.push({
        key: `tool:${name}`,
        label: name,
        detail: toolSourceByName.get(name),
        chars: lines[i].length + (i < lines.length - 1 ? 1 : 0),
        text: lines[i] + (i < lines.length - 1 ? "\n" : ""),
      });
    }
    carves.push({
      key: "tools",
      labelKey: "system.section.tools",
      start: blockStart,
      end: toolsEnd,
      children: childrenFromSpans(groups),
    });
  }

  const guideSearchFrom = toolsEnd > toolsStart ? toolsEnd : 0;
  const guideStart = prompt.indexOf(GUIDELINES_HEADER, guideSearchFrom);
  if (guideStart >= 0 && guideStart < headEnd) {
    const blockStart = guideStart + "\n\n".length;
    const block = prompt.slice(blockStart, headEnd);
    const groups = new Map<string, Group>();
    const docsStart = block.indexOf(DOCS_INTRO);
    let cursor = 0;
    while (cursor < block.length) {
      const nextNewline = block.indexOf("\n", cursor);
      const lineEnd = nextNewline >= 0 ? nextNewline : block.length;
      const line = block.slice(cursor, lineEnd);
      let group: Group;
      if (docsStart >= 0 && cursor >= docsStart) {
        group = groups.get("pi-docs") ?? newGroup({ key: "pi-docs", labelKey: "system.section.docs" });
      } else if (line.startsWith("- ")) {
        const tool = guidelineToTool.get(line.slice(2));
        if (tool) {
          const key = `ext:${tool.source ?? tool.name}`;
          group = groups.get(key)
            ?? newGroup({ key, label: tool.source ?? tool.name, detail: "" });
          group.detail = group.detail
            ? (group.detail.split(", ").includes(tool.name) ? group.detail : `${group.detail}, ${tool.name}`)
            : tool.name;
        } else {
          group = groups.get("pi-core") ?? newGroup({ key: "pi-core", labelKey: "system.section.core" });
        }
      } else {
        group = groups.get("pi-core") ?? newGroup({ key: "pi-core", labelKey: "system.section.core" });
      }
      group.chars += lineEnd - cursor + (nextNewline >= 0 ? 1 : 0);
      group.text += line + (nextNewline >= 0 ? "\n" : "");
      groups.set(group.key, group);
      cursor = lineEnd + 1;
    }
    carves.push({
      key: "guidelines",
      labelKey: "system.section.guidelines",
      start: blockStart,
      end: headEnd,
      children: childrenFromSpans(Array.from(groups.values())),
    });
  }
  carves.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const carve of carves) {
    if (carve.start > cursor) spans.push(baseSpan(cursor, carve.start));
    spans.push(carve);
    cursor = Math.max(cursor, carve.end);
  }
  if (headEnd > cursor) spans.push(baseSpan(cursor, headEnd));

  // Merge spans per key and account for everything the markers missed.
  const accounted = new Array<boolean>(totalChars).fill(false);
  const merged = new Map<string, PromptSection>();
  const makeSection = (part: Parameters<typeof toSection>[0]): PromptSection => {
    return toSection(part);
  };
  for (const span of spans) {
    if (span.end > span.start) {
      for (let i = span.start; i < span.end; i += 1) accounted[i] = true;
    }
    const spanText = prompt.slice(span.start, span.end);
    const existing = merged.get(span.key);
    if (existing) {
      existing.chars += Math.max(0, span.end - span.start);
      existing.text = (existing.text ?? "") + spanText;
      existing.tokens = estimateTokensOf(existing.text);
    } else {
      const section = makeSection({ key: span.key, labelKey: span.labelKey, label: span.label, detail: span.detail, chars: Math.max(0, span.end - span.start), text: spanText });
      if (span.children && span.children.length > 0) section.children = span.children;
      merged.set(span.key, section);
    }
  }

  let otherChars = 0;
  let otherText = "";
  for (let i = 0; i < totalChars; i += 1) {
    if (!accounted[i]) {
      otherChars += 1;
      otherText += prompt[i];
    }
  }
  if (otherChars > 0) {
    merged.set("other", toSection({ key: "other", labelKey: "system.section.other", chars: otherChars, text: otherText }));
  }

  const sections = Array.from(merged.values());
  // Parents with children should read as the sum of their children; the
  // scaffolding delta (intro text, wrapper tags) rolls into "other" so the
  // visible numbers add up while totalTokens stays exact.
  const otherTally = merged.get("other") ?? { key: "other", labelKey: "system.section.other", chars: 0, tokens: 0 } as PromptSection;
  for (const section of sections) {
    if (section.children && section.children.length > 0) {
      const childSum = section.children.reduce((sum, child) => sum + child.tokens, 0);
      if (section.tokens > childSum) {
        otherTally.tokens += section.tokens - childSum;
        section.tokens = childSum;
      }
    }
  }
  // "other" absorbs the exact residual so top-level sections always sum to
  // totalTokens: BPE merging means child estimates can slightly exceed the
  // parent's exact count, so the delta above can drift by a token or two.
  if (!merged.has("other") && otherTally.tokens > 0) merged.set("other", otherTally);
  const totalTokens = estimateTokensOf(prompt);
  const otherIdx = sections.findIndex((section) => section.key === "other");
  if (otherIdx >= 0) {
    const rest = sections.reduce((sum, section, index) => (index === otherIdx ? sum : sum + section.tokens), 0);
    sections[otherIdx].tokens = Math.max(0, totalTokens - rest);
  }
  sections.sort((a, b) => b.tokens - a.tokens);

  // Build ordered non-overlapping segments that fully cover the prompt:
  // every span contributes its range; gaps between spans land in "other".
  const ordered = spans
    .map((span) => ({ key: span.key, labelKey: span.labelKey, label: span.label, start: span.start, end: span.end }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: SystemPromptAnalysis["segments"] = [];
  let segmentCursor = 0;
  for (const segment of ordered) {
    if (segment.start > segmentCursor) {
      segments.push({ key: "other", labelKey: "system.section.other", start: segmentCursor, end: segment.start });
    }
    if (segment.end > segmentCursor) {
      segments.push(segment);
      segmentCursor = segment.end;
    }
  }
  if (segmentCursor < totalChars) {
    segments.push({ key: "other", labelKey: "system.section.other", start: segmentCursor, end: totalChars });
  }

  return { sections, segments, totalChars, totalTokens: estimateTokensOf(prompt) };
}
