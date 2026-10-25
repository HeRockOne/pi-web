import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";
import { acquireSessionLivenessLease } from "./session-liveness";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  isAlive?(): boolean;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
}

export interface AgentChannelSink {
  /** One projected event, already filtered for the browser. */
  send(event: unknown): void;
  /** The producer is done; no more events will arrive on this channel. */
  finish(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Produce one session's agent events.
 *
 * Extracted from the SSE route so the same handshake can feed either a
 * dedicated stream or a channel of the multiplexed one. The ordering it
 * guarantees is load-bearing: subscribe first, then publish `connected`, then
 * replay what arrived in between, then the snapshot. Switching that order
 * loses the first tokens of a cold start.
 *
 * Returns a close function; it is idempotent.
 */
export function openAgentEventChannel(
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
  sink: AgentChannelSink,
): () => void {
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  const releaseLease = acquireSessionLivenessLease(sessionId).release;

  const close = (): void => {
    if (closed) return;
    closed = true;
    releaseLease();
    unsubscribe?.();
    unsubscribe = null;
  };

  const forward = (event: AgentEventLike, snapshot: unknown): void => {
    if (isEventIncludedInSnapshot(event, snapshot)) return;
    const clientEvent = toClientAgentEvent(event);
    if (clientEvent) sink.send(clientEvent);
  };

  const publish = async (): Promise<void> => {
    try {
      const session = await sessionPromise;
      if (closed) return;
      if (session.isAlive && !session.isAlive()) {
        close();
        sink.finish();
        return;
      }

      const buffered: AgentEventLike[] = [];
      let snapshotPublished = false;
      const handleEvent = (event: AgentEventLike): void => {
        if (event.type === "session_shutdown") {
          close();
          sink.finish();
          return;
        }
        if (!snapshotPublished) {
          buffered.push(event);
          return;
        }
        forward(event, snapshot);
      };

      const stopListening = session.onEvent(handleEvent);
      if (closed) {
        stopListening();
        return;
      }
      if (session.isAlive && !session.isAlive()) {
        stopListening();
        close();
        sink.finish();
        return;
      }
      unsubscribe = stopListening;

      const snapshot = session.streamingMessage;
      sink.send({ type: "connected", sessionId, isStreaming: session.isStreaming });
      for (const event of buffered) forward(event, snapshot);
      if (snapshot !== undefined && snapshot !== null) {
        sink.send({ type: "message_start", message: snapshot });
      }
      snapshotPublished = true;
    } catch (error) {
      if (closed) return;
      sink.send({
        type: "startup_error",
        errorMessage: `Failed to start agent: ${errorMessage(error)}`,
      });
      close();
      sink.finish();
    }
  };

  // Attach the rejection handler before returning: the caller may already have
  // started a shared cold-start promise that rejects.
  void publish();
  return close;
}
