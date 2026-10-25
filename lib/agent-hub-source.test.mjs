import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

class FakeEventSource {
  static instances = [];
  readyState = 0;
  onmessage = null;
  onerror = null;
  closed = false;

  constructor() {
    FakeEventSource.instances.push(this);
  }

  push(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close() {
    this.closed = true;
  }
}

const posts = [];
globalThis.window = globalThis;
globalThis.EventSource = FakeEventSource;
globalThis.fetch = async (url, init) => {
  posts.push(JSON.parse(init.body));
  return { status: 200, json: async () => ({ success: true }) };
};

const jiti = createJiti(import.meta.url);
const { getEventHub } = await jiti.import("./event-hub-client.ts");
const { createHubAgentSource } = await jiti.import("./agent-hub-source.ts");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function reset() {
  getEventHub().reset();
  FakeEventSource.instances.length = 0;
  posts.length = 0;
}

test("adapts a hub channel to the EventSource contract", async () => {
  reset();
  const source = createHubAgentSource("sess-1");
  assert.equal(source.readyState, 0, "CONNECTING until the channel opens");

  FakeEventSource.instances[0].push({ c: "$hub", e: "ready", d: { connectionId: "hub-1" } });
  await tick();
  assert.deepEqual(posts[0].subscribe, [{ channel: "agent:sess-1" }]);

  const received = [];
  source.onmessage = (message) => received.push(JSON.parse(message.data));
  FakeEventSource.instances[0].push({
    c: "agent:sess-1",
    d: { type: "connected", sessionId: "sess-1", isStreaming: true },
  });

  assert.equal(source.readyState, 1, "OPEN once the channel delivers");
  assert.deepEqual(received, [{ type: "connected", sessionId: "sess-1", isStreaming: true }]);
});

test("a finished channel reports a dropped stream", async () => {
  reset();
  const source = createHubAgentSource("sess-2");
  let errors = 0;
  source.onerror = () => { errors += 1; };

  FakeEventSource.instances[0].push({ c: "$hub", e: "ready", d: { connectionId: "hub-2" } });
  await tick();
  FakeEventSource.instances[0].push({ c: "agent:sess-2", e: "done", d: null });

  assert.equal(errors, 1, "the connection reconnects instead of hanging");
  assert.equal(source.readyState, 2);
});

test("closing the source releases the channel", async () => {
  reset();
  const source = createHubAgentSource("sess-3");
  FakeEventSource.instances[0].push({ c: "$hub", e: "ready", d: { connectionId: "hub-3" } });
  await tick();

  source.close();
  await tick();

  assert.equal(source.readyState, 2);
  assert.equal(FakeEventSource.instances[0].closed, true, "idle hub releases the connection");
});
