/**
 * Browser side of the multiplexed stream.
 *
 * One EventSource per tab, shared by every consumer. The connection only exists
 * while at least one channel is subscribed, so an idle tab still holds zero
 * connections — the point is to stop paying one connection *per panel*, not to
 * keep one open forever.
 */

export const HUB_URL = "/api/events";
const CONTROL_CHANNEL = "$hub";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface HubEvent {
  /** Channel-local event name; "message" when the server omitted one. */
  name: string;
  data: unknown;
  /** Resume cursor for this channel, when the producer supplies one. */
  id?: string;
}

export interface HubChannelHandlers {
  /** Fired once per successful (re)subscription, before any buffered data. */
  onOpen?(): void;
  onEvent?(event: HubEvent): void;
  /** The channel or the transport went away. A reconnect may follow. */
  onClose?(): void;
}

interface ChannelEntry {
  handlers: HubChannelHandlers;
  /** Cursor to resume from on the next subscription. */
  cursor?: string;
  sessionId?: string;
  opened: boolean;
  sent: boolean;
}

interface HubFrame {
  c?: unknown;
  e?: unknown;
  d?: unknown;
  id?: unknown;
}

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempt, 30), RECONNECT_MAX_MS);
  // Full jitter: tabs must not reconnect in lockstep after a server restart.
  return Math.max(1, Math.round(exponential * (0.5 + Math.random() * 0.5)));
}

class EventHubClient {
  private channels = new Map<string, ChannelEntry>();
  private source: EventSource | null = null;
  private connectionId: string | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Unsubscribe and re-subscribe are separate requests; if they race, the
  // server can remove the channel it just opened and the consumer goes silent.
  private postChain: Promise<void> = Promise.resolve();

  subscribe(
    channel: string,
    handlers: HubChannelHandlers,
    options: { after?: string; sessionId?: string } = {},
  ): () => void {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return () => {};
    }
    const existing = this.channels.get(channel);
    if (existing) {
      // Re-subscribing the same channel replaces the handlers; the producer
      // stays subscribed, so nothing has to be re-sent.
      existing.handlers = handlers;
      if (options.after !== undefined) existing.cursor = options.after;
      return this.makeUnsubscribe(channel, existing);
    }

    const entry: ChannelEntry = {
      handlers,
      ...(options.after !== undefined ? { cursor: options.after } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      opened: false,
      sent: false,
    };
    this.channels.set(channel, entry);
    this.ensureConnection();
    this.flushSubscriptions();
    return this.makeUnsubscribe(channel, entry);
  }

  /** Record the resume cursor without re-subscribing (terminal byte offsets). */
  setCursor(channel: string, cursor: string): void {
    const entry = this.channels.get(channel);
    if (entry) entry.cursor = cursor;
  }

  /** Test seam: drop the singleton state without touching globals. */
  reset(): void {
    this.stopRetrying();
    this.source?.close();
    this.source = null;
    this.connectionId = null;
    this.attempt = 0;
    this.channels.clear();
    this.postChain = Promise.resolve();
  }

  private makeUnsubscribe(channel: string, entry: ChannelEntry): () => void {
    return () => {
      if (this.channels.get(channel) !== entry) return;
      this.channels.delete(channel);
      if (this.connectionId) {
        void this.post({ unsubscribe: [channel] });
      }
      if (this.channels.size === 0) this.closeConnection();
    };
  }

  private ensureConnection(): void {
    if (this.source) return;
    const source = new EventSource(HUB_URL);
    this.source = source;
    source.onmessage = (message) => this.handleMessage(message);
    source.onerror = () => {
      if (this.source !== source) return;
      // Managed reconnect: the native one cannot re-subscribe our channels.
      this.onDisconnected();
    };
  }

