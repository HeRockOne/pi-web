import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  formatAskResult,
  normalizeAskQuestions,
  type AskAnswer,
  type AskQuestion,
} from "./ask-types";

export const HOST_ASK_EXTENSION_NAME = "pi-web-ask";
const HOST_ASK_EXTENSION_PATH = `<inline:${HOST_ASK_EXTENSION_NAME}>`;

/**
 * Suppresses standalone `ask` extensions once the host implementation is live.
 *
 * The host tool ships every question in one request, so the browser can page
 * back and forth; a looping `ctx.ui.select()` implementation cannot, because the
 * next question is only revealed after the previous one resolves. Two `ask` tools
 * registering at once would also collide, and the host one wins.
 */
const LEGACY_ASK_PACKAGE_NAMES = new Set(["pi-ask"]);

export interface AskExtensionRuntime {
  /**
   * Sends one `ask` request carrying the whole question list and resolves with
   * the browser's answers, or `undefined` when the user dismissed the wizard.
   */
  ask(questions: AskQuestion[], signal?: AbortSignal): Promise<AskAnswer[] | undefined>;
}

export function createAskExtension(runtime: AskExtensionRuntime): InlineExtension {
  return {
    name: HOST_ASK_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: "ask",
        label: "Ask",
        description:
          "Ask the user one or more questions using a tappable option list. Set multiSelect: true for checkbox questions where several options may be picked. In pi-web all questions are shown in one paged dialog, so the user can move back to an earlier question and change that answer before submitting. Every question gets a free-text row (\"✎ 输入其他 / 补充说明\") by default, so the user can always add a note. Prefer this over writing questions as plain chat text.",
        promptSnippet: "Ask the user structured questions with tappable / selectable options (supports multi-select and a free-text row).",
        promptGuidelines: [
          "Use ask instead of writing a question as plain chat text whenever you need a decision, a preference, or a clarification from the user.",
          "Use multiSelect: true when the user may legitimately choose more than one option (batch selections, which items to process, which features to include).",
          "Keep option labels short; put extra detail in the description only when a shorter label would be ambiguous.",
          "Pass several questions in a single ask call when they belong together: pi-web shows them in one dialog the user can page through.",
          "A free-text row is always offered (allowOther defaults to true), so never assume the user is limited to your options; only set allowOther: false when free text would be meaningless.",
        ],
        executionMode: "sequential",
        parameters: Type.Object({
          questions: Type.Array(
            Type.Object({
              id: Type.String({ description: "Stable id used in the answer summary." }),
              prompt: Type.String({ description: "Question text, shown as the dialog heading." }),
              multiSelect: Type.Optional(Type.Boolean({ description: "true = checkbox question, several options may be picked." })),
              allowOther: Type.Optional(Type.Boolean({ description: "Offer the free-text row. Defaults to true." })),
              context: Type.Optional(Type.String({ description: "Extra context shown above the options." })),
              options: Type.Array(
                Type.Object({
                  value: Type.String({ description: "What the model gets back." }),
                  label: Type.String({ description: "What the user sees." }),
                  description: Type.Optional(Type.String({ description: "Optional secondary line." })),
                }),
              ),
            }),
          ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          if (!ctx.hasUI) {
            return {
              content: [{ type: "text", text: "Error: no interactive UI available in this mode." }],
              details: undefined,
              isError: true,
            };
          }
          const questions = normalizeAskQuestions((params as { questions?: unknown }).questions);
          if (questions.length === 0) {
            return {
              content: [{ type: "text", text: "Error: no questions provided." }],
              details: undefined,
              isError: true,
            };
          }

          const answers = await runtime.ask(questions, signal);
          if (!answers || answers.length === 0) {
            return {
              content: [{ type: "text", text: "User cancelled the question." }],
              details: {
                answers: questions.map((question) => ({
                  id: question.id,
                  prompt: question.prompt,
                  multiSelect: question.multiSelect === true,
                  labels: [],
                  values: [],
                  cancelled: true,
                })),
                cancelled: true,
              },
            };
          }

          const { text, cancelled } = formatAskResult(questions, answers);
          return {
            content: [{ type: "text", text }],
            details: { answers, cancelled },
          };
        },
      }));
    },
  };
}

/**
 * Drops a standalone `ask` extension from the loaded set when the host tool is
 * present. Mirrors `preferPiWebSubagentExtension`: only packages that identify
 * themselves as `pi-ask` AND register a tool named `ask` are removed, so an
 * unrelated extension is never stripped just for using that name.
 */
export function preferPiWebAskExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find((extension) => extension.path === HOST_ASK_EXTENSION_PATH);
  if (!host?.tools.has("ask")) return base;
  const legacyPaths = new Set(base.extensions
    .filter((extension) => extension.path !== HOST_ASK_EXTENSION_PATH)
    .filter((extension) => {
      const source = extension.sourceInfo?.source ?? "";
      const sourcePackage = source.replace(/^npm:/, "").split("@")[0];
      const pathSegments = extension.path.replaceAll("\\", "/").split("/");
      const fromLegacyPackage = LEGACY_ASK_PACKAGE_NAMES.has(sourcePackage)
        || pathSegments.some((segment) => {
          const clean = segment.split("@")[0];
          return LEGACY_ASK_PACKAGE_NAMES.has(clean);
        });
      return fromLegacyPackage && extension.tools.has("ask");
    })
    .map((extension) => extension.path));
  if (legacyPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !legacyPaths.has(extension.path)),
    errors: base.errors.filter((error) => {
      const path = (error as { path?: string }).path;
      return !path || !legacyPaths.has(path);
    }),
  };
}
