import type { AskAnswer, AskQuestion } from "./ask-types";

/**
 * Pure state machine for the native `ask` wizard.
 *
 * The dialog keeps its paging state here instead of inline in the component so
 * the two behaviours that regressed in earlier attempts — committing a
 * multi-select draft and stepping backwards over answered questions — are
 * covered by real tests rather than by reading the JSX.
 */

export type AskDraft = {
  selected: number[];
  notes: string[];
  /** True once the user committed a multi-select question with its done action. */
  done: boolean;
};

export const EMPTY_ASK_DRAFT: AskDraft = { selected: [], notes: [], done: false };

export function createAskDrafts(questions: AskQuestion[]): AskDraft[] {
  return questions.map(() => ({ ...EMPTY_ASK_DRAFT, selected: [], notes: [] }));
}

function draftAt(drafts: AskDraft[], index: number): AskDraft {
  return drafts[index] ?? EMPTY_ASK_DRAFT;
}

/** Replaces one question's draft without touching the others. */
export function patchAskDraft(drafts: AskDraft[], index: number, next: Partial<AskDraft>): AskDraft[] {
  return drafts.map((entry, position) => position === index ? { ...entry, ...next } : entry);
}

/**
 * Applies an option tap.
 *
 * Single-select settles the question outright (matching the standalone plugin,
 * so muscle memory carries over). Multi-select toggles, and clears `done`
 * because the committed set no longer matches what the user has picked.
 */
export function selectAskOption(
  drafts: AskDraft[],
  index: number,
  position: number,
  multiSelect: boolean,
): AskDraft[] {
  if (!multiSelect) {
    return patchAskDraft(drafts, index, { selected: [position], done: true });
  }
  const draft = draftAt(drafts, index);
  const selected = draft.selected.includes(position)
    ? draft.selected.filter((value) => value !== position)
    : [...draft.selected, position];
  return patchAskDraft(drafts, index, { selected, done: false });
}

/** Drops every pick and typed note for one question. */
export function clearAskDraft(drafts: AskDraft[], index: number): AskDraft[] {
  return patchAskDraft(drafts, index, { selected: [], notes: [], done: false });
}

/**
 * Appends a typed note, ignoring blanks and duplicates.
 *
 * Mirrors the plugin's `(其他)` handling: a note typed twice is still one note.
 */
export function addAskNote(drafts: AskDraft[], index: number, note: string): AskDraft[] {
  const trimmed = note.trim();
  if (!trimmed) return drafts;
  const draft = draftAt(drafts, index);
  if (draft.notes.includes(trimmed)) return drafts;
  return patchAskDraft(drafts, index, { notes: [...draft.notes, trimmed], done: false });
}

export function removeAskNote(drafts: AskDraft[], index: number, note: string): AskDraft[] {
  const draft = draftAt(drafts, index);
  return patchAskDraft(drafts, index, {
    notes: draft.notes.filter((entry) => entry !== note),
    done: false,
  });
}

/** Advancing past the last question means "submit", never an out-of-range index. */
export function nextAskIndex(index: number, total: number): number {
  return Math.min(index + 1, total - 1);
}

export function previousAskIndex(index: number): number {
  return Math.max(index - 1, 0);
}

export function isLastAskQuestion(index: number, total: number): boolean {
  return index === total - 1;
}

export function askDraftToAnswer(question: AskQuestion, draft: AskDraft): AskAnswer {
  const picked = draft.selected
    .filter((index) => index >= 0 && index < question.options.length)
    .map((index) => question.options[index]);
  const typed = draft.notes.map((note) => note.trim()).filter(Boolean);
  const dedupedTyped = typed.filter((note, index) => typed.indexOf(note) === index);
  return {
    id: question.id,
    prompt: question.prompt,
    multiSelect: question.multiSelect === true,
    labels: [...picked.map((option) => option.label), ...dedupedTyped.map((note) => `(其他) ${note}`)],
    values: [...picked.map((option) => option.value), ...dedupedTyped],
    ...(dedupedTyped.length > 0 ? { other: dedupedTyped.join("、") } : {}),
    cancelled: false,
  };
}

/**
 * Builds the whole response at once.
 *
 * This is the payoff of the native implementation: every question's draft lives
 * in one place, so the answers travel back together instead of one RPC at a
 * time.
 */
export function buildAskAnswers(questions: AskQuestion[], drafts: AskDraft[]): AskAnswer[] {
  return questions.map((question, index) => askDraftToAnswer(question, drafts[index] ?? EMPTY_ASK_DRAFT));
}
