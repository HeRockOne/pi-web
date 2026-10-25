import {
  getBashRunningRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "./rpc-manager";
import { getSessionListVersion } from "./session-reader";

/**
 * Server-side view of "what is running right now".
 *
 * The browser used to fetch this every 2.5 s. Over a public link each request
 * costs a full round trip, so the same snapshot is now computed in-process and
 * pushed through the hub. Nobody is watching unless a channel is subscribed,
 * which keeps an idle server at zero work.
 */
export interface RunningSnapshot {
  sessionListVersion: number;
  runningSessionIds: string[];
  completionNotificationSuppressedSessionIds: string[];
  bashRunningSessionIds: string[];
}

/** Fast enough that a finished turn looks instant, cheap enough to be free. */
const TICK_MS = 1_000;

interface Registry {
  listeners: Set<(snapshot: RunningSnapshot) => void>;
  timer: ReturnType<typeof setInterval> | null;
  last: string;
}

const REGISTRY_KEY = Symbol.for("pi-web.running-state");

function registry(): Registry {
  const holder = globalThis as typeof globalThis & Record<symbol, Registry | undefined>;
  return (holder[REGISTRY_KEY] ??= { listeners: new Set(), timer: null, last: "" });
}

const sorted = (ids: string[]) => [...ids].sort();

export function readRunningSnapshot(): RunningSnapshot {
  return {
    sessionListVersion: getSessionListVersion(),
    runningSessionIds: sorted(getRunningRpcSessionIds()),
    completionNotificationSuppressedSessionIds: sorted(
      getCompletionNotificationSuppressedRpcSessionIds(),
    ),
    bashRunningSessionIds: sorted(getBashRunningRpcSessionIds()),
  };
}

/** Arrays are sorted in the snapshot so this stays stable across ticks. */
function signature(snapshot: RunningSnapshot): string {
  return JSON.stringify(snapshot);
}

function tick(): void {
  const reg = registry();
  if (reg.listeners.size === 0) return;
  const snapshot = readRunningSnapshot();
  const next = signature(snapshot);
  if (next === reg.last) return;
  reg.last = next;
  for (const listener of [...reg.listeners]) {
    try {
      listener(snapshot);
    } catch {
      // One broken sink must not stop the others from being told.
    }
  }
}

/**
 * Subscribe to running-state changes. The listener is called once immediately
 * with the current snapshot, then only when something actually changed.
 */
export function subscribeRunningSnapshot(listener: (snapshot: RunningSnapshot) => void): () => void {
  const reg = registry();
  const current = readRunningSnapshot();
  reg.listeners.add(listener);
  if (reg.timer === null) {
    reg.last = signature(current);
    reg.timer = setInterval(tick, TICK_MS);
    // Never keep the process alive just to watch an idle registry.
    (reg.timer as { unref?: () => void }).unref?.();
  }
  try {
    listener(current);
  } catch {
    // Ignore: the caller will get the next change.
  }

  return () => {
    reg.listeners.delete(listener);
    if (reg.listeners.size === 0 && reg.timer !== null) {
      clearInterval(reg.timer);
      reg.timer = null;
    }
  };
}
