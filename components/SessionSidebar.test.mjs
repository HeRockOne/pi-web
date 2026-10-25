import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getSessionListIndices } = await jiti.import("./SessionSidebar.tsx");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("scrolling keeps the focused session and the viewport mounted without expanding the whole window", () => {
  for (const [scrollTop, focusedIndex] of [[0, 1999], [10000, 0]]) {
    const indices = getSessionListIndices(2000, scrollTop, 335, focusedIndex);
    const firstVisible = Math.floor(scrollTop / 46);
    const lastVisible = Math.ceil((scrollTop + 335) / 46) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(focusedIndex));
    assert.equal(indices.length, 25);
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
  assert.equal(getSessionListIndices(2000, 0, 335, 3).length, 24);
  const blurred = getSessionListIndices(2000, 10000, 335);
  assert.equal(blurred.length, 24);
  assert.ok(!blurred.includes(0));
});

test("session windows stay valid after a project shrinks and before the viewport is measured", () => {
  assert.deepEqual(getSessionListIndices(5, 80000, 335, 1999), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 80000, 335, 1999), []);
  assert.equal(getSessionListIndices(2000, 0, 0).length, 30);
});

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("subscribes to running sessions instead of polling them", () => {
  // A 2.5 s fetch cost a round trip per tick, which is the dominant cost of an
  // idle tab on a high-latency link — the snapshot is pushed now.
  assert.doesNotMatch(source, /fetch\("\/api\/agent\/running"/);
  assert.doesNotMatch(source, /RUNNING_SESSIONS_POLL_MS/);
  assert.doesNotMatch(source, /new EventSource/);
  assert.match(source, /subscribeRunningState\(\{ onState: \(snapshot\) => void apply\(snapshot\) \}\)/);
  assert.match(source, /if \(snapshot\.sessionListVersion !== sessionListVersionRef\.current\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("project activity indicators keep accessible labels", () => {
  assert.match(source, /aria-label=\{t\("sidebar\.agentRunning"\)\}/);
  assert.match(source, /aria-label=\{t\("sidebar\.newSessionActivity"\)\}/);
  assert.match(source, /function ProjectFolderRow/);
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("lifecycle refreshes bypass the cache while cross-window polling reuses it", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /loadSessions\(isFirst, !isFirst\)/);
  assert.match(source, /snapshot\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{hovered && !session\.transient && \(/);
});

test("renders the session list as a project folder tree", () => {
  assert.match(source, /const sidebarRows = useMemo<SidebarRow\[\]>\(\(\) => \{/);
  assert.match(source, /buildSessionTree\(projectSessions\)/);
  assert.match(source, /flattenSessionTree\(tree, collapsedSessionIds\)/);
  assert.match(source, /isSelected=\{row\.session\.id === selectedSessionId\}/);
  assert.match(source, /depth=\{row\.depth\}/);
  assert.match(source, /guideLayers=\{row\.guideLayers\}/);
  assert.match(source, /tailLayers=\{row\.tailLayers\}/);
  assert.match(source, /function ProjectFolderRow/);
  assert.doesNotMatch(source, /listSessionFamilies/);
  assert.doesNotMatch(source, /sessionFamilies/);
  // Tree guide lines + macOS-style inset pill rows (no tinted band; the
  // selected session row is an accent-tinted pill)
  assert.match(source, /const rowPadding = depth === 0 \? 26 : 14 \+ depth \* 18;/);
  assert.match(source, /const lineX = \(layer: number\) => 14 \+ layer \* 18 \+ 8;/);
  assert.match(source, /\[\.\.\.guides, \.\.\.\(hasChildren && !collapsed \? tails : \[\]\)\]/);
  assert.match(source, /color-mix\(in srgb, var\(--accent\) 13%, var\(--bg-panel\)\)/);
  assert.match(source, /isSelected \? "2px solid var\(--accent\)"/);
  // The project header never gets a selection band of its own — otherwise it
  // competes with the selected session row. It is marked by the accent folder
  // icon + accent mono path instead.
  assert.match(source, /background: hovered \? "var\(--bg-hover\)" : "transparent"/);
  assert.match(source, /fontWeight: selected \? 550 : 450, color: selected \? "var\(--accent\)" : "var\(--text\)"/);
  assert.doesNotMatch(source, /borderLeft: selected \? "2px solid var\(--accent\)"/);
  assert.doesNotMatch(source, /rgba\(127,127,127,0\.07\)/);
});
