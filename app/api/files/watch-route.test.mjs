import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The watch protocol has one implementation (lib/event-channels.ts); the route
// only re-frames its events as SSE. These guards follow the logic, not the URL.
const channelsSource = await readFile(new URL("../../../lib/event-channels.ts", import.meta.url), "utf8");
const authSource = await readFile(new URL("../../../lib/file-request-auth.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

const start = channelsSource.indexOf("export async function openFileWatchChannel(");
const end = channelsSource.indexOf("async function openAgentChannel(", start);
assert.notEqual(start, -1, "file watch channel not found");
assert.notEqual(end, -1, "file watch channel end not found");
const watchBlock = channelsSource.slice(start, end);

test("file watching survives same-path replacement", () => {
  assert.match(watchBlock, /watcher = fs\.watch\(watchedDirectory/);
  assert.match(watchBlock, /samePath\(path\.join\(watchedDirectory, changedName\.toString\(\)\), filePath\)/);
  assert.match(watchBlock, /next\.ctimeMs === lastCtimeMs/);
  assert.match(watchBlock, /next\.ino === lastIno/);
  assert.match(watchBlock, /lastExists/);
});

test("a missing target can be watched after its parent is authorized", () => {
  // The route opts into the missing-target path only for watch.
  assert.match(routeSource, /allowMissing: type === "watch"/);
  assert.match(authSource, /if \(!options\.allowMissing\)[\s\S]*error: "Not found"/);
  assert.match(authSource, /const existingAuthorizationPath = stat \? filePath : path\.dirname\(filePath\)/);
});

test("connected is emitted only after the watcher exists", () => {
  const watcher = watchBlock.indexOf("watcher = fs.watch");
  const connected = watchBlock.indexOf('e: "connected"');
  assert.ok(watcher >= 0, "watcher creation missing");
  assert.ok(connected > watcher, "connected emitted before watcher creation");
});

test("the legacy watch URL delegates instead of duplicating fs.watch", () => {
  assert.match(routeSource, /openFileWatchChannel\(filePath, send, \{ sessionId \}\)/);
  assert.doesNotMatch(routeSource, /fs\.watch\(/);
});
