import { getEventHub } from "./event-hub-client";

export interface FileWatchChange {
  mtime?: string;
  size?: number;
}

export interface FileWatchHandlers {
  /**
   * The watcher exists on the server and the client may now snapshot the file.
   * Fires after every (re)subscription, so a reconnect resyncs the viewer.
   */
  onReady(): void;
  onChange(change: FileWatchChange): void;
  onDisconnected?(): void;
}

/**
 * Watch a file through the shared event stream instead of a dedicated
 * EventSource. Same protocol as before: `connected` gates the first read,
 * then every `change` carries mtime/size only.
 */
export function watchFile(
  filePath: string,
  sessionId: string | undefined,
  handlers: FileWatchHandlers,
): () => void {
  return getEventHub().subscribe(
    `file:${filePath}`,
    {
      onEvent: (event) => {
        if (event.name === "connected") {
          handlers.onReady();
          return;
        }
        if (event.name === "change") {
          handlers.onChange((event.data ?? {}) as FileWatchChange);
          return;
        }
        if (event.name === "error") handlers.onDisconnected?.();
      },
      onClose: () => handlers.onDisconnected?.(),
    },
    sessionId ? { sessionId } : {},
  );
}
