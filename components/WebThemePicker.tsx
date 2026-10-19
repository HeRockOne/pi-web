"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { previewTheme, useWebTheme } from "@/hooks/useWebTheme";
import {
  DEFAULT_THEME_ID,
  THEME_VARIABLE_KEYS,
  findTheme,
  sanitizeCustomTheme,
  type ThemeVariableKey,
  type WebTheme,
  type WebThemePalette,
} from "@/lib/web-theme-types";
import {
  DERIVED_FROM,
  contrastRatio,
  contrastVerdict,
  deriveDarkFromLight,
  deriveRelated,
  generatePalettesFromSeed,
  normalizeHex6,
  restoreDerived,
  swatchHex,
} from "@/lib/web-theme-generate";

/**
 * Color-theme picker for the settings "Appearance" section.
 *
 * Editing is built around the four colors a person can actually reason about
 * (--bg, --bg-panel, --text, --accent): changing one recomputes every token that
 * follows from it, hand-picked values are kept and marked "edited" so they can be
 * restored, and the other ten live behind a collapsed "advanced" section. Each
 * mode gets a preview strip and WCAG contrast readouts, so "is this readable?"
 * is answered inside the dialog instead of after saving.
 */

type Mode = "light" | "dark";
type ManualMap = Record<Mode, ThemeVariableKey[]>;

/** The colors a user has to think about; everything else follows from them. */
const BASIC_KEYS: ThemeVariableKey[] = ["--bg", "--bg-panel", "--text", "--accent"];
const ADVANCED_KEYS = THEME_VARIABLE_KEYS.filter((key) => !BASIC_KEYS.includes(key));

/** Token -> i18n suffix under `themeField.` */
const VARIABLE_I18N: Record<ThemeVariableKey, string> = {
  "--bg": "bg",
  "--bg-panel": "bgPanel",
  "--bg-hover": "bgHover",
  "--bg-selected": "bgSelected",
  "--border": "border",
  "--text": "text",
  "--text-muted": "textMuted",
  "--text-dim": "textDim",
  "--accent": "accent",
  "--accent-hover": "accentHover",
  "--user-bg": "userBg",
  "--assistant-bg": "assistantBg",
  "--tool-bg": "toolBg",
  "--bg-subtle": "bgSubtle",
};

const EMPTY_MANUAL: ManualMap = { light: [], dark: [] };

/** Mark every token whose current value is not the one it would derive to. */
function detectManual(palette: WebThemePalette, mode: Mode): ThemeVariableKey[] {
  return ADVANCED_KEYS.filter((key) => {
    const derived = restoreDerived(palette, key, mode);
    return derived !== undefined && derived !== palette[key];
  });
}

interface EditorState {
  id: string | null;
  name: string;
  description: string;
  seed: string; // one-color generator input
  light: WebThemePalette;
  dark: WebThemePalette;
  manual: ManualMap; // tokens the user has overridden by hand
}

function paletteFrom(theme: WebTheme, mode: Mode): WebThemePalette {
  return { ...theme[mode] };
}

function newEditorState(base: WebTheme): EditorState {
  return {
    id: null,
    name: "",
    description: "",
    seed: base.light["--accent"],
    light: paletteFrom(base, "light"),
    dark: paletteFrom(base, "dark"),
    manual: EMPTY_MANUAL,
  };
}

function editorFromTheme(theme: WebTheme): EditorState {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description ?? "",
    seed: theme.light["--accent"],
    light: paletteFrom(theme, "light"),
    dark: paletteFrom(theme, "dark"),
    manual: {
      light: detectManual(theme.light, "light"),
      dark: detectManual(theme.dark, "dark"),
    },
  };
}

function slugifyThemeId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (base && !base.startsWith("pi-")) return base;
  return `custom-${Date.now().toString(36)}`;
}

function buildTheme(editor: EditorState): WebTheme | null {
  return sanitizeCustomTheme({
    id: editor.id ?? slugifyThemeId(editor.name),
    name: editor.name,
    description: editor.description,
    light: editor.light,
    dark: editor.dark,
  });
}

