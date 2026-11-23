// critic.ts
//
// Post-answer grounding. The model rewrites its own answer so every factual
// claim carries an inline URL from the retrieved set. Code validates those
// URLs and marks unsupported claims; the model never gets a new tool.
import type { Llm, Usage } from "./llm.js";
import type { EnrichedSource } from "./search.js";
import { expandInlineTables } from "./markdown.js";
import { extractSourceDate, relativeDateMention } from "./source-date.js";
import { guardValueSupport, isVerbatimQuote, type SupportEvidence } from "./support.js";
import { canonicalUrl } from "./url.js";

export type GroundResult = {
  answer: string;
  statements: number;
  dropped: number;
  /** Values the critic asserted but no retrieved source stated, rewritten in code. */
  replaced: string[];
  note: string | null;
  /** The evidence the guard graded against, traced for the eval judge. */
  sources?: Array<{ url: string; text: string }>;
  error?: string;
  usage: Usage;
};

const NUMBER = /\b\d+(?:\.\d+)?\b/g;
const YEAR = /^(?:19|20)\d{2}$/;

export function needsGrounding(answer: string): boolean {
  const hasTable = answer
    .split("\n")
    .some((line) => line.trimStart().startsWith("|"));
  // A calendar year is not a measurement. Counting years made a simple
  // "as of 2026, the latest version is v26.13.1" answer look like a
  // number-heavy answer, so it fetched pages and rewrote the version. Ground
  // tables and answers with several real measures; leave one-claim answers
  // to the model's citation.
  const numbers = new Set(
    (answer.match(NUMBER) ?? []).filter((value) => !YEAR.test(value))
  );
  return hasTable || numbers.size >= 3;
}

