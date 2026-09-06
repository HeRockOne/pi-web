import assert from "node:assert/strict";
import { test } from "node:test";
const { splitThinkTaggedText, splitThinkTextBlock } = await import("./think-tag.ts");

test("no tag → null", () => {
  assert.equal(splitThinkTaggedText("plain answer"), null);
  assert.equal(splitThinkTextBlock({ type: "text", text: "plain answer" }), null);
});

test("tag not at start → treated as literal content", () => {
  assert.equal(splitThinkTaggedText("talk <think> later"), null);
  assert.equal(splitThinkTextBlock({ type: "text", text: "talk <think> later" }), null);
});

test("closed tag → thinking + answer", () => {
  const split = splitThinkTaggedText("<think>reasoning here</think>\n\n# Answer");
  assert.ok(split);
  assert.equal(split.thinking, "reasoning here");
  assert.equal(split.answer, "\n\n# Answer");

  const blocks = splitThinkTextBlock({ type: "text", text: "<think>reasoning here</think>\n\n# Answer" });
  assert.ok(blocks);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "thinking", thinking: "reasoning here", thinkingSignature: undefined });
  assert.deepEqual(blocks[1], { type: "text", text: "\n\n# Answer" });
});

test("unclosed tag (streaming) → pure thinking, answer null", () => {
  const split = splitThinkTaggedText("<think>still thinking");
  assert.ok(split);
  assert.equal(split.thinking, "still thinking");
  assert.equal(split.answer, null);

  const blocks = splitThinkTextBlock({ type: "text", text: "<think>still thinking" });
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "thinking");
});

test("empty thinking trimmed away", () => {
  const blocks = splitThinkTextBlock({ type: "text", text: "<think>   </think>answer only" });
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: "text", text: "answer only" });
});

test("empty answer trimmed away", () => {
  const blocks = splitThinkTextBlock({ type: "text", text: "<think>reasoning</think>  " });
  assert.ok(blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "thinking");
});

test("multiline reasoning preserved verbatim", () => {
  const tx = "<think>line1\nline2\n\nline3</think>\nfinal";
  const split = splitThinkTaggedText(tx);
  assert.ok(split);
  assert.equal(split.thinking, "line1\nline2\n\nline3");
  assert.equal(split.answer, "\nfinal");
});

test("all-empty content → null blocks", () => {
  assert.equal(splitThinkTextBlock({ type: "text", text: "<think></think>" }), null);
});
