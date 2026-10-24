"use client";

import { memo, useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { MarkdownBody } from "./MarkdownBody";
import { ImagePreview } from "./ImagePreview";
import { ThinkingIcon } from "./ThinkingIcon";
import { copyText } from "@/lib/clipboard";
import { formatCost, formatPercent, formatTokens, formatTokensExact } from "@/lib/usage-stats-format";
import { formatTurnDuration } from "@/lib/turn-duration";
import { promptTokens, totalTokens, type TurnUsage } from "@/lib/turn-usage";
import { useI18n } from "@/hooks/useI18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { getAssistantErrorMessage, getDisplayableAssistantBlocks, getThinkingPreview } from "@/lib/message-display";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import { isEditToolName } from "@/lib/tool-names";
import { CODEMODE_TOOL_NAME, codemodeCalls, codemodeScript, codemodeScriptPreview, stripCodemodeHeader } from "@/lib/codemode-view";
import { CodemodeCallList } from "./CodemodeToolView";
import { isThinkingExpandedByDefault, THINKING_EXPANDED_EVENT } from "@/lib/thinking-expansion-preference";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import type { WrittenFile } from "@/lib/turn-written-files";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { MorphChevron } from "./Icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SubagentToolDetails } from "@/lib/subagent-extension";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

// CJK chars ~1 token each (GLM/DeepSeek/GPT-o200k); other chars ~4 chars/token.
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;
function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return cjk + rest / 4;
}

interface TokenEstimateCacheEntry {
  text: string;
  tokens: number;
}

export function getTokenEstimateText(block: AssistantContentBlock): string | null {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  if (block.type === "toolCall") return block.rawInput ?? JSON.stringify(block.input ?? {}) ?? "";
  return null;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function estimateUpdatedTokens(previous: TokenEstimateCacheEntry | undefined, text: string): number {
  if (!previous || !text.startsWith(previous.text)) return estimateTokens(text);

  let baseTokens = previous.tokens;
  let suffixStart = previous.text.length;
  // A streamed delta can complete a surrogate pair that was counted as two
  // non-CJK code points in the previous update.
  if (
    suffixStart > 0
    && suffixStart < text.length
    && isHighSurrogate(previous.text.charCodeAt(suffixStart - 1))
    && isLowSurrogate(text.charCodeAt(suffixStart))
  ) {
    baseTokens -= 1 / 4;
    suffixStart--;
  }
  return baseTokens + estimateTokens(text.slice(suffixStart));
}

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({ children, className, ...props }: React.ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }
  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 300;

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (message: UserMessage) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
  /** An agent run is active in this session — enables live tool timing after message end. */
  runActive?: boolean;
  /** Exact wall-clock start of each tool execution, from SSE tool_execution_start. */
  toolStartTimes?: Map<string, number>;
  /**
   * How long the finished turn took, from lib/turn-duration. Only the turn's
   * final answer carries it: the number describes the whole turn, not one step.
   */
  turnDurationMs?: number;
  /**
   * What the whole turn consumed, from lib/turn-usage — every response in it
   * summed. Like turnDurationMs, only the final answer carries it; the per-message
   * `message.usage` is the fallback for calls without a turn context.
   */
  turnUsage?: TurnUsage;
}


/** Duration display: integers as-is ("8s"), live fractional values with one decimal ("3.4s"). */
function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/** A cylinder, the way the usage card marks a stored quantity. */
function DatabaseIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "0 0 auto" }}
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

/**
 * What the whole turn consumed: a chip under the answer's footnote row that opens
 * the breakdown card (provider, cache hit rate, uncached input, cache read,
 * output, cost). Only the turn's final answer gets one — intermediate responses
 * report their own share, which is not what a round cost.
 */
