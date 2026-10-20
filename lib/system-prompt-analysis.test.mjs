import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSystemPrompt, estimateTokensOf } from "./system-prompt-analysis.ts";

// Samples mirror the pi 0.87+ composed format: a bare preamble followed by
// `<name>...</name>` section tags joined by blank lines (buildSystemPromptSections).
const PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const TOOLS_SECTION = `<tools>
- read: Read file contents from the local filesystem
- bash: Execute shell commands
- edit: Edit files with exact string replacements

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>`;

const RULES_SECTION = `<rules>
- Use bash for file operations like ls, rg, find
- Be concise in your responses
- Show file paths clearly when working with files
- Prefer the smallest possible edit
</rules>`;

const DOCS_SECTION = `<docs>
Pi documentation (read only when the user asks about pi itself):
- Main documentation: docs/README.md
</docs>`;

const ADDENDUM_SECTION = `<addendum>
Extra rules from the host app.
</addendum>`;

const CONTEXT_SECTION = `<project_context>
Project-specific instructions and guidelines:

<project_instructions path="C:/proj/AGENTS.md">
# Agent notes
Use pnpm, never npm.
</project_instructions>

<project_instructions path="C:/proj/docs/EXTRA.md">
Extra rules here
</project_instructions>
</project_context>`;

const SKILLS_SECTION = `<skills>
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
  <skill>
    <name>demo</name>
    <description>Demo skill</description>
    <location>C:/skills/demo/SKILL.md</location>
  </skill>
</available_skills>
</skills>`;

const CWD_SECTION = `<cwd>
C:/proj
</cwd>`;

const joinSections = (...parts) => parts.join("\n\n");
const FULL = joinSections(PREAMBLE, TOOLS_SECTION, RULES_SECTION, DOCS_SECTION, ADDENDUM_SECTION, CONTEXT_SECTION, SKILLS_SECTION, CWD_SECTION);

test("segments a full 0.87 system prompt into labeled sections", () => {
  const analysis = analyzeSystemPrompt(FULL);

  const keys = analysis.sections.map((s) => s.key);
  assert.ok(keys.includes("base"), "has base");
  assert.ok(keys.includes("tools"), "has tools");
  assert.ok(keys.includes("guidelines"), "has guidelines (rules tag)");
  assert.ok(keys.includes("pi-docs"), "has docs");
  assert.ok(keys.includes("addendum"), "has addendum");
  assert.ok(keys.includes("context"), "has context group");
  assert.ok(keys.includes("skills"), "has skills");
  assert.ok(keys.includes("cwd"), "has cwd");

  const context = analysis.sections.find((s) => s.key === "context");
  assert.ok(context?.children?.some((c) => c.key === "context:C:/proj/AGENTS.md"), "first context file is a child");
  assert.ok(context.children.some((c) => c.key === "context:C:/proj/docs/EXTRA.md"), "second context file is a child");

  const skills = analysis.sections.find((s) => s.key === "skills");
  assert.ok(skills?.children?.some((c) => c.label === "demo"), "skill entry is a child");

  const cwd = analysis.sections.find((s) => s.key === "cwd");
  assert.equal(cwd?.detail, "C:/proj");
  const docs = analysis.sections.find((s) => s.key === "pi-docs");
  assert.equal(docs?.labelKey, "system.section.docs");
  const addendum = analysis.sections.find((s) => s.key === "addendum");
  assert.equal(addendum?.labelKey, "system.section.addendum");

  // Sections always account for the entire prompt.
  const charsSum = analysis.sections.reduce((acc, s) => acc + s.chars, 0);
  assert.equal(charsSum, FULL.length);
  assert.equal(analysis.totalChars, FULL.length);
  assert.equal(analysis.totalTokens, estimateTokensOf(FULL));
  // Top-level tokens sum exactly to the total (residual lands in "other"),
  // so the composition bar always matches the headline number.
  const tokenSum = analysis.sections.reduce((acc, s) => acc + s.tokens, 0);
  assert.equal(tokenSum, analysis.totalTokens);
});

