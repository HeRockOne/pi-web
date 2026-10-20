// Breaks a composed pi system prompt into labeled sections and counts tokens
// with js-tiktoken (o200k_base), the encoding pi-web uses for every number it
// shows. Client-safe: js-tiktoken/lite is pure JS and the rank table ships as
// plain data; no Node/SDK imports.
//
// Since pi 0.87 the composed prompt is a sequence of named sections joined by
// blank lines: the preamble is bare text and every other section is wrapped in
// a `<name>...</name>` tag pair on its own lines (see buildSystemPromptSections
// in the SDK). Known names map to fixed labels; extension-registered sections
// surface under their own name. When tool hints (from get_tools) are supplied,
// rule bullets are attributed to the plugin that registered them via exact
// string match against each tool's promptGuidelines.
//
// Two invariants make the composition panel trustworthy:
//
//  1. Every top-level section owns a contiguous char range and the ranges
//     partition the whole prompt. No text is unowned, so nothing can be
//     silently dropped and no phantom "other" row appears.
//  2. A range's token count is the difference between the token counts of two
//     prefixes of the same prompt, so partitions are exactly additive:
//     sum(children) == parent == whole prompt. Counting each fragment in
//     isolation would break this — BPE merges across a boundary make the parts
//     sum to more than the whole, and rounding `chars / 4` for some fragments
//     makes them sum to less.
//
// Text that genuinely belongs to no named section still surfaces as "other",
// but it is only emitted when it holds real characters.

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
 * Token count of a standalone string using js-tiktoken (o200k_base).
 * Exact for the encoding, but NOT additive across concatenation — for section
 * accounting use the prefix-difference counter built by `makeCounter`.
 */
export function estimateTokensOf(text: string): number {
  return tiktoken().encode(text, [], []).length;
}

function baseLabelKey(prompt: string): string {
  return prompt.startsWith(DEFAULT_BASE_PREFIX) ? "system.section.base" : "system.section.custom";
}

/**
 * Token counter that makes any partition of `prompt` exactly additive.
 * `span(from, to)` returns `tokens(prompt[0..to]) - tokens(prompt[0..from])`,
 * so contiguous spans telescope to the whole-prompt count.
 */
