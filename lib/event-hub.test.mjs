import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHubConnection, getHubConnection, closeAllEventHubStreams } = await jiti.import("./event-hub.ts");

const decoder = new TextDecoder();

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading hub chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeFrames(chunk) {
  return decoder
    .decode(chunk.value)
    .split("\n\n")
    .filter((entry) => entry.startsWith("data: "))
    .map((entry) => JSON.parse(entry.slice("data: ".length)));
}

test("announces its connection id before anything else", async () => {
  const connection = createHubConnection(new Request("http://localhost/api/events"));
  const reader = connection.stream.getReader();

  const frames = decodeFrames(await readWithin(reader));
  assert.deepEqual(frames, [
    { c: "$hub", e: "ready", d: { connectionId: connection.id } },
  ]);
  assert.equal(getHubConnection(connection.id), connection);

  await reader.cancel();
});

test("routes frames by channel and drops removed producers", async () => {
  const connection = createHubConnection(new Request("http://localhost/api/events"));
  const reader = connection.stream.getReader();
  await readWithin(reader); // ready

  let cleaned = 0;
  connection.add("terminal:t1", () => { cleaned += 1; });

  connection.send({ c: "terminal:t1", d: { type: "output", data: "hi", offset: 2 } });
  connection.send({ c: "file:/a.ts", e: "change", d: { size: 3 } });

  const frames = decodeFrames(await readWithin(reader));
  assert.deepEqual(frames, [
    { c: "terminal:t1", d: { type: "output", data: "hi", offset: 2 } },
    { c: "file:/a.ts", e: "change", d: { size: 3 } },
  ]);

  connection.remove("terminal:t1");
  assert.equal(cleaned, 1);
  assert.equal(connection.has("terminal:t1"), false);
  assert.equal(connection.channelCount(), 0);

  await reader.cancel();
});

test("closing the stream tears down every channel and unregisters", async () => {
  const connection = createHubConnection(new Request("http://localhost/api/events"));
  const reader = connection.stream.getReader();
  await readWithin(reader);

  const cleaned = [];
  connection.add("a:1", () => cleaned.push("a"));
  connection.add("b:2", () => cleaned.push("b"));

  await reader.cancel();

  assert.deepEqual(cleaned.sort(), ["a", "b"]);
  assert.equal(connection.isClosed(), true);
  assert.equal(getHubConnection(connection.id), undefined);
});

test("replacing a channel closes the previous producer", async () => {
  const connection = createHubConnection(new Request("http://localhost/api/events"));
  const reader = connection.stream.getReader();
  await readWithin(reader);

  let firstCleaned = 0;
  connection.add("agent:s1", () => { firstCleaned += 1; });
  connection.add("agent:s1", () => {});
  assert.equal(firstCleaned, 1);

  await reader.cancel();
});

test("shutdown closes every registered connection", async () => {
  const one = createHubConnection(new Request("http://localhost/api/events"));
  const two = createHubConnection(new Request("http://localhost/api/events"));
  await readWithin(one.stream.getReader());
  await readWithin(two.stream.getReader());

  closeAllEventHubStreams();

  assert.equal(one.isClosed(), true);
  assert.equal(two.isClosed(), true);
  assert.equal(getHubConnection(one.id), undefined);
});
