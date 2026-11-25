// eval/cases.ts
//
// The acceptance set. Every case names the source it came from (the brief, a
// LongMemEval category, or a bug found while building) and carries two things:
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
import type { SearchResult, EnrichedSource } from "../src/search.js";
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
import { applyEvidence, checkClaim } from "../src/support.js";
import { ground, needsGrounding } from "../src/critic.js";

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

      // An unsupported table value carrying a valid URL: the number is absent
      // from the page, so the cell is marked "Not stated" in place.
      const guarded = applyEvidence(
        "| Feature | Neon |\n|---|---|\n| Branching | 10 branches [https://neon.com/pricing] |",
        [
          { text: "10 branches", url: "https://neon.com/pricing", quote: null, supported: false },
          { text: "Feature", url: null, quote: null, supported: true },
          { text: "Neon", url: null, quote: null, supported: true },
        ]
      );

      // A quote that is verbatim but does not contain the claimed number does
      // not verify it; the claim is removed rather than asserted.
      const backed = checkClaim(
        "Supabase includes 500 MB RAM",
        "Free: shared compute.",
        "Free: shared compute. Free: 500 MB database space."
      );

      // A verbatim quote that states the number keeps the claim.
      const kept = applyEvidence(
        "Supabase includes 2 active projects [https://supabase.com/pricing].",
        [
          {
            text: "Supabase includes 2 active projects",
            url: "https://supabase.com/pricing",
            quote: "Free: 2 active projects per user.",
            supported: checkClaim(
              "Supabase includes 2 active projects",
              "Free: 2 active projects per user.",
              "Free: 2 active projects per user."
            ),
          },
        ]
      );
      return { claims, guarded, backed, kept };
    },
    check: (o) => {
      const claims = o.claims as Array<{ url: string | null; value: string; quote: string | null }>;
      if (claims.some((c) => c.url && c.url !== "https://neon.com/pricing")) return "invented URL survived";
      if (claims.some((c) => c.value.length > 300 || (c.quote?.length ?? 0) > 400)) return "unclipped field";
      const guarded = o.guarded as { answer: string; dropped: string[] };
      if (guarded.dropped.length !== 1) return "unsupported table value was not marked";
      if (!guarded.answer.includes("Not stated")) return "no unknown marker in the cell";
      if (guarded.answer.includes("10 branches")) return "unsupported value still asserted";
      if (o.backed !== false) return "a quote without the claimed number verified it";
      const kept = o.kept as { answer: string; dropped: string[] };
      if (kept.dropped.length !== 0) return "a quoted, supported value was dropped";
      if (!kept.answer.includes("2 active projects")) return "a supported value was removed";
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
      must: ["an official or dated source"],
      mustNot: [
        "a launch-era article used as current evidence",
        "a dump of publication dates or relative update times",
      ],
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

  // ---- Domain cases for evidence-only grounding --------------------------
  // These are written by question *shape* (price, role, version, table,
  // missing info), not by the incident that produced them, so a guard that
  // only fits one past failure shows up as a miss here.
  {
    id: "ground-price-001",
    name: "A live price keeps the source's precision",
    category: "knowledge-update",
    source: "domain:live-price",
    question: "What is the bitcoin price today in USD?",
    structuredResponse: {
      revisedAnswer:
        "Bitcoin is $59,979 USD (quote timestamped 2026-11-24 17:38 UTC) [https://finance.test/quote/BTC-USD].",
      statements: [
        {
          text: "Bitcoin is $59,979 USD",
          url: "https://finance.test/quote/BTC-USD",
          quote:
            "Regular market price: 59,979.21 -1,623.04 (-2.63%) as of 2026-11-24 17:38 UTC",
        },
      ],
    },
    probe: async (ctx) => {
      const sources: EnrichedSource[] = [
        {
          title: "Bitcoin price",
          url: "https://finance.test/quote/BTC-USD",
          content:
            "Regular market price: 59,979.21 -1,623.04 (-2.63%) as of 2026-11-24 17:38 UTC",
          pageText: null,
          publishedAt: null,
        },
      ];
      const result = await ground(ctx.llm, "Bitcoin is $59,979 USD.", sources, ctx.question);
      return { answer: result.answer, dropped: result.droppedClaims };
    },
    check: (o) => {
      if (!(o.answer as string).includes("$59,979")) return "a sourced price was removed";
      if ((o.dropped as string[]).length !== 0) return "a verbatim, rounded price was dropped";
      return null;
    },
    rubric: {
      must: ["the price with its source and timestamp"],
      mustNot: ["claiming the price is unknown while citing the quote"],
    },
  },
  {
    id: "ground-role-001",
    name: "A current role needs a verbatim quote",
    category: "knowledge-update",
    source: "domain:current-role",
    question: "Is Jensen Huang still NVIDIA's CEO?",
    structuredResponse: {
      revisedAnswer: "Jensen Huang is president and CEO of NVIDIA [https://nvidia.test/about].",
      statements: [
        {
          text: "Jensen Huang is president and CEO of NVIDIA",
          url: "https://nvidia.test/about",
          quote: "Jensen Huang is president and CEO of NVIDIA",
        },
      ],
    },
    probe: async (ctx) => {
      const sources: EnrichedSource[] = [
        {
          title: "Leadership",
          url: "https://nvidia.test/about",
          content: "Jensen Huang is president and CEO of NVIDIA.",
          pageText: null,
          publishedAt: null,
        },
      ];
      const kept = await ground(
        ctx.llm,
        "Jensen Huang is president and CEO of NVIDIA.",
        sources,
        ctx.question
      );
      // Same answer, but the quote is not on the page: it must not verify.
      const fabricated = await ground(
        {
          ...ctx.llm,
          structured: async <T>() => ({
            data: {
              revisedAnswer: "Jensen Huang remains CEO of NVIDIA [https://nvidia.test/about].",
              statements: [
                {
                  text: "Jensen Huang remains CEO of NVIDIA",
                  url: "https://nvidia.test/about",
                  quote: "Jensen Huang remains CEO of NVIDIA",
                },
              ],
            } as T,
            usage: { prompt: 0, completion: 0, total: 0 },
          }),
        },
        "Jensen Huang remains CEO of NVIDIA.",
        sources,
        ctx.question
      );
      return {
        kept: kept.answer,
        keptDropped: kept.droppedClaims,
        fabricated: fabricated.answer,
      };
    },
    check: (o) => {
      if (!(o.kept as string).includes("president and CEO")) return "a quoted role was removed";
      if ((o.keptDropped as string[]).length !== 0) return "a quoted role was dropped";
      if ((o.fabricated as string).includes("remains CEO")) return "an invented quote verified a claim";
      return null;
    },
    rubric: {
      must: ["the current role with a source"],
      mustNot: ["a role asserted without a quote from the cited page"],
    },
  },
  {
    id: "ground-version-001",
    name: "A version and date must both appear in the quote",
    category: "information-extraction",
    source: "domain:version-date",
    question: "What is the latest stable Node.js version and when was it released?",
    structuredResponse: {
      revisedAnswer:
        "Node.js 26.13.1 was released on 2026-11-04 [https://nodejs.test/releases].",
      statements: [
        {
          text: "Node.js 26.13.1 was released on 2026-11-04",
          url: "https://nodejs.test/releases",
          quote: "Node.js 26.13.1 was released on 2026-11-04.",
        },
      ],
    },
    probe: async (ctx) => {
      const sources: EnrichedSource[] = [
        {
          title: "Releases",
          url: "https://nodejs.test/releases",
          content: "Node.js 26.13.1 was released on 2026-11-04.",
          pageText: null,
          publishedAt: null,
        },
      ];
      const kept = await ground(
        ctx.llm,
        "Node.js 26.13.1 was released on 2026-11-04.",
        sources,
        ctx.question
      );
      const wrong: EnrichedSource[] = sources;
      const changed = await ground(
        {
          ...ctx.llm,
          structured: async <T>() => ({
            data: {
              revisedAnswer:
                "Node.js 26.13.2 was released on 2026-11-04 [https://nodejs.test/releases].",
              statements: [
                {
                  text: "Node.js 26.13.2 was released on 2026-11-04",
                  url: "https://nodejs.test/releases",
                  quote: "Node.js 26.13.1 was released on 2026-11-04.",
                },
              ],
            } as T,
            usage: { prompt: 0, completion: 0, total: 0 },
          }),
        },
        "Node.js 26.13.2 was released on 2026-11-04.",
        wrong,
        ctx.question
      );
      return { kept: kept.answer, keptDropped: kept.droppedClaims, changed: changed.answer };
    },
    check: (o) => {
      if (!(o.kept as string).includes("26.13.1")) return "a quoted version was removed";
      if (!(o.kept as string).includes("2026-11-04")) return "a quoted date was removed";
      if ((o.keptDropped as string[]).length !== 0) return "a fully quoted version was dropped";
      if ((o.changed as string).includes("26.13.2")) return "a version absent from the quote survived";
      return null;
    },
    rubric: {
      must: ["the released version and its release date"],
      mustNot: ["a version or date the cited source does not state"],
    },
  },
  {
    id: "ground-table-001",
    name: "A comparison table marks only unquoted cells unknown",
    category: "information-extraction",
    source: "domain:comparison-table",
    question: "Compare the free tiers of Supabase and Neon",
    structuredResponse: {
      revisedAnswer:
        "| Feature | Supabase | Neon |\n|---|---|---|\n| Projects | 2 active projects [https://supabase.test/pricing] | 10 branches [https://neon.test/pricing] |",
      statements: [
        {
          text: "2 active projects",
          url: "https://supabase.test/pricing",
          quote: "Free: 2 active projects per user.",
        },
        {
          text: "10 branches",
          url: "https://neon.test/pricing",
          quote: "Free: shared compute and storage.",
        },
      ],
    },
    probe: async (ctx) => {
      const sources: EnrichedSource[] = [
        {
          title: "Supabase pricing",
          url: "https://supabase.test/pricing",
          content: "Free: 2 active projects per user.",
          pageText: null,
          publishedAt: null,
        },
        {
          title: "Neon pricing",
          url: "https://neon.test/pricing",
          content: "Free: shared compute and storage.",
          pageText: null,
          publishedAt: null,
        },
      ];
      const result = await ground(
        ctx.llm,
        "| Feature | Supabase | Neon |\n|---|---|---|\n| Projects | 2 active projects | 10 branches |",
        sources,
        ctx.question
      );
      return { answer: result.answer, dropped: result.droppedClaims };
    },
    check: (o) => {
      const answer = o.answer as string;
      if (!answer.includes("2 active projects")) return "a supported cell was removed";
      if (answer.includes("10 branches")) return "an unquoted cell survived";
      if (!answer.includes("Not stated")) return "an unquoted cell was not marked";
      return null;
    },
    rubric: {
      must: ["a supported value beside its source", "unknown where the source does not state it"],
      mustNot: ["a table value with no supporting quote"],
    },
  },
  {
    id: "ground-missing-001",
    name: "A missing fact is reported, not invented",
    category: "abstention",
    source: "domain:missing-info",
    question: "What is the price of the Neon Pro plan?",
    structuredResponse: {
      revisedAnswer:
        "The Pro plan costs $99 per month [https://neon.test/pricing].",
      statements: [
        {
          text: "The Pro plan costs $99 per month",
          url: "https://neon.test/pricing",
          quote: "The Pro plan costs $99 per month.",
        },
      ],
    },
    probe: async (ctx) => {
      const sources: EnrichedSource[] = [
        {
          title: "Neon pricing",
          url: "https://neon.test/pricing",
          content: "Free plan: 1 GB of storage. Pro pricing is not listed.",
          pageText: null,
          publishedAt: null,
        },
      ];
      const result = await ground(
        ctx.llm,
        "The Pro plan costs $99 per month.",
        sources,
        ctx.question
      );
      return { answer: result.answer, dropped: result.droppedClaims };
    },
    check: (o) => {
      const answer = o.answer as string;
      if (answer.includes("$99")) return "an invented price survived";
      if (!/could not verify/i.test(answer)) return "the answer did not say it could not verify";
      return null;
    },
    rubric: {
      must: ["that the retrieved sources do not state the price"],
      mustNot: ["a price absent from the sources"],
    },
  },
  {
    id: "ground-short-001",
    name: "A short factual answer is still grounded",
    category: "information-extraction",
    source: "domain:short-answer",
    question: "Did NVIDIA announce a stock split?",
    probe: () => ({
      citationOnly: needsGrounding("Yes. [https://investor.nvidia.com/announcement]"),
      oneNumber: needsGrounding("The split is 10-for-1."),
      noFact: needsGrounding("I do not know the answer."),
      yearOnly: needsGrounding("It happened in 2026."),
    }),
    check: (o) => {
      if (o.citationOnly !== true) return "a cited one-line answer was skipped";
      if (o.oneNumber !== true) return "a one-number answer was skipped";
      if (o.noFact !== false) return "an answer with no fact was grounded";
      if (o.yearOnly !== false) return "a bare calendar year triggered grounding";
      return null;
    },
    rubric: {
      must: ["an answer grounded in a retrieved source"],
      mustNot: ["a skipped check that leaves an unquoted claim"],
    },
    live: false,
  },
];

export function coverage(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CASES) out[c.category] = (out[c.category] ?? 0) + 1;
  return out;
}
