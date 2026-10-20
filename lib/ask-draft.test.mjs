import assert from "node:assert/strict";
import test from "node:test";

const {
  EMPTY_ASK_DRAFT,
  addAskNote,
  askDraftToAnswer,
  buildAskAnswers,
  clearAskDraft,
  createAskDrafts,
  isLastAskQuestion,
  nextAskIndex,
  previousAskIndex,
  removeAskNote,
  selectAskOption,
} = await import("./ask-draft.ts");

const q = (id, options, extra = {}) => ({
  id,
  prompt: `Question ${id}`,
  options: options.map((value) => ({ value, label: value.toUpperCase() })),
  ...extra,
});

const QUESTIONS = [q("a", ["x", "y"]), q("b", ["p", "r"], { multiSelect: true }), q("c", ["m"])];

test("createAskDrafts gives every question its own empty draft", () => {
  const drafts = createAskDrafts(QUESTIONS);
  assert.equal(drafts.length, 3);
  assert.deepEqual(drafts, [EMPTY_ASK_DRAFT, EMPTY_ASK_DRAFT, EMPTY_ASK_DRAFT]);
  // Distinct objects: patching one must never leak into another.
  assert.notEqual(drafts[0], drafts[1]);
  assert.notEqual(drafts[0].selected, drafts[1].selected);
});

test("a single-select tap settles that question without touching the others", () => {
  const drafts = selectAskOption(createAskDrafts(QUESTIONS), 0, 1, false);
  assert.deepEqual(drafts[0], { selected: [1], notes: [], done: true });
  assert.deepEqual(drafts[1], EMPTY_ASK_DRAFT);
  assert.deepEqual(drafts[2], EMPTY_ASK_DRAFT);
});

test("a second single-select tap replaces the pick instead of adding to it", () => {
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 0, 0, false);
  drafts = selectAskOption(drafts, 0, 1, false);
  assert.deepEqual(drafts[0].selected, [1]);
});

test("multi-select toggles options on and off and never auto-commits", () => {
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 1, 0, true);
  drafts = selectAskOption(drafts, 1, 1, true);
  assert.deepEqual(drafts[1].selected, [0, 1]);
  assert.equal(drafts[1].done, false, "only the done action commits a multi-select question");

  drafts = selectAskOption(drafts, 1, 0, true);
  assert.deepEqual(drafts[1].selected, [1]);
});

test("toggling a committed multi-select answer clears done so it must be re-committed", () => {
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 1, 0, true);
  drafts = drafts.map((draft, at) => at === 1 ? { ...draft, done: true } : draft);
  assert.equal(drafts[1].done, true);

  drafts = selectAskOption(drafts, 1, 1, true);
  assert.equal(drafts[1].done, false);
});

test("stepping back preserves an uncommitted multi-select draft", () => {
  // The regression this guards: pick M on q2, tap 上一题 before committing, and
  // the selection used to come back empty.
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 1, 1, true);
  drafts = selectAskOption(drafts, 0, 0, false);
  assert.deepEqual(drafts[1].selected, [1]);
  assert.deepEqual(askDraftToAnswer(QUESTIONS[1], drafts[1]).values, ["r"]);
});

test("nextAskIndex clamps at the last question so submitting never runs past the end", () => {
  assert.equal(nextAskIndex(0, 3), 1);
  assert.equal(nextAskIndex(1, 3), 2);
  assert.equal(nextAskIndex(2, 3), 2, "advancing past the last question must stay on it");
  assert.equal(nextAskIndex(0, 1), 0);
});

test("previousAskIndex clamps at the first question", () => {
  assert.equal(previousAskIndex(2), 1);
  assert.equal(previousAskIndex(1), 0);
  assert.equal(previousAskIndex(0), 0);
});

test("isLastAskQuestion identifies the submit step", () => {
  assert.equal(isLastAskQuestion(0, 3), false);
  assert.equal(isLastAskQuestion(2, 3), true);
  assert.equal(isLastAskQuestion(0, 1), true);
});

test("addAskNote ignores blanks and duplicates and clears done", () => {
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 1, 0, true);
  drafts = addAskNote(drafts, 1, "  keep it small  ");
  assert.deepEqual(drafts[1].notes, ["keep it small"]);
  assert.equal(drafts[1].done, false);

  const unchanged = addAskNote(drafts, 1, "keep it small");
  assert.equal(unchanged, drafts, "a duplicate note is a no-op, not a re-render");

  assert.equal(addAskNote(drafts, 1, "   "), drafts);
});

test("removeAskNote drops one note and keeps the rest", () => {
  let drafts = addAskNote(createAskDrafts(QUESTIONS), 1, "alpha");
  drafts = addAskNote(drafts, 1, "beta");
  drafts = removeAskNote(drafts, 1, "alpha");
  assert.deepEqual(drafts[1].notes, ["beta"]);
});

test("clearAskDraft empties picks and notes for one question only", () => {
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 1, 0, true);
  drafts = addAskNote(drafts, 1, "note");
  drafts = selectAskOption(drafts, 0, 0, false);

  drafts = clearAskDraft(drafts, 1);
  assert.deepEqual(drafts[1], EMPTY_ASK_DRAFT);
  assert.deepEqual(drafts[0].selected, [0], "other questions keep their answers");
});

test("askDraftToAnswer renders picks plus (其他) notes", () => {
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 1, 0, true);
  drafts = addAskNote(drafts, 1, "keep it small");
  const answer = askDraftToAnswer(QUESTIONS[1], drafts[1]);

  assert.deepEqual(answer, {
    id: "b",
    prompt: "Question b",
    multiSelect: true,
    labels: ["P", "(其他) keep it small"],
    values: ["p", "keep it small"],
    other: "keep it small",
    cancelled: false,
  });
});

test("askDraftToAnswer omits other when nothing was typed", () => {
  const drafts = selectAskOption(createAskDrafts(QUESTIONS), 0, 0, false);
  const answer = askDraftToAnswer(QUESTIONS[0], drafts[0]);
  assert.equal("other" in answer, false);
  assert.deepEqual(answer.values, ["x"]);
});

test("askDraftToAnswer ignores out-of-range selections instead of throwing", () => {
  const answer = askDraftToAnswer(QUESTIONS[0], { selected: [99], notes: [], done: true });
  assert.deepEqual(answer.values, []);
  assert.deepEqual(answer.labels, []);
});

test("buildAskAnswers returns one answer per question, in order", () => {
  let drafts = selectAskOption(createAskDrafts(QUESTIONS), 0, 1, false);
  drafts = selectAskOption(drafts, 1, 0, true);
  drafts = addAskNote(drafts, 1, "note");
  drafts = selectAskOption(drafts, 2, 0, false);

  const answers = buildAskAnswers(QUESTIONS, drafts);
  assert.deepEqual(answers.map((answer) => answer.id), ["a", "b", "c"]);
  assert.deepEqual(answers.map((answer) => answer.values), [["y"], ["p", "note"], ["m"]]);
  assert.ok(answers.every((answer) => answer.cancelled === false));
});

test("buildAskAnswers falls back to an empty answer for a missing draft", () => {
  const answers = buildAskAnswers(QUESTIONS, []);
  assert.equal(answers.length, 3);
  assert.deepEqual(answers[0].values, []);
  assert.deepEqual(answers[0].labels, []);
});
