// critic.ts
//
// Post-answer grounding. The model rewrites its own answer so every factual
// claim carries an inline URL from the retrieved set. Code validates those
// URLs and marks unsupported claims; the model never gets a new tool.
import type { Llm, Usage } from "./llm.js";
import type { EnrichedSource } from "./search.js";

export type GroundResult = {
  answer: string;
  statements: number;
  dropped: number;
  note: string | null;
  error?: string;
  usage: Usage;
};

const NUMBER = /\b\d+(?:\.\d+)?\b/g;

export function needsGrounding(answer: string): boolean {
  const hasTable = answer
    .split("\n")
    .some((line) => line.trimStart().startsWith("|"));
  const numbers = new Set(answer.match(NUMBER) ?? []);
  return hasTable || numbers.size >= 3;
}

const CRITIC_INSTRUCTIONS = `You revise a research answer so every factual claim is grounded.

You are given the original answer and the sources that were retrieved. Return:
- revisedAnswer: the same answer with the same markdown structure, but with an
  inline source URL beside every factual claim, written as [URL]. For a table,
  put the URL in the relevant cell. Use ONLY URLs from the source list.
- statements: one entry per factual claim with its text, the URL used, and
  supported: true if the source states it, false if it does not.
  A statement with supported: false must be rendered as "not stated in sources"
  in revisedAnswer instead of being asserted.

Do not add facts. Do not remove the answer's structure. If there are no sources,
return the original answer and an empty statements list.`;

const CRITIC_SCHEMA = {
  type: "object",
  properties: {
    revisedAnswer: { type: "string" },
    statements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          url: { anyOf: [{ type: "string" }, { type: "null" }] },
          supported: { type: "boolean" },
        },
        required: ["text", "url", "supported"],
        additionalProperties: false,
      },
    },
  },
  required: ["revisedAnswer", "statements"],
  additionalProperties: false,
};

type CriticData = {
  revisedAnswer: string;
  statements: Array<{ text: string; url: string | null; supported: boolean }>;
};

export async function ground(
  llm: Llm,
  answer: string,
  sources: EnrichedSource[],
  question: string
): Promise<GroundResult> {
  const allowed = new Set(sources.map((s) => s.url));
  const sourceBlock =
    sources
      .map(
        (s) =>
          `[${s.url}] ${s.title}` +
          (s.publishedAt ? ` (published ${s.publishedAt})` : "") +
          `\n${s.pageText ?? s.content}`
      )
      .join("\n\n") || "(none)";

  try {
    const { data, usage } = await llm.structured<CriticData>({
      name: "grounding_critic",
      schema: CRITIC_SCHEMA,
      instructions: CRITIC_INSTRUCTIONS,
      input: `QUESTION:\n${question}\n\nANSWER:\n${answer}\n\nSOURCES:\n${sourceBlock}`,
    });

    let revised = data.revisedAnswer || answer;
    // Strip URLs the critic invented. Literal replacement preserves markdown
    // structure and surrounding prose unchanged.
    for (const statement of data.statements ?? []) {
      if (statement.url && !allowed.has(statement.url)) {
        revised = revised.split(statement.url).join("");
      }
    }
    const dropped = (data.statements ?? []).filter((s) => !s.supported).length;
    if (dropped > 0 && !revised.includes("not stated in sources")) {
      revised += "\n\nClaims not stated in sources were marked as such.";
    }

    const hasDate = sources.some((s) => s.publishedAt !== null);
    const note = hasDate
      ? null
      : "No publication date was visible in the retrieved sources.";
    if (note) revised += `\n\n${note}`;

    return {
      answer: revised.trim() || answer,
      statements: (data.statements ?? []).length,
      dropped,
      note,
      usage,
    };
  } catch (err) {
    return {
      answer,
      statements: 0,
      dropped: 0,
      note: null,
      error: err instanceof Error ? err.message : String(err),
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
