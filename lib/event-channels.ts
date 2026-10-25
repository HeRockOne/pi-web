import fs from "fs";
import path from "path";
import { openAgentEventChannel } from "./agent-event-channel";
import { channelKey, parseChannelKey } from "./event-channel-key";
import type { HubChannelCleanup, HubChannelSink } from "./event-hub";
import { authorizeFileRequest } from "./file-request-auth";
import { samePath } from "./paths";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { subscribeRunningSnapshot } from "./running-state";
import { resolveSessionPath } from "./session-reader";
import { subscribeTerminal } from "./terminal-manager";

/**
 * The client used to poll /api/agent/running every 2.5 s. Pushing the same
 * snapshot costs the server one in-memory read per second and the client
 * nothing at all, which is the difference between ~24 round trips per minute
 * and zero on a high-latency link.
 */
function openRunningChannel(sink: HubChannelSink): HubChannelCleanup {
  const channel = channelKey("running", "");
  return subscribeRunningSnapshot((snapshot) => {
    sink({ c: channel, e: "state", d: snapshot });
  });
}

function openTerminalChannel(
  id: string,
  sink: HubChannelSink,
  after: string | undefined,
): HubChannelCleanup | null {
  // The cursor is the terminal's byte offset; anything unparsable means "send
  // the whole backlog" (subscribeTerminal resets rather than resuming).
  const cursor = after !== undefined && /^\d+$/.test(after) ? Number(after) : undefined;
  const subscription = subscribeTerminal(
    id,
    (event) => {
      sink({
        c: channelKey("terminal", id),
        d: event,
        ...(event.type === "output" ? { id: String(event.offset) } : {}),
      });
    },
    cursor,
  );
  if (!subscription) return null;

  const channel = channelKey("terminal", id);
  // A channel-level "open" replaces the EventSource `onopen` the panel used:
  // the transport is shared, so connection-open no longer means terminal-ready.
  sink({ c: channel, e: "open", d: null });
  sink({ c: channel, d: subscription.output, id: String(subscription.output.offset) });
  if (subscription.exited) {
    sink({ c: channel, d: { type: "exit", exitCode: subscription.exitCode ?? 0 } });
  }
  return subscription.unsubscribe;
}

/**
 * File watching moved off its own EventSource. The authorization decision is
 * the same one /api/files makes; it must stay that way (see
 * lib/file-request-auth.ts).
 */
export async function openFileWatchChannel(
  filePath: string,
  sink: HubChannelSink,
  options: { sessionId?: string | null },
): Promise<HubChannelCleanup | null> {
  const auth = await authorizeFileRequest(filePath, {
    sessionId: options.sessionId,
    allowSessionReference: true,
    allowMissing: true,
  });
  if (!auth.ok) return null;
  if (auth.stat && !auth.stat.isFile()) return null;

  const channel = channelKey("file", filePath);
  const initial = auth.stat;
  let lastMtimeMs = initial?.mtimeMs ?? 0;
  let lastCtimeMs = initial?.ctimeMs ?? 0;
  let lastIno = initial?.ino ?? 0;
  let lastSize = initial?.size ?? 0;
  let lastExists = initial !== undefined;
  let watcher: fs.FSWatcher | null = null;

  try {
    const watchedDirectory = path.dirname(filePath);
    watcher = fs.watch(watchedDirectory, (_eventType, changedName) => {
      if (
        changedName != null
        && !samePath(path.join(watchedDirectory, changedName.toString()), filePath)
      ) return;
      try {
        const next = fs.statSync(filePath);
        // Some platforms emit watch events for reads and attribute access.
        // Forwarding those would make the viewer reload in a loop.
        if (
          lastExists
          && next.mtimeMs === lastMtimeMs
          && next.ctimeMs === lastCtimeMs
          && next.ino === lastIno
          && next.size === lastSize
        ) return;
        lastExists = true;
        lastMtimeMs = next.mtimeMs;
        lastCtimeMs = next.ctimeMs;
        lastIno = next.ino;
        lastSize = next.size;
        sink({ c: channel, e: "change", d: { mtime: next.mtime.toISOString(), size: next.size } });
      } catch {
        if (!lastExists) return;
        lastExists = false;
        sink({ c: channel, e: "change", d: { mtime: new Date().toISOString(), size: 0 } });
      }
    });
    watcher.on("error", () => {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    });
  } catch {
    sink({ c: channel, e: "error", d: { message: "Failed to watch file" } });
    return null;
  }

  // The client snapshots only after this event, so emit it once the watcher
  // exists — otherwise a change between those steps is lost.
  sink({ c: channel, e: "connected", d: { filePath } });

  return () => {
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  };
}

/**
 * The chat stream, moved onto the shared connection. Same handshake as the
 * dedicated endpoint (see lib/agent-event-channel.ts); the only difference is
 * where the frames go.
 */
async function openAgentChannel(
  sessionId: string,
  sink: HubChannelSink,
  onDone: () => void,
): Promise<HubChannelCleanup | null> {
  const running = getRpcSession(sessionId);
  let sessionPromise;
  if (running?.isAlive()) {
    sessionPromise = Promise.resolve(running);
  } else {
    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) return null;
    sessionPromise = startRpcSession(sessionId, filePath, undefined).then((result) => result.session);
  }

  const channel = channelKey("agent", sessionId);
  let finished = false;
  const closeChannel = openAgentEventChannel(sessionId, sessionPromise, {
    send(event) {
      sink({ c: channel, d: event });
    },
    finish() {
      if (finished) return;
      finished = true;
      // Tell the client this channel is spent, then drop it server-side so a
      // re-subscribe opens a fresh producer instead of a dead one.
      sink({ c: channel, e: "done", d: null });
      onDone();
    },
  });

  return () => {
    finished = true;
    closeChannel();
  };
}

/**
 * Start the producer behind one channel. Returns null when the channel cannot
 * be served; the caller reports that in-band on the channel itself.
 */
export async function openEventChannel(
  key: string,
  sink: HubChannelSink,
  options: { sessionId?: string | null; after?: string; onDone?: () => void } = {},
): Promise<HubChannelCleanup | null> {
  const parsed = parseChannelKey(key);
  if (!parsed) return null;
  if (parsed.kind === "running") return openRunningChannel(sink);
  if (parsed.kind === "terminal") return openTerminalChannel(parsed.id, sink, options.after);
  if (parsed.kind === "file") return openFileWatchChannel(parsed.id, sink, options);
  if (parsed.kind === "agent") {
    return openAgentChannel(parsed.id, sink, options.onDone ?? (() => {}));
  }
  return null;
}
