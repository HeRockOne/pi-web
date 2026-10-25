import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCount(list, count, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (list.length >= count) return;
    await wait(50);
  }
  assert.fail(`expected ${count} snapshots, saw ${list.length}`);
}

test("running state is pushed on change instead of polled", async () => {
  const { readRunningSnapshot, subscribeRunningSnapshot } = await jiti.import("./running-state.ts");
  const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

  const seen = [];
  const stop = subscribeRunningSnapshot((snapshot) => seen.push(snapshot));

  // The subscriber must not have to ask for the first one.
  assert.equal(seen.length, 1);
  assert.deepEqual(
    Object.keys(seen[0]).sort(),
    [
      "bashRunningSessionIds",
      "completionNotificationSuppressedSessionIds",
      "runningSessionIds",
      "sessionListVersion",
    ],
  );
  assert.deepEqual(seen[0], readRunningSnapshot());

  // An idle tick must stay silent, otherwise this is a poll with extra steps.
  await wait(1_300);
  assert.equal(seen.length, 1, "no change means no frame");

  const before = readRunningSnapshot().sessionListVersion;
  invalidateSessionListCache();
  await waitForCount(seen, 2);
  assert.equal(seen.at(-1).sessionListVersion, before + 1);

  stop();
  const afterStop = readRunningSnapshot().sessionListVersion;
  invalidateSessionListCache();
  await wait(1_300);
  assert.equal(seen.length, 2, "a removed listener must not be called");
  assert.equal(readRunningSnapshot().sessionListVersion, afterStop + 1);
});

test("a second subscriber gets the current snapshot immediately", async () => {
  const { subscribeRunningSnapshot } = await jiti.import("./running-state.ts");

  const first = [];
  const stopFirst = subscribeRunningSnapshot((snapshot) => first.push(snapshot));
  const second = [];
  const stopSecond = subscribeRunningSnapshot((snapshot) => second.push(snapshot));

  // Both are watching the same in-process state; neither waits for a tick.
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0], first[0]);

  stopSecond();
  stopFirst();
});
