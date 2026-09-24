"use client";

import { useState } from "react";

import { colorForProvider } from "../lib/usage-stats-format";
import { analyzeSystemPrompt, type PromptSection, type ToolHint } from "../lib/system-prompt-analysis";
import type { ToolEntry } from "../lib/tool-presets";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const SYNTHETIC_SOURCE_LABELS = new Set(["inline", "builtin"]);


// 固定 section key → 颜色，保证互不重复；未知 key 回退哈希取色。
// 色值走 globals.css 的 --chart-* 变量，与供应商取色同一套深浅色档位。
const SECTION_COLORS: Record<string, string> = {
  base: "var(--text-muted)",
  tools: "var(--chart-1)",
  guidelines: "var(--chart-3)",
  context: "var(--chart-4)",
  skills: "var(--chart-7)",
  cwd: "var(--chart-2)",
  other: "var(--chart-5)",
  custom: "var(--chart-8)",
};

function sectionColor(key: string): string {
  return SECTION_COLORS[key] ?? colorForProvider(key);
}
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
  const color = sectionColor(section.key);
  const hasChildren = Boolean(section.children && section.children.length > 0);
  const hasBody = Boolean(section.text && section.text.trim().length > 0);
  const isChild = depth > 0;
  const expandable = hasChildren || hasBody;
  const row = (
    <>
      <span
        className="system-prompt-composition-dot"
        style={{ background: color, opacity: isChild ? 0.65 : 1 }}
      />
      {expandable ? (
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
  if (!expandable) {
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
        <div className="system-prompt-composition-expanded">
          {hasChildren && section.children ? (
            <ul className="system-prompt-composition-list is-nested">
              {section.children.map((child) => (
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
          {hasBody ? (
            <pre className="system-prompt-composition-body">{section.text}</pre>
          ) : null}
        </div>
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
    color: sectionColor(section.key),
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
  const analysis = prompt ? analyzeSystemPrompt(prompt, toToolHints(tools)) : null;
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      {prompt ? (
        <PromptComposition prompt={prompt} tools={tools} translate={translate} />
      ) : null}
      <div className="system-prompt-scroll">
        {prompt && analysis && analysis.segments.length > 0 ? (
          <table className="system-prompt-body-table">
            <tbody>
              {analysis.segments
                .filter((segment) => prompt.slice(segment.start, segment.end).trim().length > 0)
                .map((segment, index) => {
                const label = segment.labelKey
                  ? translate(segment.labelKey)
                  : segment.label && SYNTHETIC_SOURCE_LABELS.has(segment.label)
                    ? translate("system.section.builtin")
                    : segment.label ?? segment.key;
                const section = analysis.sections.find((s) => s.key === segment.key);
                const percent = analysis.totalTokens > 0 && section
                  ? Math.round((section.tokens / analysis.totalTokens) * 100)
                  : 0;
                return (
                  <tr key={index}>
                    <td className="system-prompt-body-cat">
                      <span className="system-prompt-body-dot" style={{ background: sectionColor(segment.key) }} />
                      <span className="system-prompt-body-label">{label}</span>
                      {section ? (
                        <span
                          className="system-prompt-body-tokens"
                          title={`${section.tokens.toLocaleString("en-US")} tokens · ${percent}%`}
                        >
                          ≈ {section.tokens.toLocaleString("en-US")} tokens
                        </span>
                      ) : null}
                    </td>
                    <td className="system-prompt-body-content">{prompt.slice(segment.start, segment.end)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
          height: min(500px, 60dvh);
          min-height: 180px;
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
        .system-prompt-body-table {
          width: 100%;
          border-collapse: collapse;
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
        }
        .system-prompt-body-table tr {
          vertical-align: top;
        }
        .system-prompt-body-table tr + tr td {
          border-top: 2px solid color-mix(in srgb, var(--border) 55%, var(--text));
        }
        .system-prompt-body-cat {
          width: 1%;
          white-space: nowrap;
          padding: 4px 10px 4px 0;
          font-family: var(--font-sans);
          font-size: 10.5px;
          font-weight: 600;
          color: var(--text);
          border-right: 1px solid color-mix(in srgb, var(--border) 60%, var(--text));
        }
        .system-prompt-body-tokens {
          display: block;
          margin: 2px 0 0 14px;
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-dim);
          white-space: nowrap;
        }
        .system-prompt-body-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          margin-right: 6px;
          border-radius: 2px;
        }
        .system-prompt-body-content {
          padding: 4px 0 4px 12px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
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
        .system-prompt-composition-label {
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
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
        .system-prompt-composition-expanded {
          min-width: 0;
        }
        .system-prompt-composition-body {
          margin: 6px 2px 2px;
          padding: 8px 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 11px;
          line-height: 1.6;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          max-height: 260px;
          overflow-y: auto;
        }
        .system-prompt-composition-list.is-nested > li {
          padding-right: 6px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: color-mix(in srgb, var(--bg) 35%, var(--bg-panel));
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
        .system-prompt-composition-path {
          color: var(--text-dim);
          font-family: var(--font-mono);
          font-size: 10px;
        }
      `}</style>
    </section>
  );
}
