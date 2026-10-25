export type ChannelKind = "agent" | "terminal" | "file" | "running";

const CHANNEL_KINDS = new Set<string>(["agent", "terminal", "file", "running"]);

/**
 * One channel per connection, not per subject: `running` carries the whole
 * server's running-state snapshot, so it needs no id.
 */
const SINGLETON_KINDS = new Set<string>(["running"]);

export function channelKey(kind: ChannelKind, id: string): string {
  return id ? `${kind}:${id}` : kind;
}

/**
 * `file:C:\dir\a.ts` must survive the round trip, so split at the FIRST colon
 * only — the payload may legitimately contain more of them.
 */
export function parseChannelKey(key: string): { kind: ChannelKind; id: string } | null {
  if (SINGLETON_KINDS.has(key)) return { kind: key as ChannelKind, id: "" };
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!CHANNEL_KINDS.has(kind) || !id) return null;
  return { kind: kind as ChannelKind, id };
}

export interface ChannelRequest {
  channel: string;
  /** Resume cursor the producer should start from, when it supports one. */
  after?: string;
}

/**
 * Accepts both `"terminal:t1"` and `{ channel: "terminal:t1", after: "42" }`.
 * The browser sends descriptors so a reconnect can resume, but a plain string
 * stays valid for manual probing.
 */
export function parseChannelRequests(value: unknown): ChannelRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: ChannelRequest[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry) requests.push({ channel: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.channel !== "string" || !record.channel) continue;
    requests.push(
      typeof record.after === "string"
        ? { channel: record.channel, after: record.after }
        : { channel: record.channel },
    );
  }
  return requests;
}
