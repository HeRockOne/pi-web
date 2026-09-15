"use client";

import { useState } from "react";

import { colorForProvider } from "../lib/usage-stats-format";
import { analyzeSystemPrompt, type PromptSection, type ToolHint } from "../lib/system-prompt-analysis";
import type { ToolEntry } from "../lib/tool-presets";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const SYNTHETIC_SOURCE_LABELS = new Set(["inline", "builtin"]);

interface Props {
  loading: boolean;
  prompt: string | null;
  tools: ToolEntry[] | null;
  translate: Translate;
}

function toToolHints(tools: ToolEntry[] | null): ToolHint[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    promptGuidelines: tool.promptGuidelines,
    source: tool.sourceInfo?.source?.replace(/^npm:/, ""),
  }));
}

function SectionRow({
  section,
  depth,
  totalTokens,
  expanded,
  onToggle,
  translate,
}: {
  section: PromptSection;
  depth: number;
  totalTokens: number;
  expanded: boolean;
  onToggle: () => void;
  translate: Translate;
}) {
  const label = section.labelKey
    ? translate(section.labelKey)
    : section.label && SYNTHETIC_SOURCE_LABELS.has(section.label)
      ? translate("system.section.builtin")
      : section.label ?? section.key;
  const percent = totalTokens > 0 ? Math.round((section.tokens / totalTokens) * 100) : 0;
  const color = colorForProvider(section.key);
  const hasChildren = Boolean(section.children && section.children.length > 0);
  const isChild = depth > 0;
  const row = (
    <>
      <span
        className="system-prompt-composition-dot"
        style={{ background: color, opacity: isChild ? 0.65 : 1 }}
      />
      {hasChildren ? (
        <span className={`system-prompt-composition-chevron${expanded ? " open" : ""}`} aria-hidden="true">▶</span>
      ) : null}
      <span className="system-prompt-composition-label">
        {label}
        {section.detail ? <span className="system-prompt-composition-path">{section.detail}</span> : null}
      </span>
      <span className="system-prompt-composition-numbers">
        ≈ {section.tokens.toLocaleString("en-US")} tokens · {percent}%
      </span>
    </>
  );
  if (!hasChildren) {
    return <li className={isChild ? "is-child" : undefined}>{row}</li>;
  }
  return (
    <li className={isChild ? "is-child has-children" : "has-children"}>
      <button
        type="button"
        className="system-prompt-composition-row"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {row}
      </button>
      {expanded ? (
        <ul className="system-prompt-composition-list is-nested">
          {section.children!.map((child) => (
            <SectionRow
              key={child.key}
              section={child}
              depth={depth + 1}
              totalTokens={totalTokens}
              expanded={false}
              onToggle={() => {}}
              translate={translate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PromptComposition({ prompt, tools, translate }: { prompt: string; tools: ToolEntry[] | null; translate: Translate }) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [compositionExpanded, setCompositionExpanded] = useState(false);
  const analysis = analyzeSystemPrompt(prompt, toToolHints(tools));
  if (analysis.sections.length === 0) return null;

  const toggle = (key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const rows = analysis.sections.map((section) => ({
    section,
    color: colorForProvider(section.key),
    percent: analysis.totalTokens > 0 ? Math.round((section.tokens / analysis.totalTokens) * 100) : 0,
  }));

  return (
    <div className="system-prompt-composition">
      <button
        type="button"
        className="system-prompt-composition-head"
        aria-expanded={compositionExpanded}
        onClick={() => setCompositionExpanded((current) => !current)}
      >
        <span className={`system-prompt-composition-chevron${compositionExpanded ? " open" : ""}`} aria-hidden="true">▶</span>
        <span className="system-prompt-composition-title">{translate("system.composition")}</span>
        <span
          className="system-prompt-composition-total"
          title={translate("system.compositionHint")}
        >
          ≈ {analysis.totalTokens.toLocaleString("en-US")} tokens
        </span>
      </button>
      <div
        className="system-prompt-composition-bar"
        role="img"
        aria-label={translate("system.composition")}
      >
        {rows.map(({ section, color }) => (
          <span
            key={section.key}
            style={{
              flexGrow: Math.max(section.tokens, 1),
              flexBasis: 0,
              minWidth: 3,
              background: color,
            }}
            title={`${section.labelKey ? translate(section.labelKey) : section.label} ≈${section.tokens.toLocaleString("en-US")}`}
          />
        ))}
      </div>
      {compositionExpanded ? (
        <ul className="system-prompt-composition-list">
          {rows.map(({ section }) => (
            <SectionRow
              key={section.key}
              section={section}
              depth={0}
              totalTokens={analysis.totalTokens}
              expanded={expandedKeys.has(section.key)}
              onToggle={() => toggle(section.key)}
              translate={translate}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SystemPromptPanel({ loading, prompt, tools, translate }: Props) {
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      {prompt ? (
        <PromptComposition prompt={prompt} tools={tools} translate={translate} />
      ) : null}
      <div className="system-prompt-scroll">
        {prompt ? (
          <div className="system-prompt-text">{prompt}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 220px;
          flex-direction: column;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
        .system-prompt-composition {
          margin: 12px 16px 0;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: color-mix(in srgb, var(--bg) 55%, var(--bg-panel));
          min-height: 0;
          overflow-y: auto;
        }
        .system-prompt-composition-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          width: 100%;
          padding: 2px 4px;
          background: none;
          border: none;
          border-radius: 4px;
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;
          transition: background 0.1s;
        }
        .system-prompt-composition-head:hover {
          background: var(--bg-hover);
        }
        .system-prompt-composition-head .system-prompt-composition-chevron {
          width: 12px;
          font-size: 10px;
        }
        .system-prompt-composition-title {
          color: var(--text);
          font-size: 12px;
          font-weight: 600;
        }
        .system-prompt-composition-total {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          cursor: help;
        }
        .system-prompt-composition-bar {
          display: flex;
          margin-top: 8px;
          height: 8px;
          border-radius: 4px;
          overflow: hidden;
          background: var(--border);
          gap: 1px;
        }
        .system-prompt-composition-list {
          list-style: none;
          margin: 8px 0 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .system-prompt-composition-list > li {
          min-width: 0;
        }
        .system-prompt-composition-list > li:not(.has-children) {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 2px 0 2px 4px;
        }
        .system-prompt-composition-list .is-child {
          padding-left: 8px;
        }
        .system-prompt-composition-row {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 2px 0 2px 4px;
          background: none;
          border: none;
          border-radius: 4px;
          color: inherit;
          font-size: inherit;
          cursor: pointer;
          text-align: left;
          transition: background 0.1s;
        }
        .system-prompt-composition-row:hover {
          background: var(--bg-hover);
        }
        .system-prompt-composition-list .is-child .system-prompt-composition-label,
        .system-prompt-composition-list .is-child .system-prompt-composition-numbers {
          font-size: 10.5px;
          color: var(--text-muted);
        }
        .system-prompt-composition-chevron {
          flex-shrink: 0;
          display: inline-block;
          width: 8px;
          font-size: 8px;
          color: var(--text-dim);
          transition: transform 0.12s;
        }
        .system-prompt-composition-chevron.open {
          transform: rotate(90deg);
        }
        .system-prompt-composition-dot {
          flex-shrink: 0;
          width: 8px;
          height: 8px;
          border-radius: 2px;
        }
        .system-prompt-composition-label {
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
        }
        .system-prompt-composition-path {
          margin-left: 6px;
          color: var(--text-dim);
          font-family: var(--font-mono);
          font-size: 10px;
        }
        .system-prompt-composition-numbers {
          flex-shrink: 0;
          margin-left: 8px;
          white-space: nowrap;
          font-family: var(--font-mono);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        .system-prompt-composition-list.is-nested {
          margin: 2px 0 4px;
          padding-left: 10px;
          gap: 3px;
          border-left: 1px solid var(--border);
        }
        .system-prompt-composition-list.is-nested > li {
          padding-right: 6px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: color-mix(in srgb, var(--bg) 35%, var(--bg-panel));
        }
      `}</style>
    </section>
  );
}
