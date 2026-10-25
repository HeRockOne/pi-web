import { createHubConnection } from "@/lib/event-hub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/events - the single SSE connection a browser tab keeps open.
// Channels are added and removed through POST /api/events/subscribe once the
// client learns its connectionId from the `$hub` ready frame.
export async function GET(req: Request) {
  if (req.signal.aborted) return new Response(null, { status: 204 });
  const connection = createHubConnection(req);
  return new Response(connection.stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
