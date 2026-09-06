// Breaks a composed pi system prompt into labeled sections and estimates
// token counts with pi's own heuristic (ceil(chars / 4), see
// pi-agent-core's estimateTokens). Client-safe: no SDK imports.

export interface PromptSection {
  key: string;
  labelKey: string;
  detail?: string;
  chars: number;
  tokens: number;
}

export interface SystemPromptAnalysis {
  sections: PromptSection[];
  totalChars: number;
  totalTokens: number;
}

const DEFAULT_BASE_PREFIX = "You are an expert coding assistant operating inside pi";
const TOOLS_HEADER = "\nAvailable tools:\n";
const TOOLS_TAIL = "\n\nIn addition to the tools";
const GUIDELINES_HEADER = "\n\nGuidelines:\n";
const CONTEXT_OPEN = "<project_context>";
const CONTEXT_CLOSE = "</project_context>";
const CONTEXT_FILE_PATTERN = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions";
const SKILLS_CLOSE = "</available_skills>";
const CWD_HEADER = "\nCurrent working directory: ";

export function estimateTokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

function baseLabelKey(prompt: string): string {
  return prompt.startsWith(DEFAULT_BASE_PREFIX) ? "system.section.base" : "system.section.custom";
}

interface Span {
  key: string;
  labelKey: string;
  detail?: string;
  start: number;
  end: number;
}

/**
 * Splits a composed system prompt into sections: base/persona, the tools
 * block, one entry per project context file, skills, and the working-directory
 * tail. Marker scaffolding the labels cannot account for lands in "other", so
 * sum(sections) always equals the whole prompt.
 */
export function analyzeSystemPrompt(prompt: string): SystemPromptAnalysis {
  const totalChars = prompt.length;
  if (totalChars === 0) {
    return { sections: [], totalChars: 0, totalTokens: 0 };
  }

  const spans: Span[] = [];

  // Skills block (appended after project context, before the cwd tail).
  const skillsStart = prompt.indexOf(SKILLS_HEADER);
  let skillsEnd = -1;
  if (skillsStart >= 0) {
    const close = prompt.indexOf(SKILLS_CLOSE, skillsStart);
    if (close >= 0) {
      skillsEnd = close + SKILLS_CLOSE.length;
      spans.push({ key: "skills", labelKey: "system.section.skills", start: skillsStart, end: skillsEnd });
    }
  }

  // Working-directory tail (last line of the prompt).
  const cwdStart = prompt.lastIndexOf(CWD_HEADER);
  if (cwdStart >= 0 && (skillsStart < 0 || cwdStart > skillsStart)) {
    spans.push({
      key: "cwd",
      labelKey: "system.section.cwd",
      start: cwdStart,
      end: totalChars,
      detail: prompt.slice(cwdStart + CWD_HEADER.length),
    });
  }

  // Project context block: one section per wrapped file; the wrapper
  // scaffolding stays unmarked and flows into "other".
  const contextStart = prompt.indexOf(CONTEXT_OPEN);
  if (contextStart >= 0 && (skillsStart < 0 || contextStart < skillsStart)) {
    const contextEnd = prompt.indexOf(CONTEXT_CLOSE, contextStart);
    if (contextEnd >= 0) {
      const block = prompt.slice(contextStart, contextEnd + CONTEXT_CLOSE.length);
      CONTEXT_FILE_PATTERN.lastIndex = 0;
      for (let match = CONTEXT_FILE_PATTERN.exec(block); match; match = CONTEXT_FILE_PATTERN.exec(block)) {
        const fileStart = contextStart + match.index;
        spans.push({
          key: `context:${match[1]}`,
          labelKey: "system.section.context",
          detail: match[1],
          start: fileStart,
          end: fileStart + match[0].length,
        });
      }
    }
  }

  // Head of the prompt: template intro, tools block, then a guidelines zone
  // where pi's core guidelines mix with extension-injected guidelines and
  // appended prompt text. Base is split around the carved spans so sections
  // never overlap.
  const headEnd = [contextStart, skillsStart, cwdStart]
    .filter((v) => v >= 0)
    .reduce((a, b) => Math.min(a, b), totalChars);
  const baseSpan = (start: number, end: number): Span => ({
    key: "base",
    labelKey: baseLabelKey(prompt),
    start,
    end,
  });
  const carves: Span[] = [];
  const toolsStart = prompt.indexOf(TOOLS_HEADER);
  const toolsEnd = toolsStart >= 0 ? prompt.indexOf(TOOLS_TAIL, toolsStart) : -1;
  if (toolsStart >= 0 && toolsEnd > toolsStart && toolsStart < headEnd) {
    carves.push({ key: "tools", labelKey: "system.section.tools", start: toolsStart + 1, end: toolsEnd });
  }
  const guideSearchFrom = toolsEnd > toolsStart ? toolsEnd : 0;
  const guideStart = prompt.indexOf(GUIDELINES_HEADER, guideSearchFrom);
  if (guideStart >= 0 && guideStart < headEnd) {
    carves.push({ key: "guidelines", labelKey: "system.section.guidelines", start: guideStart, end: headEnd });
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
  const merged = new Map<string, { key: string; labelKey: string; detail?: string; chars: number }>();
  const accounted = new Array<boolean>(totalChars).fill(false);
  for (const span of spans) {
    if (span.end <= span.start) continue;
    for (let i = span.start; i < span.end; i += 1) accounted[i] = true;
    const existing = merged.get(span.key);
    if (existing) {
      existing.chars += span.end - span.start;
    } else {
      merged.set(span.key, { key: span.key, labelKey: span.labelKey, detail: span.detail, chars: span.end - span.start });
    }
  }

  let otherChars = 0;
  for (let i = 0; i < totalChars; i += 1) {
    if (!accounted[i]) otherChars += 1;
  }
  if (otherChars > 0) {
    merged.set("other", { key: "other", labelKey: "system.section.other", chars: otherChars });
  }

  const sections = Array.from(merged.values())
    .map((s) => ({ ...s, tokens: Math.ceil(s.chars / 4) }))
    .sort((a, b) => b.tokens - a.tokens);

  return { sections, totalChars, totalTokens: estimateTokensOf(prompt) };
}
