// The temporal re-check pipeline. A pure detector (detect.ts) decides when a
// question is a re-check; this module then does the work: pull the recorded
// claims, search each subject in parallel, read fresh values with one
// structured-output call, build a diff for the model to write an answer from,
// and write the results back to the ledger.
import type Database from "better-sqlite3";
import type { Claim, SessionContext } from "./db.js";
import { claimsForDate, openClaims, saveVerification } from "./db.js";
import { CLAIM_LIMITS, recordClaims } from "./claims.js";
import { attributeTokens, SIBLING_CONCEPTS, sameAttribute } from "./concepts.js";
import { localDateInTz } from "./dates.js";
import type { RecheckIntent } from "./detect.js";
import type { Llm, LlmCall, PromptMessage, StopReason, Usage } from "./llm.js";
import type { SearchResult } from "./search.js";
import { clip } from "./text.js";
import { guardUnverified } from "./unverified.js";
import { isVerbatimQuote } from "./support.js";
import { canonicalUrl } from "./url.js";

// Billing language around a price, not part of what the price is for. Dropped
// before deciding whether a source's number and the value's feature agree.
const VALUE_FRAME = new Set([
  "per", "the", "and", "for", "from", "with", "user", "users", "seat",
  "seats", "month", "months", "monthly", "year", "years", "annual",
  "annually", "billing", "billed", "plan", "plans", "tier", "tiers",
  "price", "pricing", "cost", "costs", "starts", "starting", "about",
  "around", "over", "under", "more", "less", "than", "plus", "included",
]);

export type FreshStatus = "changed" | "unchanged" | "not_found";

/** A sourced product/feature change reported by extraction, if the sources state one. */
export type NotableChange = {
  description: string;
  url: string | null;
  quote: string | null;
  date: string | null;
};

export type FreshValue = {
  claimId: number;
  value: string;
  url: string | null;
  quote: string | null;
  status: FreshStatus;
  /** The concept the source actually describes, reported by extraction and
   * checked against the recorded attribute in code. */
  matchedAttribute?: string | null;
  /** A product or feature change since the observation, not a new price. */
  notableChange?: NotableChange | null;
  /** Set when the guard downgraded a result because the concepts differ. */
  mismatch?: boolean;
  /** Set when the reported value appears in none of the fresh sources. */
  valueNotInSources?: boolean;
};

// The diff tells the model what is unknown; this tells it what that means. A
// second developer message rather than a global prompt rule, so the constraint
// only costs tokens on a re-check. The deterministic guard below is the real
// enforcement — this message exists so the model does not fight it.
const UNVERIFIED_CONSTRAINT = `Hard constraint: a row in <recheck-diff> whose status is not_found
(or whose mismatch note is present) is UNVERIFIED. The recorded value is history,
not a current observation. Never present its recorded value as the current value.
You may mention it only as a past observation with its observed date. If every
row is unverified, say plainly that you could not verify a current value and do
not claim the earlier answer is still correct. For every row whose status is
changed or unchanged, put the source URL beside the value you state. A change
without a URL is not usable evidence.`;

export function buildQueries(claims: Claim[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const claim of claims) {
    if (seen.has(claim.subject)) continue;
    seen.add(claim.subject);
    out.push(`${claim.subject} ${claim.attribute}`.trim());
  }
  return out;
}

/**
 * The second half of a re-check. "Has anything changed?" is not only a price
 * question: brief-1 also asks whether a vendor "shipped something big". One
 * change query per subject gives the extractor a chance to see release notes,
 * not just the pricing page.
 */
export function buildChangeQueries(claims: Claim[], date: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const claim of claims) {
    if (seen.has(claim.subject)) continue;
    seen.add(claim.subject);
    out.push(
      `${claim.subject} changelog OR release notes OR new features since ${date}`
    );
  }
  return out;
}

/**
 * A value is only evidence about the attribute it was recorded against. If a
 * source describes a different concept, "unchanged" would be a false
 * verification — the F-010 failure. Downgrade to not_found in code, so the
 * discipline does not depend on the model remembering the prompt.
 */
