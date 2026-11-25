// critic.ts
//
// Post-answer grounding. The model rewrites its own answer so every factual
// claim carries an inline URL and a verbatim quote from the cited page. Code
// verifies the quote and the claim's numbers, removes any claim that does not
// hold up, and lifts the surviving citations into one Sources list. The model
// never gets a new tool.
import type { Llm, Usage } from "./llm.js";
import type { EnrichedSource } from "./search.js";
import { expandInlineTables } from "./markdown.js";
import { dropSourcesBlock, sourcesSection, stripCitations, urlsIn } from "./sources.js";
import { extractSourceDate, relativeDateMention } from "./source-date.js";
import {
  applyEvidence,
  assembleProse,
  checkClaim,
  claimMeasures,
  isLeadIn,
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
  /** Every statement, its evidence and verdict, for the trace. */
  checked: Array<{
    text: string;
    url: string | null;
    quote: string | null;
    supported: boolean;
  }>;
  note: string | null;
  /** The evidence the critic graded against, traced for the eval judge. */
  sources?: Array<{ url: string; text: string }>;
  error?: string;
  usage: Usage;
};

const NUMBER = /\b\d+(?:\.\d+)?\b/g;
const YEAR = /^(?:19|20)\d{2}$/;
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
- revisedAnswer: the answer with the same markdown structure and an inline
  source URL beside every factual claim, written as [URL]. It is used only to
  lay out a markdown table. For a prose answer, the statements below are what
  the reader sees, so keep this text consistent with them. Use ONLY URLs from
  the source list. Do not write your own Sources section.
- statements: the prose answer in reading order, one entry per sentence or
  bullet line. Code renders these entries verbatim; it never splits or
  rewrites them, so every sentence the reader should see must be its own entry.
  - text: the sentence or bullet exactly as it should appear, WITHOUT a URL.
    Keep a bullet's "- " marker. Split separate claims into separate entries.
    Connective prose that makes no factual claim is an entry too, with url and
    quote null, but only a section heading or a lead-in that ends with a colon
    qualifies. Any sentence that says something about a product needs its URL
    and quote, even when it contains no number.
  - url: the source URL for the claim, or null for connective prose.
  - quote: an exact contiguous excerpt from that URL's text, copied word for
    word, that states the claim's value together with the feature it belongs
    to. Copy it from the page you cite, not from a related page or a navigation
    sidebar, even when that text names the same version. Do not paraphrase and
    do not join separate sentences. The quote must contain every number the
    claim uses. Connective prose has quote null.
  - For a table cell, text is the cell exactly as written (without the URL),
    and the quote is the source sentence that supports that cell's value for
    that vendor.

A version and its release date often appear in different source sentences.
Then return two statements rather than one: every number in a statement must
appear in that statement's quote. If the version heading and the date line are
contiguous on the page, quote both ("# Python 3.15.0 ... Release date: Oct. 9,
2026") so one statement can carry the version and the date.

Order statements as the reader should see them. Write each one so it makes
sense on its own: a rejected neighbour must not leave a dangling "it" or "that
release". Omit a claim you cannot support rather than returning a statement for
it. Do not add facts. Prefer readable magnitudes in prose ("$5.13 trillion",
"1.2 million") over long digit strings; the verifier compares the value, not
the spelling.
If the answer turns on freshness (a live price, a current role, a release
date), keep the source's own date or timestamp inside that sentence in one
short phrase; do not add a separate list of dates.
If there are no sources, return the original answer and an empty statements
list.`;

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

    const statements = data.statements ?? [];
    const hasTable = answer
      .split("\n")
      .some((line) => line.trimStart().startsWith("|"));

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
        url = match ?? null;
      }
      const quote =
        (statement.quote ?? "").trim() === "" ? null : statement.quote;
      // An entry with no URL and no quote is only allowed when it introduces
      // what follows (a heading or a lead-in ending in a colon). Numbers and
      // prose sentences both require evidence: otherwise a statement could
      // slip past verification by calling itself connective.
      const connective =
        statement.url === null &&
        quote === null &&
        claimMeasures(statement.text).length === 0 &&
        isLeadIn(statement.text);
      const cited = url ? byUrl.get(canonicalUrl(url)) : undefined;
      return {
        text: statement.text,
        url,
        quote,
        supported:
          connective ||
          (url !== null &&
            cited !== undefined &&
            checkClaim(statement.text, quote, cited)),
      };
    });

    let final: string;
    let citedUrls: string[];
    let droppedClaims: string[];

    if (hasTable) {
      // A markdown table already delimits its cells, so grading the rendered
      // table is exact. Prose answers take the statement path below.
      const applied = applyEvidence(
        expandInlineTables(data.revisedAnswer || answer),
        verified
      );
      final = dropSourcesBlock(applied.answer);
      citedUrls = urlsIn(final)
        .map((url) => retrieved.get(canonicalUrl(url)))
        .filter((url): url is string => url !== undefined);
      final = stripCitations(final);
      droppedClaims = applied.dropped;
    } else if (statements.length === 0) {
      // The critic returned no prose entries. Keep the model's answer rather
      // than turning a correct reply into "could not verify"; only remove
      // citations that point outside the retrieved set.
      final = dropSourcesBlock(stripCitations(answer));
      citedUrls = urlsIn(answer)
        .map((url) => retrieved.get(canonicalUrl(url)))
        .filter((url): url is string => url !== undefined);
      droppedClaims = [];
    } else {
      // The statements are the answer. There is no draft to split into
      // sentences and no text to match back onto one, which is what lost
      // verified Node.js and Python claims to a paraphrase and to "Oct.".
      const kept = verified.filter((statement) => statement.supported);
      final = dropSourcesBlock(stripCitations(assembleProse(kept)));
      citedUrls = kept
        .map((statement) => statement.url)
        .filter((url): url is string => url !== null);
      droppedClaims = verified
        .filter((statement) => !statement.supported)
        .map((statement) => statement.text);
    }

    // Losing every claim is a real outcome. Say so once, as its own sentence,
    // rather than splicing a marker into prose that still cites a source.
    if (final.trim() === "") {
      final = "I could not verify this answer against the retrieved sources.";
    }
    final += sourcesSection(citedUrls, sources);

    // Date visibility is trace metadata, not part of the reply. Only dates
    // present in the page text count as visible: Tavily's publishedAt is
    // metadata, and listing it made the answer claim dates a reader could not
    // see. Keeping it here means the trace still explains a freshness decision
    // without dumping it into the chat.
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

    return {
      answer: final.trim(),
      statements: statements.length,
      dropped: verified.filter((statement) => !statement.supported).length,
      droppedClaims,
      checked: verified.map((statement) => ({
        text: statement.text,
        url: statement.url,
        quote: statement.quote,
        supported: statement.supported,
      })),
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
      checked: [],
      note: null,
      error: err instanceof Error ? err.message : String(err),
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