  private handleMessage(message: MessageEvent<string>): void {
    let frame: HubFrame;
    try {
      frame = JSON.parse(message.data) as HubFrame;
    } catch {
      return;
    }
    if (typeof frame.c !== "string") return;

    if (frame.c === CONTROL_CHANNEL) {
      const data = frame.d as { connectionId?: unknown } | null;
      if (frame.e === "ready" && typeof data?.connectionId === "string") {
        this.connectionId = data.connectionId;
        this.attempt = 0;
        this.flushSubscriptions();
      }
      return;
    }

    const entry = this.channels.get(frame.c);
    if (!entry) return; // channel already unsubscribed
    if (typeof frame.id === "string") entry.cursor = frame.id;
    const name = typeof frame.e === "string" ? frame.e : "message";
    if (name === "error") {
      // Forward it *and* report the close: a channel-level failure means this
      // subscription is dead, while the transport may still be healthy.
      entry.opened = false;
      entry.handlers.onEvent?.({ name, data: frame.d });
      entry.handlers.onClose?.();
      return;
    }
    // "open" is explicit for channels whose producers have a ready step
    // (terminal); everything else opens implicitly on its first frame. Either
    // way onOpen fires once per subscription, not once per event.
    if (name === "open") {
      if (!entry.opened) {
        entry.opened = true;
        entry.handlers.onOpen?.();
      }
      return;
    }
    if (!entry.opened) {
      entry.opened = true;
      entry.handlers.onOpen?.();
    }
    entry.handlers.onEvent?.({
      name,
      data: frame.d,
      ...(typeof frame.id === "string" ? { id: frame.id } : {}),
    });
  }

  /** Send every channel the server has not been told about yet. */
  private flushSubscriptions(): void {
    if (!this.connectionId) return;
    const pending = [...this.channels.entries()].filter(([, entry]) => !entry.sent);
    if (pending.length === 0) return;
    for (const [, entry] of pending) entry.sent = true;
    // The server takes one sessionId per request (file channels authorize
    // against it), so group instead of leaking the first one onto everyone.
    const groups = new Map<string, Array<{ channel: string; after?: string }>>();
    for (const [channel, entry] of pending) {
      const key = entry.sessionId ?? "";
      const bucket = groups.get(key);
      const item = { channel, ...(entry.cursor !== undefined ? { after: entry.cursor } : {}) };
      if (bucket) bucket.push(item);
      else groups.set(key, [item]);
    }
    for (const [sessionId, subscribe] of groups) {
      void this.post({ subscribe, ...(sessionId ? { sessionId } : {}) });
    }
  }

  private post(body: Record<string, unknown>): Promise<void> {
    const next = this.postChain.then(() => this.postNow(body));
    // Keep the chain alive even when one request rejects.
    this.postChain = next.catch(() => {});
    return next;
  }

  private async postNow(body: Record<string, unknown>): Promise<void> {
    if (!this.connectionId) return;
    try {
      const res = await fetch("/api/events/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: this.connectionId, ...body }),
      });
      if (res.status === 409) {
        // The server forgot this connection; start a fresh one.
        this.onDisconnected();
        return;
      }
    } catch {
      // Offline, or the route is briefly unavailable. The SSE usually dies at
      // the same time and the reconnect path re-subscribes everything, but a
      // half-broken transport must not leave channels unsubscribed forever.
      for (const entry of this.channels.values()) entry.sent = false;
      if (this.channels.size > 0 && this.retryTimer === null) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.flushSubscriptions();
        }, RECONNECT_BASE_MS);
      }
    }
  }

  private onDisconnected(): void {
    this.connectionId = null;
    this.source?.close();
    this.source = null;
    for (const entry of this.channels.values()) {
      const wasOpen = entry.opened;
      entry.sent = false;
      entry.opened = false;
      if (wasOpen) entry.handlers.onClose?.();
    }
    if (this.channels.size === 0) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null) return;
    const delay = reconnectDelay(this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.channels.size === 0) return;
      this.ensureConnection();
    }, delay);
  }

  private stopRetrying(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private closeConnection(): void {
    this.stopRetrying();
    this.source?.close();
    this.source = null;
    this.connectionId = null;
    this.attempt = 0;
  }
}

const HUB_KEY = "__piWebEventHubClient";

/** Singleton across hot reloads: two hubs would mean two connections. */
export function getEventHub(): EventHubClient {
  const holder = globalThis as typeof globalThis & Record<string, EventHubClient | undefined>;
  return (holder[HUB_KEY] ??= new EventHubClient());
}

export type { EventHubClient };
