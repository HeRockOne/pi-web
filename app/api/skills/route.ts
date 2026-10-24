import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { invalidateSkillsCache, loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { setDisableModelInvocation } from "@/lib/skill-frontmatter";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on one or many SKILL.md files
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      filePath?: string;
      filePaths?: string[];
      disableModelInvocation: boolean;
    };
    const { disableModelInvocation } = body;
    const filePaths = (body.filePaths?.length ? body.filePaths : body.filePath ? [body.filePath] : [])
      .map((p) => p.trim())
      .filter(Boolean);
    if (filePaths.length === 0) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    const allowedRoots = new Set(await getAllowedFileRoots());
    allowedRoots.add(getAgentDir());
    // Globally installed skills live in ~/.agents/skills and are symlinked into
    // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
    // the real target sits outside getAgentDir(). Allow the global skills root
    // too (the SDK always treats ~/.agents/skills as trusted).
    const globalSkillsDir = path.join(homedir(), ".agents", "skills");
    if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
    // Validate and read every file before writing anything, so the batch is
    // all-or-nothing: a missing or disallowed path aborts the whole toggle.
    const contents = new Map<string, string>();
    for (const filePath of filePaths) {
      if (!existsSync(filePath)) {
        return NextResponse.json({ error: `file not found: ${filePath}` }, { status: 404 });
      }
      if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
        return NextResponse.json({ error: `Access denied: ${filePath}` }, { status: 403 });
      }
      contents.set(filePath, readFileSync(filePath, "utf8"));
    }
    for (const [filePath, content] of contents) {
      writeFileSync(filePath, setDisableModelInvocation(content, disableModelInvocation), "utf8");
    }
    // The loader snapshot cached for GET is now stale — drop it.
    invalidateSkillsCache();
    return NextResponse.json({ success: true, updated: contents.size });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