export function enforceAttributeMatch(
  claims: Claim[],
  fresh: FreshValue[]
): FreshValue[] {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));

  return fresh.map((value) => {
    const claim = byId.get(value.claimId);
    const matched = value.matchedAttribute;
    if (!claim || !matched || attributeTokens(matched).length === 0) return value;
    if (sameAttribute(claim.attribute, matched)) return value;
    if (value.status === "not_found") return value;

    return { ...value, status: "not_found" as const, mismatch: true };
  });
}

/**
 * A fresh value is evidence only if a retrieved source actually states it.
 * The live brief-3 trace showed extraction echoing the recorded "$19/month"
 * back as "unchanged" while citing an article that never quotes that price —
 * the model verified the claim against itself. Downgrade any such result to
 * not_found in code, the same discipline `enforceAttributeMatch` applies to a
 * concept mismatch and `critic.ts` applies to an invented URL.
 *
 * Comparing the whole descriptive value was too strict: extraction composes
 * "$25 per user per month for Starter Suite" from a source row that says
 * "Starter Suite | $25 user/month", and the live brief-1 run downgraded every
 * correct value to not_found because the words were in a different order. The
 * check is now about the measure and its identity: the number must appear as a
 * standalone value, and either the verbatim quote names it or one of the
 * value's own identity words appears beside it.
 */
export function enforceValueInSources(
  sources: SearchResult[],
  fresh: FreshValue[]
): FreshValue[] {
  const normalise = (text: string): string =>
    text.toLowerCase().replace(/\s+/g, "");
  const corpus = normalise(
    sources.map((source) => `${source.title} ${source.content}`).join("\n")
  );
  const byUrl = new Map(
    sources.map((source) => [
      canonicalUrl(source.url),
      `${source.title} ${source.content}`,
    ])
  );

  /** The words that identify what a value measures, not its billing frame. */
  const identity = (value: string): string[] =>
    (value.toLowerCase().match(/[a-z][a-z0-9-]+/g) ?? []).filter(
      (word) => word.length >= 3 && !VALUE_FRAME.has(word)
    );

  /** A number must not match inside a larger one: $1 is not $19. */
  const standalone = (hay: string, number: string): boolean => {
    let at = hay.indexOf(number);
    while (at !== -1) {
      const before = hay[at - 1] ?? "";
      const after = hay[at + number.length] ?? "";
      if (!/\d/.test(before) && !/\d/.test(after)) return true;
      at = hay.indexOf(number, at + 1);
    }
    return false;
  };

  return fresh.map((value) => {
    if (value.status === "not_found") return value;
    const stated = normalise(value.value ?? "");
    if (stated === "") return { ...value, status: "not_found" as const, valueNotInSources: true };

    // A named value ("Neon") has no measure to anchor; it must appear whole.
    const measure = value.value?.match(/\$?\d[\d.,]*/)?.[0] ?? "";
    if (measure === "" || !standalone(corpus, normalise(measure))) {
      if (measure !== "") {
        return { ...value, status: "not_found" as const, valueNotInSources: true };
      }
      return corpus.includes(stated)
        ? value
        : { ...value, status: "not_found" as const, valueNotInSources: true };
    }

    // A quote that is verbatim in the cited page and names the measure is the
    // strongest evidence: it ties the number to a sentence the source states.
    if (value.quote && value.url) {
      const cited = byUrl.get(canonicalUrl(value.url));
      if (
        cited !== undefined &&
        isVerbatimQuote(value.quote, cited) &&
        normalise(value.quote).includes(normalise(measure))
      ) {
        return value;
      }
    }

    // Otherwise the number needs an identity word near it in the corpus.
    const words = identity(value.value ?? "");
    if (words.length === 0) return value;
    let at = corpus.indexOf(normalise(measure));
    while (at !== -1) {
      const window = corpus.slice(Math.max(0, at - 140), at + 160);
      if (words.some((word) => window.includes(word))) return value;
      at = corpus.indexOf(normalise(measure), at + 1);
    }
    return { ...value, status: "not_found" as const, valueNotInSources: true };
  });
}

