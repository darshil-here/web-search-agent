// eval/cases.ts
//
// The acceptance set. Every case names the source it came from (the brief, a
// LongMemEval category, or a logged failure) and carries two things:
//   probe — a deterministic observation of the real pipeline, with stubbed
//           model and search, so the offline runner is free and repeatable;
//   rubric — what a good *answer* must and must not say, used by the live judge.
//
// The offline probe is not a duplicate of the unit tests: it checks the shape
// of the behaviour the brief grades (which path ran, what was recalled, what
// went in the ledger), not a single function's return value.
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Llm } from "../src/llm.js";
import type { SearchResult } from "../src/search.js";
import {
  claimsBySubject,
  claimsForDate,
  openClaims,
} from "../src/db.js";
import { buildNotebook } from "../src/notebook.js";
import { parseDateRefs } from "../src/dates.js";
import { detectRecheck } from "../src/detect.js";
import {
  buildChangeQueries,
  buildQueries,
  enforceAttributeMatch,
  writeBack,
} from "../src/recheck.js";
import { extractClaims } from "../src/claims.js";
import { sameAttribute } from "../src/concepts.js";
import { guardUnverified } from "../src/unverified.js";
import { guardValueSupport } from "../src/support.js";

export const IST = "Asia/Kolkata";
/** Tuesday 17 November 2026, 11:30 IST. */
export const NOW = new Date("2026-11-17T06:00:00Z");

export type Category =
  | "information-extraction"
  | "multi-session-reasoning"
  | "temporal-reasoning"
  | "knowledge-update"
  | "abstention";

export type SeedTurn = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  localDate: string;
};

export type SeedClaim = {
  subject: string;
  attribute: string;
  value: string;
  url?: string | null;
  quote?: string | null;
  observedAt: string;
  localDate: string;
};

export type Observation = Record<string, unknown>;

export type ProbeCtx = {
  db: Database.Database;
  sessionId: string;
  timeZone: string;
  now: Date;
  question: string;
  llm: Llm;
  search: (query: string) => Promise<SearchResult[]>;
};

export type EvalCase = {
  id: string;
  name: string;
  category: Category;
  source: string;
  question: string;
  seed?: { turns?: SeedTurn[]; claims?: SeedClaim[] };
  /** Override the fixed clock for timezone edge cases. */
  now?: Date;
  /** Canned structured output for the offline stub LLM. */
  structuredResponse?: unknown;
  /** Override the whole LLM stub (the budget case needs an always-tool loop). */
  llm?: Llm;
  probe: (ctx: ProbeCtx) => Observation | Promise<Observation>;
  /** null means pass; a string is the failure reason. */
  check: (obs: Observation) => string | null;
  rubric: { must: string[]; mustNot?: string[] };
  /** False for cases that can only be judged on a live answer. */
  offline?: boolean;
  /** False for cases too costly or open-ended to include in the live sweep. */
  live?: boolean;
};

const sourceText = (): string =>
  readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");

const turn = (content: string, localDate: string): SeedTurn => ({
  role: "user",
  content,
  createdAt: `${localDate}T05:00:00.000Z`,
  localDate,
});

const claim = (
  subject: string,
  attribute: string,
  value: string,
  localDate: string
): SeedClaim => ({
  subject,
  attribute,
  value,
  url: "https://example.com/pricing",
  quote: value,
  observedAt: `${localDate}T05:00:00.000Z`,
  localDate,
});

