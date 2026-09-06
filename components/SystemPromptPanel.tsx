import { colorForProvider } from "../lib/usage-stats-format";
import { analyzeSystemPrompt } from "../lib/system-prompt-analysis";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
}

function PromptComposition({ prompt, translate }: { prompt: string; translate: Translate }) {
  const analysis = analyzeSystemPrompt(prompt);
  if (analysis.sections.length === 0) return null;

  const rows = analysis.sections.map((section) => ({
    ...section,
    percent: analysis.totalTokens > 0 ? Math.round((section.tokens / analysis.totalTokens) * 100) : 0,
    color: colorForProvider(section.detail ?? section.key),
  }));

  return (
    <div className="system-prompt-composition">
      <div className="system-prompt-composition-head">
        <span className="system-prompt-composition-title">{translate("system.composition")}</span>
        <span
          className="system-prompt-composition-total"
          title={translate("system.compositionHint")}
        >
          ≈ {analysis.totalTokens.toLocaleString("en-US")} tokens
        </span>
      </div>
      <div
        className="system-prompt-composition-bar"
        role="img"
        aria-label={translate("system.composition")}
      >
        {rows.map((row) => (
          <span
            key={row.key}
            style={{
              flexGrow: Math.max(row.tokens, 1),
              flexBasis: 0,
              minWidth: 3,
              background: row.color,
            }}
            title={`${translate(row.labelKey)}${row.detail ? ` · ${row.detail}` : ""} ≈${row.tokens.toLocaleString("en-US")} (${row.percent}%)`}
          />
        ))}
      </div>
      <ul className="system-prompt-composition-list">
        {rows.map((row) => (
          <li key={row.key} title={row.detail ?? undefined}>
            <span className="system-prompt-composition-dot" style={{ background: row.color }} />
            <span className="system-prompt-composition-label">
              {translate(row.labelKey)}
              {row.detail ? <span className="system-prompt-composition-path">{row.detail}</span> : null}
            </span>
            <span className="system-prompt-composition-numbers">
              ≈{row.tokens.toLocaleString("en-US")} · {row.percent}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SystemPromptPanel({ loading, prompt, translate }: Props) {
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      <div className="system-prompt-scroll">
        {prompt ? (
          <>
            <PromptComposition prompt={prompt} translate={translate} />
            <div className="system-prompt-text">{prompt}</div>
          </>
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
          margin: 0 0 12px;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: color-mix(in srgb, var(--bg) 55%, var(--bg-panel));
        }
        .system-prompt-composition-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
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
          gap: 4px;
        }
        .system-prompt-composition-list li {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          font-size: 11px;
          color: var(--text-muted);
        }
        .system-prompt-composition-dot {
          flex-shrink: 0;
          width: 8px;
          height: 8px;
          border-radius: 2px;
        }
        .system-prompt-composition-label {
          flex: 1;
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
          font-family: var(--font-mono);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </section>
  );
}
