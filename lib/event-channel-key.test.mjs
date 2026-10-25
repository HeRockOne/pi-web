import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { channelKey, parseChannelKey } = await jiti.import("./event-channel-key.ts");

test("keeps Windows drive letters inside the channel payload", () => {
  const parsed = parseChannelKey(channelKey("file", "C:\\repo\\src\\a.ts"));
  assert.deepEqual(parsed, { kind: "file", id: "C:\\repo\\src\\a.ts" });
});

test("splits on the first colon only", () => {
  assert.deepEqual(parseChannelKey("agent:sess-1"), { kind: "agent", id: "sess-1" });
  assert.deepEqual(parseChannelKey("terminal:t:1"), { kind: "terminal", id: "t:1" });
  assert.deepEqual(parseChannelKey("file:/tmp/a:b.ts"), { kind: "file", id: "/tmp/a:b.ts" });
});

test("rejects unknown kinds and empty payloads", () => {
  assert.equal(parseChannelKey("nope:x"), null);
  assert.equal(parseChannelKey("agent"), null);
  assert.equal(parseChannelKey(":agent"), null);
  assert.equal(parseChannelKey("agent:"), null);
  assert.equal(parseChannelKey(""), null);
});

test("accepts descriptor and string subscriptions, keeping the cursor", async () => {
  const { parseChannelRequests } = await jiti.import("./event-channel-key.ts");
  assert.deepEqual(
    parseChannelRequests([
      { channel: "terminal:t1", after: "42" },
      "file:/a.ts",
      { channel: "" },
      { after: "1" },
      { channel: "agent:s1", after: 7 },
      null,
    ]),
    [
      { channel: "terminal:t1", after: "42" },
      { channel: "file:/a.ts" },
      { channel: "agent:s1" },
    ],
  );
  assert.deepEqual(parseChannelRequests(undefined), []);
  assert.deepEqual(parseChannelRequests("terminal:t1"), []);
});

test("the running channel is a singleton key with no id", async () => {
  const { channelKey, parseChannelKey } = await jiti.import("./event-channel-key.ts");

  // No colon: one snapshot covers every session, so there is nothing to key on.
  assert.equal(channelKey("running", ""), "running");
  assert.deepEqual(parseChannelKey("running"), { kind: "running", id: "" });
  // The colon form still parses, so an older client cannot break the route.
  assert.deepEqual(parseChannelKey("running:x"), { kind: "running", id: "x" });
  // Everything else keeps its existing rules.
  assert.equal(channelKey("agent", "s1"), "agent:s1");
  assert.equal(parseChannelKey(""), null);
  assert.equal(parseChannelKey(":x"), null);
  assert.equal(parseChannelKey("agent:"), null);
});
