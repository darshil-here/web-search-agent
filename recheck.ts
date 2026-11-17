// recheck.ts
//
// The temporal re-check pipeline. A pure detector (detect.ts) decides when a
// question is a re-check; this module then does the work: pull the recorded
// claims, search each subject in parallel, read fresh values with one
// structured-output call, build a diff for the model to write an answer from,
// and write the results back to the ledger.
import type OpenAI from "openai";
import type Database from "better-sqlite3";
import type { Claim } from "./db.js";
import type { ClaimSource } from "./claims.js";
import { recordClaims } from "./claims.js";
import { claimsForDate, openClaims, saveVerification } from "./db.js";
import { localDateInTz } from "./dates.js";
import type { RecheckIntent } from "./detect.js";
import type { NotebookContext } from "./notebook.js";

export type RecheckLlmCall = {
  step: number;
  ms: number;
  usage: { prompt: number; completion: number; total: number };
  toolCallCount: number;
};

export type FreshStatus = "changed" | "unchanged" | "not_found";

export type FreshValue = {
  claimId: number;
  value: string;
  url: string | null;
  quote: string | null;
  status: FreshStatus;
};

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

const EXTRACT_FRESH_INSTRUCTIONS = `You compare previously recorded claims against fresh search results.

For each claim id, decide whether the current value is:
- "unchanged" if the sources state the same value
- "changed" if the sources state a different value
- "not_found" if the sources do not state a current value

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
        },
        required: ["claimId", "value", "url", "quote", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

export async function extractFreshValues(
  openai: OpenAI,
  model: string,
  claims: Claim[],
  sources: ClaimSource[],
  onUsage?: (usage: {
    prompt: number;
    completion: number;
    total: number;
  }) => void
): Promise<FreshValue[]> {
  const sourceBlock =
    sources.length === 0
      ? "(no sources were retrieved)"
      : sources
          .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`)
          .join("\n\n");
  const claimBlock = claims
    .map(
      (c) =>
        `id ${c.id}: ${c.subject} / ${c.attribute} = ${c.value} (observed ${c.localDate})`
    )
    .join("\n");

  const response = await openai.responses.create({
    model,
    instructions: EXTRACT_FRESH_INSTRUCTIONS,
    input: `CLAIMS:\n${claimBlock}\n\nFRESH SOURCES:\n${sourceBlock}`,
    text: {
      format: {
        type: "json_schema",
        name: "fresh_values",
        schema: FRESH_SCHEMA,
        strict: true,
      },
    },
  });

  if (response.usage && onUsage) {
    onUsage({
      prompt: response.usage.input_tokens,
      completion: response.usage.output_tokens,
      total: response.usage.total_tokens,
    });
  }

  const parsed = JSON.parse(response.output_text) as { results: FreshValue[] };
  const allowed = new Set(sources.map((s) => s.url));
  const byId = new Map<number, FreshValue>();
  for (const result of parsed.results ?? []) {
    if (!claims.some((c) => c.id === result.claimId)) continue;
    if (result.url && !allowed.has(result.url)) result.url = null;
    byId.set(result.claimId, result);
  }

  // Every claim must appear in the diff, even when extraction omitted it.
  return claims.map(
    (c) =>
      byId.get(c.id) ?? {
        claimId: c.id,
        value: "",
        url: null,
        quote: null,
        status: "not_found" as const,
      }
  );
}

export function buildDiff(
  claims: Claim[],
  fresh: FreshValue[]
): { text: string; results: FreshValue[] } {
  const byId = new Map(fresh.map((f) => [f.claimId, f]));
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
    } else {
      lines.push(`  current: ${value.value} (${value.status})`);
      if (value.url) lines.push(`  source: ${value.url}`);
    }
    lines.push("");
  }
  lines.push("</recheck-diff>");
  return { text: lines.join("\n"), results: fresh };
}

