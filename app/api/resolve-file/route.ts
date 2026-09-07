import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots } from "@/lib/file-access";
import { findInHome, findInRoots, scoreMatch, type FileMatch } from "@/lib/file-index";

const MAX_CANDIDATES = 20;

// POST /api/resolve-file
// Body: { name, size?, lastModified?, cwd? }
//
// The browser never exposes a dropped file's absolute path (the File API only
// gives name/size/lastModified — see the WICG entries-api spec: dropped items
// live in a virtual root that does not exist in the native filesystem). So the
// client sends those three metadata fields and we locate the file ourselves:
// first in the allowed file roots (cached git/readdir listings), then — only
// when no size+mtime match is found there — in a bounded walk of the user's
// home directory. No file content is ever uploaded or read.
//
// Response: { path } unique best match · { candidates } ambiguous · { path: null }
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      size?: number;
      lastModified?: number;
      cwd?: string;
    };
    const name = body.name?.trim() ?? "";
    if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      return NextResponse.json({ error: "name must be a plain file name" }, { status: 400 });
    }
    const size = typeof body.size === "number" && body.size >= 0 ? body.size : undefined;
    const lastModified = typeof body.lastModified === "number" ? body.lastModified : undefined;

    const roots = await getAllowedFileRoots();
    const matches: FileMatch[] = await findInRoots(name, roots);

    // The allowed roots already contain a size+mtime match — no home walk needed.
    if (!matches.some((m) => scoreMatch(m, size, lastModified) >= 3)) {
      const seen = new Set(matches.map((m) => m.path.toLowerCase()));
      for (const m of findInHome(name)) {
        if (!seen.has(m.path.toLowerCase())) matches.push(m);
      }
    }

    if (matches.length === 0) return NextResponse.json({ path: null });

    const scored = matches.map((m) => ({ ...m, score: scoreMatch(m, size, lastModified) }));
    const best = Math.max(...scored.map((m) => m.score));
    const top = scored
      .filter((m) => m.score === best)
      .sort((a, b) => a.path.localeCompare(b.path));
    if (top.length === 1) return NextResponse.json({ path: top[0].path });
    return NextResponse.json({ candidates: top.slice(0, MAX_CANDIDATES).map((m) => m.path) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