function TurnUsageFootnote({ usage, provider, model }: { usage: TurnUsage; provider: string; model: string }) {
  const { t, locale } = useI18n();
  // Hovering previews the card; a click pins it open so a touch screen (which has
  // no hover) can reach it too. Leaving the chip always closes it.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const prompt = promptTokens(usage);
  const hitRate = prompt > 0 ? usage.cacheRead / prompt : null;
  const rows: { label: string; value: string }[] = [
    { label: t("chat.turnUsageProvider"), value: `${provider}/${model}` },
    { label: t("chat.turnUsageCacheHit"), value: hitRate === null ? "—" : formatPercent(hitRate, 1) },
    { label: t("chat.turnUsageInput"), value: `${formatTokensExact(usage.input, locale)} tok` },
    { label: t("chat.turnUsageCacheRead"), value: `${formatTokensExact(usage.cacheRead, locale)} tok` },
    { label: t("chat.turnUsageOutput"), value: `${formatTokensExact(usage.output, locale)} tok` },
    // What the whole turn was billed: the sum of every response's cost in it.
    { label: t("session.cost"), value: formatCost(usage.costTotal) },
  ];

  return (
    <span
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPinned(false);
      }}
    >
      <button
        type="button"
        onClick={() => setPinned(true)}
        title={t("chat.turnUsage")}
        aria-label={t("chat.turnUsage")}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "1px 7px",
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--text-dim)",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          cursor: "default",
        }}
      >
        <DatabaseIcon />
        {t("chat.turnUsageShort")} {formatTokens(totalTokens(usage), locale)} tok
      </button>
      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 60,
            minWidth: 252,
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            boxShadow: "0 10px 28px rgba(0,0,0,0.18)",
            color: "var(--text)",
            fontSize: 12,
            cursor: "default",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
            <DatabaseIcon size={13} />
            <span style={{ flex: 1, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("chat.turnUsage")}</span>
            <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {formatTokensExact(totalTokens(usage), locale)} tok
            </span>
          </div>
          <div style={{ height: 1, background: "var(--border)", margin: "0 -12px 8px" }} />
          {rows.map((row) => (
            <div key={row.label} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "2px 0" }}>
              <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** Turn totals are rebuilt on every render, so memo compares them field by field. */
function sameTurnUsage(a?: TurnUsage, b?: TurnUsage): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead
    && a.cacheWrite === b.cacheWrite && a.costTotal === b.costTotal;
}

export function getModelDisplayName(
  provider: string,
  responseModel: string,
  modelNames?: Record<string, string>,
): string {
  const normalizedProvider = provider.toLowerCase();
  const normalizedResponse = responseModel.toLowerCase();
  const configured = Object.entries(modelNames ?? {}).flatMap(([key, name]) => {
    const separator = key.indexOf(":");
    return separator > 0 && key.slice(0, separator).toLowerCase() === normalizedProvider
      ? [{ id: key.slice(separator + 1).toLowerCase(), name }]
      : [];
  });
  return configured.find((model) => model.id === normalizedResponse)?.name
    ?? configured.find((model) => normalizedResponse.endsWith(`/${model.id}`))?.name
    ?? Object.entries(modelNames ?? {}).find(([key]) => key.toLowerCase() === normalizedResponse)?.[1]
    ?? `${provider}/${responseModel}`;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, cwd, onOpenFile, onOpenSession, entryId, searchBlock, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, sessionId, writtenFiles, runActive, toolStartTimes, turnDurationMs, turnUsage }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} runActive={runActive} toolStartTimes={toolStartTimes} toolResults={toolResults} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} searchBlock={searchBlock} writtenFiles={writtenFiles} turnDurationMs={turnDurationMs} turnUsage={turnUsage} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.onOpenSession === next.onOpenSession
    && prev.entryId === next.entryId
    && prev.searchBlock === next.searchBlock
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.onEditContent === next.onEditContent
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.writtenFiles === next.writtenFiles
    && prev.turnDurationMs === next.turnDurationMs
    && sameTurnUsage(prev.turnUsage, next.turnUsage)
    && prev.sessionId === next.sessionId;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (message: UserMessage) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const copyTarget = commandText ?? content;
  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;
  const isMobile = useIsMobile();

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => {
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
        // pi-ai on-disk format uses flat {data, mimeType} — handle both
        const flat = img as unknown as { data?: string; mimeType?: string };
        const src = img.source
          ? img.source.type === "base64"
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : img.source.url ?? ""
          : flat.data
            ? `data:${flat.mimeType};base64,${flat.data}`
            : "";
        return (
          <ImagePreview key={i} src={src}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  const copyContent = () => {
    copyText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: isMobile ? "94%" : "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
            borderRadius: 12,
            boxShadow: "var(--shadow-sm)",
            padding: "8px 12px",
            fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: "auto",
          }}
        >
          {commandText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "calc(13px + var(--chat-font-size-offset, 0px))",
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</MarkdownBody>
              )}
            </div>
          ) : (
          <>
          {imageBlocksNode}
          {content && <SafeMarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>}
          </>
          )}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canNavigate || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          <div style={{
            display: "flex", gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={copyContent}
               title={t("i18n.copyMessage")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          </div>
          {(canFork || canNavigate) && (
            <div style={{
              display: "flex", gap: 3,
              opacity: (hovered || forking) ? 1 : 0,
              pointerEvents: (hovered || forking) ? "auto" : "none",
              transition: "opacity 0.12s",
            }}>
              {canNavigate && (
                <button
                  onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(editTarget); }}
                   title={t("i18n.editFromHereTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                   {t("i18n.editFromHere")}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                   title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: forking ? "var(--accent)" : "var(--text-dim)",
                    cursor: forking ? "not-allowed" : "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                   {forking ? t("i18n.creating") : t("i18n.newSession")}
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  cwd,
  onOpenFile,
  onOpenSession,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  searchBlock,
  writtenFiles,
  runActive,
  toolStartTimes,
  turnDurationMs,
  turnUsage,
}: {
  message: AssistantMessage;
  /** Streamed model output still growing — the streaming-phase live tick. */
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  /** An agent run is active in this session — enables live tool timing. */
  runActive?: boolean;
  /** Exact wall-clock start of each tool execution, from SSE tool_execution_start. */
  toolStartTimes?: Map<string, number>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  writtenFiles?: WrittenFile[];
  turnDurationMs?: number;
  turnUsage?: TurnUsage;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blockItems = useMemo(() => getDisplayableAssistantBlocks(message, { isStreaming })
    .map((block, originalIndex) => ({ block, originalIndex })), [message, isStreaming]);
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;
  const tokenEstimateCacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const estimatedTokens = useMemo(() => {
    if (!isStreaming) {
      tokenEstimateCacheRef.current = new Map();
      return 0;
    }
    const nextCache = new Map<number, TokenEstimateCacheEntry>();
    let total = 0;
    for (const { block, originalIndex } of blockItems) {
      const text = getTokenEstimateText(block);
      if (text === null) continue;
      const tokens = estimateUpdatedTokens(tokenEstimateCacheRef.current.get(originalIndex), text);
      nextCache.set(originalIndex, { text, tokens });
      total += tokens;
    }
    tokenEstimateCacheRef.current = nextCache;
    return total;
  }, [blockItems, isStreaming]);
  const estimatedTokensRef = useRef(estimatedTokens);
  estimatedTokensRef.current = estimatedTokens;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());
  // Live elapsed seconds for the still-running (last) block while streaming.
  const [liveDurations, setLiveDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // Tool call durations derived from session file timestamps (accurate for completed messages).
  // Prefer the exact SSE execution start; fall back to the assistant message
  // timestamp, which is when generation started — a later overstatement that
  // only applies to historical entries loaded from file.
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      const start = toolStartTimes?.get(callId) ?? message.timestamp;
      if (result.timestamp && start) {
        const secs = Math.round((result.timestamp - start) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp, toolStartTimes]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    // Live timing follows the whole agent run (not just the model stream):
    // tools keep running after message_end / stream end, and their elapsed
    // time must keep ticking until the run settles.
    const active = isStreaming || runActive;
    if (!active) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      setLiveDurations(new Map());
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // The last block is still running — expose its live elapsed seconds.
      const lastIdx = items.length > 0 ? items[items.length - 1].originalIndex : undefined;
      const lastStart = lastIdx !== undefined ? blockStartTimesRef.current.get(lastIdx) : undefined;
      if (lastIdx !== undefined && lastStart !== undefined) {
        setLiveDurations(new Map([[lastIdx, (now - lastStart) / 1000]]));
      }

      const tokens = estimatedTokensRef.current;
      if (tokens === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(tokens / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming, runActive]);

  // Live tool-execution timing: between assistant message end (generation done,
  // tools start) and each tool result, tick elapsed seconds per still-running
  // tool call. This is the phase where the model stream is already over but the
  // bash/tool card would otherwise show no timer until its result landed.
  const [liveToolDurations, setLiveToolDurations] = useState<Map<string, number>>(new Map());
  const toolResultsRef = useRef(toolResults);
  toolResultsRef.current = toolResults;
  const messageTimestampRef = useRef(message.timestamp);
  messageTimestampRef.current = message.timestamp;
  const toolStartTimesRef = useRef(toolStartTimes);
  toolStartTimesRef.current = toolStartTimes;
  useEffect(() => {
    if (!runActive || isStreaming) {
      setLiveToolDurations((prev) => prev.size > 0 ? new Map<string, number>() : prev);
      return;
    }
    const tick = () => {
      const results = toolResultsRef.current;
      const now = Date.now();
      const next = new Map<string, number>();
      for (const { block } of blockItemsRef.current) {
        if (block.type !== "toolCall") continue;
        const id = (block as ToolCallContent).toolCallId;
        if (!id || (results && results.has(id))) continue;
        const start = toolStartTimesRef.current?.get(id) ?? messageTimestampRef.current;
        if (!start) continue;
        const secs = (now - start) / 1000;
        if (secs > 0) next.set(id, secs);
      }
      setLiveToolDurations((prev) => {
        if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev;
        return next;
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [runActive, isStreaming]);

  // Tree rail: consecutive thinking/toolCall blocks hang off one guide line,
  // narration text breaks the rail. Keeps long tool runs readable as a list
  // instead of a stack of bordered cards.
  const railGroups = useMemo(() => {
    const groups: Array<{ rail: boolean; items: Array<{ block: AssistantContentBlock; originalIndex: number }> }> = [];
    for (const item of blockItems) {
      const isRailItem = item.block.type === "toolCall" || item.block.type === "thinking";
      const last = groups[groups.length - 1];
      if (last && last.rail === isRailItem) last.items.push(item);
      else groups.push({ rail: isRailItem, items: [item] });
    }
    return groups;
  }, [blockItems]);

  if (blocks.length === 0 && !isStreaming && !providerError) return null;

  return (
    <div
      data-message-role="assistant"
      data-entry-id={entryId}
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label: intentionally removed — provider/model/thinking are
          session-level facts and repeat on every message. They live in the
          top-bar session panel instead. Only the live streaming estimate
          stays here, because it is genuinely per-message. */}
      {isStreaming && (
      <div
        style={{
          fontSize: 11.5,
          color: "var(--text-dim)",
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >

        {(() => {
          const est = Math.round(estimatedTokens);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("i18n.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {railGroups.map((group, groupIndex) => {
          const renderBlock = ({ block, originalIndex }: { block: AssistantContentBlock; originalIndex: number }) => (
            <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} searchTarget={block === searchBlock} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} liveDuration={liveDurations.get(originalIndex)} liveToolDuration={liveToolDurations.get((block as ToolCallContent).toolCallId ?? "")} blockStart={blockStartTimesRef.current.get(originalIndex)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} />
          );
          if (!group.rail) return group.items.map(renderBlock);
          return (
            <div
              key={`rail-${entryId ?? "stream"}-${groupIndex}`}
              style={{
                borderLeft: "1px solid var(--border)",
                margin: "1px 0 1px 7px",
                padding: "1px 0 1px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 5,
                minWidth: 0,
              }}
            >
              {group.items.map(renderBlock)}
            </div>
          );
        })}
      </div>

      {providerError && (
        <div
          role="alert"
          style={{
            marginTop: blocks.length > 0 ? 8 : 0,
            padding: "7px 10px",
            border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--err) 7%, transparent)",
            color: "var(--err)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {providerError}
        </div>
      )}

      {writtenFiles && writtenFiles.length > 0 && (
        <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />
      )}

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {!isStreaming && turnUsage && (
          <TurnUsageFootnote usage={turnUsage} provider={message.provider} model={message.model} />
        )}
        {!isStreaming && turnDurationMs !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {t("chat.turnDuration", { time: formatTurnDuration(turnDurationMs) })}
          </span>
        )}
        {message.usage && !isStreaming && (showTimestamp || turnUsage !== undefined || turnDurationMs !== undefined) && (() => {
          // This is one request's own hit rate: the share of this response's prompt
          // that came from cache. Only a turn's closer shows it — the final answer
          // (turn usage/duration props) or a standalone last message. Process-group
          // and live-tail intermediates carry none of those, so the dot no longer
          // repeats under every tool row; the card holds the turn's weighted rate.
          const hitTotal = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
          if (!(message.usage.cacheRead > 0) || hitTotal <= 0) return null;
          const rate = message.usage.cacheRead / hitTotal;
          // 缓存命中率是唯一保留在消息底部的内容：它是每条消息都会变的
          // 质量指标，掉档时值得一眼看见。颜色分档由数值决定，不靠 emoji。
          const tone = rate >= 0.9 ? "var(--ok)" : rate >= 0.7 ? "var(--warn)" : "var(--err)";
          return (
            <span
              title={`${t("session.cacheHitRate")} ${formatPercent(rate)}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}
            >
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: tone, flex: "0 0 auto" }} />
              {formatPercent(rate, 1)}
            </span>
          );
        })()}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
             title={t("i18n.copyMessage")}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11, fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
             {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, searchTarget, toolResults, isStreaming, streamingDuration, liveDuration, liveToolDuration, blockStart, toolCallDurations, cwd, onOpenFile, onOpenSession, sessionId, entryId, blockIndex }: { block: AssistantContentBlock; searchTarget?: boolean; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; liveDuration?: number; liveToolDuration?: number; blockStart?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; onOpenSession?: (sessionId: string) => void; sessionId?: string; entryId?: string; blockIndex: number }) {
  if (block.type === "text") {
    return <div data-message-text data-search-target={searchTarget || undefined}><TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} /></div>;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration ?? liveDuration} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    // Prefer the file-based duration; else freeze at result arrival (result ts − block start);
    // else live-tick while the tool is still running.
    const streamedSecs = result?.timestamp !== undefined && blockStart !== undefined
      ? (result.timestamp - blockStart) / 1000
      : undefined;
    const duration = toolCallDurations?.get(tc.toolCallId)
      ?? (streamedSecs !== undefined && streamedSecs > 0.05 ? Math.round(streamedSecs) : undefined)
      ?? (result ? undefined : (liveToolDuration ?? liveDuration));
    return <ToolCallBlock block={tc} result={result} duration={duration} onOpenSession={onOpenSession} />;
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
}

export function ThinkingBlock({ block, duration, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(isThinkingExpandedByDefault);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const preview = getThinkingPreview(block.thinking);

  // Keep already-mounted blocks in sync when the preference changes.
  useEffect(() => {
    const onChange = () => setExpanded(isThinkingExpandedByDefault());
    window.addEventListener(THINKING_EXPANDED_EVENT, onChange);
    return () => window.removeEventListener(THINKING_EXPANDED_EVENT, onChange);
  }, []);

  // Load deferred history content whenever the block is expanded.
  // loadThinkingContent() memoizes in-flight promises and drops failed ones
  // from its cache, so re-running this effect is cheap and a failed load can
  // be retried by collapsing and expanding the block again.
  useEffect(() => {
    if (!expanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(tRef.current("i18n.thinkingUnavailable"));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadThinkingContent(sessionId, entryId, blockIndex)
      .then((value) => {
        if (!cancelled) {
          setContent(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, block.deferred, content, sessionId, entryId, blockIndex]);

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0, flexWrap: "wrap",
      borderRadius: 7,
      padding: "4px 8px",
      fontFamily: "var(--font-mono)",
      fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
      lineHeight: 1.5,
    }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${t("i18n.thinking")}${preview ? `: ${preview}` : ""}`}
        title={t("i18n.thinking")}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: expanded ? 14 : "100%",
          flexShrink: expanded ? 0 : 1,
          minWidth: 0,
          minHeight: "1.5em",
          padding: 0,
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <ThinkingIcon active={expanded} />
        {!expanded && (
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {preview ? <ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml>{preview}</ReactMarkdown> : "..."}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: error ? "var(--err)" : "var(--text-muted)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
           {loading ? t("i18n.loadingThinking") : error ?? (block.deferred ? content : block.thinking)}
        </div>
      )}
      {duration !== undefined && (
        <span style={{ flexShrink: 0, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{formatSeconds(duration)}</span>
      )}
      {expanded && !loading && (
        <div
          style={{
            position: "sticky",
            bottom: 0,
            zIndex: 1,
            flex: "1 0 100%",
            display: "flex",
            justifyContent: "flex-end",
            padding: "4px 0 2px",
          }}
        >
          <button
            type="button"
            onClick={() => setExpanded(false)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 12px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
            {t("i18n.collapse")}
          </button>
        </div>
      )}
    </div>
  );
}

function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}

/** Left-edge status of a flat tool row: pulsing dot while running, check/cross after. */
function ToolCallStatusDot({ pending, isError }: { pending: boolean; isError: boolean }) {
  if (pending) {
    return (
      <span
        aria-hidden="true"
        className="animate-[pulse_1.6s_ease-in-out_infinite]"
        style={{ width: 7, height: 7, borderRadius: 4, background: "var(--warn)", flex: "0 0 auto", margin: "0 2px" }}
      />
    );
  }
  if (isError) {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" style={{ stroke: "var(--err)", flex: "0 0 auto", margin: "0 2px" }}>
        <line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ stroke: "var(--ok)", flex: "0 0 auto", margin: "0 2px" }}>
      <polyline points="2.5 6.5 5 9 9.5 3.5" />
    </svg>
  );
}

function ToolCallBlock({ block, result, duration, onOpenSession }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; onOpenSession?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const inputStr = getToolCallInputText(block);
  const isStreamingInput = block.rawInput !== undefined;
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;
  // A codemode script and the calls it made, instead of the input JSON.
  // Streamed input is still incomplete JSON and keeps the generic view.
  const codemodeCode = block.toolName === CODEMODE_TOOL_NAME && !isStreamingInput ? codemodeScript(block.input) : null;
  const codemode = codemodeCode === null ? null : { code: codemodeCode, ...codemodeCalls(result?.details) };
  // A running script's progress snapshot has calls but no content yet.
  const codemodeRunning = codemode !== null && result !== undefined && result.content.length === 0;
  const codemodeCallCount = codemode ? codemode.calls.length + codemode.omitted : 0;

  // Result display
  const resultContent = result ? (codemode ? stripCodemodeHeader(result.content) : result.content) : [];
  const resultText = result
    ? resultContent.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultImages = getMessageImages(resultContent);
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;
  const subagent = isSubagentToolDetails(result?.details) ? result.details : null;

  return (
    <div style={{ minWidth: 0 }}>
      {/* ── Flat tool row: no card chrome — the rail + status dot carry the structure ── */}
      <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-subtle)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = expanded ? "var(--bg-subtle)" : "transparent"; }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flex: 1,
            minWidth: 0,
            padding: "4px 8px",
            background: expanded ? "var(--bg-subtle)" : "transparent",
            border: "none",
            borderRadius: 7,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            textAlign: "left",
            transition: "background 0.12s",
          }}
        >
          <ToolCallStatusDot pending={!result} isError={isError} />
          <span style={{ color: isError ? "var(--err)" : "var(--text-muted)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
            {block.toolName}
          </span>
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {isStreamingInput ? t("chat.generatingToolInput") : codemode ? codemodeScriptPreview(codemode.code) : getToolPreview(block)}
          </span>
          {codemodeCallCount > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {codemodeCallCount === 1 ? t("codemode.callCountOne") : t("codemode.callCount", { count: codemodeCallCount })}
            </span>
          )}
          {duration !== undefined && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{duration !== undefined ? formatSeconds(duration) : ""}</span>
          )}
          <MorphChevron open={expanded} strokeWidth={1.6} style={{ flexShrink: 0, color: "var(--text-dim)" }} />
        </button>
        {subagent && onOpenSession && (
          <button
            type="button"
            onClick={() => onOpenSession(subagent.sessionId)}
            title={t("subagent.open")}
            aria-label={t("subagent.open")}
            style={{ width: 30, display: "grid", placeItems: "center", border: "none", background: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
          </button>
        )}
      </div>

      {/* ── Expanded detail panel: input args, nested calls, paired result ── */}
      {expanded && (
        <div
          style={{
            margin: "2px 0 2px 4px",
            border: isError ? "1px solid color-mix(in srgb, var(--err) 35%, transparent)" : "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
            background: "var(--bg)",
          }}
        >
          {(isStreamingInput || !isEditTool) && (
            <pre
              style={{
                margin: 0,
                padding: "8px 10px",
                color: "var(--text-muted)",
                fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
                lineHeight: 1.5,
                overflow: "auto",
                background: "var(--bg-subtle)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {codemode ? codemode.code.replace(/\r/g, "").trimEnd() : inputStr}
            </pre>
          )}

          {codemode && (
            <CodemodeCallList calls={codemode.calls} omitted={codemode.omitted} isError={isError} />
          )}

          {result && !codemodeRunning && (
            resultDiff ? (
              <PairedDiffResult
                diff={resultDiff}
              />
            ) : (
              <PairedResult
                text={resultText ?? ""}
                images={resultImages}
                isEmpty={resultIsEmpty}
                isError={isError}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid color-mix(in srgb, var(--ok) 15%, transparent)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;
  // Phones stack the before/after columns into one narrow column instead of
  // squeezing two half-width diff panes side by side.
  const gridColumns = isMobile ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 1fr)";

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: gridColumns,
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
               {isMobile
                 ? <SplitDiffHeader title={file.newPath || file.oldPath || t("i18n.after")} side="right" />
                 : <>
                     <SplitDiffHeader title={file.oldPath || t("i18n.before")} side="left" />
                     <SplitDiffHeader title={file.newPath || t("i18n.after")} side="right" />
                   </>}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: gridColumns }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "color-mix(in srgb, var(--ok) 12%, transparent)"
      : cell.type === "removed"
      ? "color-mix(in srgb, var(--err) 13%, transparent)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "var(--ok)" : cell.type === "removed" ? "var(--err)" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "color-mix(in srgb, var(--ok) 12%, transparent)" :
          kind === "removed" ? "color-mix(in srgb, var(--err) 13%, transparent)" :
          kind === "hunk" ? "rgba(96,165,250,0.12)" :
          "transparent";
        const color =
          kind === "added" ? "#22c55e" :
          kind === "removed" ? "var(--err)" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid #22c55e"
                : kind === "removed"
                ? "3px solid var(--err)"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PairedResult({ text, images, isEmpty, isError }: {
  text: string;
  images: ImageContent[];
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  const showText = !isEmpty || images.length === 0;
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "color-mix(in srgb, var(--err) 30%, transparent)" : "color-mix(in srgb, var(--ok) 15%, transparent)"}`,
        background: isError ? "color-mix(in srgb, var(--err) 4%, transparent)" : "var(--bg-subtle)",
      }}
    >
      {images.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "10px", background: "var(--bg)" }}>
          {images.map((image, index) => {
            const src = imageSource(image);
            if (!src) return null;
            return (
              <ImagePreview
                key={`${src}-${index}`}
                src={src}
                style={{ maxWidth: "100%" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  style={{
                    display: "block",
                    maxWidth: "min(100%, 720px)",
                    maxHeight: 520,
                    borderRadius: 6,
                    objectFit: "contain",
                    border: "1px solid var(--border)",
                  }}
                />
              </ImagePreview>
            );
          })}
        </div>
      )}
      {showText && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: isError ? "var(--err)" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
            fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.5,
            overflow: "auto",
            maxHeight: 400,
            background: "var(--bg)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            fontStyle: isEmpty ? "italic" : "normal",
            opacity: isEmpty ? 0.6 : 1,
          }}
        >
           {isEmpty ? t("i18n.noOutput") : text}
        </pre>
      )}
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            compaction
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: "calc(15px + var(--chat-font-size-offset, 0px))", fontWeight: 700, lineHeight: 1.35 }}>
             {t("i18n.conversationCompacted")}
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: "calc(14px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
             {t("i18n.compactionDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
             <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noSummary")}</span>
          )}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
      </div>
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} />}
       {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
           {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("i18n.hiddenExtensionMessage")}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    <ImagePreview key={i} src={src}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt=""
                        style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                      />
                    </ImagePreview>
                  );
                })}
              </div>
            )}
             {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noMessage")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
             {text ? previewText(text) : t("i18n.showExtensionMessage")}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {isHiddenDisplay
                 ? (contentExpanded ? t("i18n.collapse") : t("i18n.expand"))
                 : (detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails"))}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolCallInputText(block: ToolCallContent): string {
  return block.rawInput ?? JSON.stringify(block.input, null, 2);
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: 11, marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? "loading…" : "view full output"}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: 11, textDecoration: "underline" }}
          >
            download full output
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 11 }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}
