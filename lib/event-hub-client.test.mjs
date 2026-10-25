import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

class FakeEventSource {
  static instances = [];
  readyState = 0;
  onmessage = null;
  onerror = null;
  closed = false;

  constructor(url) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  push(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  fail() {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function resetHub() {
  getEventHub().reset();
  FakeEventSource.instances.length = 0;
  posts.length = 0;
}

function ready(connectionId = "hub-1") {
  FakeEventSource.instances.at(-1).push({ c: "$hub", e: "ready", d: { connectionId } });
}

test("shares one connection across channels and closes it when idle", async () => {
  resetHub();
  const hub = getEventHub();
  const offTerminal = hub.subscribe("terminal:t1", {});
  const offFile = hub.subscribe("file:/a.ts", {});

  assert.equal(FakeEventSource.instances.length, 1, "one EventSource for two channels");

  ready();
  await tick();
  assert.equal(posts.length, 1);
  assert.deepEqual(
    posts[0].subscribe.map((entry) => entry.channel).sort(),
    ["file:/a.ts", "terminal:t1"],
  );

  offTerminal();
  offFile();
  await tick();
  assert.equal(FakeEventSource.instances[0].closed, true, "idle hub holds no connection");

  hub.subscribe("file:/b.ts", {});
  assert.equal(FakeEventSource.instances.length, 2, "subscribing again reopens the hub");
});

test("dispatches by channel and opens each channel once", async () => {
  resetHub();
  const hub = getEventHub();
  const seen = { terminal: [], file: [], opens: 0, closes: 0 };

  hub.subscribe("terminal:t1", {
    onOpen: () => { seen.opens += 1; },
    onEvent: (event) => seen.terminal.push(event),
    onClose: () => { seen.closes += 1; },
  });
  hub.subscribe("file:/a.ts", {
    onEvent: (event) => seen.file.push(event),
  });

  ready();
  await tick();
  const source = FakeEventSource.instances[0];

  source.push({ c: "terminal:t1", e: "open", d: null });
  source.push({ c: "terminal:t1", d: { type: "output", data: "a", offset: 1 }, id: "1" });
  source.push({ c: "terminal:t1", d: { type: "output", data: "b", offset: 2 }, id: "2" });
  source.push({ c: "file:/a.ts", e: "change", d: { size: 9 } });

  assert.equal(seen.opens, 1, "onOpen fires once per subscription");
  // Terminal output rides the default "message" name; the payload says output.
  assert.deepEqual(seen.terminal.map((event) => event.name), ["message", "message"]);
  assert.deepEqual(
    seen.terminal.map((event) => event.data.type),
    ["output", "output"],
  );
  assert.equal(seen.terminal[1].id, "2");
  assert.deepEqual(seen.file, [{ name: "change", data: { size: 9 } }]);
  assert.equal(seen.closes, 0);
});

test("reports channel errors without tearing the transport down", async () => {
  resetHub();
  const hub = getEventHub();
  let closed = 0;
  hub.subscribe("terminal:gone", {
    onEvent: () => {},
    onClose: () => { closed += 1; },
  });

  ready();
  await tick();
  FakeEventSource.instances[0].push({ c: "terminal:gone", e: "error", d: { message: "Channel unavailable" } });

  assert.equal(closed, 1);
  assert.equal(FakeEventSource.instances[0].closed, false, "other channels keep the transport");
});

test("reconnects and re-subscribes with the last cursor", async () => {
  resetHub();
  const hub = getEventHub();
  hub.subscribe("terminal:t1", {}, { after: "40" });

  ready("hub-1");
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].subscribe[0].after, "40");

  const source = FakeEventSource.instances[0];
  source.push({ c: "terminal:t1", d: { type: "output", data: "x", offset: 41 }, id: "41" });
  hub.setCursor("terminal:t1", "41");

  source.fail();
  assert.equal(source.closed, true);
  // Full jitter over a 1 s base: the retry lands somewhere in 0.5–1 s.
  await wait(1_200);
  assert.equal(FakeEventSource.instances.length, 2, "transport reopened after backoff");

  ready("hub-2");
  await tick();
  const resubscribe = posts.at(-1);
  assert.equal(resubscribe.connectionId, "hub-2");
  assert.equal(resubscribe.subscribe[0].after, "41", "resumes from the last cursor");
});

test("a stale connection id is replaced instead of leaving channels dead", async () => {
  resetHub();
  globalThis.fetch = async (url, init) => {
    posts.push(JSON.parse(init.body));
    return { status: 409, json: async () => ({ error: "Unknown connection" }) };
  };

  const hub = getEventHub();
  hub.subscribe("file:/a.ts", {});
  ready("stale");
  await tick();
  await tick();

  assert.equal(FakeEventSource.instances[0].closed, true, "409 forces a new connection");
  globalThis.fetch = async (url, init) => {
    posts.push(JSON.parse(init.body));
    return { status: 200, json: async () => ({ success: true }) };
  };
});