function ThemeSwatch({
  theme,
  mode,
  label,
}: {
  theme: WebTheme;
  mode: Mode;
  label: string;
}) {
  const palette = theme[mode];
  return (
    <span className="web-theme-swatch" style={{ background: palette["--bg"] }} title={label}>
      <span className="web-theme-swatch-bubble" style={{ background: palette["--user-bg"] }} />
      <span className="web-theme-swatch-panel" style={{ background: palette["--bg-panel"] }} />
      <span className="web-theme-swatch-accent" style={{ background: palette["--accent"] }} />
    </span>
  );
}

export function WebThemePicker() {
  const { t } = useI18n();
  const { activeId, themes, activateTheme, saveCustomTheme, deleteCustomTheme } = useWebTheme();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeTheme = useMemo(() => findTheme(themes, activeId) ?? null, [themes, activeId]);

  const fieldLabel = (key: ThemeVariableKey) => t(`themeField.${VARIABLE_I18N[key]}`);
  const modeLabel = (mode: Mode) =>
    mode === "light" ? t("settings.colorThemeModeLight") : t("settings.colorThemeModeDark");

  const closeEditor = () => {
    setEditor(null);
    setError(null);
    previewTheme(activeTheme); // restore the persisted theme after previewing
  };

  const updateEditor = (patch: Partial<EditorState>) => {
    if (!editor) return;
    const next = { ...editor, ...patch };
    setEditor(next);
    const candidate = buildTheme(next);
    if (candidate) previewTheme(candidate); // live preview only once all 28 values are valid
  };

  /** Replace one base color and recompute everything that follows from it. */
  const setPaletteValue = (mode: Mode, key: ThemeVariableKey, value: string) => {
    if (!editor) return;
    const palette: WebThemePalette = { ...editor[mode], [key]: value };
    const previous = editor.manual[mode];
    let manual: ThemeVariableKey[];
    if (BASIC_KEYS.includes(key)) {
      // Choosing a base color by hand hands the derived tokens back to the rules.
      manual = previous.filter((entry) => entry !== key);
      const derived = deriveRelated(palette, key, mode);
      for (const [derivedKey, derivedValue] of Object.entries(derived)) {
        if (derivedValue && !manual.includes(derivedKey as ThemeVariableKey)) {
          palette[derivedKey as ThemeVariableKey] = derivedValue;
        }
      }
    } else {
      manual = previous.includes(key) ? previous : [...previous, key];
    }
    updateEditor({ [mode]: palette, manual: { ...editor.manual, [mode]: manual } } as Partial<EditorState>);
  };

  /** Drop a hand-picked value and go back to what the rules would produce. */
  const restoreAuto = (mode: Mode, key: ThemeVariableKey) => {
    if (!editor) return;
    const base = DERIVED_FROM[key];
    if (!base) return;
    const derived = restoreDerived(editor[mode], key, mode);
    if (derived === undefined) return;
    updateEditor({
      [mode]: { ...editor[mode], [key]: derived },
      manual: { ...editor.manual, [mode]: editor.manual[mode].filter((entry) => entry !== key) },
    } as Partial<EditorState>);
  };

  /** One seed color in, a complete light + dark palette out. */
  const applySeed = (seed: string) => {
    const generated = generatePalettesFromSeed(seed);
    updateEditor({ seed, light: generated.light, dark: generated.dark, manual: EMPTY_MANUAL });
  };

  const handleSave = () => {
    if (!editor) return;
    const theme = buildTheme(editor);
    if (!theme) {
      setError(t("settings.colorThemeInvalid"));
      return;
    }
    saveCustomTheme(theme);
    setEditor(null);
    setError(null);
  };

  const handleDelete = (theme: WebTheme) => {
    if (!window.confirm(`${t("settings.colorThemeDelete")}: ${theme.name}?`)) return;
    deleteCustomTheme(theme.id);
    if (editor?.id === theme.id) closeEditor();
  };

  const startEdit = (theme: WebTheme) => {
    setEditor(editorFromTheme(theme));
    setError(null);
  };

  const startNew = () => {
    const base = activeTheme ?? findTheme(themes, DEFAULT_THEME_ID) ?? themes[0];
    if (base) setEditor(newEditorState(base));
  };

  if (editor) {
    const paletteSections: { mode: Mode; label: string; palette: WebThemePalette }[] = [
      { mode: "light", label: t("settings.colorThemeLightPalette"), palette: editor.light },
      { mode: "dark", label: t("settings.colorThemeDarkPalette"), palette: editor.dark },
    ];

    const renderField = (mode: Mode, palette: WebThemePalette, key: ThemeVariableKey) => {
      const label = fieldLabel(key);
      const manual = editor.manual[mode].includes(key);
      return (
        <label key={key} className="web-theme-editor-field" title={key}>
          <input
            type="color"
            className="web-theme-editor-color"
            value={swatchHex(palette[key], palette["--bg"])}
            onChange={(event) => setPaletteValue(mode, key, event.target.value)}
            aria-label={`${label} ${modeLabel(mode)}`}
          />
          <span className="web-theme-editor-key">{label}</span>
          <input
            type="text"
            value={palette[key]}
            onChange={(event) => setPaletteValue(mode, key, event.target.value.trim())}
            spellCheck={false}
            aria-label={`${key} ${modeLabel(mode)}`}
          />
          {manual && (
            <button
              type="button"
              className="web-theme-editor-manual"
              title={t("settings.colorThemeRestoreAuto")}
              aria-label={`${t("settings.colorThemeRestoreAuto")}: ${label}`}
              onClick={() => restoreAuto(mode, key)}
            >
              {t("settings.colorThemeManual")}
            </button>
          )}
        </label>
      );
    };

    const renderBasic = (mode: Mode, palette: WebThemePalette, key: ThemeVariableKey) => {
      const label = fieldLabel(key);
      return (
        <label key={key} className="web-theme-editor-basic" title={key}>
          <input
            type="color"
            className="web-theme-editor-color"
            value={swatchHex(palette[key], palette["--bg"])}
            onChange={(event) => setPaletteValue(mode, key, event.target.value)}
            aria-label={`${label} ${modeLabel(mode)}`}
          />
          <span className="web-theme-editor-basic-body">
            <span className="web-theme-editor-basic-label" style={{ color: palette["--text"] }}>
              {label}
            </span>
            <span className="web-theme-editor-basic-hint" style={{ color: palette["--text-dim"] }}>
              {t(`themeField.${VARIABLE_I18N[key]}Hint`)}
            </span>
          </span>
          <input
            type="text"
            value={palette[key]}
            onChange={(event) => setPaletteValue(mode, key, event.target.value.trim())}
            spellCheck={false}
            aria-label={`${key} ${modeLabel(mode)}`}
            style={{
              background: palette["--bg-panel"],
              color: palette["--text"],
              borderColor: `color-mix(in srgb, ${palette["--text"]} 22%, transparent)`,
            }}
          />
        </label>
      );
    };

    const renderContrast = (palette: WebThemePalette) => {
      const checks: { label: string; ratio: number | null }[] = [
        { label: t("settings.colorThemeTextOnBg"), ratio: contrastRatio(palette["--text"], palette["--bg"]) },
        { label: t("settings.colorThemeMutedOnBg"), ratio: contrastRatio(palette["--text-muted"], palette["--bg"]) },
      ];
      const verdictLabel = { good: t("settings.colorThemeContrastGood"), low: t("settings.colorThemeContrastLow"), bad: t("settings.colorThemeContrastBad") };
      return (
        <div className="web-theme-editor-checks">
          <span className="web-theme-editor-checks-title">{t("settings.colorThemeContrast")}</span>
          {checks.map((check) => {
            const verdict = contrastVerdict(check.ratio);
            return (
              <span key={check.label} className={`web-theme-editor-check is-${verdict}`}>
                {check.label}
                <b>{check.ratio === null ? "—" : `${check.ratio.toFixed(1)}:1`}</b>
                {verdictLabel[verdict]}
              </span>
            );
          })}
        </div>
      );
    };

    // Every token shown in the preview strip wears its own name, so the sample
    // doubles as the legend.
    const renderPreview = (mode: Mode, palette: WebThemePalette) => (
      <div
        className="web-theme-editor-preview"
        style={{ background: palette["--bg"], borderColor: palette["--border"] }}
        aria-label={`${t("settings.colorThemePreview")} ${modeLabel(mode)}`}
      >
        <div
          className="web-theme-editor-preview-panel"
          style={{ background: palette["--bg-panel"], borderColor: palette["--border"] }}
        >
          <span
            className="web-theme-editor-preview-item"
            style={{ background: palette["--bg-selected"], borderLeft: `2px solid ${palette["--accent"]}`, color: palette["--text"] }}
          >
            {fieldLabel("--bg-selected")}
          </span>
          <span
            className="web-theme-editor-preview-item"
            style={{ background: palette["--bg-hover"], color: palette["--text"] }}
          >
            {fieldLabel("--bg-hover")}
          </span>
        </div>
        <div className="web-theme-editor-preview-main">
          <span className="web-theme-editor-preview-line" style={{ color: palette["--text"] }}>
            {fieldLabel("--text")}
          </span>
          <span className="web-theme-editor-preview-line" style={{ color: palette["--text-muted"] }}>
            {fieldLabel("--text-muted")}
          </span>
          <span className="web-theme-editor-preview-line" style={{ color: palette["--text-dim"] }}>
            {fieldLabel("--text-dim")}
          </span>
          <div className="web-theme-editor-preview-row">
            <span
              className="web-theme-editor-preview-chip"
              style={{
                background: palette["--accent"],
                color: contrastRatio(palette["--bg"], palette["--accent"]) !== null
                  && (contrastRatio(palette["--bg"], palette["--accent"]) ?? 0) >= 3
                  ? palette["--bg"]
                  : "#ffffff",
              }}
            >
              {fieldLabel("--accent")}
            </span>
            <span
              className="web-theme-editor-preview-chip"
              style={{ background: palette["--tool-bg"], border: `1px solid ${palette["--border"]}`, color: palette["--text-muted"] }}
            >
              {fieldLabel("--tool-bg")}
            </span>
            <span
              className="web-theme-editor-preview-chip"
              style={{ background: palette["--user-bg"], border: `1px solid ${palette["--border"]}`, color: palette["--text"] }}
            >
              {fieldLabel("--user-bg")}
            </span>
          </div>
        </div>
      </div>
    );

    return (
      <div className="web-theme-editor">
        <div className="web-theme-editor-row">
          <input
            type="text"
            value={editor.name}
            placeholder={t("settings.colorThemeName")}
            aria-label={t("settings.colorThemeName")}
            maxLength={60}
            onChange={(event) => updateEditor({ name: event.target.value })}
            className="web-theme-editor-name"
          />
          <input
            type="text"
            value={editor.description}
            placeholder={t("settings.colorThemeDescription")}
            aria-label={t("settings.colorThemeDescription")}
            maxLength={200}
            onChange={(event) => updateEditor({ description: event.target.value })}
            className="web-theme-editor-description"
          />
        </div>
        <div className="web-theme-editor-tools">
          <span className="web-theme-editor-tools-label">{t("settings.colorThemeSeed")}</span>
          <input
            type="color"
            className="web-theme-editor-seed"
            value={normalizeHex6(editor.seed) ?? "#2563eb"}
            aria-label={t("settings.colorThemeSeed")}
            onChange={(event) => applySeed(event.target.value)}
          />
          <button
            type="button"
            className="web-theme-button web-theme-button-secondary"
            onClick={() => applySeed(editor.seed)}
          >
            {t("settings.colorThemeGenerate")}
          </button>
          <span className="web-theme-editor-tools-hint">{t("settings.colorThemeSeedHint")}</span>
        </div>
        <div className="web-theme-editor-tools web-theme-editor-tools-secondary">
          {editor.id === null && (
            <>
              <span className="web-theme-editor-tools-label">{t("settings.colorThemeBase")}</span>
              <select
                value={activeTheme?.id ?? DEFAULT_THEME_ID}
                onChange={(event) => {
                  const base = findTheme(themes, event.target.value);
                  if (!base) return;
                  updateEditor({
                    light: paletteFrom(base, "light"),
                    dark: paletteFrom(base, "dark"),
                    manual: EMPTY_MANUAL,
                  });
                }}
              >
                {themes.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <button
            type="button"
            className="web-theme-button web-theme-button-secondary"
            onClick={() =>
              updateEditor({ dark: deriveDarkFromLight(editor.light), manual: { ...editor.manual, dark: [] } })
            }
          >
            {t("settings.colorThemeGenerateDark")}
          </button>
        </div>
        {paletteSections.map((section) => (
          <fieldset
            key={section.mode}
            className={`web-theme-editor-group is-${section.mode}`}
            style={{ color: section.palette["--text"] }}
          >
            {/* A chip in the mode's own palette: the region no longer borrows the
                app theme's colors, so light and dark readouts cannot be confused. */}
            <legend>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: section.mode === "light" ? section.palette["--bg"] : "#0b0b0c",
                    border: `1px solid ${section.palette["--border"]}`,
                  }}
                />
                {section.label}
              </span>
            </legend>
            {/* Card-within-the-region: the fieldset keeps the app's neutral
                frame, and only this inner card wears the mode's own surface.
                A full-bleed dark block inside a light page looked like a
                broken panel, not like "this is the dark palette". */}
            <div
              className="web-theme-editor-surface"
              style={{
                // Bind the section's own palette to the very CSS variables its
                // children consume, so a dark section never borrows the app
                // theme's border/text colours (that was the "which region am I
                // in?" confusion), and vice versa. Scoped to this card only —
                // the surrounding fieldset must stay in the app theme.
                ...(section.palette as CSSProperties),
                background: section.palette["--bg"],
                borderColor: section.palette["--border"],
                color: section.palette["--text"],
              }}
            >
              <div className="web-theme-editor-basics">
                {BASIC_KEYS.map((key) => renderBasic(section.mode, section.palette, key))}
              </div>
              <p className="web-theme-editor-hint" style={{ color: section.palette["--text-dim"] }}>{t("settings.colorThemeBasicsHint")}</p>
              {renderPreview(section.mode, section.palette)}
              {renderContrast(section.palette)}
            </div>
            <details className="web-theme-editor-advanced">
              <summary>
                {t("settings.colorThemeAdvanced")}
                {editor.manual[section.mode].length > 0 && (
                  <span className="web-theme-editor-advanced-count">
                    {t("settings.colorThemeManual")} {editor.manual[section.mode].length}
                  </span>
                )}
              </summary>
              <p className="web-theme-editor-hint">{t("settings.colorThemeAdvancedHint")}</p>
              <div className="web-theme-editor-grid">
                {ADVANCED_KEYS.map((key) => renderField(section.mode, section.palette, key))}
              </div>
            </details>
          </fieldset>
        ))}
        {error && <p role="alert" className="settings-general-error">{error}</p>}
        <div className="web-theme-editor-actions">
          <button type="button" className="web-theme-button" onClick={handleSave}>
            {t("settings.colorThemeSave")}
          </button>
          <button type="button" className="web-theme-button web-theme-button-secondary" onClick={closeEditor}>
            {t("settings.colorThemeCancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="web-theme-picker">
      <div role="radiogroup" aria-label={t("settings.colorTheme")} className="web-theme-grid">
        {themes.map((theme) => {
          const selected = theme.id === activeId;
          return (
            <div
              key={theme.id}
              role="radio"
              aria-checked={selected}
              tabIndex={0}
              onClick={() => activateTheme(theme.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activateTheme(theme.id);
                }
              }}
              className={`web-theme-card${selected ? " is-active" : ""}`}
            >
              <div className="web-theme-card-swatches">
                <ThemeSwatch theme={theme} mode="light" label={t("settings.colorThemeModeLight")} />
                <ThemeSwatch theme={theme} mode="dark" label={t("settings.colorThemeModeDark")} />
              </div>
              <div className="web-theme-card-body">
                <span className="web-theme-card-name">
                  {theme.name}
                  {theme.builtin && <span className="web-theme-card-badge">{t("settings.colorThemeBuiltin")}</span>}
                </span>
                {theme.description && <span className="web-theme-card-description">{theme.description}</span>}
              </div>
              {!theme.builtin && (
                <div className="web-theme-card-actions">
                  <button
                    type="button"
                    title={t("settings.colorThemeEdit")}
                    aria-label={`${t("settings.colorThemeEdit")}: ${theme.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      startEdit(theme);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    title={t("settings.colorThemeDelete")}
                    aria-label={`${t("settings.colorThemeDelete")}: ${theme.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDelete(theme);
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="web-theme-card web-theme-card-new"
          onClick={startNew}
        >
          ＋ {t("settings.colorThemeNew")}
        </button>
      </div>
    </div>
  );
}
