"use client";

import { useMemo, useState } from "react";
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
  deriveDarkFromLight,
  generatePalettesFromSeed,
  normalizeHex6,
} from "@/lib/web-theme-generate";

/**
 * Color-theme picker for the settings "Appearance" section.
 * Builtin presets are selectable only; custom themes can be created,
 * edited, deleted, and live-previewed while editing.
 *
 * New themes start as a copy of an existing theme (base template selector)
 * and every color field has a native color picker next to its text input,
 * so hand-writing hex codes is never required.
 */

const VARIABLE_LABELS: Record<ThemeVariableKey, string> = {
  "--bg": "bg 背景",
  "--bg-panel": "panel 面板",
  "--bg-hover": "hover 悬浮",
  "--bg-selected": "selected 选中",
  "--border": "border 边框",
  "--text": "text 主文本",
  "--text-muted": "muted 次级文本",
  "--text-dim": "dim 弱化文本",
  "--accent": "accent 强调色",
  "--accent-hover": "accent hover 悬浮强调",
  "--user-bg": "user 用户气泡",
  "--assistant-bg": "assistant 助手消息",
  "--tool-bg": "tool 工具区",
  "--bg-subtle": "subtle 聚焦光环",
};

interface EditorState {
  id: string | null;
  name: string;
  description: string;
  seed: string; // one-color generator input
  light: WebThemePalette;
  dark: WebThemePalette;
}

function paletteFrom(theme: WebTheme, mode: "light" | "dark"): WebThemePalette {
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
function ThemeSwatch({ theme, mode }: { theme: WebTheme; mode: "light" | "dark" }) {
  const palette = theme[mode];
  return (
    <span className="web-theme-swatch" style={{ background: palette["--bg"] }} title={mode === "light" ? "Light 浅色" : "Dark 深色"}>
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
    const paletteSections: { mode: "light" | "dark"; label: string; palette: WebThemePalette }[] = [
      { mode: "light", label: t("settings.colorThemeLightPalette"), palette: editor.light },
      { mode: "dark", label: t("settings.colorThemeDarkPalette"), palette: editor.dark },
    ];
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
            onChange={(event) => {
              const generated = generatePalettesFromSeed(event.target.value);
              updateEditor({ seed: event.target.value, light: generated.light, dark: generated.dark });
            }}
          />
          {editor.id === null && (
            <>
              <span className="web-theme-editor-tools-label">{t("settings.colorThemeBase")}</span>
              <select
                value={activeTheme?.id ?? DEFAULT_THEME_ID}
                onChange={(event) => {
                  const base = findTheme(themes, event.target.value);
                  if (!base) return;
                  updateEditor({ light: paletteFrom(base, "light"), dark: paletteFrom(base, "dark") });
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
            onClick={() => updateEditor({ dark: deriveDarkFromLight(editor.light) })}
          >
            {t("settings.colorThemeGenerateDark")}
          </button>
        </div>
        {paletteSections.map((section) => (
          <fieldset key={section.mode} className="web-theme-editor-group">
            <legend>{section.label}</legend>
            <div className="web-theme-editor-grid">
              {THEME_VARIABLE_KEYS.map((key) => (
                <label key={key} className="web-theme-editor-field" title={key}>
                  <input
                    type="color"
                    className="web-theme-editor-color"
                    value={normalizeHex6(section.palette[key]) ?? "#888888"}
                    onChange={(event) => updateEditor({
                      [section.mode]: { ...section.palette, [key]: event.target.value },
                    } as Partial<EditorState>)}
                    aria-label={`${section.label} ${VARIABLE_LABELS[key]}`}
                  />
                  <span className="web-theme-editor-key">{VARIABLE_LABELS[key]}</span>
                  <input
                    type="text"
                    value={section.palette[key]}
                    onChange={(event) => updateEditor({
                      [section.mode]: { ...section.palette, [key]: event.target.value.trim() },
                    } as Partial<EditorState>)}
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
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
                <ThemeSwatch theme={theme} mode="light" />
                <ThemeSwatch theme={theme} mode="dark" />
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