const CRITIC_INSTRUCTIONS = `You revise a research answer so every factual claim is grounded.

You are given the original answer and the sources that were retrieved. Return:
- revisedAnswer: the same answer with the same markdown structure, but with an
  inline source URL beside every factual claim, written as [URL]. For a table,
  put the URL in the relevant cell. Use ONLY URLs from the source list.
- statements: one entry per factual claim with its text, the URL used, a quote,
  and supported: true if the source states it, false if it does not.
  The quote must be an exact contiguous excerpt from that URL's text, copied
  word for word, that states the claim's value together with the feature it
  belongs to. Do not paraphrase and do not join separate sentences. If no
  sentence states it, set quote to null and supported to false. For a table
  cell, quote the source sentence that supports that cell's value for that
  vendor, not a sentence about a different feature or a different vendor.
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
          quote: { anyOf: [{ type: "string" }, { type: "null" }] },
          supported: { type: "boolean" },
        },
        required: ["text", "url", "quote", "supported"],
        additionalProperties: false,
      },
    },
  },
  required: ["revisedAnswer", "statements"],
  additionalProperties: false,
};

type CriticData = {
  revisedAnswer: string;
  statements: Array<{
    text: string;
    url: string | null;
    quote: string | null;
    supported: boolean;
  }>;
};

/** Remove a URL and its markdown wrapper, leaving no empty brackets behind. */
function stripUrl(text: string, url: string): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`\\[([^\\]]*)\\]\\(\\s*${escaped}\\s*\\)`, "g"), "$1")
    .replace(new RegExp(`\\[\\s*${escaped}\\s*\\]`, "g"), "")
    .split(url)
    .join("");
}

/** Point an already-correct citation at the fetched URL without appending a
 * second fragment to it. A clean URL is a prefix of its tracked form. */
function replaceUrl(text: string, from: string, to: string): string {
  if (from === to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?![\\w#?/.-])`, "g"), to);
}

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

    let revised = expandInlineTables(data.revisedAnswer || answer);
    // A URL the critic wrote that canonicalises to a retrieved page (tracking
    // query, www, .md) is the same evidence: point the answer at the URL we
    // actually fetched instead of stripping it. A URL we never retrieved is
    // removed together with its markdown wrapper so no empty "[]" is left.
    const retrieved = new Map(sources.map((s) => [canonicalUrl(s.url), s.url]));
    const rewritten = new Set<string>();
    for (const statement of data.statements ?? []) {
      if (!statement.url || allowed.has(statement.url)) continue;
      if (rewritten.has(statement.url)) continue;
      rewritten.add(statement.url);
      const match = retrieved.get(canonicalUrl(statement.url));
      if (match) {
        revised = replaceUrl(revised, statement.url, match);
        statement.url = match;
      } else {
        revised = stripUrl(revised, statement.url);
      }
    }
    const dropped = (data.statements ?? []).filter((s) => !s.supported).length;
    if (dropped > 0 && !revised.includes("not stated in sources")) {
      revised += "\n\nClaims not stated in sources were marked as such.";
    }

    // Evidence is the union of the search snippet and the fetched page. A page
    // fetch can omit a section the snippet contained (or vice versa), and using
    // `pageText ?? content` let a successful fetch hide the snippet that stated
    // the value. Keyed by page identity, because the answer cites the clean URL
    // while search may return a tracked variant.
    const sourceText = (source: EnrichedSource) =>
      [source.content, source.pageText ?? ""]
        .filter((part) => part.trim() !== "")
        .join("\n");
    const textByUrl = new Map<string, string>();
    for (const source of sources) {
      const key = canonicalUrl(source.url);
      const previous = textByUrl.get(key);
      const text = sourceText(source);
      textByUrl.set(key, previous ? `${previous}\n${text}` : text);
    }
    const evidence: SupportEvidence[] = [];
    for (const statement of data.statements ?? []) {
      if (!statement.url) continue;
      const cited = textByUrl.get(canonicalUrl(statement.url));
      if (cited === undefined) continue;
      if (!("quote" in statement)) continue; // pre-quote stubs: keep old behaviour
      const raw = typeof statement.quote === "string" ? statement.quote.trim() : "";
      evidence.push({
        url: statement.url,
        text: statement.text ?? "",
        quote:
          raw !== "" && isVerbatimQuote(raw, cited)
            ? raw
            : "",
      });
    }

    // The critic's `supported` flags are a hint, not the contract: F-002 showed
    // it marking unsupported table values as supported. Check each numeric
    // claim against the retrieved text and replace what no source states.
    // Runs before the date note so metadata dates are not graded as claims.
    const support = guardValueSupport(
      revised,
      sources.map((source) => ({
        url: source.url,
        text: sourceText(source),
      })),
      evidence
    );
    revised = support.answer
      // The critic can leave a qualifier in front of its own marker ("Up to
      // not stated in sources"), which reads as if a ceiling survived.
      .replace(
        /\b(?:up to|as much as|about|around|nearly)\s+\*{0,2}not stated in sources\*{0,2}/gi,
        "not stated in sources"
      );

    // Always state date visibility. F-006's rubric asks whether the cited
    // source has a visible date, so silence is never an acceptable answer —
    // even when some other source in the set did have one. Only dates present
    // in the page text count as visible: Tavily's publishedAt is metadata, and
    // listing it made the answer claim dates a reader could not see.
    const dated: string[] = [];
    const relative: string[] = [];
    for (const source of sources) {
      const text = sourceText(source);
      const absolute = extractSourceDate(text);
      if (absolute !== null) dated.push(`${source.url} (${absolute})`);
      const ago = relativeDateMention(text);
      if (ago !== null) relative.push(`${source.url} ("${ago}")`);
    }
    const dateParts: string[] = [];
    if (dated.length > 0) {
      dateParts.push(`Publication dates visible in sources: ${dated.join(", ")}.`);
    }
    if (relative.length > 0) {
      dateParts.push(`Relative update times visible in sources: ${relative.join(", ")}.`);
    }
    const note =
      dateParts.length > 0
        ? dateParts.join(" ")
        : "No publication date was visible in the retrieved sources.";
    revised += `\n\n${note}`;

    return {
      answer: revised.trim() || answer,
      statements: (data.statements ?? []).length,
      dropped,
      replaced: support.replaced,
      note,
      sources: sources.map((source) => ({
        url: source.url,
        text: sourceText(source).slice(0, 4000),
      })),
      usage,
    };
  } catch (err) {
    return {
      answer,
      statements: 0,
      dropped: 0,
      replaced: [],
      note: null,
      error: err instanceof Error ? err.message : String(err),
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
