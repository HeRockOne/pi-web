import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentEventConnection } = await jiti.import("./agent-event-connection.ts");

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeEventSource {
  readyState = CONNECTING;
  onmessage = null;
  onerror = null;
  closeCount = 0;

  open() { this.readyState = OPEN; }
  message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  error() {
    this.readyState = CLOSED;
    this.onerror?.(new Event("error"));
  }
  close() {
    this.readyState = CLOSED;
    this.closeCount += 1;
  }
}

function createHarness({ readinessTimeoutMs = 100, reconnectDelayMs = 5, maxReconnectDelayMs } = {}) {
  const sources = [];
  const events = [];
  const unexpectedErrors = [];
  let activeSession = "session-a";
  let demand = false;
  const connection = new AgentEventConnection({
    createSource(sessionId) {
      const source = new FakeEventSource();
      source.sessionId = sessionId;
      sources.push(source);
      return source;
    },
    onEvent(event) { events.push(event); },
    shouldMaintain: (sessionId) => demand && sessionId === activeSession,
    readinessTimeoutMs,
    reconnectDelayMs,
    ...(maxReconnectDelayMs !== undefined ? { maxReconnectDelayMs } : {}),
    onUnexpectedError(error) { unexpectedErrors.push(error); },
  });
  return {
    connection,
    sources,
    events,
    unexpectedErrors,
    setActiveSession(sessionId) { activeSession = sessionId; },
    setDemand(value) { demand = value; },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await wait(2);
  }
}

test("shares one source and waits past the former transport deadline", async () => {
  const { connection, sources, events } = createHarness();
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");

  assert.equal(sources.length, 1);
  sources[0].open();
  await wait(20);
  sources[0].message({ type: "connected" });
  await Promise.all([first, second]);

  sources[0].message({ type: "agent_start" });
  assert.deepEqual(events.map((event) => event.type), ["connected", "agent_start"]);
});

test("times out all waiters and closes the stalled source", async () => {
  const { connection, sources } = createHarness({ readinessTimeoutMs: 10 });
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");

  await assert.rejects(first, (error) => error.status === "ready_timeout");
  await assert.rejects(second, (error) => error.status === "ready_timeout");
  assert.equal(sources[0].closeCount, 1);
});

test("manual close rejects waiters and isolates late events", async () => {
  const { connection, sources, events } = createHarness();
  const abandoned = connection.ensureConnected("session-a");
  const oldSource = sources[0];
  connection.close();
  await assert.rejects(abandoned, (error) => error.status === "closed");

  const replacement = connection.ensureConnected("session-a");
  oldSource.open();
  oldSource.message({ type: "connected" });
  await nextTurn();
  assert.deepEqual(events, []);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await replacement;
});

test("surfaces startup errors without retrying or dispatching them", async () => {
  const { connection, sources, events } = createHarness();
  const ready = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "startup_error", errorMessage: "broken config" });

  await assert.rejects(ready, (error) => (
    error.status === "startup_error" && error.message === "broken config"
  ));
  await wait(10);
  assert.equal(sources.length, 1);
  assert.deepEqual(events, []);
});

test("replaces a previously connected CONNECTING source only once", async () => {
  const { connection, sources } = createHarness();
  const initial = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "connected" });
  await initial;

  sources[0].readyState = CONNECTING;
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");
  await nextTurn();
  assert.equal(sources.length, 2);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await Promise.all([first, second]);
});

test("passive maintenance retries a transient failure once", async () => {
  const { connection, sources, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");
  sources[0].error();
  await wait(10);
  assert.equal(sources.length, 2);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await wait(10);
  assert.equal(sources.length, 2);
});

test("an explicit startup error cancels a pending passive retry", async () => {
  const { connection, sources, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");
  sources[0].error();

  const explicit = connection.ensureConnected("session-a");
  sources[1].open();
  sources[1].message({ type: "startup_error", errorMessage: "terminal" });
  await assert.rejects(explicit, (error) => error.status === "startup_error");
  await wait(10);
  assert.equal(sources.length, 2);
});

test("dropped demand, session switches, and close cannot revive an old retry", async () => {
  const first = createHarness();
  first.setDemand(true);
  first.connection.maintain("session-a");
  first.sources[0].error();
  first.setDemand(false);
  await wait(10);
  assert.equal(first.sources.length, 1);

  const second = createHarness();
  second.setDemand(true);
  second.connection.maintain("session-a");
  second.sources[0].error();
  second.setActiveSession("session-b");
  const ready = second.connection.ensureConnected("session-b");
  second.sources[1].open();
  second.sources[1].message({ type: "connected" });
  await ready;
  await wait(10);
  assert.equal(second.sources.length, 2);

  const closed = createHarness();
  closed.setDemand(true);
  closed.connection.maintain("session-a");
  closed.sources[0].error();
  closed.connection.close();
  await wait(10);
  assert.equal(closed.sources.length, 1);
});

/**
 * Record the delays the connection actually schedules. Asserting on scheduled
 * values instead of wall-clock elapsed time keeps these tests deterministic
 * when the runner is under load.
 */
async function recordRetryDelays(readinessTimeoutMs, run) {
  const recorded = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    recorded.push(ms);
    return realSetTimeout(fn, ms, ...args);
  };
  try {
    await run();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  const pollInterval = 2;
  return recorded.filter((ms) => ms !== pollInterval && ms !== readinessTimeoutMs);
}

test("backs off exponentially instead of retrying every base delay", async () => {
  // Each retry can cold-start an agent session, so a fixed delay turned a
  // server hiccup into a reconnect storm that outlasted the hiccup.
  const harness = createHarness({ reconnectDelayMs: 20, maxReconnectDelayMs: 200, readinessTimeoutMs: 30_000 });

  const delays = await recordRetryDelays(30_000, async () => {
    harness.setDemand(true);
    harness.connection.maintain("session-a");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const count = harness.sources.length;
      harness.sources[count - 1].error();
      await waitFor(() => harness.sources.length > count);
    }
  });

  // Full jitter halves each value: 20 → 10-20, 40 → 20-40, 80 → 40-80, 160 → 80-160.
  assert.ok(delays.length >= 4, `expected four retries, got ${delays.length}`);
  assert.ok(delays[0] >= 10 && delays[0] <= 20, `first retry was ${delays[0]}ms`);
  assert.ok(delays[3] >= 80 && delays[3] <= 160, `fourth retry was ${delays[3]}ms`);
  harness.connection.close();
});

test("a healthy connect resets the backoff", async () => {
  const harness = createHarness({ reconnectDelayMs: 10, maxReconnectDelayMs: 5_000, readinessTimeoutMs: 30_000 });

  harness.setDemand(true);
  harness.connection.maintain("session-a");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const count = harness.sources.length;
    harness.sources[count - 1].error();
    await waitFor(() => harness.sources.length > count);
  }

  const recovered = harness.sources.at(-1);
  recovered.open();
  recovered.message({ type: "connected" });

  const delays = await recordRetryDelays(30_000, async () => {
    const count = harness.sources.length;
    harness.sources[count - 1].error();
    await waitFor(() => harness.sources.length > count);
  });

  // Without the reset this retry would be at 80 ms (± jitter), not the base 10.
  assert.ok(delays.length >= 1, "expected a retry after the failure");
  assert.ok(delays[0] <= 10, `expected the base delay again, got ${delays[0]}ms`);
  harness.connection.close();
});
