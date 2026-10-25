import { getEventHub } from "./event-hub-client";
import type { AgentEventSourceLike } from "./agent-event-connection";

const EVENT_SOURCE_CONNECTING = 0;
const EVENT_SOURCE_OPEN = 1;
const EVENT_SOURCE_CLOSED = 2;

/**
 * Presents one hub channel as the EventSource-shaped source that
 * AgentEventConnection already knows how to drive, so the readiness handshake,
 * reconnect backoff and `shouldMaintain` gating all stay untouched.
 *
 * The frames are re-serialized because that interface speaks SSE strings;
 * events are small since the wire projection drops the cumulative payloads.
 */
export function createHubAgentSource(sessionId: string): AgentEventSourceLike {
  let readyState = EVENT_SOURCE_CONNECTING;
  let unsubscribe: (() => void) | null = null;

  const source: AgentEventSourceLike = {
    get readyState() {
      return readyState;
    },
    onmessage: null,
    onerror: null,
    close() {
      readyState = EVENT_SOURCE_CLOSED;
      unsubscribe?.();
      unsubscribe = null;
    },
  };

  const reportClosed = (): void => {
    readyState = EVENT_SOURCE_CLOSED;
    source.onerror?.(new Event("error"));
  };

  unsubscribe = getEventHub().subscribe(`agent:${sessionId}`, {
    onOpen() {
      readyState = EVENT_SOURCE_OPEN;
    },
    onEvent(event) {
      if (event.name === "done") {
        // The session shut down or was replaced: behave like a dropped stream
        // so AgentEventConnection reconnects against the new session.
        reportClosed();
        return;
      }
      source.onmessage?.({ data: JSON.stringify(event.data) } as MessageEvent<string>);
    },
    onClose: reportClosed,
  });

  return source;
}
