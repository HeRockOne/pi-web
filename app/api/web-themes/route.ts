import { NextResponse } from "next/server";
import {
  activateWebTheme,
  deleteCustomTheme,
  listWebThemes,
  upsertCustomTheme,
} from "@/lib/web-themes";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listWebThemes());
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const action = body.action;

    if (action === "activate") {
      const id = typeof body.id === "string" ? body.id : "";
      const theme = activateWebTheme(id);
      if (!theme) return NextResponse.json({ error: "Unknown theme id" }, { status: 404 });
      return NextResponse.json({ success: true, theme });
    }

    if (action === "save") {
      const theme = upsertCustomTheme(body.theme);
      if (!theme) return NextResponse.json({ error: "Invalid theme payload" }, { status: 400 });
      return NextResponse.json({ success: true, theme });
    }

    if (action === "delete") {
      const id = typeof body.id === "string" ? body.id : "";
      const result = deleteCustomTheme(id);
      if (!result.ok) return NextResponse.json({ error: "Unknown theme id" }, { status: 404 });
      return NextResponse.json({ success: true, ...result });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
