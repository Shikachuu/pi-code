import {
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type Answers,
  formatAnswers,
  interview,
  type Question,
} from "./interview.ts";
import { DOC_ENTRY, type DocEntry } from "./review.ts";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Short choice text (1-5 words)" }),
  description: Type.Optional(
    Type.String({
      description: "What picking this option means, including trade-offs",
    }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Stable key for the answer; defaults to q1, q2, ...",
    }),
  ),
  header: Type.String({
    description:
      "Tab label, 12 characters or fewer, e.g. 'Auth', 'Storage'; longer labels are cut",
  }),
  question: Type.String({
    description: "The full question, ending with a question mark",
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description:
      "2-4 distinct choices. Do not add an 'Other' option; the picker adds a free-form row",
  }),
  multiSelect: Type.Boolean({
    description:
      "true when several options can apply at once (e.g. which platforms, which fields to include); false when the options are mutually exclusive",
  }),
});

const Params = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
});

interface Details {
  questions: Question[];
  answers?: Answers;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user 1-4 multiple-choice questions in an interactive picker. Each question has 2-4 options plus a free-form answer. Returns the chosen options and any text the user wrote.",
    promptSnippet:
      "Ask the user 1-4 multiple-choice questions in an interactive picker",
    promptGuidelines: [
      "Use ask_user only for decisions that belong to the user and that you cannot resolve from the request, the code, or sensible defaults.",
      "Batch related questions into one ask_user call. If you recommend an option, list it first and add '(Recommended)' to its label.",
      "Set multiSelect true whenever the user may want more than one option, such as which platforms, fields or features to include; set it false only for mutually exclusive choices.",
    ],
    parameters: Params,

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const taken = new Set<string>();
      const questions: Question[] = params.questions.map((q, i) => {
        let id = q.id || `q${i + 1}`;
        while (taken.has(id)) id = `${id}-${i + 1}`;
        taken.add(id);
        return { ...q, id };
      });
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: no interactive UI; make a sensible default choice and state it",
            },
          ],
          details: { questions },
        };
      }
      let answers: Answers | undefined;
      try {
        answers = await interview(ctx, questions);
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error: ${(error as Error).message}` },
          ],
          details: { questions },
        };
      }
      if (!answers) {
        return {
          content: [
            {
              type: "text",
              text: "The user dismissed the questions without answering.",
            },
          ],
          details: { questions },
        };
      }
      return {
        content: [{ type: "text", text: formatAnswers(questions, answers) }],
        details: { questions, answers },
      };
    },

    renderCall(args, theme) {
      const headers = ((args.questions ?? []) as Question[])
        .map((q) => q.header)
        .join(", ");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg("muted", headers)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as Details | undefined;
      if (!details?.answers) {
        const first = result.content[0];
        return new Text(
          theme.fg(
            "warning",
            first?.type === "text" ? first.text : "No answer",
          ),
          0,
          0,
        );
      }
      return new Text(formatAnswers(details.questions, details.answers), 0, 0);
    },
  });

  pi.registerEntryRenderer<DocEntry>(
    DOC_ENTRY,
    (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      const header = new Text(
        `${theme.fg("accent", theme.bold(data.title))} ${theme.fg("dim", `(${data.status})`)}`,
        0,
        0,
      );
      if (!expanded) return header;
      const box = new Container();
      box.addChild(header);
      box.addChild(new Markdown(data.markdown, 1, 0, getMarkdownTheme()));
      return box;
    },
  );
}
