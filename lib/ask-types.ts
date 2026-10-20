/**
 * Native `ask` protocol shared by the host extension (lib/ask-extension.ts) and
 * the browser dialog (components/AskDialog.tsx).
 *
 * Why a dedicated protocol instead of looping ctx.ui.select(): an extension can
 * only ever hold ONE question at a time through the select RPC, because the next
 * question is revealed only after the previous one resolves. That makes a
 * "go back and change answer 1" flow impossible. The `ask` request therefore
 * ships the whole question list in a single payload, and the browser owns the
 * paging state.
 */

export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  prompt: string;
  options: AskOption[];
  multiSelect?: boolean;
  /** Offer the free-text row. Defaults to true, like @wwyxin/pi-ask. */
  allowOther?: boolean;
  /** Shown above the options as extra context. */
  context?: string;
}

export interface AskAnswer {
  id: string;
  prompt: string;
  multiSelect: boolean;
  /** Human-readable picks, including typed notes as "(其他) ...". */
  labels: string[];
  /** Raw option values, plus typed notes verbatim. */
  values: string[];
  /** Typed free-text notes, already joined with "、" when more than one. */
  other?: string;
  /** The user dismissed the whole wizard before submitting. */
  cancelled: boolean;
}

export interface AskRequest {
  type: "extension_ui_request";
  id: string;
  method: "ask";
  questions: AskQuestion[];
  timeout?: number;
  expiresAt?: number;
}

/** Values the browser sends back through the regular extension_ui_response. */
export type AskResponse =
  | { type: "extension_ui_response"; id: string; askAnswers: AskAnswer[] }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export const ASK_MAX_QUESTIONS = 12;
export const ASK_MAX_OPTIONS = 24;

const DEFAULT_OTHER_LABEL = "✎ 输入其他 / 补充说明";

export function askOtherLabel(): string {
  return DEFAULT_OTHER_LABEL;
}

export function askAllowsOther(question: AskQuestion): boolean {
  return question.allowOther !== false;
}

export function isMultiSelect(question: AskQuestion): boolean {
  return question.multiSelect === true;
}

/**
 * Normalizes the model's raw tool arguments into the wire shape. Coerces plain
 * strings to options (some providers drop the object form) and drops questions
 * that carry nothing to answer.
 */
export function normalizeAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: AskQuestion[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    const options = normalizeAskOptions(item.options);
    if (!prompt || options.length === 0) continue;
    questions.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `q${index + 1}`,
      prompt,
      options,
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      ...(item.allowOther === false ? { allowOther: false } : {}),
      ...(typeof item.context === "string" && item.context.trim()
        ? { context: item.context.trim() }
        : {}),
    });
    if (questions.length >= ASK_MAX_QUESTIONS) break;
  }
  return questions;
}

function normalizeAskOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AskOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const option = normalizeAskOption(entry);
    if (!option || seen.has(option.value)) continue;
    seen.add(option.value);
    options.push(option);
    if (options.length >= ASK_MAX_OPTIONS) break;
  }
  return options;
}

function normalizeAskOption(entry: unknown): AskOption | undefined {
  if (typeof entry === "string") {
    const value = entry.trim();
    return value ? { value, label: value } : undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  const item = entry as Record<string, unknown>;
  const rawValue = item.value ?? item.label ?? item.title ?? item.name;
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) return undefined;
  const rawLabel = item.label ?? item.title ?? item.name ?? value;
  const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : value;
  const description = typeof item.description === "string" ? item.description.trim() : "";
  return { value, label, ...(description ? { description } : {}) };
}

/**
 * Turns the browser's answers into the compact summary the model reads. Mirrors
 * the plugin's wording so few-shot behaviour stays stable.
 */
export function formatAskResult(questions: AskQuestion[], answers: AskAnswer[]): {
  text: string;
  cancelled: boolean;
} {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const filled: AskAnswer[] = questions.map((question) => byId.get(question.id) ?? {
    id: question.id,
    prompt: question.prompt,
    multiSelect: isMultiSelect(question),
    labels: [],
    values: [],
    cancelled: true,
  });
  const cancelled = filled.some((answer) => answer.cancelled);
  const asked = filled.filter((answer) => !answer.cancelled);
  const lines = asked.map((answer) => {
    const picked = answer.labels.length > 0 ? answer.labels.join("、") : "(未选择)";
    return `- ${answer.id}${answer.multiSelect ? " [多选]" : ""}: ${picked}`;
  });
  const text = cancelled
    ? asked.length > 0
      ? `User cancelled the remaining questions. Already answered:\n${lines.join("\n")}`
      : "User cancelled the question."
    : `User answered:\n${lines.join("\n")}`;
  return { text, cancelled };
}
