import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ask-types.ts");
}

test("normalizeAskQuestions keeps well-formed questions and coerces plain strings", async () => {
  const { normalizeAskQuestions } = await loadSubject();
  const questions = normalizeAskQuestions([
    {
      id: "scope",
      prompt: "Which layers?",
      multiSelect: true,
      options: [{ value: "api", label: "API layer" }, "docs"],
    },
  ]);

  assert.equal(questions.length, 1);
  assert.equal(questions[0].id, "scope");
  assert.equal(questions[0].multiSelect, true);
  assert.deepEqual(questions[0].options, [
    { value: "api", label: "API layer" },
    { value: "docs", label: "docs" },
  ]);
});

test("normalizeAskQuestions drops questions without a prompt or without options", async () => {
  const { normalizeAskQuestions } = await loadSubject();
  const questions = normalizeAskQuestions([
    { id: "no-prompt", options: [{ value: "a", label: "A" }] },
    { id: "no-options", prompt: "Pick", options: [] },
    { id: "ok", prompt: "Pick", options: [{ value: "a", label: "A" }] },
  ]);

  assert.deepEqual(questions.map((question) => question.id), ["ok"]);
});

test("normalizeAskQuestions ignores non-object input and caps the question count", async () => {
  const { normalizeAskQuestions, ASK_MAX_QUESTIONS } = await loadSubject();
  assert.deepEqual(normalizeAskQuestions(undefined), []);
  assert.deepEqual(normalizeAskQuestions("nope"), []);

  const many = Array.from({ length: ASK_MAX_QUESTIONS + 5 }, (_, index) => ({
    id: `q${index}`,
    prompt: `Question ${index}`,
    options: [{ value: "v", label: "V" }],
  }));
  assert.equal(normalizeAskQuestions(many).length, ASK_MAX_QUESTIONS);
});

test("askAllowsOther defaults to true and only opts out on an explicit false", async () => {
  const { askAllowsOther } = await loadSubject();
  assert.equal(askAllowsOther({ id: "a", prompt: "P", options: [] }), true);
  assert.equal(askAllowsOther({ id: "a", prompt: "P", options: [], allowOther: false }), false);
  assert.equal(askAllowsOther({ id: "a", prompt: "P", options: [], allowOther: true }), true);
});

test("formatAskResult lists every answer and prefixes typed notes with (其他)", async () => {
  const { formatAskResult } = await loadSubject();
  const questions = [
    { id: "scope", prompt: "Which layers?", options: [], multiSelect: true },
    { id: "mode", prompt: "How?", options: [] },
  ];
  const { text, cancelled } = formatAskResult(questions, [
    {
      id: "scope",
      prompt: "Which layers?",
      multiSelect: true,
      labels: ["API layer", "Documentation", "(其他) keep it small"],
      values: ["api", "docs", "keep it small"],
      other: "keep it small",
      cancelled: false,
    },
    { id: "mode", prompt: "How?", multiSelect: false, labels: ["Just do it"], values: ["go"], cancelled: false },
  ]);

  assert.equal(cancelled, false);
  assert.equal(
    text,
    "User answered:\n- scope [多选]: API layer、Documentation、(其他) keep it small\n- mode: Just do it",
  );
});

test("formatAskResult reports a mid-wizard cancel but keeps the answers already given", async () => {
  const { formatAskResult } = await loadSubject();
  const questions = [
    { id: "a", prompt: "First?", options: [] },
    { id: "b", prompt: "Second?", options: [] },
  ];
  const { text, cancelled } = formatAskResult(questions, [
    { id: "a", prompt: "First?", multiSelect: false, labels: ["Yes"], values: ["y"], cancelled: false },
    { id: "b", prompt: "Second?", multiSelect: false, labels: [], values: [], cancelled: true },
  ]);

  assert.equal(cancelled, true);
  assert.match(text, /^User cancelled the remaining questions\./);
  assert.match(text, /- a: Yes/);
});

test("formatAskResult reports a full cancel without listing anything", async () => {
  const { formatAskResult } = await loadSubject();
  const questions = [{ id: "a", prompt: "First?", options: [] }];
  const { text, cancelled } = formatAskResult(questions, [
    { id: "a", prompt: "First?", multiSelect: false, labels: [], values: [], cancelled: true },
  ]);

  assert.equal(cancelled, true);
  assert.equal(text, "User cancelled the question.");
});