test("body segments cover the prompt with no other rows for a well-formed prompt", () => {
  const analysis = analyzeSystemPrompt(FULL);

  let cursor = 0;
  for (const segment of analysis.segments) {
    assert.equal(segment.start, cursor, "segments are contiguous");
    cursor = segment.end;
  }
  assert.equal(cursor, FULL.length, "segments cover the whole prompt");
  assert.ok(analysis.segments.every((s) => s.key !== "other"), "join separators are folded into their section");
  assert.ok(analysis.segments[0].key === "base", "prompt starts with the preamble");
});

test("attributes rule bullets to plugins via tool hints", () => {
  const tools = [
    {
      name: "todo",
      source: "rpiv-todo",
      promptGuidelines: [
        "Be concise in your responses",
        "Show file paths clearly when working with files",
      ],
    },
    {
      name: "replace",
      source: "pi-hashline-edit-pro",
      promptGuidelines: ["Use bash for file operations like ls, rg, find"],
    },
  ];
  const analysis = analyzeSystemPrompt(FULL, tools);
  const guidelines = analysis.sections.find((s) => s.key === "guidelines");
  assert.ok(guidelines?.children);

  const byKey = new Map(guidelines.children.map((c) => [c.key, c]));
  const todo = byKey.get("ext:rpiv-todo");
  assert.ok(todo, "rpiv-todo group exists");
  assert.equal(todo.label, "rpiv-todo");
  assert.equal(todo.detail, "todo");
  // Each attributed line contributes "- " + rule + newline; the final line of
  // the rules content has no trailing newline before </rules>.
  const rulesContent = RULES_SECTION.slice("<rules>\n".length, RULES_SECTION.length - "\n</rules>".length);
  const expectedChars = ["Be concise in your responses", "Show file paths clearly when working with files"]
    .reduce((acc, g) => acc + `- ${g}`.length + (rulesContent.includes(`- ${g}\n`) ? 1 : 0), 0);
  assert.equal(todo.chars, expectedChars);

  const hashline = byKey.get("ext:pi-hashline-edit-pro");
  assert.ok(hashline, "hashline group exists");
  assert.equal(hashline.detail, "replace");

  const core = byKey.get("pi-core");
  assert.ok(core, "unmatched bullets fall into pi core");
  assert.ok(core.chars > 0);

  // Children account for the whole section: the rule lines plus one scaffold
  // row holding the <rules> wrappers, so nothing lands in a phantom bucket.
  const childSum = guidelines.children.reduce((acc, c) => acc + c.chars, 0);
  assert.equal(childSum, guidelines.chars);
  const tokenSum = guidelines.children.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(tokenSum, guidelines.tokens);
  const scaffold = byKey.get("scaffold:guidelines");
  assert.ok(scaffold, "wrapper tags get their own row");
  assert.equal(scaffold.labelKey, "system.section.scaffold");
  assert.equal(scaffold.text, undefined, "the scaffold row is a counter, not readable text");
});

test("tools section lists one child per tool line", () => {
  const analysis = analyzeSystemPrompt(FULL);
  const tools = analysis.sections.find((s) => s.key === "tools");
  assert.ok(tools?.children);
  const toolRows = tools.children.filter((c) => c.key.startsWith("tool:"));
  assert.deepEqual(toolRows.map((c) => c.label).sort(), ["bash", "edit", "read"]);
  for (let i = 1; i < tools.children.length; i += 1) {
    assert.ok(tools.children[i - 1].tokens >= tools.children[i].tokens, "children sorted largest first");
  }
  // Children are counted exactly and conserve the parent's tokens.
  const childSum = tools.children.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(tools.tokens, childSum);
  // The intro paragraph is attributed instead of vanishing into "other".
  assert.ok(tools.children.some((c) => c.key === "scaffold:tools"), "intro text gets its own row");
});

test("cwd section exposes the path as detail", () => {
  const analysis = analyzeSystemPrompt(FULL);
  const cwd = analysis.sections.find((s) => s.key === "cwd");
  assert.ok(cwd);
  assert.equal(cwd.detail, "C:/proj");
  assert.equal(cwd.chars, CWD_SECTION.length + 2);
});

test("extension-registered sections surface under their own name", () => {
  const prompt = joinSections(PREAMBLE, `<session>\nsession-specific instructions\n</session>`, CWD_SECTION);
  const analysis = analyzeSystemPrompt(prompt);

  const custom = analysis.sections.find((s) => s.key === "section:session");
  assert.ok(custom, "custom section detected");
  assert.equal(custom.label, "session");
  assert.ok(analysis.sections.some((s) => s.key === "cwd"));
});

