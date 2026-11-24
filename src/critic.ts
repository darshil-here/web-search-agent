// critic.ts
//
// Post-answer grounding. The model rewrites its own answer so every factual
// claim carries an inline URL and a verbatim quote from the cited page. Code
// verifies the quote and the claim's numbers, then removes any claim that does
// not hold up. The model never gets a new tool.
import type { Llm, Usage } from "./llm.js";
import type { EnrichedSource } from "./search.js";
import { expandInlineTables } from "./markdown.js";
import { extractSourceDate, relativeDateMention } from "./source-date.js";
import {
  applyEvidence,
  checkClaim,
  type VerifiedStatement,
} from "./support.js";
import { canonicalUrl } from "./url.js";

export type GroundResult = {
  answer: string;
  statements: number;
  /** Statements whose evidence did not verify. */
  dropped: number;
  /** The sentences or cells actually removed from the answer. */
  droppedClaims: string[];
  note: string | null;
  /** The evidence the critic graded against, traced for the eval judge. */
  sources?: Array<{ url: string; text: string }>;
  error?: string;
  usage: Usage;
};

const NUMBER = /\b\d+(?:\.\d+)?\b/g;
const YEAR = /^(?:19|20)\d{2}$/;
const URL = /https?:\/\/[^\s)\]|,]+/g;
/** Non-global twin: `.test` on a global regex is stateful across calls. */
const HAS_URL = /https?:\/\/[^\s)\]|,]+/;

export function needsGrounding(answer: string): boolean {
  const hasTable = answer
    .split("\n")
    .some((line) => line.trimStart().startsWith("|"));
  // A calendar year is not a measurement.
  const numbers = (answer.match(NUMBER) ?? []).filter(
    (value) => !YEAR.test(value)
  );
  // Any citation or any real number is enough. Gating on three numbers skipped
  // short factual answers such as "NVIDIA reinstated Jensen Huang [URL]", which
  // is exactly the shape a hallucinated claim takes.
  return hasTable || HAS_URL.test(answer) || numbers.length > 0;
}

const CRITIC_INSTRUCTIONS = `You revise a research answer so every factual claim is grounded.

You are given the original answer and the sources that were retrieved. Return:
- revisedAnswer: the same answer with the same markdown structure, but with an
  inline source URL beside every factual claim, written as [URL]. For a table,
  put the URL in the relevant cell. Use ONLY URLs from the source list.
  Remove every claim you cannot support with a verbatim quote. Do not replace
  it with a marker and do not leave an unverified number behind. For a table
  cell you cannot support, write "Not stated" in that cell. Keep connective
  prose that makes no factual claim.
- statements: one entry per factual claim kept in revisedAnswer.
  - text: the claim copied exactly as it appears in revisedAnswer. Include any
    date, range or qualifier that sits inside the claim, so the quote has to
    cover it too.
  - url: the source URL used.
  - quote: an exact contiguous excerpt from that URL's text, copied word for
    word, that states the claim's value together with the feature it belongs
    to. Do not paraphrase and do not join separate sentences. The quote must
    contain every number the claim uses. If no sentence states it, omit the
    claim from revisedAnswer instead of returning a statement for it.
  - For a table cell, text is the cell exactly as written, and the quote is the
    source sentence that supports that cell's value for that vendor.

Write each factual claim as its own sentence so it can be verified on its own.
Do not add facts. If there are no sources, return the original answer and an
empty statements list.`;

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
        },
        required: ["text", "url", "quote"],
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
  const sourceBlock =
    sources
      .map(
        (source) =>
          `[${source.url}] ${source.title}` +
          (source.publishedAt ? ` (published ${source.publishedAt})` : "") +
          `\n${source.pageText ?? source.content}`
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
    const statements = data.statements ?? [];

    // Evidence is the union of the search snippet and the fetched page. A page
    // fetch can omit a section the snippet contained (or vice versa), and using
    // `pageText ?? content` let a successful fetch hide the snippet that stated
    // the value. Keyed by page identity, because the answer cites the clean URL
    // while search may return a tracked variant.
    const sourceText = (source: EnrichedSource) =>
      [source.content, source.pageText ?? ""]
        .filter((part) => part.trim() !== "")
        .join("\n");

    const byUrl = new Map<string, string>();
    for (const source of sources) {
      const key = canonicalUrl(source.url);
      const previous = byUrl.get(key);
      const text = sourceText(source);
      byUrl.set(key, previous ? `${previous}\n${text}` : text);
    }

    const allowed = new Set(sources.map((source) => source.url));
    const retrieved = new Map(
      sources.map((source) => [canonicalUrl(source.url), source.url])
    );

    // A URL the critic wrote that canonicalises to a retrieved page is the same
    // evidence: point the statement at the URL we actually fetched. A URL we
    // never retrieved is not evidence and cannot verify a claim.
    const verified: VerifiedStatement[] = statements.map((statement) => {
      let url = statement.url;
      if (url && !allowed.has(url)) {
        const match = retrieved.get(canonicalUrl(url));
        if (match) {
          revised = replaceUrl(revised, url, match);
          url = match;
        } else {
          url = null;
        }
      }
      const cited = url ? byUrl.get(canonicalUrl(url)) : undefined;
      return {
        text: statement.text,
        url,
        supported:
          url !== null &&
          cited !== undefined &&
          checkClaim(statement.text, statement.quote, cited),
      };
    });

    const applied = applyEvidence(revised, verified);
    let final = applied.answer;

    // Strip any citation that does not name a page we retrieved. The claim it
    // sat beside is either gone above or was connective prose with no fact.
    const cited = [...final.matchAll(new RegExp(URL.source, "g"))].map((match) => match[0]);
    for (const url of new Set(cited)) {
      if (allowed.has(url)) continue;
      const match = retrieved.get(canonicalUrl(url));
      final = match ? replaceUrl(final, url, match) : stripUrl(final, url);
    }

    // Losing every claim is a real outcome. Say so once, as its own sentence,
    // rather than splicing a marker into prose that still cites a source.
    if (final.trim() === "") {
      final = "I could not verify this answer against the retrieved sources.";
    }

    // Always state date visibility. Only dates present in the page text count
    // as visible: Tavily's publishedAt is metadata, and listing it made the
    // answer claim dates a reader could not see.
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
    final += `\n\n${note}`;

    return {
      answer: final.trim(),
      statements: statements.length,
      dropped: verified.filter((statement) => !statement.supported).length,
      droppedClaims: applied.dropped,
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
      droppedClaims: [],
      note: null,
      error: err instanceof Error ? err.message : String(err),
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
