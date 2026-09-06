"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  allThemes,
  findTheme,
  themeToCss,
  type WebTheme,
} from "@/lib/web-theme-types";

/**
 * Client-side runtime for pi-web color themes.
 *
 * The active theme's override stylesheet is injected as a single <style> tag
 * (id: pi-web-custom-theme). It only overrides the 14 CSS custom properties
 * from app/globals.css; light/dark/auto still follow hooks/useTheme.ts.
 *
 * Persistence model (mirrors the legacy patch extension):
 * - Server: ~/.pi/agent/pi-web-themes.json via /api/web-themes (source of truth)
 * - Browser: localStorage caches the injected CSS + active id so the first
 *   frame after a reload already has the right colors (layout.tsx inline script
 *   applies the cache before React hydrates).
 */

const STYLE_ELEMENT_ID = "pi-web-custom-theme";
const CSS_CACHE_KEY = "pi-web-theme-css";
const ID_CACHE_KEY = "pi-web-theme-id";

interface WebThemeState {
  loaded: boolean;
  activeId: string;
  themes: WebTheme[];
}

const listeners = new Set<() => void>();
let state: WebThemeState = { loaded: false, activeId: DEFAULT_THEME_ID, themes: BUILTIN_THEMES };
let fetchStarted = false;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function setState(patch: Partial<WebThemeState>): void {
  state = { ...state, ...patch };
  emit();
}

export function cssForThemeId(themes: WebTheme[], id: string): string | null {
  if (id === DEFAULT_THEME_ID) return null; // default palette = app/globals.css values
  const theme = findTheme(themes, id);
  return theme ? themeToCss(theme) : null;
}

function applyCss(css: string | null): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!css) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/** Live-preview a theme without persisting (used by the theme editor). */
export function previewTheme(theme: WebTheme | null): void {
  applyCss(theme ? themeToCss(theme) : null);
}

function readCache(): { css: string | null; activeId: string } {
  if (typeof window === "undefined") return { css: null, activeId: DEFAULT_THEME_ID };
  try {
    return {
      css: window.localStorage.getItem(CSS_CACHE_KEY),
      activeId: window.localStorage.getItem(ID_CACHE_KEY) ?? DEFAULT_THEME_ID,
    };
  } catch {
    return { css: null, activeId: DEFAULT_THEME_ID };
  }
}

function writeCache(css: string | null, activeId: string): void {
  try {
    if (css === null) window.localStorage.removeItem(CSS_CACHE_KEY);
    else window.localStorage.setItem(CSS_CACHE_KEY, css);
    window.localStorage.setItem(ID_CACHE_KEY, activeId);
  } catch {
    // private mode / quota — next mount just refetches
  }
}

/** Apply the localStorage cache immediately (used on mount, before fetch). */
function applyCachedTheme(): void {
  const cached = readCache();
  applyCss(cached.css);
  if (cached.activeId !== state.activeId) setState({ activeId: cached.activeId });
}

async function fetchThemes(): Promise<void> {
  try {
    const response = await fetch("/api/web-themes");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { themes?: WebTheme[]; active?: string };
    const themes = allThemes(Array.isArray(data.themes) ? data.themes.filter((t) => !t.builtin) : []);
    const activeId = typeof data.active === "string" && findTheme(themes, data.active) ? data.active : DEFAULT_THEME_ID;
    setState({ loaded: true, themes, activeId });
    const css = cssForThemeId(themes, activeId);
    applyCss(css);
    writeCache(css, activeId);
  } catch {
    // Keep the cached theme applied; loaded=true stops retry loops.
    setState({ loaded: true });
  }
}

function ensureLoaded(): void {
  applyCachedTheme();
  if (!fetchStarted) {
    fetchStarted = true;
    void fetchThemes();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureLoaded();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CSS_CACHE_KEY && event.key !== ID_CACHE_KEY) return;
    applyCachedTheme();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): WebThemeState {
  return state;
}

function getServerSnapshot(): WebThemeState {
  return { loaded: false, activeId: DEFAULT_THEME_ID, themes: BUILTIN_THEMES };
}

export function useWebTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const activateTheme = useCallback((id: string) => {
    const theme = findTheme(state.themes, id);
    if (!theme) return;
    const css = cssForThemeId(state.themes, id);
    applyCss(css);
    writeCache(css, id);
    setState({ activeId: id });
    void fetch("/api/web-themes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate", id }),
    }).catch(() => undefined);
  }, []);

  const saveCustomTheme = useCallback((theme: WebTheme) => {
    const rest = state.themes.filter((existing) => existing.builtin || existing.id !== theme.id);
    const themes = [...rest, theme];
    const css = cssForThemeId(themes, theme.id);
    applyCss(css);
    writeCache(css, theme.id);
    setState({ themes, activeId: theme.id });
    void fetch("/api/web-themes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", theme }),
    }).catch(() => undefined);
  }, []);

  const deleteCustomTheme = useCallback((id: string) => {
    const themes = state.themes.filter((existing) => existing.builtin || existing.id !== id);
    const activeId = state.activeId === id ? DEFAULT_THEME_ID : state.activeId;
    const css = cssForThemeId(themes, activeId);
    applyCss(css);
    writeCache(css, activeId);
    setState({ themes, activeId });
    void fetch("/api/web-themes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    }).catch(() => undefined);
  }, []);

  return {
    loaded: snapshot.loaded,
    activeId: snapshot.activeId,
    themes: snapshot.themes,
    activateTheme,
    saveCustomTheme,
    deleteCustomTheme,
  };
}
