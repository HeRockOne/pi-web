import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { getListing, type FileListing } from "@/lib/file-index";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy";

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface CacheEntry {
  listing: FileListing;
  entries: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so derived
// entries must not be recomputed within a short window. The raw listing
// itself is cached by lib/file-index (shared with /api/resolve-file).
declare global {
  var __piFileIndexEntriesCache: Map<string, CacheEntry> | undefined;
}

function getEntriesCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexEntriesCache) globalThis.__piFileIndexEntriesCache = new Map();
  return globalThis.__piFileIndexEntriesCache;
}

// GET /api/file-index?cwd=/abs/path[&q=query]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd).
// Guarded by the same allow-list as /api/files.
export async function GET(req: NextRequest) {
  try {
    const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const cache = getEntriesCache();
    const now = Date.now();
    let cached = cache.get(cwd);
    if (!cached || cached.expiresAt <= now) {
      const listing = await getListing(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cached = {
        listing,
        entries: buildEntriesFromFiles(listing.files),
        expiresAt: now + CACHE_TTL_MS,
      };
      cache.set(cwd, cached);
    }

    if (query) {
      return NextResponse.json({ matches: filterFileEntries(cached.entries, query) });
    }

    const { files, hardTruncated } = cached.listing;
    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