function makeCounter(prompt: string, cuts: number[]): (from: number, to: number) => number {
  const boundaries = Array.from(new Set(cuts.map((cut) => Math.max(0, Math.min(prompt.length, cut))))).sort(
    (a, b) => a - b,
  );
  const at = new Map<number, number>();
  for (const boundary of boundaries) {
    at.set(boundary, boundary === 0 ? 0 : estimateTokensOf(prompt.slice(0, boundary)));
  }
  return (from, to) => {
    const start = at.get(Math.max(0, Math.min(prompt.length, from)));
    const end = at.get(Math.max(0, Math.min(prompt.length, to)));
    if (start === undefined || end === undefined) {
      // A range outside the collected cuts should never happen; fall back to a
      // real count rather than inventing a number.
      return estimateTokensOf(prompt.slice(Math.max(0, from), Math.max(0, to)));
    }
    return Math.max(0, end - start);
  };
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

/** Offset of a section's content start within the whole prompt. */
function contentStartOf(section: TaggedSection): number {
  return section.start + section.name.length + 3;
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

/** A named item inside a parent section, expressed as absolute prompt offsets. */
interface Item {
  key: string;
  labelKey?: string;
  label?: string;
  detail?: string;
  ranges: Array<{ start: number; end: number }>;
}

interface ScannedItems {
  items: Item[];
  /** Parent-relative offsets of every cut, for the counter. */
  cuts: number[];
}

function addRange(item: Item, start: number, end: number): void {
  if (end > start) item.ranges.push({ start, end });
}

function toolItems(content: string, contentStart: number, ctx: SectionContext): ScannedItems {
  const items: Item[] = [];
  const cuts: number[] = [];
  const byName = new Map<string, Item>();
  let lineStart = 0;
  for (const rawLine of content.split("\n")) {
    const lineEnd = lineStart + rawLine.length;
    const toolMatch = TOOL_LINE_PATTERN.exec(rawLine);
    if (toolMatch) {
      const name = toolMatch[1].trim();
      let item = byName.get(name);
      if (!item) {
        item = { key: `tool:${name}`, label: name, detail: ctx.toolSourceByName.get(name), ranges: [] };
        byName.set(name, item);
        items.push(item);
      }
      // Same rule as rules: the terminating newline belongs to the line.
      const itemEnd = contentStart + lineEnd;
      addRange(item, contentStart + lineStart, itemEnd);
      cuts.push(contentStart + lineStart, itemEnd);
    }
    lineStart = lineEnd + 1;
  }
  return { items, cuts };
}

function ruleItems(content: string, contentStart: number, ctx: SectionContext): ScannedItems {
  const items: Item[] = [];
  const cuts: number[] = [];
  const byKey = new Map<string, Item>();
  let cursor = 0;
  while (cursor < content.length) {
    const nextNewline = content.indexOf("\n", cursor);
    const lineEnd = nextNewline >= 0 ? nextNewline : content.length;
    const line = content.slice(cursor, lineEnd);
    let key: string;
    let labelKey: string | undefined;
    let label: string | undefined;
    if (line.startsWith("- ")) {
      const tool = ctx.guidelineToTool.get(line.slice(2));
      if (tool) {
        key = `ext:${tool.source ?? tool.name}`;
        label = tool.source ?? tool.name;
      } else {
        key = "pi-core";
        labelKey = "system.section.core";
      }
    } else {
      key = "pi-core";
      labelKey = "system.section.core";
    }
    let item = byKey.get(key);
    if (!item) {
      item = { key, ...(labelKey ? { labelKey } : {}), ...(label ? { label } : {}), detail: "", ranges: [] };
      byKey.set(key, item);
      items.push(item);
    }
    if (line.startsWith("- ")) {
      const tool = ctx.guidelineToTool.get(line.slice(2));
      if (tool) {
        item.detail = item.detail
          ? item.detail.split(", ").includes(tool.name)
            ? item.detail
            : `${item.detail}, ${tool.name}`
          : tool.name;
      }
    }
    // The newline that ends a line belongs to that line, not to the wrapper.
    addRange(item, contentStart + cursor, contentStart + lineEnd + (nextNewline >= 0 ? 1 : 0));
    cuts.push(contentStart + cursor, contentStart + lineEnd + (nextNewline >= 0 ? 1 : 0));
    cursor = lineEnd + 1;
  }
  return { items, cuts };
}

function contextItems(content: string, contentStart: number): ScannedItems {
  const items: Item[] = [];
  const cuts: number[] = [];
  CONTEXT_FILE_PATTERN.lastIndex = 0;
  for (let match = CONTEXT_FILE_PATTERN.exec(content); match; match = CONTEXT_FILE_PATTERN.exec(content)) {
    const start = contentStart + match.index;
    const end = start + match[0].length;
    items.push({ key: `context:${match[1]}`, label: match[1], ranges: [{ start, end }] });
    cuts.push(start, end);
  }
  return { items, cuts };
}

function skillItems(content: string, contentStart: number): ScannedItems {
  const items: Item[] = [];
  const cuts: number[] = [];
  SKILL_BLOCK_PATTERN.lastIndex = 0;
  for (let match = SKILL_BLOCK_PATTERN.exec(content); match; match = SKILL_BLOCK_PATTERN.exec(content)) {
    const start = contentStart + match.index;
    const end = start + match[0].length;
    const name = SKILL_NAME_PATTERN.exec(match[0])?.[1] ?? "skill";
    items.push({ key: `skill:${name}`, label: name, ranges: [{ start, end }] });
    cuts.push(start, end);
  }
  return { items, cuts };
}

type TopSpan = {
  key: string;
  labelKey?: string;
  label?: string;
  detail?: string;
  start: number;
  end: number;
  items?: ScannedItems;
};

function sectionSpan(prompt: string, section: TaggedSection, ctx: SectionContext): TopSpan {
  const start = spanStartWithJoin(prompt, section);
  const name = section.name;
  const base = { start, end: section.end };
  const contentStart = contentStartOf(section);
  if (name === "tools") {
    return { ...base, key: "tools", labelKey: "system.section.tools", items: toolItems(taggedSectionContent(prompt, section), contentStart, ctx) };
  }
  if (name === "rules") {
    return { ...base, key: "guidelines", labelKey: "system.section.guidelines", items: ruleItems(taggedSectionContent(prompt, section), contentStart, ctx) };
  }
  if (name === "docs") {
    return { ...base, key: "pi-docs", labelKey: "system.section.docs" };
  }
  if (name === "addendum") {
    return { ...base, key: "addendum", labelKey: "system.section.addendum" };
  }
  if (name === "project_context") {
    return { ...base, key: "context", labelKey: "system.section.context", items: contextItems(taggedSectionContent(prompt, section), contentStart) };
  }
  if (name === "skills") {
    return { ...base, key: "skills", labelKey: "system.section.skills", items: skillItems(taggedSectionContent(prompt, section), contentStart) };
  }
  if (name === "cwd") {
    return { ...base, key: "cwd", labelKey: "system.section.cwd", detail: taggedSectionContent(prompt, section).trim() };
  }
  // Extension-registered section: surface it under its own name.
  return { ...base, key: `section:${name}`, label: name };
}

/**
 * Splits a composed system prompt into sections: the bare preamble, the
 * tools block, the rules zone (attributed per plugin when tool hints are
 * given), the docs appendix, any appended prompt, per-file project context,
 * skills, the working directory, and extension-registered sections.
 *
 * The top-level spans partition the prompt, so sum(sections) always equals
 * totalTokens exactly, and within a section the child rows (items plus one
 * scaffolding row for the wrapper tags and intro text) also sum exactly.
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
  const spans: TopSpan[] = [];
  let cursor = 0;
  let preambleDone = false;
  for (const section of tagged) {
    const start = spanStartWithJoin(prompt, section);
    if (start > cursor) {
      // Text before the first tag is the preamble (base or a fully custom
      // prompt); anything later is scaffolding the tags cannot explain.
      spans.push(
        preambleDone
          ? { key: "other", labelKey: "system.section.other", start: cursor, end: start }
          : { key: "base", labelKey: baseLabelKey(prompt), start: cursor, end: start },
      );
      preambleDone = true;
    }
    preambleDone = true;
    spans.push(sectionSpan(prompt, section, ctx));
    cursor = section.end;
  }
  if (cursor < totalChars) {
    // No tags at all: the whole prompt is one bare preamble (e.g. a forced
    // system prompt); a bare tail after real sections is unattributable.
    spans.push(
      preambleDone
        ? { key: "other", labelKey: "system.section.other", start: cursor, end: totalChars }
        : { key: "base", labelKey: baseLabelKey(prompt), start: cursor, end: totalChars },
    );
  }

  // Every cut point we may need, so one counter serves sections and children.
  const cuts: number[] = [0, totalChars];
  for (const span of spans) {
    cuts.push(span.start, span.end);
    for (const cut of span.items?.cuts ?? []) cuts.push(cut);
  }
  const spanTokens = makeCounter(prompt, cuts);

  const sections: PromptSection[] = [];
  for (const span of spans) {
    const chars = Math.max(0, span.end - span.start);
    const tokens = spanTokens(span.start, span.end);
    const section: PromptSection = {
      key: span.key,
      labelKey: span.labelKey,
      label: span.label,
      detail: span.detail,
      text: prompt.slice(span.start, span.end),
      chars,
      tokens,
    };

    const items = span.items?.items ?? [];
    if (items.length > 0) {
      const children: PromptSection[] = [];
      let itemTokens = 0;
      let itemChars = 0;
      for (const item of items) {
        const itemTokenCount = item.ranges.reduce((sum, range) => sum + spanTokens(range.start, range.end), 0);
        const itemCharCount = item.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
        if (itemCharCount === 0) continue;
        itemTokens += itemTokenCount;
        itemChars += itemCharCount;
        children.push({
          key: item.key,
          labelKey: item.labelKey,
          label: item.label,
          detail: item.detail,
          text: item.ranges.map((range) => prompt.slice(range.start, range.end)).join(""),
          chars: itemCharCount,
          tokens: itemTokenCount,
        });
      }

      // The wrapper tags and intro text belong to nobody's item, but they are
      // real tokens. Surface them as their own row instead of losing them.
      const scaffoldChars = chars - itemChars;
      const scaffoldTokens = Math.max(0, tokens - itemTokens);
      if (scaffoldChars > 0 && scaffoldTokens > 0) {
        children.push({
          key: `scaffold:${span.key}`,
          labelKey: "system.section.scaffold",
          chars: scaffoldChars,
          tokens: scaffoldTokens,
        });
      }
      children.sort((a, b) => b.tokens - a.tokens);
      section.children = children;
      section.tokens = children.reduce((sum, child) => sum + child.tokens, 0);
      section.chars = children.reduce((sum, child) => sum + child.chars, 0);
    }

    // A bucket with no characters has nothing to show; drop it rather than
    // render an unexplainable number.
    if (section.chars > 0) sections.push(section);
  }

  sections.sort((a, b) => b.tokens - a.tokens);

  // The spans already partition the prompt, so segments are the spans in
  // reading order. Sorted by start with ties resolved by the wider span.
  const segments = spans
    .filter((span) => span.end > span.start)
    .slice()
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((span) => ({ key: span.key, labelKey: span.labelKey, label: span.label, start: span.start, end: span.end }));

  return { sections, segments, totalChars, totalTokens: estimateTokensOf(prompt) };
}
