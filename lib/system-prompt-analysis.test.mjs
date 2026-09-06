import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSystemPrompt, estimateTokensOf } from "./system-prompt-analysis.ts";

const BASE = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents from the local filesystem
- bash: Execute shell commands
- edit: Edit files with exact string replacements

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Pi documentation lives under docs/`;

const CONTEXT_BLOCK = `

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="C:/proj/AGENTS.md">
# Agent notes
Use pnpm, never npm.
</project_instructions>

<project_instructions path="C:/proj/docs/EXTRA.md">
Extra rules here
</project_instructions>

</project_context>`;

const SKILLS_BLOCK = `

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory.

<available_skills>
  <skill>
    <name>demo</name>
    <description>Demo skill</description>
    <location>C:/skills/demo/SKILL.md</location>
  </skill>
</available_skills>`;

const CWD_TAIL = "\nCurrent working directory: C:/proj";

test("segments a full default system prompt into labeled sections", () => {
  const prompt = BASE + CONTEXT_BLOCK + SKILLS_BLOCK + CWD_TAIL;
  const analysis = analyzeSystemPrompt(prompt);

  const keys = analysis.sections.map((s) => s.key);
  assert.ok(keys.includes("base"), "has base");
  assert.ok(keys.includes("tools"), "has tools");
  assert.ok(keys.includes("guidelines"), "has guidelines+extension zone");
  assert.ok(keys.includes("context:C:/proj/AGENTS.md"), "has first context file");
  assert.ok(keys.includes("context:C:/proj/docs/EXTRA.md"), "has second context file");
  assert.ok(keys.includes("skills"), "has skills");
  assert.ok(keys.includes("cwd"), "has cwd");
  assert.ok(keys.includes("other"), "wrapper scaffolding lands in other");

  // Sections always account for the entire prompt.
  const charsSum = analysis.sections.reduce((acc, s) => acc + s.chars, 0);
  assert.equal(charsSum, prompt.length);
  assert.equal(analysis.totalChars, prompt.length);
  assert.equal(analysis.totalTokens, estimateTokensOf(prompt));
});

test("token counts follow the chars/4 heuristic per section", () => {
  const prompt = BASE + CONTEXT_BLOCK + SKILLS_BLOCK + CWD_TAIL;
  const analysis = analyzeSystemPrompt(prompt);

  const toolsStart = prompt.indexOf("\nAvailable tools:\n") + 1;
  const toolsEnd = prompt.indexOf("\n\nIn addition to the tools");
  const tools = analysis.sections.find((s) => s.key === "tools");
  assert.ok(tools);
  assert.equal(tools.chars, toolsEnd - toolsStart);
  assert.equal(tools.tokens, Math.ceil((toolsEnd - toolsStart) / 4));

  const guidelines = analysis.sections.find((s) => s.key === "guidelines");
  assert.ok(guidelines);
  assert.equal(guidelines.labelKey, "system.section.guidelines");
  const guideStart = prompt.indexOf("\n\nGuidelines:\n");
  const contextStart = prompt.indexOf("<project_context>");
  assert.equal(guidelines.chars, contextStart - guideStart);

  const agents = analysis.sections.find((s) => s.key === "context:C:/proj/AGENTS.md");
  assert.ok(agents);
  const agentsBlock = `<project_instructions path="C:/proj/AGENTS.md">\n# Agent notes\nUse pnpm, never npm.\n</project_instructions>`;
  assert.equal(agents.chars, agentsBlock.length);
  assert.equal(agents.detail, "C:/proj/AGENTS.md");
  assert.equal(agents.labelKey, "system.section.context");

  const cwd = analysis.sections.find((s) => s.key === "cwd");
  assert.ok(cwd);
  assert.equal(cwd.detail, "C:/proj");
  assert.equal(cwd.chars, CWD_TAIL.length);
});

test("custom prompts are labeled as such and skip the tools row", () => {
  const prompt = "You are a pirate. Answer only in verse." + CONTEXT_BLOCK + CWD_TAIL;
  const analysis = analyzeSystemPrompt(prompt);

  const base = analysis.sections.find((s) => s.key === "base");
  assert.ok(base);
  assert.equal(base.labelKey, "system.section.custom");
  assert.ok(!analysis.sections.some((s) => s.key === "tools"));

  const charsSum = analysis.sections.reduce((acc, s) => acc + s.chars, 0);
  assert.equal(charsSum, prompt.length);
});

test("prompts without markers collapse into a single section", () => {
  const prompt = "Just a plain prompt with no recognizable sections at all.";
  const analysis = analyzeSystemPrompt(prompt);

  assert.equal(analysis.sections.length, 1);
  assert.equal(analysis.sections[0].key, "base");
  assert.equal(analysis.sections[0].chars, prompt.length);
  assert.equal(analysis.totalTokens, Math.ceil(prompt.length / 4));
});

test("empty prompts produce an empty analysis", () => {
  const analysis = analyzeSystemPrompt("");
  assert.deepEqual(analysis, { sections: [], totalChars: 0, totalTokens: 0 });
});

test("sections are sorted largest first", () => {
  const prompt = BASE + CONTEXT_BLOCK + SKILLS_BLOCK + CWD_TAIL;
  const { sections } = analyzeSystemPrompt(prompt);
  for (let i = 1; i < sections.length; i += 1) {
    assert.ok(sections[i - 1].tokens >= sections[i].tokens);
  }
});
