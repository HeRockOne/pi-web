/**
 * One SSE connection per browser tab, many logical channels.
 *
 * Why: browsers hold at most six HTTP/1.1 connections per origin, shared across
 * every tab, and `next start` speaks HTTP/1.1 only. The chat stream, the
 * terminal stream and a file-watch stream each pinned one connection, so two
 * tabs with a couple of panels open could exhaust the pool and stall *every*
 * later request — including the POST that sends a prompt. Multiplexing them
 * onto one connection keeps the pool free.
 *
 * Protocol: the connection carries `{"c":<channel>,"e":<event>,"d":<data>,
 * "id":<cursor>}` frames. `e` defaults to "message". `id` is the resume cursor
 * a channel understands (the terminal uses its byte offset).
 */

export const HUB_CONTROL_CHANNEL = "$hub";

export interface HubFrame {
  /** Channel key, e.g. "agent:<sessionId>". */
  c: string;
  /** Event name within the channel; "message" when omitted. */
  e?: string;
  d?: unknown;
  /** Per-channel resume cursor. */
  id?: string;
}

export type HubChannelSink = (frame: HubFrame) => void;
export type HubChannelCleanup = () => void;

const FLUSH_INTERVAL_MS = 16;
const MAX_PENDING_CHARS = 32 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

type HubConnection = {
  readonly id: string;
  readonly stream: ReadableStream<Uint8Array>;
  has(channel: string): boolean;
  channelCount(): number;
  add(channel: string, cleanup: HubChannelCleanup): void;
  remove(channel: string): void;
  send(frame: HubFrame, immediate?: boolean): void;
  isClosed(): boolean;
  /** Hard-close the response (process shutdown). Safe when the stream is locked. */
  close(): void;
};

// Route handlers and instrumentation are bundled into separate module graphs,
// each with a copy of this module; Symbol.for + globalThis keeps one registry.
const REGISTRY_KEY: symbol = Symbol.for("pi-web.eventHubConnections");

function registry(): Map<string, HubConnection> {
  return ((globalThis as Record<symbol, Map<string, HubConnection>>)[REGISTRY_KEY] ??=
    new Map<string, HubConnection>());
}

/** Close every multiplexed stream (called on process shutdown signals). */
export function closeAllEventHubStreams(): void {
  for (const connection of [...registry().values()]) {
    try {
      // Not stream.cancel(): the response body holds a reader, so cancel()
      // rejects on a locked stream and the socket would survive shutdown.
      connection.close();
    } catch {
      /* already closed */
    }
  }
  registry().clear();
}

export function getHubConnection(id: string): HubConnection | undefined {
  return registry().get(id);
}

export function createHubConnection(req: Request): HubConnection {
  const id = `hub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const encoder = new TextEncoder();
  const channels = new Map<string, HubChannelCleanup>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function flush(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pending) return;
    const text = pending;
    pending = "";
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      shutdown("error");
    }
  }

  function write(text: string, immediate: boolean): void {
    if (closed) return;
    pending += text;
    if (immediate || pending.length >= MAX_PENDING_CHARS) {
      flush();
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  function shutdown(closeController: "error" | "graceful"): void {
    if (closed) return;
    // Deliver what is already queued before ending the stream.
    flush();
    closed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    req.signal.removeEventListener("abort", onAbort);
    for (const cleanup of [...channels.values()]) {
      try {
        cleanup();
      } catch {
        /* channel already torn down */
      }
    }
    channels.clear();
    registry().delete(id);
    try {
      if (closeController === "error") controller.error(new Error("pi-web stream closed"));
      else controller.close();
    } catch {
      /* already closed */
    }
  }

  function onAbort(): void {
    shutdown("graceful");
  }

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      req.signal.addEventListener("abort", onAbort, { once: true });
      heartbeat = setInterval(() => write(":\n\n", false), HEARTBEAT_INTERVAL_MS);
      // The client needs the id before it can subscribe anything.
      write(`data: ${JSON.stringify({ c: HUB_CONTROL_CHANNEL, e: "ready", d: { connectionId: id } })}\n\n`, true);
    },
    cancel() {
      shutdown("graceful");
    },
  });

  const connection: HubConnection = {
    id,
    stream,
    has: (channel) => channels.has(channel),
    channelCount: () => channels.size,
    add(channel, cleanup) {
      const existing = channels.get(channel);
      if (existing) existing();
      channels.set(channel, cleanup);
    },
    remove(channel) {
      const cleanup = channels.get(channel);
      if (!cleanup) return;
      channels.delete(channel);
      try {
        cleanup();
      } catch {
        /* channel already torn down */
      }
    },
    send(frame, immediate = false) {
      write(`data: ${JSON.stringify(frame)}\n\n`, immediate);
    },
    isClosed: () => closed,
    close() {
      shutdown("error");
    },
  };

  registry().set(id, connection);
  return connection;
}
