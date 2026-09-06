/**
 * Some OpenAI-compatible providers (e.g. MiniMax on gmi-serving relays) return
 * reasoning inline in the assistant text instead of a separate reasoning field.
 * pi stores it as a plain text block, so the UI can't tell reasoning apart from
 * the real answer. This module recovers the split at render time — session
 * files stay untouched (raw provider output is preserved verbatim).
 */

export interface ThinkTagSplit {
  /** Reasoning captured from inside the think tags. */
  thinking: string;
  /** Everything after the closing tag; null means "text was pure reasoning". */
  answer: string | null;
}

export function splitThinkTaggedText(text: string): ThinkTagSplit | null {
  if (!text.startsWith("<think>")) return null;
  const end = text.indexOf("</think>");
  if (end !== -1) {
    return {
      thinking: text.slice("<think>".length, end),
      answer: text.slice(end + "</think>".length),
    };
  }
  // Unclosed (still streaming): everything after the opening tag is reasoning.
  return {
    thinking: text.slice("<think>".length),
    answer: null,
  };
}

/**
 * Split a text block whose text is wrapped in think tags into
 * [thinking, answer] content blocks. Returns null when no split applies
 * (no tag, or tag not at the start, or nothing left after trimming).
 */
export function splitThinkTextBlock(
  block: { type: "text"; text: string },
): Array<{ type: "thinking"; thinking: string; thinkingSignature: undefined } | { type: "text"; text: string }> | null {
  const split = splitThinkTaggedText(block.text);
  if (!split) return null;
  const blocks: Array<{ type: "thinking"; thinking: string; thinkingSignature: undefined } | { type: "text"; text: string }> = [];
  if (split.thinking.trim().length > 0) {
    blocks.push({ type: "thinking", thinking: split.thinking, thinkingSignature: undefined });
  }
  if (split.answer !== null && split.answer.trim().length > 0) {
    blocks.push({ type: "text", text: split.answer });
  }
  if (blocks.length === 0) return null;
  return blocks;
}
