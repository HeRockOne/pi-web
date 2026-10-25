import { openAgentEventChannel, type AgentEventStreamSession } from "./agent-event-channel";

export type { AgentEventStreamSession } from "./agent-event-channel";

const HEARTBEAT_INTERVAL_MS = 30_000;
// One enqueue per agent event means one syscall, one flush and one small TCP
// segment per token. Coalesce into roughly one frame: the browser renders on
// the animation frame anyway, so this cuts syscalls and packet count without
// adding perceptible latency.
const FLUSH_INTERVAL_MS = 16;
// A tool result or a big snapshot should not sit in a 16 ms window when the
// buffer is already this large; flush immediately past this point.
const MAX_PENDING_CHARS = 32 * 1024;

// Only the high-frequency streaming events are worth coalescing. State
// transitions stay immediate so a turn boundary is never held back.
const COALESCED_EVENT_TYPES = new Set(["message_update", "tool_execution_update"]);

/**
 * Registry of live SSE streams, closed from the SIGINT/SIGTERM hook in
 * instrumentation.ts.
 *
 * In production Next 16 handles those signals with `server.close()` and waits
 * for every connection to end, with no timeout and no `closeAllConnections`
 * (that call is dev-only in next/dist/server/lib/start-server.js). An SSE
 * stream only ends when the client disconnects, so without this the process
 * stops listening (502 upstream) but never exits.
 *
 * instrumentation.ts and the route handlers are bundled into separate module
 * graphs, each with its own copy of this module; a plain module-level Set
 * would be two disconnected registries. Symbol.for + globalThis shares one.
 */
const CLOSER_REGISTRY: symbol = Symbol.for("pi-web.agentEventStreamClosers");
type StreamCloser = () => void;
const activeStreamClosers: Set<StreamCloser> =
  ((globalThis as Record<symbol, Set<StreamCloser>>)[CLOSER_REGISTRY] ??= new Set<StreamCloser>());

/** Close every live SSE stream (called on process shutdown signals). */
export function closeAllAgentEventStreams(): void {
  for (const close of [...activeStreamClosers]) {
    try { close(); } catch { /* stream already closed */ }
  }
}

/**
 * The dedicated per-session SSE endpoint.
 *
 * Kept as a thin transport around openAgentEventChannel so the handshake has
 * exactly one implementation; the multiplexed hub drives the same channel.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean | "error") => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let abortHandler: (() => void) | null = null;
      let teardown = (): void => {};
      let pending = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      function flushPending(): void {
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
          cleanup(false);
        }
      }

      function enqueueText(text: string, immediate = false): void {
        if (closed) return;
        pending += text;
        if (immediate || pending.length >= MAX_PENDING_CHARS) {
          flushPending();
          return;
        }
        if (flushTimer !== null) return;
        flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
      }

      function shutdownCloser(): void {
        cleanup("error");
      }

      // "error": hard-terminate the response (SSE client sees a broken
      // stream and reconnects). Used on process shutdown: a plain close() is
      // swallowed by the Next/Node response pipeline without emitting a
      // chunked termination, so the socket stays ESTABLISHED and Next's
      // server.close() drain never completes (the original zombie bug).
      // "true": graceful close after we finished writing a final event.
      function cleanup(closeController: boolean | "error"): void {
        if (closed) return;
        // Deliver whatever is still queued: a final event must not be lost to
        // the coalescing window.
        flushPending();
        closed = true;
        teardown();
        activeStreamClosers.delete(shutdownCloser);
        if (heartbeat !== null) clearInterval(heartbeat);
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController === "error") {
          try { controller.error(new Error("pi-web server shutting down")); } catch { /* already closed */ }
        } else if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      }
      cancelStream = cleanup;
      activeStreamClosers.add(shutdownCloser);

      teardown = openAgentEventChannel(sessionId, sessionPromise, {
        send(event) {
          const type = (event as { type?: string } | null)?.type;
          enqueueText(
            `data: ${JSON.stringify(event)}\n\n`,
            !(type && COALESCED_EVENT_TYPES.has(type)),
          );
        },
        finish() {
          cleanup(true);
        },
      });

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n", true);
    },
    cancel() {
      cancelStream(false);
    },
  });
}