export function writeBack(
  db: Database.Database,
  sessionId: string,
  claims: Claim[],
  fresh: FreshValue[],
  now: Date,
  timeZone: string
): { inserted: number; superseded: number; verifications: number } {
  const localDate = localDateInTz(now, timeZone);
  const checkedAt = now.toISOString();
  const byId = new Map(fresh.map((f) => [f.claimId, f]));
  let inserted = 0;
  let superseded = 0;
  let verifications = 0;

  for (const claim of claims) {
    const freshValue = byId.get(claim.id);
    const status: FreshStatus = freshValue?.status ?? "not_found";

    if (status === "changed" && freshValue && freshValue.value) {
      const result = recordClaims(
        db,
        sessionId,
        [
          {
            subject: claim.subject,
            attribute: claim.attribute,
            value: freshValue.value,
            url: freshValue.url,
            quote: freshValue.quote,
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
      newValue: status === "changed" ? freshValue?.value ?? null : null,
      url: status === "changed" ? freshValue?.url ?? null : null,
    });
    verifications++;
  }

  return { inserted, superseded, verifications };
}

export type RecheckReport = {
  answer: string;
  intent: RecheckIntent;
  queries: string[];
  claimsChecked: number;
  failedSearches: number;
  writeBack: { inserted: number; superseded: number; verifications: number };
  usedSearch: boolean;
  fresh: FreshValue[];
  llmCalls: RecheckLlmCall[];
};

export async function recheck(args: {
  ctx: NotebookContext;
  intent: RecheckIntent;
  userText: string;
  now: Date;
  openai: OpenAI;
  model: string;
  instructions: string;
  search: (q: string) => Promise<ClaimSource[]>;
  /** Turn recall from the ordinary path, for compound questions that also ask
   * what was said on the named date. */
  notebookText?: string;
}): Promise<RecheckReport> {
  const { ctx, intent, now, openai, model, instructions, search } = args;
  const dated = claimsForDate(ctx.db, ctx.sessionId, intent.date);
  const claims = dated.length > 0 ? dated : openClaims(ctx.db, ctx.sessionId);
  const queries = buildQueries(claims);

  if (claims.length === 0 || queries.length === 0) {
    return {
      answer: `I have no prior claim recorded for ${intent.date}, so there is nothing to re-check.`,
      intent,
      queries: [],
      claimsChecked: 0,
      failedSearches: 0,
      writeBack: { inserted: 0, superseded: 0, verifications: 0 },
      usedSearch: false,
      fresh: [],
      llmCalls: [],
    };
  }

  // Bound the fan-out: a 20-subject question must not fire 20 searches.
  const configured = Number(process.env.MAX_RECHECK_SEARCHES ?? 8);
  const cap = Number.isInteger(configured) && configured > 0 ? configured : 8;
  const cappedQueries = queries.slice(0, cap);

  const settled = await Promise.all(
    cappedQueries.map(async (q) => {
      try {
        return { ok: true as const, results: await search(q) };
      } catch {
        return { ok: false as const, results: [] as ClaimSource[] };
      }
    })
  );
  const sources: ClaimSource[] = [];
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

  const llmCalls: RecheckLlmCall[] = [];
  let fresh: FreshValue[];
  const extractStart = performance.now();
  try {
    fresh = await extractFreshValues(
      openai, model, claims, sources,
      (usage) => {
        llmCalls.push({
          step: llmCalls.length,
          ms: performance.now() - extractStart,
          usage,
          toolCallCount: 0,
        });
      }
    );
  } catch {
    fresh = claims.map((c) => ({
      claimId: c.id,
      value: "",
      url: null,
      quote: null,
      status: "not_found" as const,
    }));
  }

  const { text: diff } = buildDiff(claims, fresh);

  if (failedSearches === cappedQueries.length) {
    return {
      answer: "I could not complete the re-check: every web search failed.",
      intent,
      queries: cappedQueries,
      claimsChecked: claims.length,
      failedSearches,
      writeBack: { inserted: 0, superseded: 0, verifications: 0 },
      usedSearch: false,
      fresh,
      llmCalls,
    };
  }

  const input: OpenAI.Responses.ResponseInputItem[] = [
    ...(args.notebookText
      ? [{ role: "developer" as const, content: args.notebookText }]
      : []),
    { role: "developer", content: diff },
    { role: "user", content: args.userText },
  ];

  const answerStart = performance.now();
  const response = await openai.responses.create({
    model,
    instructions,
    input,
    tools: [
      {
        type: "function",
        name: "web_search",
        description: "Search the web. Use only if the diff leaves something unverified.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        strict: false,
      },
    ],
  });

  llmCalls.push({
    step: llmCalls.length,
    ms: performance.now() - answerStart,
    usage: {
      prompt: response.usage?.input_tokens ?? 0,
      completion: response.usage?.output_tokens ?? 0,
      total: response.usage?.total_tokens ?? 0,
    },
    toolCallCount: response.output.filter((o) => o.type === "function_call").length,
  });

  // Best-effort, same principle as claims.ts: a ledger failure is traced in
  // the report, never thrown to the user.
  let writeBackResult = { inserted: 0, superseded: 0, verifications: 0 };
  try {
    writeBackResult = writeBack(
      ctx.db, ctx.sessionId, claims, fresh, now, ctx.timeZone
    );
  } catch {
    // The answer stands; the trace records zero write-backs.
  }

  return {
    answer: response.output_text,
    intent,
    queries: cappedQueries,
    claimsChecked: claims.length,
    failedSearches,
    writeBack: writeBackResult,
    usedSearch: response.output.some((o) => o.type === "function_call"),
    fresh,
    llmCalls,
  };
}
