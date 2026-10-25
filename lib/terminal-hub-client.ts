import type { TerminalEvent } from "./terminal-manager";
import { getEventHub } from "./event-hub-client";

type TerminalOutputEvent = Extract<TerminalEvent, { type: "output" }>;

export interface TerminalChannelHandlers {
  /** The terminal is attached on the server and can accept input. */
  onOpen(): void;
  onOutput(event: TerminalOutputEvent): void;
  onExit(exitCode: number | null): void;
  /** The channel itself failed (terminal gone); do not expect a reconnect. */
  onChannelError(): void;
  /** Transport lost. The hub reconnects and re-subscribes on its own. */
  onClose(): void;
}

/**
 * Terminal output over the shared stream. The byte offset travels as the
 * channel's resume cursor, so a reconnect replays only what was missed —
 * the same contract the dedicated endpoint had via `?after=`.
 */
export function subscribeTerminalChannel(
  id: string,
  options: { after?: string },
  handlers: TerminalChannelHandlers,
): () => void {
  const hub = getEventHub();
  const channel = `terminal:${id}`;
  return hub.subscribe(
    channel,
    {
      onOpen: () => handlers.onOpen(),
      onEvent: (event) => {
        if (event.name === "error") {
          handlers.onChannelError();
          return;
        }
        if (event.name === "open") return;
        const payload = event.data as TerminalEvent | null;
        if (!payload || typeof payload !== "object") return;
        if (payload.type === "output") {
          hub.setCursor(channel, String(payload.offset));
          handlers.onOutput(payload);
          return;
        }
        if (payload.type === "exit") {
          handlers.onExit(payload.exitCode ?? 0);
          return;
        }
        handlers.onExit(null);
      },
      onClose: () => handlers.onClose(),
    },
    options.after === undefined ? {} : { after: options.after },
  );
}
