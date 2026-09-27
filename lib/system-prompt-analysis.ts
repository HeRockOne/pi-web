// Breaks a composed pi system prompt into labeled sections and counts
// tokens exactly with js-tiktoken (OpenAI o200k_base — the same encoding
// pi's model stack uses). Client-safe: js-tiktoken/lite is pure JS and
// the rank table ships as plain data; no Node/SDK imports.
//
// Since pi 0.87 the composed prompt is a sequence of named sections joined
// by blank lines: the preamble is bare text and every other section is
// wrapped in a `<name>...</name>` tag pair on its own lines (see
// buildSystemPromptSections in the SDK). Known names map to fixed labels;
// extension-registered sections surface under their own name. When tool
// hints (from get_tools) are supplied, rule bullets are attributed to the
// plugin that registered them via exact string match against each tool's
// promptGuidelines.

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
const CONTEXT_FILE_PATTERN = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const SKILL_BLOCK_PATTERN = /<skill>[\s\S]*?<\/skill>/g;
const SKILL_NAME_PATTERN = /<name>([^<]*)<\/name>/;
const TOOL_LINE_PATTERN = /^- ([^:]+): /;
// Section tags always sit alone on their line; inner markers either carry
// attributes (<project_instructions path=...>), are indented (  <skill>), or
// are inline (<name>x</name>), so this shape only matches section wrappers.
const SECTION_OPEN_LINE = /^<([a-z][a-z0-9_-]*)>$/;
const SECTION_CLOSE_LINE = /^<\/([a-z][a-z0-9_-]*)>$/;

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

interface TaggedSection {
  name: string;
  start: number;
  end: number;
}

/**
 * Finds the top-level `<name>...</name>` section wrappers of a composed
 * 0.87+ prompt. A stack keeps inner bare tags (e.g. <available_skills>)
 * nested inside their parent instead of terminating it; closers that match
 * nothing open (e.g. </project_instructions>, whose opener carries
 * attributes) are ignored. Unterminated tags contribute nothing.
 */
function scanTopLevelSections(prompt: string): TaggedSection[] {
  const sections: TaggedSection[] = [];
  const stack: Array<{ name: string; start: number }> = [];
  let lineStart = 0;
  for (const rawLine of prompt.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const open = SECTION_OPEN_LINE.exec(line);
    const close = SECTION_CLOSE_LINE.exec(line);
    if (open) {
      stack.push({ name: open[1], start: lineStart });
    } else if (close) {
      const top = stack[stack.length - 1];
      if (top && top.name === close[1]) {
        const opened = stack.pop()!;
        if (stack.length === 0) {
          sections.push({ name: opened.name, start: opened.start, end: lineStart + line.length });
        }
      }
    }
    lineStart += rawLine.length + 1;
  }
  return sections;
}

/** Content between a section's opening `<name>\n` and its closing `\n</name>`. */
function taggedSectionContent(prompt: string, section: TaggedSection): string {
  const openLen = section.name.length + 3;
  const closeLen = section.name.length + 4;
  if (section.end - section.start < openLen + closeLen) return "";
  return prompt.slice(section.start + openLen, section.end - closeLen);
}

/** Sections are joined by "\n\n"; fold the join into the following section. */
function spanStartWithJoin(prompt: string, section: TaggedSection): number {
  return section.start >= 2 && prompt.slice(section.start - 2, section.start) === "\n\n"
    ? section.start - 2
    : section.start;
}

interface SectionContext {
  guidelineToTool: Map<string, ToolHint>;
  toolSourceByName: Map<string, string | undefined>;
}

interface Group {
  key: string;
  labelKey?: string;
  label?: string;
  detail?: string;
  chars: number;
  text: string;
}

const newGroup = (part: Omit<Group, "chars" | "text">): Group => ({ ...part, chars: 0, text: "" });

function toolChildren(content: string, ctx: SectionContext): PromptSection[] | undefined {
  const groups: Array<Pick<PromptSection, "key" | "label" | "detail"> & { chars: number; text: string }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const toolMatch = TOOL_LINE_PATTERN.exec(lines[i]);
    if (!toolMatch) continue;
    const name = toolMatch[1].trim();
    groups.push({
      key: `tool:${name}`,
      label: name,
      detail: ctx.toolSourceByName.get(name),
      chars: lines[i].length + (i < lines.length - 1 ? 1 : 0),
      text: lines[i] + (i < lines.length - 1 ? "\n" : ""),
    });
  }
  return childrenFromSpans(groups);
}

