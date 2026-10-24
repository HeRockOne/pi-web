import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";

// DefaultResourceLoader rescans every skill directory, settings path, and
// package on construction — hundreds of ms per call. The settings panel opens
// this route on each mount and polls it after toggles, so the loaded snapshot
// is cached briefly; every mutating route invalidates it explicitly.
const SKILLS_CACHE_TTL_MS = 10_000;

interface SkillsCacheEntry {
  response: SkillsResponse;
  createdAt: number;
}

const skillsCache = new Map<string, SkillsCacheEntry>();

/** Drop cached skill snapshots — all of them, or one cwd's. */
export function invalidateSkillsCache(cwd?: string): void {
  if (cwd === undefined) {
    skillsCache.clear();
    return;
  }
  for (const key of skillsCache.keys()) {
    if (key.endsWith(`\0${cwd}`)) skillsCache.delete(key);
  }
}

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const key = `${agentDir}\0${cwd}`;
  const cached = skillsCache.get(key);
  if (cached && Date.now() - cached.createdAt < SKILLS_CACHE_TTL_MS) {
    return cached.response;
  }

  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  const response: SkillsResponse = {
    skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
  skillsCache.set(key, { response, createdAt: Date.now() });
  return response;
}
