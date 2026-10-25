import { statSync, type Stats } from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "./file-access";
import { isFilePathReferencedBySession } from "./session-file-references";

export type FileRequestAuth =
  | { ok: true; stat: Stats | undefined; allowedBySessionReference: boolean }
  | { ok: false; status: 403 | 404; error: string };

export interface FileRequestAuthOptions {
  sessionId?: string | null;
  /**
   * Allow the request to fall back to "this path is mentioned by that session's
   * transcript". Never enable it for directory listings.
   */
  allowSessionReference: boolean;
  /** A missing target is acceptable (watch registers the parent directory). */
  allowMissing: boolean;
}

/**
 * The single implementation of "may this request touch that path?".
 *
 * Every file route — including the SSE hub's watch channel — must go through
 * it. Two copies of this check drifting apart is a security bug, not a
 * maintainability nit: the allow-list is the only boundary between a browser
 * and the user's filesystem.
 */
export async function authorizeFileRequest(
  filePath: string,
  options: FileRequestAuthOptions,
): Promise<FileRequestAuth> {
  const allowedRoots = await getAllowedFileRoots();
  const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
  const allowedBySessionReference = !allowedByRoot
    && options.allowSessionReference
    && await isFilePathReferencedBySession(filePath, options.sessionId ?? null);
  if (!allowedByRoot && !allowedBySessionReference) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  let stat: Stats | undefined;
  try {
    stat = statSync(filePath);
  } catch {
    if (!options.allowMissing) {
      return { ok: false, status: 404, error: "Not found" };
    }
  }

  // Resolve symlinks on the path that actually exists: a watched-but-missing
  // file authorizes through its directory instead.
  const existingAuthorizationPath = stat ? filePath : path.dirname(filePath);
  if (
    !allowedBySessionReference
    && !isExistingFilePathAllowed(existingAuthorizationPath, allowedRoots)
  ) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  return { ok: true, stat, allowedBySessionReference };
}