function ruleChildren(content: string, ctx: SectionContext): PromptSection[] | undefined {
  const groups = new Map<string, Group>();
  let cursor = 0;
  while (cursor < content.length) {
    const nextNewline = content.indexOf("\n", cursor);
    const lineEnd = nextNewline >= 0 ? nextNewline : content.length;
    const line = content.slice(cursor, lineEnd);
    let group: Group;
    if (line.startsWith("- ")) {
      const tool = ctx.guidelineToTool.get(line.slice(2));
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
  return childrenFromSpans(Array.from(groups.values()));
}

function contextChildren(content: string): PromptSection[] | undefined {
  const groups: Array<Pick<PromptSection, "key" | "label"> & { chars: number }> = [];
  CONTEXT_FILE_PATTERN.lastIndex = 0;
  for (let match = CONTEXT_FILE_PATTERN.exec(content); match; match = CONTEXT_FILE_PATTERN.exec(content)) {
    groups.push({ key: `context:${match[1]}`, label: match[1], chars: match[0].length });
  }
  return childrenFromSpans(groups);
}

function skillChildren(content: string): PromptSection[] | undefined {
  const groups: Array<Pick<PromptSection, "key" | "label"> & { chars: number }> = [];
  SKILL_BLOCK_PATTERN.lastIndex = 0;
  for (let match = SKILL_BLOCK_PATTERN.exec(content); match; match = SKILL_BLOCK_PATTERN.exec(content)) {
    const name = SKILL_NAME_PATTERN.exec(match[0])?.[1] ?? "skill";
    groups.push({ key: `skill:${name}`, label: name, chars: match[0].length });
  }
  return childrenFromSpans(groups);
}

type SectionSpan = Pick<PromptSection, "key" | "labelKey" | "label" | "detail"> & { start: number; end: number; children?: PromptSection[] };

function sectionSpan(prompt: string, section: TaggedSection, ctx: SectionContext): SectionSpan {
  const start = spanStartWithJoin(prompt, section);
  const name = section.name;
  const base = { start, end: section.end };
  if (name === "tools") {
    const content = taggedSectionContent(prompt, section);
    return { ...base, key: "tools", labelKey: "system.section.tools", children: toolChildren(content, ctx) };
  }
  if (name === "rules") {
    const content = taggedSectionContent(prompt, section);
    return { ...base, key: "guidelines", labelKey: "system.section.guidelines", children: ruleChildren(content, ctx) };
  }
  if (name === "docs") {
    return { ...base, key: "pi-docs", labelKey: "system.section.docs" };
  }
  if (name === "addendum") {
    return { ...base, key: "addendum", labelKey: "system.section.addendum" };
  }
  if (name === "project_context") {
    const content = taggedSectionContent(prompt, section);
    return { ...base, key: "context", labelKey: "system.section.context", children: contextChildren(content) };
  }
  if (name === "skills") {
    const content = taggedSectionContent(prompt, section);
    return { ...base, key: "skills", labelKey: "system.section.skills", children: skillChildren(content) };
  }
  if (name === "cwd") {
    const content = taggedSectionContent(prompt, section);
    return { ...base, key: "cwd", labelKey: "system.section.cwd", detail: content.trim() };
  }
  // Extension-registered section: surface it under its own name.
  return { ...base, key: `section:${name}`, label: name };
}

/**
 * Splits a composed system prompt into sections: the bare preamble, the
 * tools block, the rules zone (attributed per plugin when tool hints are
 * given), the docs appendix, any appended prompt, per-file project context,
 * skills, the working directory, and extension-registered sections.
 * Text the tags cannot account for lands in "other", so sum(top-level
 * sections) always equals the whole prompt.
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
  const ctx: SectionContext = { guidelineToTool, toolSourceByName };

  const tagged = scanTopLevelSections(prompt);
  const spans: Array<Pick<PromptSection, "key" | "labelKey" | "label" | "detail"> & { start: number; end: number; children?: PromptSection[] }> = [];
  let cursor = 0;
  let preambleDone = false;
  for (const section of tagged) {
    const start = spanStartWithJoin(prompt, section);
    if (start > cursor) {
      // Text before the first tag is the preamble (base or a fully custom
      // prompt); anything later is scaffolding the tags cannot explain.
      if (!preambleDone) {
        spans.push({ key: "base", labelKey: baseLabelKey(prompt), start: cursor, end: start });
        preambleDone = true;
      } else {
        spans.push({ key: "other", labelKey: "system.section.other", start: cursor, end: start });
      }
    }
    preambleDone = true;
    spans.push(sectionSpan(prompt, section, ctx));
    cursor = section.end;
  }
  if (cursor < totalChars) {
    // No tags at all: the whole prompt is one bare preamble (e.g. a forced
    // system prompt); a bare tail after real sections is unattributable.
    spans.push(preambleDone
      ? { key: "other", labelKey: "system.section.other", start: cursor, end: totalChars }
      : { key: "base", labelKey: baseLabelKey(prompt), start: cursor, end: totalChars });
  }

  // Merge spans per key and account for everything the tags missed.
  const accounted = new Array<boolean>(totalChars).fill(false);
  const merged = new Map<string, PromptSection>();
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
      const section = toSection({ key: span.key, labelKey: span.labelKey, label: span.label, detail: span.detail, chars: Math.max(0, span.end - span.start), text: spanText });
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

  const sections0 = Array.from(merged.values());
  // Parents with children should read as the sum of their children; the
  // scaffolding delta (wrapper tags, intro text) rolls into "other" so the
  // visible numbers add up while totalTokens stays exact.
  const otherTally = merged.get("other") ?? { key: "other", labelKey: "system.section.other", chars: 0, tokens: 0 } as PromptSection;
  for (const section of sections0) {
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
  const sections = Array.from(merged.values());
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