const EXTRACT_FRESH_INSTRUCTIONS = `You compare previously recorded claims against fresh search results.

For each claim id, decide whether the current value is:
- "unchanged" if the sources state the same value for the SAME attribute
- "changed" if the sources state a different value for the SAME attribute
- "not_found" if the sources do not state that attribute's current value

Also set matchedAttribute to the exact concept the sources actually describe.
Sibling concepts are different attributes even when they read alike:
${SIBLING_CONCEPTS}. If the sources describe a different attribute than the
recorded one, set status to not_found and report what they did describe in
matchedAttribute.

Also set notableChange for the subject when the sources state a product, feature,
packaging or pricing-structure change that happened after the observed date.
Use only the sources. Give an exact URL and a short verbatim quote; set date to
the date the source states, or null. If the sources show no such change, set
notableChange to null. A different price is already reported in status/value;
do not repeat it as a notable change unless the source describes it as a change.

Return one result per claim id given. Use only values stated in the sources.
Use an exact source URL from the sources, or null. Never invent a URL.`;

const FRESH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claimId: { type: "integer" },
          value: { type: "string" },
          url: { anyOf: [{ type: "string" }, { type: "null" }] },
          quote: { anyOf: [{ type: "string" }, { type: "null" }] },
          status: { type: "string", enum: ["changed", "unchanged", "not_found"] },
          matchedAttribute: { anyOf: [{ type: "string" }, { type: "null" }] },
          notableChange: {
            anyOf: [
              {
                type: "object",
                properties: {
                  description: { type: "string" },
                  url: { anyOf: [{ type: "string" }, { type: "null" }] },
                  quote: { anyOf: [{ type: "string" }, { type: "null" }] },
                  date: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
                required: ["description", "url", "quote", "date"],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
        },
        required: [
          "claimId",
          "value",
          "url",
          "quote",
          "status",
          "matchedAttribute",
          "notableChange",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

function notFound(claim: Claim): FreshValue {
  return {
    claimId: claim.id,
    value: "",
    url: null,
    quote: null,
    status: "not_found",
  };
}

export async function extractFreshValues(
  llm: Llm,
  claims: Claim[],
  sources: SearchResult[]
): Promise<{ fresh: FreshValue[]; usage: Usage }> {
  const sourceBlock =
    sources.length === 0
      ? "(no sources were retrieved)"
      : sources
          .map(
            (source, i) =>
              `[${i + 1}] ${source.title}\nURL: ${source.url}\n${source.content}`
          )
          .join("\n\n");
  const claimBlock = claims
    .map(
      (claim) =>
        `id ${claim.id}: ${claim.subject} / ${claim.attribute} = ${claim.value} (observed ${claim.localDate})`
    )
    .join("\n\n");

  const { data, usage } = await llm.structured<{ results: FreshValue[] }>({
    name: "fresh_values",
    schema: FRESH_SCHEMA,
    instructions: EXTRACT_FRESH_INSTRUCTIONS,
    input: `CLAIMS:\n${claimBlock}\n\nFRESH SOURCES:\n${sourceBlock}`,
  });

  const allowed = new Map(
    sources.map((source) => [canonicalUrl(source.url), source.url])
  );
  const recordedIds = new Set(claims.map((claim) => claim.id));
  const byId = new Map<number, FreshValue>();

  for (const result of data.results ?? []) {
    if (!recordedIds.has(result.claimId)) continue;
    // A change is only evidence if it carries a source we actually retrieved;
    // the same URL rule that applies to a fresh value applies here.
    const change = result.notableChange
      ? {
          description: clip(result.notableChange.description ?? "", CLAIM_LIMITS.value),
          url: result.notableChange.url
            ? allowed.get(canonicalUrl(result.notableChange.url)) ?? null
            : null,
          quote: result.notableChange.quote
            ? clip(result.notableChange.quote, CLAIM_LIMITS.quote)
            : null,
          date: result.notableChange.date
            ? clip(result.notableChange.date, 40)
            : null,
        }
      : null;

    byId.set(result.claimId, {
      ...result,
      value: clip(result.value ?? "", CLAIM_LIMITS.value),
      quote: result.quote ? clip(result.quote, CLAIM_LIMITS.quote) : null,
      url: result.url ? allowed.get(canonicalUrl(result.url)) ?? null : null,
      ...(change && change.description ? { notableChange: change } : {}),
    });
  }

  // Every claim must appear in the diff, even when extraction omitted it.
  const complete = claims.map((claim) => byId.get(claim.id) ?? notFound(claim));
  const matched = enforceAttributeMatch(claims, complete);
  return { fresh: enforceValueInSources(sources, matched), usage };
}

export function buildDiff(claims: Claim[], fresh: FreshValue[]): string {
  const byId = new Map(fresh.map((value) => [value.claimId, value]));
  const lines = [
    "<recheck-diff>",
    "Compare each recorded claim with the fresh value below. Report every row,",
    "including unchanged and not_found. Cite the URL shown. Never guess a value.",
    "",
  ];
  for (const claim of claims) {
    const value = byId.get(claim.id);
    lines.push(`- ${claim.subject} / ${claim.attribute}`);
    lines.push(`  recorded: ${claim.value} (observed ${claim.localDate})`);
    if (!value || value.status === "not_found") {
      lines.push(`  current: not found in fresh sources — status: not_found`);
      if (value?.valueNotInSources) {
        lines.push(
          "  mismatch: the reported value does not appear in any fresh source — " +
            "do not treat this as a re-check"
        );
      }
      if (value?.mismatch && value.matchedAttribute) {
        lines.push(
          `  mismatch: source describes "${value.matchedAttribute}", ` +
            `not "${claim.attribute}" — do not treat this as a re-check`
        );
      }
    } else {
      lines.push(`  current: ${value.value} (${value.status})`);
      if (value.url) lines.push(`  source: ${value.url}`);
    }
    if (value?.notableChange?.description) {
      const change = value.notableChange;
      lines.push(
        `  notable change: ${change.description}` +
          `${change.date ? ` (${change.date})` : ""}` +
          `${change.url ? ` — ${change.url}` : ""}`
      );
    }
    lines.push("");
  }
  lines.push("</recheck-diff>");
  return lines.join("\n");
}

/**
 * The deterministic answer of last resort. The model writes the prose when it
 * can; this renders the same diff when it returns nothing or runs out of steps.
 * It never presents a not_found value as current, so the F-011 contract holds
 * even when the model is unavailable.
 */
type DiffParts = { lines: string[]; changes: string[] };

function diffParts(claims: Claim[], fresh: FreshValue[]): DiffParts {
  const byId = new Map(fresh.map((value) => [value.claimId, value]));
  const lines: string[] = [];
  const changes: string[] = [];
  const seenChanges = new Set<string>();

  for (const claim of claims) {
    const value = byId.get(claim.id);
    const label = `${claim.subject} / ${claim.attribute}`;

    if (!value || value.status === "not_found") {
      const why = value?.valueNotInSources
        ? "the reported value did not appear in any fresh source"
        : value?.mismatch
          ? `fresh sources described ${value.matchedAttribute ?? "a different attribute"}`
          : "no fresh source stated it";
      lines.push(
        `- ${label}: could not verify a current value (${why}). ` +
          `The recorded value was ${claim.value} (observed ${claim.localDate}).`
      );
    } else if (value.status === "unchanged") {
      lines.push(
        `- ${label}: unchanged at ${value.value}` +
          `${value.url ? ` (${value.url})` : " (source URL not reported)"}.`
      );
    } else {
      lines.push(
        `- ${label}: changed to ${value.value}` +
          `${value.url ? ` (${value.url})` : " (source URL not reported)"}; ` +
          `previously ${claim.value} (observed ${claim.localDate}).`
      );
    }

    const change = value?.notableChange;
    if (change?.description) {
      const key = `${claim.subject}|${change.description}`.toLowerCase();
      if (!seenChanges.has(key)) {
        seenChanges.add(key);
        changes.push(
          `- ${claim.subject}: ${change.description}` +
            `${change.date ? ` (${change.date})` : ""}` +
            `${change.url ? ` — ${change.url}` : ""}`
        );
      }
    }
  }

  return { lines, changes };
}

export function renderDiffAnswer(
  claims: Claim[],
  fresh: FreshValue[],
  date: string
): string {
  const { lines, changes } = diffParts(claims, fresh);
  const out = [
    `I re-checked the claims recorded for ${date} against fresh sources.`,
    ...lines,
  ];
  if (changes.length > 0) {
    out.push("", "Notable changes in fresh sources:", "", ...changes);
  }
  return out.join("\n");
}

/**
 * Does the answer already give this subject its own verdict? Naming a vendor
 * in a collective sentence ("none of the five changed") is not a per-vendor
 * result: the sentence must name the subject *and* carry a status or the value
 * checked. That distinction is what brief-1 caught.
 */
export function coversSubject(
  answer: string,
  subject: string,
  value: FreshValue | undefined,
  subjects: string[] = [subject]
): boolean {
  const name = subject.toLowerCase();
  const clauses = answer
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((clause) => clause.replace(/^\s*[-*]\s*/, ""));
  return clauses.some((clause) => {
    const lower = clause.toLowerCase();
    if (!lower.includes(name)) return false;
    // A clause that names more than one checked subject carries a joint
    // verdict, not a result for this one: "Alpha and Beta are both unchanged"
    // still needs the per-vendor lines.
    const named = subjects.filter((s) => lower.includes(s.toLowerCase()));
    if (named.length > 1) return false;
    if (
      /\b(?:unchanged|changed|could not verify|couldn't verify|not found|no fresh|still)\b/i.test(
        clause
      )
    ) {
      // A change is a factual claim about the world, so it needs its source
      // beside it. If the model says "changed to $9" without a link, the diff
      // line is appended instead, which carries the URL.
      if (/\bchanged\b/i.test(clause) && !/https?:\/\//.test(clause)) {
        return false;
      }
      return true;
    }
    return value?.value ? clause.includes(value.value) : false;
  });
}

/**
 * Per-subject lines from the same diff, limited to subjects the model answer
 * did not already report. The rubric asks for a result per vendor; a model that
 * answers collectively must not hide a vendor the code already checked.
 */
export function renderMissingSubjects(
  claims: Claim[],
  fresh: FreshValue[],
  subjects: string[]
): string[] {
  const wanted = new Set(subjects.map((subject) => subject.toLowerCase()));
  return diffParts(claims, fresh).lines.filter((line) => {
    const match = line.match(/^- (.*?) \/ /);
    return match ? wanted.has(match[1].toLowerCase()) : false;
  });
}

export type WriteBackResult = {
  inserted: number;
  superseded: number;
  verifications: number;
};

/**
 * Apply fresh values to the ledger and log every check. One transaction: a
 * superseded claim, its replacement and the verification row move together, so
 * a crash cannot leave the ledger half-updated.
 */
export function writeBack(
  db: Database.Database,
  sessionId: string,
  claims: Claim[],
  fresh: FreshValue[],
  now: Date,
  timeZone: string
): WriteBackResult {
  const localDate = localDateInTz(now, timeZone);
  const checkedAt = now.toISOString();
  const byId = new Map(fresh.map((value) => [value.claimId, value]));

  return db.transaction((): WriteBackResult => {
    let inserted = 0;
    let superseded = 0;
    let verifications = 0;

    for (const claim of claims) {
      const value = byId.get(claim.id);
      const status: FreshStatus = value?.status ?? "not_found";

      if (status === "changed" && value && value.value) {
        const result = recordClaims(
          db,
          sessionId,
          [
            {
              subject: claim.subject,
              attribute: claim.attribute,
              value: value.value,
              url: value.url,
              quote: value.quote,
            },
          ],
          now,
          timeZone
        );
        inserted += result.inserted;
        superseded += result.superseded;
      }

      saveVerification(db, {
        sessionId,
        claimId: claim.id,
        checkedAt,
        localDate,
        result: status,
        newValue: status === "changed" ? value?.value ?? null : null,
        url: status === "changed" ? value?.url ?? null : null,
      });
      verifications++;
    }

    return { inserted, superseded, verifications };
  })();
}

export type AnswerKind = "model" | "fallback";

export type RecheckReport = {
  answer: string;
  /** "model" when the answer call wrote it; "fallback" when code rendered the diff. */
  answerKind: AnswerKind;
  stopReason: StopReason;
  intent: RecheckIntent;
  queries: string[];
  claimsChecked: number;
  failedSearches: number;
  writeBack: WriteBackResult;
  usedSearch: boolean;
  fresh: FreshValue[];
  /** The sources the re-check actually searched, for the trace and the judge. */
  sources: SearchResult[];
  /** Sentences that presented an unverified value as current, rewritten in code. */
  guard: { rewritten: string[] };
  /** Every model call the re-check made, for the trace. */
  llmCalls: LlmCall[];
  /** Things that went wrong but did not stop the answer. */
  errors: { extraction?: string; writeBack?: string; answer?: string };
};

function newReport(
  intent: RecheckIntent,
  overrides: Partial<RecheckReport> = {}
): RecheckReport {
  return {
    answer: "",
    answerKind: "fallback",
    stopReason: "answered",
    intent,
    queries: [],
    claimsChecked: 0,
    failedSearches: 0,
    writeBack: { inserted: 0, superseded: 0, verifications: 0 },
    usedSearch: false,
    fresh: [],
    sources: [],
    guard: { rewritten: [] },
    llmCalls: [],
    errors: {},
    ...overrides,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function recheck(args: {
  ctx: SessionContext;
  intent: RecheckIntent;
  userText: string;
  now: Date;
  llm: Llm;
  instructions: string;
  search: (query: string) => Promise<SearchResult[]>;
  maxSearches: number;
  /** Turn recall from the ordinary path, for compound questions that also ask
   * what was said on the named date. */
  notebookText?: string;
  /** Called once with what is about to be searched. Progress reporting only. */
  onPlan?: (plan: { subjects: string[]; queries: string[] }) => void;
}): Promise<RecheckReport> {
  const { ctx, intent, now, llm, instructions, search, maxSearches } = args;

  const dated = claimsForDate(ctx.db, ctx.sessionId, intent.date);
  const claims = dated.length > 0 ? dated : openClaims(ctx.db, ctx.sessionId);
  const attributeQueries = buildQueries(claims);
  const changeQueries = buildChangeQueries(claims, intent.date);

  if (claims.length === 0 || attributeQueries.length === 0) {
    return newReport(intent, {
      answer: `I have no prior claim recorded for ${intent.date}, so there is nothing to re-check.`,
    });
  }

  // Bound the fan-out: a 20-subject question must not fire 40 searches. Price
  // queries come first so freshness is never starved of the recorded attribute.
  const queries = [...attributeQueries, ...changeQueries].slice(0, maxSearches);
  args.onPlan?.({
    subjects: [...new Set(claims.map((claim) => claim.subject))],
    queries,
  });

  const settled = await Promise.all(
    queries.map(async (query, index) => {
      // Keep the extraction prompt bounded: three hits per recorded claim, two
      // per change query. A change hit is a lead, not a fact to grade.
      const limit = index < attributeQueries.length ? 3 : 2;
      try {
        return {
          ok: true as const,
          results: (await search(query)).slice(0, limit),
        };
      } catch {
        return { ok: false as const, results: [] as SearchResult[] };
      }
    })
  );

  const sources: SearchResult[] = [];
  const seen = new Set<string>();
  let failedSearches = 0;
  for (const outcome of settled) {
    if (!outcome.ok) {
      failedSearches++;
      continue;
    }
    for (const result of outcome.results) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      sources.push(result);
    }
  }

  const llmCalls: LlmCall[] = [];
  const errors: RecheckReport["errors"] = {};
  const extractStart = performance.now();
  let fresh: FreshValue[];

  try {
    const extracted = await extractFreshValues(llm, claims, sources);
    fresh = extracted.fresh;
    llmCalls.push({
      label: "extract",
      step: null,
      ms: performance.now() - extractStart,
      usage: extracted.usage,
    });
  } catch (err) {
    errors.extraction = message(err);
    fresh = claims.map(notFound);
  }

  const diff = buildDiff(claims, fresh);

  if (failedSearches === queries.length) {
    return newReport(intent, {
      answer: "I could not complete the re-check: every web search failed.",
      queries,
      claimsChecked: claims.length,
      failedSearches,
      fresh,
      llmCalls,
      errors,
    });
  }

  const input: PromptMessage[] = [
    ...(args.notebookText
      ? [{ role: "developer" as const, content: args.notebookText }]
      : []),
    { role: "developer", content: diff },
    { role: "developer", content: UNVERIFIED_CONSTRAINT },
    { role: "user", content: args.userText },
  ];

  let usedSearch = false;
  const turn = await llm.turn({
    instructions,
    input,
    search,
    toolDescription: "Search the web. Not used on a re-check.",
    // The per-subject searches already ran. Letting the answer call search
    // again let the model spend its whole budget searching instead of writing
    // (the brief-1 live failure), so the answer is written from the diff only.
    maxSteps: 1,
    useTools: false,
    onEvent: (event) => {
      if (event.type === "llm") llmCalls.push(event.call);
      if (event.type === "tool") usedSearch = true;
    },
  });

  // Best-effort, same principle as claims.ts: a ledger failure is reported in
  // the trace, never thrown to the user.
  let writeBackResult: WriteBackResult = {
    inserted: 0,
    superseded: 0,
    verifications: 0,
  };
  try {
    writeBackResult = writeBack(
      ctx.db,
      ctx.sessionId,
      claims,
      fresh,
      now,
      ctx.timeZone
    );
  } catch (err) {
    errors.writeBack = message(err);
  }

  // Every claim the fresh search could not confirm is unverified: its recorded
  // value is history, not a current observation. Apply the guard below to the
  // answer so a model that ignores the diff cannot turn history into a price.
  const unverified = claims
    .filter((claim) => {
      const value = fresh.find((item) => item.claimId === claim.id);
      return !value || value.status === "not_found" || value.mismatch === true;
    })
    .map((claim) => ({
      subject: claim.subject,
      attribute: claim.attribute,
      value: claim.value,
      localDate: claim.localDate,
    }));

  // A model can say "answered" with empty text, or can exhaust its one step
  // without writing. Either way the diff is already computed: render it in code
  // rather than handing the user a blank reply or a "try again" (F-009/F-013).
  const empty = turn.text.trim() === "";
  const failed = turn.stopReason === "budget" || empty;
  if (failed) {
    errors.answer =
      "the answer model returned no text; the re-check diff was rendered in code";
  }
  const guarded = failed
    ? { answer: renderDiffAnswer(claims, fresh, intent.date), rewritten: [] as string[] }
    : guardUnverified(turn.text, unverified);

  // The answer must account for every subject the code checked. A model that
  // summarises collectively ("none of the five changed") used to hide the
  // per-vendor results the diff already had; append only the missing ones.
  // A single-subject re-check ("Still $10.") is already complete, so this
  // coverage rule only applies when more than one subject was checked.
  let answer = guarded.answer;
  if (!failed) {
    const subjects = [...new Set(claims.map((claim) => claim.subject))];
    const byId = new Map(fresh.map((value) => [value.claimId, value]));
    const statusOf = (subject: string) => {
      const claim = claims.find((item) => item.subject === subject);
      return claim ? byId.get(claim.id) : undefined;
    };
    const uncovered = subjects.filter(
      (subject) => !coversSubject(answer, subject, statusOf(subject), subjects)
    );
    // A single-subject answer is complete once it states the result, so it is
    // not padded. An asserted change is the exception: it always needs the URL
    // the diff already has.
    const missing =
      subjects.length > 1
        ? uncovered
        : uncovered.filter((subject) => statusOf(subject)?.status === "changed");
    if (missing.length > 0) {
      const lines = renderMissingSubjects(claims, fresh, missing);
      if (lines.length > 0) {
        answer +=
          subjects.length > 1
            ? `\n\nPer-vendor results from the diff:\n${lines.join("\n")}`
            : `\n\n${lines.join("\n")}`;
      }
    }
  }

  return newReport(intent, {
    answer,
    answerKind: failed ? "fallback" : "model",
    stopReason: "answered",
    queries,
    claimsChecked: claims.length,
    failedSearches,
    writeBack: writeBackResult,
    usedSearch,
    fresh,
    // Bounded in the trace, same as a tool result: evidence, not a payload.
    sources: sources.map((source) => ({
      ...source,
      content: source.content.slice(0, 2000),
    })),
    guard: { rewritten: guarded.rewritten },
    llmCalls,
    errors,
  });
}
