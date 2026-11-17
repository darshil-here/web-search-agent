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

export type FreshStatus = "changed" | "unchanged" | "not_found";

export type FreshValue = {
  claimId: number;
  value: string;
  url: string | null;
  quote: string | null;
  status: FreshStatus;
  /** The concept the source actually describes, reported by extraction and
   * checked against the recorded attribute in code. */
  matchedAttribute?: string | null;
  /** Set when the guard downgraded a result because the concepts differ. */
  mismatch?: boolean;
};

/** How many model calls the answer may take: the answer, plus one search retry. */
const ANSWER_STEPS = 2;

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
        },
        required: ["claimId", "value", "url", "quote", "status", "matchedAttribute"],
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

  const allowed = new Set(sources.map((source) => source.url));
  const recordedIds = new Set(claims.map((claim) => claim.id));
  const byId = new Map<number, FreshValue>();

  for (const result of data.results ?? []) {
    if (!recordedIds.has(result.claimId)) continue;
    byId.set(result.claimId, {
      ...result,
      value: clip(result.value ?? "", CLAIM_LIMITS.value),
      quote: result.quote ? clip(result.quote, CLAIM_LIMITS.quote) : null,
      url: result.url && allowed.has(result.url) ? result.url : null,
    });
  }

  // Every claim must appear in the diff, even when extraction omitted it.
  const complete = claims.map((claim) => byId.get(claim.id) ?? notFound(claim));
  return { fresh: enforceAttributeMatch(claims, complete), usage };
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
    lines.push("");
  }
  lines.push("</recheck-diff>");
  return lines.join("\n");
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

export type RecheckReport = {
  answer: string;
  stopReason: StopReason;
  intent: RecheckIntent;
  queries: string[];
  claimsChecked: number;
  failedSearches: number;
  writeBack: WriteBackResult;
  usedSearch: boolean;
  fresh: FreshValue[];
  /** Every model call the re-check made, for the trace. */
  llmCalls: LlmCall[];
  /** Things that went wrong but did not stop the answer. */
  errors: { extraction?: string; writeBack?: string };
};

function newReport(
  intent: RecheckIntent,
  overrides: Partial<RecheckReport> = {}
): RecheckReport {
  return {
    answer: "",
    stopReason: "answered",
    intent,
    queries: [],
    claimsChecked: 0,
    failedSearches: 0,
    writeBack: { inserted: 0, superseded: 0, verifications: 0 },
    usedSearch: false,
    fresh: [],
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
}): Promise<RecheckReport> {
  const { ctx, intent, now, llm, instructions, search, maxSearches } = args;

  const dated = claimsForDate(ctx.db, ctx.sessionId, intent.date);
  const claims = dated.length > 0 ? dated : openClaims(ctx.db, ctx.sessionId);
  const queries = buildQueries(claims);

  if (claims.length === 0 || queries.length === 0) {
    return newReport(intent, {
      answer: `I have no prior claim recorded for ${intent.date}, so there is nothing to re-check.`,
    });
  }

  // Bound the fan-out: a 20-subject question must not fire 20 searches.
  const cappedQueries = queries.slice(0, maxSearches);

  const settled = await Promise.all(
    cappedQueries.map(async (query) => {
      try {
        return { ok: true as const, results: await search(query) };
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

  if (failedSearches === cappedQueries.length) {
    return newReport(intent, {
      answer: "I could not complete the re-check: every web search failed.",
      queries: cappedQueries,
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
    { role: "user", content: args.userText },
  ];

  let usedSearch = false;
  const turn = await llm.turn({
    instructions,
    input,
    search,
    toolDescription:
      "Search the web. Use only if the diff leaves something unverified.",
    maxSteps: ANSWER_STEPS,
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

  // A model can say "answered" with empty text. Treat that as the failure it
  // is rather than handing the user a blank reply (the F-009 lesson).
  const empty = turn.text.trim() === "";
  return newReport(intent, {
    answer:
      turn.stopReason === "budget" || empty
        ? `I stopped while writing the re-check for ${intent.date} without an answer. ` +
          `Try asking again, or ask about one claim at a time.`
        : turn.text,
    stopReason: turn.stopReason === "budget" || empty ? "budget" : turn.stopReason,
    queries: cappedQueries,
    claimsChecked: claims.length,
    failedSearches,
    writeBack: writeBackResult,
    usedSearch,
    fresh,
    llmCalls,
    errors,
  });
}