test("inner tags never terminate their parent section", () => {
  const analysis = analyzeSystemPrompt(FULL);
  const context = analysis.sections.find((s) => s.key === "context");
  // </project_instructions> closers must not close <project_context>.
  assert.equal(context?.labelKey, "system.section.context");
  assert.equal(context?.children?.filter((c) => c.key.startsWith("context:")).length, 2);
  const skills = analysis.sections.find((s) => s.key === "skills");
  // <available_skills> nests inside <skills> instead of splitting it.
  assert.equal(skills?.children?.filter((c) => c.key.startsWith("skill:")).length, 1);
  assert.match(skills.text ?? "", /<\/available_skills>/);
});

test("custom prompts are labeled as such and skip the tools row", () => {
  const prompt = joinSections("You are a pirate. Answer only in verse.", CWD_SECTION);
  const analysis = analyzeSystemPrompt(prompt);

  const base = analysis.sections.find((s) => s.key === "base");
  assert.ok(base);
  assert.equal(base.labelKey, "system.section.custom");
  assert.ok(!analysis.sections.some((s) => s.key === "tools"));

  const charsSum = analysis.sections.reduce((acc, s) => acc + s.chars, 0);
  assert.equal(charsSum, prompt.length);
});

test("prompts without tags collapse into a single section", () => {
  const prompt = "Just a plain prompt with no recognizable sections at all.";
  const analysis = analyzeSystemPrompt(prompt);

  assert.equal(analysis.sections.length, 1);
  assert.equal(analysis.sections[0].key, "base");
  assert.equal(analysis.sections[0].chars, prompt.length);
  assert.equal(analysis.totalTokens, estimateTokensOf(prompt));
});

test("empty prompts produce an empty analysis", () => {
  const analysis = analyzeSystemPrompt("");
  assert.deepEqual(analysis, { sections: [], segments: [], totalChars: 0, totalTokens: 0 });
});

test("sections are sorted largest first", () => {
  const { sections } = analyzeSystemPrompt(FULL);
  for (let i = 1; i < sections.length; i += 1) {
    assert.ok(sections[i - 1].tokens >= sections[i].tokens);
  }
});

test("token counts are exactly additive at every level", () => {
  const analysis = analyzeSystemPrompt(FULL);

  // Top level: the sections partition the prompt, so they must sum to the
  // headline number the panel shows in its title.
  const topSum = analysis.sections.reduce((acc, s) => acc + s.tokens, 0);
  assert.equal(topSum, analysis.totalTokens, "top-level tokens sum to the total");

  // Each parent equals its children, so drilling in never contradicts the row
  // it came from.
  for (const section of analysis.sections) {
    if (!section.children) continue;
    const childTokens = section.children.reduce((acc, c) => acc + c.tokens, 0);
    const childChars = section.children.reduce((acc, c) => acc + c.chars, 0);
    assert.equal(childTokens, section.tokens, `${section.key} children conserve tokens`);
    assert.equal(childChars, section.chars, `${section.key} children conserve chars`);
  }
});

test("a section with no text is never reported", () => {
  // Regression: the panel used to show an "other" row of ~700 tokens that had
  // zero characters behind it, because BPE over-counting in children was
  // dumped into a residual bucket. A bucket must own real text to exist.
  const analysis = analyzeSystemPrompt(FULL);
  for (const section of analysis.sections) {
    assert.ok(section.chars > 0, `${section.key} owns characters`);
    assert.ok(section.text && section.text.length > 0, `${section.key} exposes its body`);
  }
  assert.equal(analysis.sections.filter((s) => s.key === "other").length, 0);
});

test("children never over-count their parent", () => {
  // Counting fragments independently makes BPE parts exceed the whole; the
  // prefix-difference counter must keep every child at or below its parent.
  const analysis = analyzeSystemPrompt(FULL);
  for (const section of analysis.sections) {
    for (const child of section.children ?? []) {
      assert.ok(child.tokens <= section.tokens, `${child.key} <= ${section.key}`);
      if (child.text !== undefined) {
        assert.ok(child.text.length === child.chars, `${child.key} text matches its char count`);
      }
    }
  }
});
