import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);

// Same skip lists as /api/files — only used for the non-git readdir fallback.
// Git-tracked repos rely on .gitignore instead (matches the TUI's fd behavior).
const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const IGNORED_SUFFIXES = [".pyc"];

/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

export interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (IGNORED_NAMES.has(d.name) || IGNORED_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

/** Cached per-cwd listing (git ls-files when available, readdir walk otherwise). */
export async function getListing(cwd: string): Promise<FileListing> {
  const cache = getIndexCache();
  const now = Date.now();
  let cached = cache.get(cwd);
  if (!cached || cached.expiresAt <= now) {
    const listing = (await listWithGit(cwd)) ?? listWithWalk(cwd);
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cached = { listing, expiresAt: now + CACHE_TTL_MS };
    cache.set(cwd, cached);
  }
  return cached.listing;
}

// ---------------------------------------------------------------------------
// Dropped-file resolution: the browser never exposes a dropped file's absolute
// path, so the client sends {name, size, lastModified} and we locate the file
// by matching those against the filesystem.
// ---------------------------------------------------------------------------

export interface FileMatch {
  /** Absolute path, "/"-separated */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Size match is worth 2, mtime match (±2s) is worth 1. Both = 3 (strong). */
export function scoreMatch(m: FileMatch, size?: number, lastModified?: number): number {
  let score = 0;
  if (size !== undefined && m.size === size) score += 2;
  if (lastModified !== undefined && Math.abs(m.mtimeMs - lastModified) <= 2000) score += 1;
  return score;
}

function toSlash(p: string): string {
  return p.split(path.sep).join("/");
}

/** Basename matches inside the cached listings of the given roots. */
export async function findInRoots(name: string, roots: Iterable<string>): Promise<FileMatch[]> {
  const out: FileMatch[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let listing: FileListing;
    try {
      listing = await getListing(root);
    } catch {
      continue;
    }
    for (const rel of listing.files) {
      const base = rel.split("/").pop();
      if (base !== name) continue;
      const abs = path.join(root, ...rel.split("/"));
      const key = abs.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const st = fs.statSync(abs);
        if (st.isFile()) out.push({ path: toSlash(abs), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Gone between listing and stat — skip.
      }
    }
  }
  return out;
}

// Bounded walk of the user's home directory for dropped files that live
// outside the allowed roots (Desktop, Downloads, Documents, ...). AppData and
// other heavy trees are skipped; BFS keeps shallow (i.e. likely) files first.
const HOME_SKIP = new Set([
  ...IGNORED_NAMES,
  "AppData", ".npm", ".cargo", ".rustup", ".vscode-server", ".config",
  ".local", ".mozilla", ".cache", "Videos", "Music", "$RECYCLE.BIN",
  "System Volume Information",
]);
const HOME_MAX_DEPTH = 6;
const HOME_MAX_FILES = 30_000;
const HOME_MAX_DIRS = 12_000;

export function findInHome(name: string): FileMatch[] {
  const home = os.homedir();
  const out: FileMatch[] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  let dirCount = 0;
  const queue: Array<{ abs: string; depth: number }> = [{ abs: home, depth: 0 }];
  while (queue.length > 0 && fileCount < HOME_MAX_FILES && dirCount < HOME_MAX_DIRS) {
    const { abs, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (fileCount >= HOME_MAX_FILES || dirCount >= HOME_MAX_DIRS) break;
      if (HOME_SKIP.has(d.name) || IGNORED_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
      if (d.isDirectory()) {
        if (depth + 1 <= HOME_MAX_DEPTH) {
          dirCount += 1;
          queue.push({ abs: path.join(abs, d.name), depth: depth + 1 });
        }
      } else if (d.isFile()) {
        fileCount += 1;
        if (d.name !== name) continue;
        const absPath = path.join(abs, d.name);
        const key = absPath.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const st = fs.statSync(absPath);
          out.push({ path: toSlash(absPath), size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // Skip unreadable entries.
        }
      }
    }
  }
  return out;
}
