import { getEventHub } from "./event-hub-client";

/**
 * Client side of the `running` channel.
 *
 * Several components care about the same snapshot (the sidebar list, the shell
 * settle path), and the hub keeps exactly one handler set per channel, so this
 * fans out locally and replays the last snapshot to late subscribers — the
 * server only sends on change, so a newcomer would otherwise wait forever.
 */

export const RUNNING_CHANNEL = "running";

export interface RunningSnapshot {
  sessionListVersion: number;
  runningSessionIds: string[];
  completionNotificationSuppressedSessionIds: string[];
  bashRunningSessionIds: string[];
}

export interface RunningStateHandlers {
  onState(snapshot: RunningSnapshot): void;
  /** The channel or the transport dropped; a reconnect may follow. */
  onClose?(): void;
}

interface LocalHub {
  listeners: Set<RunningStateHandlers>;
  stop: (() => void) | null;
  last: RunningSnapshot | null;
}

const LOCAL_KEY = Symbol.for("pi-web.running-hub");

function local(): LocalHub {
  const holder = globalThis as typeof globalThis & Record<symbol, LocalHub | undefined>;
  return (holder[LOCAL_KEY] ??= { listeners: new Set(), stop: null, last: null });
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

function parseSnapshot(data: unknown): RunningSnapshot | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.runningSessionIds)) return null;
  return {
    sessionListVersion: typeof record.sessionListVersion === "number" ? record.sessionListVersion : 0,
    runningSessionIds: list(record.runningSessionIds),
    completionNotificationSuppressedSessionIds: list(record.completionNotificationSuppressedSessionIds),
    bashRunningSessionIds: list(record.bashRunningSessionIds),
  };
}

export function subscribeRunningState(handlers: RunningStateHandlers): () => void {
  const hub = local();
  hub.listeners.add(handlers);

  if (!hub.stop) {
    hub.last = null;
    hub.stop = getEventHub().subscribe(RUNNING_CHANNEL, {
      onEvent(event) {
        if (event.name !== "state") return;
        const snapshot = parseSnapshot(event.data);
        if (!snapshot) return;
        hub.last = snapshot;
        for (const listener of [...hub.listeners]) {
          try {
            listener.onState(snapshot);
          } catch {
            // One bad consumer must not starve the others.
          }
        }
      },
      onClose() {
        for (const listener of [...hub.listeners]) {
          try {
            listener.onClose?.();
          } catch {
            // ignored, same reason
          }
        }
      },
    });
  } else if (hub.last) {
    // Late subscriber: give it the state it joined too late to witness.
    handlers.onState(hub.last);
  }

  return () => {
    hub.listeners.delete(handlers);
    if (hub.listeners.size === 0 && hub.stop) {
      hub.stop();
      hub.stop = null;
      hub.last = null;
    }
  };
}
