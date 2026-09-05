// Last-known context usage per session, persisted to localStorage so the top
// bar keeps showing the gauge after a page refresh or while the agent session
// wrapper is idle/recycled (live values only exist while the wrapper is alive).
export interface ContextUsageSnapshot {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

const LS_KEY = "pi-web:context-usage";
const MAX_SESSIONS = 40;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Record<string, { v: 1; ts: number; usage: ContextUsageSnapshot }>;

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStore(): Store {
  const ls = safeLocalStorage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store | null;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // Quota issues are non-fatal — the gauge is cosmetic.
  }
}

export function getContextUsageSnapshot(sessionId: string): ContextUsageSnapshot | null {
  const entry = readStore()[sessionId];
  if (!entry || entry.v !== 1 || typeof entry.ts !== "number") return null;
  if (Date.now() - entry.ts > MAX_AGE_MS) return null;
  const usage = entry.usage;
  if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return null;
  if (usage.percent !== null && typeof usage.percent !== "number") return null;
  if (usage.tokens !== null && typeof usage.tokens !== "number") return null;
  return usage;
}

export function setContextUsageSnapshot(sessionId: string, usage: ContextUsageSnapshot): void {
  if (!sessionId || !usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) {
    return;
  }
  const store = readStore();
  store[sessionId] = { v: 1, ts: Date.now(), usage };
  // Prune: drop expired entries, then trim to the most recent MAX_SESSIONS.
  const now = Date.now();
  for (const [id, entry] of Object.entries(store)) {
    if (!entry || typeof entry.ts !== "number" || now - entry.ts > MAX_AGE_MS) {
      delete store[id];
    }
  }
  const ids = Object.keys(store);
  if (ids.length > MAX_SESSIONS) {
    ids.sort((a, b) => (store[b]?.ts ?? 0) - (store[a]?.ts ?? 0));
    for (const id of ids.slice(MAX_SESSIONS)) delete store[id];
  }
  writeStore(store);
}

export function clearContextUsageSnapshot(sessionId: string): void {
  const store = readStore();
  if (!(sessionId in store)) return;
  delete store[sessionId];
  writeStore(store);
}
