// Turns the prose of an answer into a ledger of checkable facts. Two jobs:
//
//   1. extract — one structured-output call over (answer + sources). This is
//      pipeline code, not a tool: the model still has exactly one tool.
//   2. record  — reconcile those facts against the open ledger. A changed value
//      closes the old row and inserts a new one instead of overwriting it. That
//      validity chain is what a later "has it changed?" step reads as a diff.
//
// `record` is pure DB work and is unit-tested with no network; only `extract`
// needs a model.
import type Database from "better-sqlite3";
import type { Claim } from "./db.js";
import { closeClaim, openClaim, saveClaim } from "./db.js";
import { localDateInTz } from "./dates.js";
import { anchorAttribute, SIBLING_CONCEPTS } from "./concepts.js";
import type { Llm, Usage } from "./llm.js";
import type { SearchResult } from "./search.js";
import { clip } from "./text.js";
import { canonicalUrl } from "./url.js";

export type ExtractedClaim = {
  subject: string;
  attribute: string;
  value: string;
  url: string | null;
  quote: string | null;
};

/** Caps that keep a runaway model string from inflating the ledger. */
export const CLAIM_LIMITS = {
  subject: 200,
  attribute: 200,
  value: 300,
  quote: 400,
};

const EXTRACT_INSTRUCTIONS = `You extract checkable factual claims from a research answer, so they can be stored in a ledger and re-checked later.

Extract ONLY claims that are:
- external, checkable facts: prices, limits, versions, release dates, availability, specs
- actually stated by one of the sources provided

Do NOT extract:
- the user's question, chat history, or anything about this conversation
- arithmetic, opinions, advice, predictions, or hedges
- anything the sources do not state. If a number is not in the source text, do not extract it.

For each claim:
- subject:   the entity, e.g. "Neon free tier", "ChatGPT Plus"
- attribute: the property the USER actually asked about, e.g. "storage quota",
             "monthly price", "latest stable release". Sibling concepts are
             different attributes even when they read alike: ${SIBLING_CONCEPTS}.
- value:     the short factual value, e.g. "10 GB", "$20/month", "26.13.1"
- url:       the EXACT source URL supporting it, or null if none
- quote:     a short verbatim snippet from that source, or null

The user's question is given below. Use its wording to choose the attribute.
If the answer and the question disagree about the concept, prefer the question
and keep the attribute tied to it. A source may label the value with a related
but different concept (e.g. "LTS" where the question said "stable"): that is
still extractable. Record the value under the question's attribute and let the
re-check step handle the concept mismatch. Do not drop the claim only because
of that wording difference.

If there are no such claims, return an empty claims array.`;

// Strict structured outputs: every field required, no extras, nullable via anyOf.
const CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string" },
          attribute: { type: "string" },
          value: { type: "string" },
          url: { anyOf: [{ type: "string" }, { type: "null" }] },
          quote: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["subject", "attribute", "value", "url", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

/**
 * Defensive cleanup: the model can't invent a URL we did not retrieve, can't
 * emit empty fields, and can't repeat the same claim three times. Length caps
 * stop a runaway quote from inflating the ledger, and the attribute is anchored
 * to the question's wording so a sibling concept cannot stand in for it.
 */
function sanitise(
  raw: ExtractedClaim[],
  sources: SearchResult[],
  question?: string
): ExtractedClaim[] {
  const allowedUrls = new Map(
    sources.map((source) => [canonicalUrl(source.url), source.url])
  );
  const seen = new Set<string>();
  const out: ExtractedClaim[] = [];

  for (const claim of raw) {
    const subject = clip(claim.subject ?? "", CLAIM_LIMITS.subject);
    const attribute = anchorAttribute(
      clip(claim.attribute ?? "", CLAIM_LIMITS.attribute),
      question
    );
    const value = clip(claim.value ?? "", CLAIM_LIMITS.value);
    if (!subject || !attribute || !value) continue;

    const url = claim.url
      ? allowedUrls.get(canonicalUrl(claim.url)) ?? null
      : null;
    const quote = claim.quote ? clip(claim.quote, CLAIM_LIMITS.quote) : null;
    const key = `${subject}|${attribute}|${value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ subject, attribute, value, url, quote });
  }

  return out;
}

/** One structured-output call. The caller decides whether a failure is fatal. */
export async function extractClaims(
  llm: Llm,
  answer: string,
  sources: SearchResult[],
  question?: string
): Promise<{ claims: ExtractedClaim[]; usage: Usage }> {
  const sourceBlock =
    sources.length === 0
      ? "(no sources were retrieved)"
      : sources
          .map((source, i) => `[${i + 1}] ${source.title}\nURL: ${source.url}\n${source.content}`)
          .join("\n\n");

  const { data, usage } = await llm.structured<{ claims: ExtractedClaim[] }>({
    name: "claim_ledger",
    schema: CLAIMS_SCHEMA,
    instructions: EXTRACT_INSTRUCTIONS,
    input:
      `USER QUESTION:\n${question ?? "(not supplied)"}\n\n` +
      `ANSWER:\n${answer}\n\nSOURCES:\n${sourceBlock}`,
  });

  return { claims: sanitise(data.claims ?? [], sources, question), usage };
}

export type RecordResult = {
  inserted: number;
  superseded: number;
  unchanged: number;
  claims: Claim[];
};

/**
 * Reconcile extracted claims with the open ledger.
 *
 * - same subject+attribute+value -> no-op (idempotent, re-observation)
 * - same subject+attribute, new value -> close old row, insert new one
 * - no open row -> insert new one
 *
 * `valid_from` defaults to the observed local date: without a source-published
 * date we cannot claim to know when a fact became true, only when we saw it.
 *
 * Runs as one transaction: a closing row and its replacement are either both
 * there or neither is, so the ledger never holds two current values at once.
 */
export function recordClaims(
  db: Database.Database,
  sessionId: string,
  extracted: ExtractedClaim[],
  now: Date,
  timeZone: string
): RecordResult {
  const observedAt = now.toISOString();
  const localDate = localDateInTz(now, timeZone);

  return db.transaction((): RecordResult => {
    const claims: Claim[] = [];
    let inserted = 0;
    let superseded = 0;
    let unchanged = 0;

    for (const claim of extracted) {
      const existing = openClaim(db, sessionId, claim.subject, claim.attribute);

      if (existing && existing.value === claim.value) {
        unchanged++;
        claims.push(existing);
        continue;
      }

      const saved = saveClaim(db, {
        sessionId,
        subject: claim.subject,
        attribute: claim.attribute,
        value: claim.value,
        url: claim.url,
        quote: claim.quote,
        observedAt,
        localDate,
      });

      if (existing) {
        closeClaim(db, existing.id, localDate, saved.id);
        superseded++;
      }
      inserted++;
      claims.push(saved);
    }

    return { inserted, superseded, unchanged, claims };
  })();
}