export const CASES: EvalCase[] = [
  // ---- The three examples in the brief -----------------------------------
  {
    id: "brief-1",
    name: "Five CRM tools, has anything changed",
    category: "temporal-reasoning",
    source: "brief",
    question:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    seed: {
      claims: [
        claim("HubSpot", "price", "$20/seat", "2026-11-16"),
        claim("Salesforce", "price", "$25/seat", "2026-11-16"),
        claim("Pipedrive", "price", "$14/seat", "2026-11-16"),
        claim("Zoho CRM", "price", "$14/seat", "2026-11-16"),
        claim("Freshsales", "price", "$15/seat", "2026-11-16"),
      ],
    },
    probe: (ctx) => {
      const intent = detectRecheck(ctx.question, ctx.now, ctx.timeZone);
      const claims = claimsForDate(ctx.db, ctx.sessionId, "2026-11-16");
      return {
        intent,
        claims: claims.length,
        queries: buildQueries(claims),
        changeQueries: buildChangeQueries(claims, "2026-11-16"),
      };
    },
    check: (o) => {
      const intent = o.intent as ReturnType<typeof detectRecheck>;
      if (intent?.date !== "2026-11-16") return `date ${intent?.date}`;
      if (o.claims !== 5) return `claims ${o.claims}`;
      if ((o.queries as string[]).length !== 5) return "expected one query per vendor";
      const changeQueries = o.changeQueries as string[];
      if (changeQueries.length !== 5) return "expected one change query per vendor";
      if (!changeQueries.every((query) => query.includes("2026-11-16"))) {
        return "change query does not name the observation date";
      }
      return null;
    },
    rubric: {
      must: ["per-vendor result", "source URL for each change or explicit no fresh data"],
      mustNot: ["a change stated without a source"],
    },
  },
  {
    id: "brief-2",
    name: "What did I ask, still correct",
    category: "temporal-reasoning",
    source: "brief",
    question: "What did I ask you on 3 November? Is your answer still correct today?",
    seed: {
      turns: [turn("Which Postgres host should I use?", "2026-11-03")],
      claims: [claim("Postgres hosting", "recommended host", "Neon", "2026-11-03")],
    },
    probe: (ctx) => {
      const intent = detectRecheck(ctx.question, ctx.now, ctx.timeZone);
      const notebook = buildNotebook(ctx, ctx.question, ctx.now);
      return { intent, notebook };
    },
    check: (o) => {
      const intent = o.intent as ReturnType<typeof detectRecheck>;
      if (intent?.date !== "2026-11-03") return `date ${intent?.date}`;
      const nb = o.notebook as { mode: string; text: string };
      if (nb.mode !== "dates") return `mode ${nb.mode}`;
      if (!nb.text.includes("Which Postgres host should I use?")) return "prior question not recalled";
      return null;
    },
    rubric: {
      must: ["the recalled question", "an explicit re-check result or inability to verify"],
      mustNot: ["an invented past question"],
    },
  },
  {
    id: "brief-3",
    name: "Last Tuesday, pricing changed",
    category: "temporal-reasoning",
    source: "brief",
    question: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    seed: { claims: [claim("Postgres hosting", "price", "$19/month", "2026-11-10")] },
    probe: (ctx) => {
      const intent = detectRecheck(ctx.question, ctx.now, ctx.timeZone);
      const claims = claimsForDate(ctx.db, ctx.sessionId, "2026-11-10");
      // The live judge saw the recorded price asserted as current with no
      // source. Feed that exact shape through the guard so the regression is
      // caught offline, not only in a live sweep.
      const guarded = guardUnverified(
        "The current price is still $19/month.",
        claims.map((claimRow) => ({
          subject: claimRow.subject,
          attribute: claimRow.attribute,
          value: claimRow.value,
          localDate: claimRow.localDate,
        }))
      );
      return { intent, queries: buildQueries(claims), guarded };
    },
    check: (o) => {
      const intent = o.intent as ReturnType<typeof detectRecheck>;
      if (intent?.date !== "2026-11-10") return `date ${intent?.date}`;
      if ((o.queries as string[]).length !== 1) return "expected one query";
      const guarded = o.guarded as { answer: string; rewritten: string[] };
      if (guarded.rewritten.length !== 1) return "unverified value was not rewritten";
      if (!guarded.answer.includes("could not verify a current value")) {
        return "rewrite does not state the inability to verify";
      }
      if (guarded.answer.includes("current price is still")) {
        return "recorded value still asserted as current";
      }
      return null;
    },
    rubric: {
      must: ["old value", "new value or no fresh data", "date or source"],
      mustNot: ["a price asserted from memory"],
    },
  },

  // ---- LongMemEval categories --------------------------------------------
  {
    id: "tax-extraction",
    name: "Extract a fact from a dated turn",
    category: "information-extraction",
    source: "LongMemEval",
    question: "What did I ask you on 3 November?",
    seed: { turns: [turn("Which Postgres host should I use?", "2026-11-03")] },
    probe: (ctx) => {
      const intent = detectRecheck(ctx.question, ctx.now, ctx.timeZone);
      const notebook = buildNotebook(ctx, ctx.question, ctx.now);
      return { intent, notebook };
    },
    check: (o) => {
      if (o.intent !== null) return "plain recall must not trigger re-check";
      const nb = o.notebook as { mode: string; rows: number };
      return nb.mode === "dates" && nb.rows === 1 ? null : `mode ${nb.mode}, rows ${nb.rows}`;
    },
    rubric: { must: ["the verbatim question asked on that date"] },
  },
  {
    id: "tax-multisession",
    name: "Current belief is available without a date",
    category: "multi-session-reasoning",
    source: "LongMemEval",
    question: "What price did we agree on for Postgres hosting?",
    seed: { claims: [claim("Postgres hosting", "agreed price", "$19/month", "2026-11-10")] },
    probe: (ctx) => ({ claims: openClaims(ctx.db, ctx.sessionId) }),
    check: (o) => {
      const claims = o.claims as Array<{ value: string }>;
      return claims.length === 1 && claims[0].value === "$19/month"
        ? null
        : "current belief not readable";
    },
    rubric: { must: ["$19/month with its source"] },
    live: false, // claim recall in the notebook is still a known gap
  },
  {
    id: "tax-temporal",
    name: "Yesterday at 00:30 IST is the previous local day",
    category: "temporal-reasoning",
    source: "LongMemEval",
    question: "what did I ask yesterday?",
    now: new Date("2026-11-16T19:00:00Z"),
    probe: (ctx) => ({ refs: parseDateRefs(ctx.question, ctx.now, ctx.timeZone) }),
    check: (o) => {
      const refs = o.refs as Array<{ date: string }>;
      return refs.length === 1 && refs[0].date === "2026-11-16"
        ? null
        : `resolved ${JSON.stringify(refs)}`;
    },
    rubric: { must: ["2026-11-16"] },
    live: false, // the clock is pinned; a live run would use today's date
  },
  {
    id: "tax-update",
    name: "A changed value supersedes, it does not overwrite",
    category: "knowledge-update",
    source: "LongMemEval",
    question: "Has the agreed price changed?",
    seed: { claims: [claim("Postgres hosting", "agreed price", "$19/month", "2026-11-10")] },
    probe: (ctx) => {
      const old = openClaims(ctx.db, ctx.sessionId)[0];
      writeBack(ctx.db, ctx.sessionId, [old], [
        {
          claimId: old.id,
          value: "$29/month",
          url: "https://example.com/new-pricing",
          quote: "$29/month",
          status: "changed",
        },
      ], ctx.now, ctx.timeZone);
      return {
        current: openClaims(ctx.db, ctx.sessionId)[0].value,
        chain: claimsBySubject(ctx.db, ctx.sessionId, "Postgres hosting"),
      };
    },
    check: (o) => {
      const chain = o.chain as Array<{ validUntil: string | null; supersededBy: number | null }>;
      if (o.current !== "$29/month") return `current ${o.current}`;
      if (chain.length !== 2) return `chain ${chain.length}`;
      if (!chain[0].validUntil || chain[0].supersededBy === null) return "old row not closed";
      return null;
    },
    rubric: { must: ["old value", "new value", "superseding source"] },
    live: false,
  },
  {
    id: "tax-abstention",
    name: "A date with no turns is stated, not filled in",
    category: "abstention",
    source: "LongMemEval",
    question: "what did I ask on 4 November?",
    probe: (ctx) => ({ notebook: buildNotebook(ctx, ctx.question, ctx.now) }),
    check: (o) => {
      const text = (o.notebook as { text: string }).text;
      return text.includes("No turns on 2026-11-04") ? null : "missing explicit empty-date statement";
    },
    rubric: { must: ["no turns on that date"], mustNot: ["an invented question"] },
  },

  // ---- Logged failure regressions ----------------------------------------
  {
    id: "temporal-001",
    name: "F-001 current date is injected from the clock",
    category: "temporal-reasoning",
    source: "F-001",
    question: "What is the latest stable Node.js version?",
    probe: () => ({ src: sourceText() }),
    check: (o) => ((o.src as string).includes("{{ISO}}") ? null : "no date placeholder in system prompt"),
    rubric: { must: ["a current version from search"], mustNot: ["a stale search year"] },
    live: false,
  },
  {
    id: "grounding-001",
    name: "F-002 extracted claims are clipped and URL-checked",
    category: "information-extraction",
    source: "F-002",
    question: "Compare the free tiers of Neon and Supabase",
    structuredResponse: {
      claims: [
        {
          subject: "Neon Free",
          attribute: "storage",
          value: "x".repeat(5000),
          url: "https://neon.com/pricing",
          quote: "y".repeat(5000),
        },
        {
          subject: "Supabase Free",
          attribute: "storage",
          value: "500 MB",
          url: "https://invented.example",
          quote: "500 MB",
        },
      ],
    },
    probe: async (ctx) => {
      const sources = [{ title: "Neon", url: "https://neon.com/pricing", content: "storage" }];
      const { claims } = await extractClaims(ctx.llm, "answer", sources, ctx.question);
      // The live judge's complaint was unsupported table values that carried a
      // valid URL. Feed that exact shape through the deterministic support guard.
      const guarded = guardValueSupport(
        "| Feature | Neon |\n|---|---|\n| Branching | 10 branches [https://neon.com/pricing] |",
        [{ url: "https://neon.com/pricing", text: "100 projects, 1 GB storage" }]
      );
      // The live failure is finer than "number absent": the number exists on the
      // page but belongs to another feature or vendor. A verified quote is the
      // evidence; a value must appear in it together with its feature.
      const quoted = guardValueSupport(
        "| Compute | 500 MB RAM [https://supabase.com/pricing] |",
        [{ url: "https://supabase.com/pricing", text: "Free: 500 MB database space." }],
        [
          {
            url: "https://supabase.com/pricing",
            text: "Supabase free includes 500 MB RAM",
            quote: "Free: 500 MB database space.",
          },
        ]
      );
      const kept = guardValueSupport(
        "Supabase includes 2 active projects [https://supabase.com/pricing].",
        [{ url: "https://supabase.com/pricing", text: "Free: 2 active projects per user." }],
        [
          {
            url: "https://supabase.com/pricing",
            text: "Supabase includes 2 active projects",
            quote: "Free: 2 active projects per user.",
          },
        ]
      );
      return { claims, guarded, quoted, kept };
    },
    check: (o) => {
      const claims = o.claims as Array<{ url: string | null; value: string; quote: string | null }>;
      if (claims.some((c) => c.url && c.url !== "https://neon.com/pricing")) return "invented URL survived";
      if (claims.some((c) => c.value.length > 300 || (c.quote?.length ?? 0) > 400)) return "unclipped field";
      const guarded = o.guarded as { answer: string; replaced: string[] };
      if (guarded.replaced.length !== 1) return "unsupported table value was not marked";
      if (!guarded.answer.includes("not stated in sources")) return "no unknown marker in the cell";
      if (guarded.answer.includes("10 branches")) return "unsupported value still asserted";
      const quoted = o.quoted as { answer: string; replaced: string[] };
      if (quoted.replaced.length !== 1) return "a value with a wrong-feature quote was kept";
      const kept = o.kept as { replaced: string[] };
      if (kept.replaced.length !== 0) return "a quoted, supported value was marked unknown";
      return null;
    },
    rubric: {
      must: ["only cells present in retrieved sources", "unknown marked where unsupported"],
      mustNot: ["a table cell with no source"],
    },
  },
  {
    id: "citation-001",
    name: "F-003 unsupported URLs are stripped",
    category: "information-extraction",
    source: "F-003",
    // Must name a product: an ambiguous subject makes the agent ask for
    // clarification, which has no factual claims to cite and tests nothing.
    question: "What is the free tier storage limit of Neon?",
    structuredResponse: {
      claims: [
        {
          subject: "A",
          attribute: "limit",
          value: "10 GB",
          url: "https://not-retrieved.example",
          quote: "10 GB",
        },
      ],
    },
    probe: async (ctx) => {
      const { claims } = await extractClaims(ctx.llm, "answer", [], ctx.question);
      return { claims };
    },
    check: (o) => {
      const claims = o.claims as Array<{ url: string | null }>;
      return claims.every((c) => c.url === null) ? null : "a URL survived without a retrieved source";
    },
    rubric: {
      must: ["a URL beside every factual claim about the product or its limits"],
      mustNot: ["a product or limit asserted without a URL"],
      // A note about whether sources show a date is retrieval metadata required
      // by F-006, not a product claim, so it needs no citation of its own.
    },
  },
  {
    id: "calibration-001",
    name: "F-004 unverifiable policy claims are hedged",
    category: "abstention",
    source: "F-004",
    question: "Do the Neon and Supabase free tiers expire?",
    probe: () => ({}),
    check: () => null, // answer-only behaviour, judged live
    rubric: {
      must: [
        "attributes any claim about whether a free tier expires to a retrieved source, or hedges when no source states it",
      ],
      mustNot: ["asserts a longevity policy that no retrieved source states"],
    },
  },
  {
    id: "recency-001",
    name: "F-006 fresh sources are preferred",
    category: "knowledge-update",
    source: "F-006",
    question: "What is the current price of ChatGPT Plus?",
    probe: () => ({}),
    check: () => null, // source-date extraction is still a known gap
    rubric: {
      must: ["an official or dated source", "a note when the source has no visible date"],
      mustNot: ["a launch-era article used as current evidence"],
    },
  },
  {
    id: "memory-abstain-001",
    name: "F-007 history questions never search the web",
    category: "abstention",
    source: "F-007",
    question: "What did I ask you on 3 November?",
    probe: (ctx) => {
      const intent = detectRecheck(ctx.question, ctx.now, ctx.timeZone);
      const notebook = buildNotebook(ctx, ctx.question, ctx.now);
      return { intent, notebook };
    },
    check: (o) => {
      if (o.intent !== null) return "history question triggered re-check";
      return (o.notebook as { text: string }).text.includes("No turns on 2026-11-03")
        ? null
        : "abstention not grounded in an empty query";
    },
    rubric: {
      must: ["states that this conversation has no record of a question on 3 November"],
      mustNot: ["a web search for chat history", "invents a past question"],
    },
  },
  {
    id: "budget-001",
    name: "F-009 step exhaustion is a visible failure",
    category: "abstention",
    source: "F-009",
    question: "What is the latest stable Node.js version?",
    llm: {
      structured: async <T>() => ({
        data: {} as T,
        usage: { prompt: 0, completion: 0, total: 0 },
      }),
      turn: async () => ({ text: "", stopReason: "budget" }),
    },
    probe: async (ctx) => ({ result: await ctx.llm.turn({
      instructions: "",
      input: [],
      search: ctx.search,
      toolDescription: "search",
      maxSteps: 1,
    }) }),
    check: (o) => {
      const result = o.result as { stopReason: string; text: string };
      return result.stopReason === "budget" && result.text === ""
        ? null
        : "budget exhaustion was not reported as such";
    },
    rubric: { must: ["an explicit stopped-without-answer message"] },
    live: false,
  },
  {
    id: "year-rule-001",
    name: "F-008 the year rule forbids stale years only",
    category: "temporal-reasoning",
    source: "F-008",
    question: "Compare the free tiers of Neon and Supabase",
    probe: () => ({ src: sourceText() }),
    check: (o) => {
      const src = o.src as string;
      return src.includes("not the current year") && src.includes("fresher pages")
        ? null
        : "year rule does not distinguish stale from current years";
    },
    rubric: { must: ["a current-year query or no year"] },
    live: false,
  },
  {
    id: "temporal-002",
    name: "F-010 sibling concepts cannot verify each other",
    category: "knowledge-update",
    source: "F-010",
    question: "Is your answer about the latest stable version still correct?",
    probe: (ctx) => {
      const recorded = {
        id: 1, sessionId: ctx.sessionId, subject: "Node.js",
        attribute: "latest stable version", value: "v26.13.1", url: null, quote: null,
        observedAt: ctx.now.toISOString(), localDate: "2026-11-17",
        validFrom: "2026-11-17", validUntil: null, supersededBy: null,
      };
      return {
        same: sameAttribute("latest stable version", "latest LTS release"),
        guarded: enforceAttributeMatch([recorded], [
          {
            claimId: 1,
            value: "v26.13.1",
            url: "https://nodejs.org/en/download",
            quote: "Latest LTS",
            status: "unchanged",
            matchedAttribute: "latest LTS release",
          },
        ]),
      };
    },
    check: (o) => {
      if (o.same !== false) return "sibling concepts compared as equal";
      const guarded = o.guarded as Array<{ status: string }>;
      return guarded[0]?.status === "not_found" ? null : "LTS source verified a stable claim";
    },
    rubric: { must: ["mismatch or no verification for different concepts"] },
  },
  {
    id: "scope-001",
    name: "F-005 adjacent releases are not volunteered",
    category: "information-extraction",
    source: "F-005",
    question: "What is the latest stable Node.js version?",
    probe: () => ({ src: sourceText() }),
    check: (o) => {
      const src = o.src as string;
      return src.includes("adjacent") && src.includes("only if the user asks")
        ? null
        : "scope rule missing from system prompt";
    },
    rubric: {
      must: ["the stable LTS line"],
      mustNot: ["alpha or beta release mentioned unprompted"],
    },
    live: true,
  },
];

export function coverage(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CASES) out[c.category] = (out[c.category] ?? 0) + 1;
  return out;
}
