import { NextResponse } from "next/server";
import { parseChannelRequests } from "@/lib/event-channel-key";
import { openEventChannel } from "@/lib/event-channels";
import { getHubConnection } from "@/lib/event-hub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A tab needs a handful of channels; the cap only stops a runaway client from
// pinning unbounded producers to one connection.
const MAX_CHANNELS_PER_CONNECTION = 32;

interface SubscribeBody {
  connectionId?: unknown;
  subscribe?: unknown;
  unsubscribe?: unknown;
}

function parseKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

// POST /api/events/subscribe - add/remove channels on an open hub connection.
export async function POST(req: Request) {
  let body: SubscribeBody;
  try {
    body = (await req.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const connection = getHubConnection(connectionId);
  if (!connection || connection.isClosed()) {
    // The client must open a new connection (it will, on the next frame).
    return NextResponse.json({ error: "Unknown connection" }, { status: 409 });
  }

  const sessionId = typeof (body as { sessionId?: unknown }).sessionId === "string"
    ? (body as { sessionId: string }).sessionId
    : undefined;

  for (const key of parseKeys(body.unsubscribe)) connection.remove(key);

  const failed: string[] = [];
  for (const request of parseChannelRequests(body.subscribe)) {
    const key = request.channel;
    if (connection.has(key)) continue;
    if (connection.channelCount() >= MAX_CHANNELS_PER_CONNECTION) {
      failed.push(key);
      connection.send({ c: key, e: "error", d: { message: "Too many channels" } }, true);
      continue;
    }
    const handle = { done: false };
    const cleanup = await openEventChannel(key, (frame) => connection.send(frame), {
      sessionId,
      ...(request.after !== undefined ? { after: request.after } : {}),
      onDone: () => {
        handle.done = true;
        connection.remove(key);
      },
    });
    if (!cleanup) {
      failed.push(key);
      connection.send({ c: key, e: "error", d: { message: "Channel unavailable" } }, true);
      continue;
    }
    // The producer can finish during startup (session missing or already shut
    // down). Registering it anyway would leave a dead channel that swallows
    // the client's next subscribe.
    if (handle.done) {
      cleanup();
      continue;
    }
    if (connection.isClosed()) {
      cleanup();
      break;
    }
    connection.add(key, cleanup);
  }

  return NextResponse.json({ success: true, data: { failed } });
}
