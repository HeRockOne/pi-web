import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Wiring tests for the native `ask` dialog.
 *
 * The paging logic itself lives in `lib/ask-draft.ts` and is tested there. What
 * is asserted here is only what the component must do to reach it: render one
 * dialog per request, keep every question's draft in one place, and hand the
 * whole answer list back in a single response.
 */
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const askSource = source.slice(source.indexOf("function AskDialog"), source.indexOf("type ExtensionCustomRequest"));

test("AskDialog is mounted from the session hook exactly like the other overlays", () => {
  assert.match(source, /\{askDialog && \(\s*<AskDialog key=\{askDialog\.id\} request=\{askDialog\} onRespond=\{respondToAsk\} \/>\s*\)\}/);
  // A stale dialog must never survive an id change.
  assert.match(source, /<AskDialog key=\{askDialog\.id\}/);
});

test("AskDialog sends one response carrying every answer", () => {
  assert.match(askSource, /onRespond\(request, \{ askAnswers: buildAskAnswers\(questions, effective\) \}\)/);
  assert.doesNotMatch(askSource, /for \(const .* of questions/);
});

test("AskDialog pages both ways and never advances past the last question", () => {
  assert.match(askSource, /setIndex\(\(current\) => previousAskIndex\(current\)\)/);
  assert.match(askSource, /setIndex\(\(current\) => nextAskIndex\(current, questions\.length\)\)/);
  assert.match(askSource, /if \(isLast\) \{\s*submitAll\(\);\s*return;\s*\}/);
  // The submit button must replace 下一题 rather than sit beside it.
  assert.match(askSource, /isLast \? \(questions\.length > 1 \? t\("chat\.askSubmitAll"\) : t\("chat\.submit"\)\) : t\("chat\.askNext"\)/);
});

test("AskDialog hides 上一题 on the first question", () => {
  assert.match(askSource, /\{index > 0 && \(\s*<button[\s\S]*?chat\.askPrev/);
});

test("AskDialog keeps drafts for every question in one state array", () => {
  assert.match(askSource, /const \[drafts, setDrafts\] = useState<AskDraft\[\]>\(\(\) => createAskDrafts\(questions\)\)/);
  assert.doesNotMatch(askSource, /const \[selected, setSelected\]/);
});

test("an option tap only advances mid-wizard, never submits", () => {
  // Regression: tapping an option on the last question used to fire submitAll,
  // committing the whole wizard before the user could step back and revise.
  assert.match(askSource, /setDrafts\(selectAskOption\(drafts, index, position, false\)\);\s*if \(!isLast\) goNext\(\);/);
  assert.doesNotMatch(askSource, /if \(isLast\) submitAll\(next\)/);
  // Multi-select toggles only; committing stays the footer button's job.
  assert.match(askSource, /setDrafts\(\(current\) => selectAskOption\(current, index, position, true\)\)/);
});

test("the free-text row honours allowOther and adds removable notes", () => {
  assert.match(askSource, /const allowOther = question\?\.allowOther !== false;/);
  assert.match(askSource, /addAskNote\(current, index, noteDraft\)/);
  assert.match(askSource, /removeAskNote\(current, index, note\)/);
  assert.match(askSource, /clearAskDraft\(current, index\)/);
});

test("AskDialog reuses the shared cancel and expiry conventions", () => {
  assert.match(askSource, /onRespond\(request, \{ cancelled: true \}\)/);
  assert.match(askSource, /event\.nativeEvent\.isComposing/);
  assert.match(askSource, /expiresAt === undefined/);
  assert.match(askSource, /chat\.extensionExpiresIn/);
});

test("AskDialog stacks above the extension dialog but below the composer", () => {
  assert.match(askSource, /zIndex: 96/);
  assert.match(askSource, /position: "absolute"[\s\S]*?inset: 0/);
});
