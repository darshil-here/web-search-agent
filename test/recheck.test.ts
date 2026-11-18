// All re-check tests use a stubbed search and a stubbed model: no network, no
// API key. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  openClaim,
  openDb,
  verificationsForClaim,
  type Claim,
} from "../src/db.js";
import { recordClaims } from "../src/claims.js";
import type { Llm, PromptMessage, TurnRequest, Usage } from "../src/llm.js";
import {
  buildQueries,
  extractFreshValues,
  buildDiff,
  writeBack,
  recheck,
  enforceAttributeMatch,
  enforceValueInSources,
  type FreshValue,
} from "../src/recheck.js";

const NO_USAGE: Usage = { prompt: 0, completion: 0, total: 0 };

function c(
  id: number,
  subject: string,
  attribute: string,
  value: string,
  date: string
): Claim {
  return {
    id,
    sessionId: "s",
    subject,
    attribute,
    value,
    url: "https://neon.com/pricing",
    quote: "10 GB",
    observedAt: `${date}T05:00:00Z`,
    localDate: date,
    validFrom: date,
    validUntil: null,
    supersededBy: null,
  };
}

const SOURCES = [
  { title: "Neon", url: "https://neon.com/pricing", content: "512 MB storage free" },
];

/** A model that returns one structured payload and an answer of the caller's choosing. */
function stubLlm(data: unknown, answer = ""): Llm {
  return {
    structured: async <T>() => ({ data: data as T, usage: NO_USAGE }),
    turn: async () => ({ text: answer, stopReason: "answered" }),
  };
}

test("buildQueries makes one query per distinct subject", () => {
  const queries = buildQueries([
    c(1, "Neon free tier", "storage", "10 GB", "2026-11-03"),
    c(2, "Neon free tier", "compute", "100 CU", "2026-11-03"),
    c(3, "Supabase free tier", "storage", "500 MB", "2026-11-03"),
  ]);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /Neon free tier/);
  assert.match(queries[0], /storage/);
});

test("extraction maps results to claims and strips invented URLs", async () => {
  const claims = [c(1, "Neon free tier", "storage", "10 GB", "2026-11-03")];
  const { fresh } = await extractFreshValues(
    stubLlm({
      results: [
        {
          claimId: 1,
          value: "512 MB",
          url: "https://neon.com/pricing",
          quote: "512 MB storage free",
          status: "changed",
        },
        {
          claimId: 999,
          value: "$1",
          url: "https://invented.example",
          quote: "x",
          status: "changed",
        },
      ],
    }),
    claims,
    SOURCES
  );
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].value, "512 MB");
  assert.equal(fresh[0].url, "https://neon.com/pricing");
});

test("a claim with no extraction row becomes not_found", async () => {
  const claims = [c(1, "Neon free tier", "storage", "10 GB", "2026-11-03")];
  const { fresh } = await extractFreshValues(
    stubLlm({ results: [] }),
    claims,
    SOURCES
  );
  assert.deepEqual(fresh, [
    { claimId: 1, value: "", url: null, quote: null, status: "not_found" },
  ]);
});

test("buildDiff renders old -> new with status and dates", () => {
  const claims = [c(1, "Neon free tier", "storage", "10 GB", "2026-11-03")];
  const fresh: FreshValue[] = [
    {
      claimId: 1,
      value: "512 MB",
      url: "https://neon.com/pricing",
      quote: "512 MB",
      status: "changed",
    },
  ];
  const text = buildDiff(claims, fresh);
  assert.match(text, /Neon free tier/);
  assert.match(text, /10 GB/);
  assert.match(text, /512 MB/);
  assert.match(text, /changed/);
  assert.match(text, /2026-11-03/);
});

// --- write-back -------------------------------------------------------------

const PATH = "data/recheck-test.db";
const IST = "Asia/Kolkata";
const NOW = new Date("2026-11-16T19:00:00Z"); // 00:30 on 17 Nov in IST
const LATER = new Date("2026-11-18T06:00:00Z");

function freshDb() {
  for (const s of ["", "-wal", "-shm"]) rmSync(PATH + s, { force: true });
  return openDb(PATH);
}

function extracted(subject: string, attribute: string, value: string) {
  return {
    subject,
    attribute,
    value,
    url: "https://neon.com/pricing",
    quote: "quoted",
  };
}

test("write-back supersedes changed values and logs every check", () => {
  const db = freshDb();
  const old = recordClaims(
    db, "s", [extracted("Neon free tier", "storage", "10 GB")], NOW, IST
  ).claims[0];

  const result = writeBack(
    db, "s", [old],
    [
      {
        claimId: old.id,
        value: "512 MB",
        url: "https://neon.com/pricing",
        quote: "512 MB",
        status: "changed" as const,
      },
    ],
    LATER,
    IST
  );

  assert.equal(result.inserted, 1);
  assert.equal(result.superseded, 1);
  assert.equal(result.verifications, 1);
  assert.equal(openClaim(db, "s", "Neon free tier", "storage")?.value, "512 MB");
  assert.equal(verificationsForClaim(db, "s", old.id)[0].result, "changed");
  db.close();
});

test("unchanged writes only a verification; not_found leaves the claim open", () => {
  const db = freshDb();
  const a = recordClaims(db, "s", [extracted("A", "price", "$10")], NOW, IST).claims[0];
  const b = recordClaims(db, "s", [extracted("B", "price", "$20")], NOW, IST).claims[0];

  const result = writeBack(
    db, "s", [a, b],
    [
      { claimId: a.id, value: "$10", url: null, quote: null, status: "unchanged" as const },
      { claimId: b.id, value: "", url: null, quote: null, status: "not_found" as const },
    ],
    LATER,
    IST
  );

  assert.equal(result.inserted, 0);
  assert.equal(result.superseded, 0);
  assert.equal(result.verifications, 2);
  assert.equal(openClaim(db, "s", "A", "price")?.value, "$10");
  assert.equal(openClaim(db, "s", "B", "price")?.value, "$20");
  db.close();
});

// --- orchestration ----------------------------------------------------------

test("an empty answer text is reported as an incomplete re-check", async () => {
  const db = freshDb();
  const claim = recordClaims(
    db, "s", [extracted("A", "price", "$10")], NOW, IST
  ).claims[0];

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-17", phrase: "still correct" },
    userText: "Is A still correct?",
    now: NOW,
    llm: stubLlm(
      {
        results: [
          {
            claimId: claim.id,
            value: "$10",
            url: "https://neon.com/pricing",
            quote: "$10",
            status: "unchanged",
          },
        ],
      },
      "" // claims "answered" but produces no text
    ),
    instructions: "You are a research assistant.",
    maxSearches: 8,
    search: async () => [
      { title: "A", url: "https://neon.com/pricing", content: "$10" },
    ],
  });

  assert.equal(report.stopReason, "budget");
  assert.match(report.answer, /without an answer/);
  db.close();
});

test("recheck falls back to open claims when the named date is empty", async () => {
  const db = freshDb();
  const claim = recordClaims(
    db, "s", [extracted("Node.js", "latest LTS release", "v26.13.1")], NOW, IST
  ).claims[0];
  const searches: string[] = [];

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-03", phrase: "still correct" },
    userText: "What did I ask on 3 November? Is your answer still correct today?",
    now: NOW,
    llm: stubLlm(
      {
        results: [
          {
            claimId: claim.id,
            value: "v26.13.1",
            url: "https://nodejs.org/en/download",
            quote: "v26.13.1 Latest LTS",
            status: "unchanged",
          },
        ],
      },
      "No change: v26.13.1 is still the latest LTS."
    ),
    instructions: "You are a research assistant.",
    search: async (query) => {
      searches.push(query);
      return [
        {
          title: "Node",
          url: "https://nodejs.org/en/download",
          content: "v26.13.1 Latest LTS",
        },
      ];
    },
    maxSearches: 8,
  });

  assert.equal(report.claimsChecked, 1);
  assert.equal(searches.length, 1);
  assert.equal(report.fresh[0].status, "unchanged");
  assert.equal(report.writeBack.verifications, 1);
  assert.equal(report.stopReason, "answered");
  assert.equal(report.llmCalls[0].label, "extract");
  db.close();
});

test("recheck abstains with zero searches when there is nothing to check", async () => {
  const db = freshDb();
  let called = false;

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-03", phrase: "changed since" },
    userText: "Has anything changed since 3 November?",
    now: NOW,
    llm: stubLlm({ results: [] }),
    instructions: "You are a research assistant.",
    search: async () => {
      called = true;
      return [];
    },
    maxSearches: 8,
  });

  assert.equal(called, false);
  assert.equal(report.claimsChecked, 0);
  assert.match(report.answer, /no prior claim/i);
  db.close();
});

test("a source describing a different attribute is downgraded to not_found", () => {
  const claim = c(1, "Node.js", "latest stable release", "v26.13.1", "2026-11-03");
  const fresh: FreshValue[] = [
    {
      claimId: 1,
      value: "v26.13.1",
      url: "https://endoflife.date/nodejs",
      quote: "v26.13.1 Latest LTS",
      status: "unchanged",
      matchedAttribute: "latest LTS release",
    },
  ];

  const result = enforceAttributeMatch([claim], fresh);

  assert.equal(result[0].status, "not_found");
  assert.equal(result[0].mismatch, true);
});

test("the same attribute with different wording still matches", () => {
  const claim = c(1, "Node.js", "latest stable release", "v26.13.1", "2026-11-03");
  const fresh: FreshValue[] = [
    {
      claimId: 1,
      value: "v26.13.1",
      url: "https://neon.com/pricing",
      quote: "v26.13.1 stable",
      status: "unchanged",
      matchedAttribute: "stable release",
    },
  ];

  const result = enforceAttributeMatch([claim], fresh);

  assert.equal(result[0].status, "unchanged");
  assert.equal(result[0].mismatch, undefined);
});

test("a reported value that appears in no source is downgraded to not_found", () => {
  const fresh: FreshValue[] = [
    {
      claimId: 1,
      value: "$19/month",
      url: "https://medium.com/hosting",
      quote: "$19/month",
      status: "unchanged",
    },
  ];
  const sources = [
    {
      title: "Hosting prices",
      url: "https://medium.com/hosting",
      content: "Some providers are free; see the linked table.",
    },
  ];

  const result = enforceValueInSources(sources, fresh);

  assert.equal(result[0].status, "not_found");
  assert.equal(result[0].valueNotInSources, true);
});

test("a reported value that a source states is left unchanged", () => {
  const fresh: FreshValue[] = [
    {
      claimId: 1,
      value: "$19/month",
      url: "https://example.com/pricing",
      quote: "$19/month",
      status: "unchanged",
    },
  ];
  const sources = [
    {
      title: "Pricing",
      url: "https://example.com/pricing",
      content: "Our hosting plan costs $19/month.",
    },
  ];

  assert.deepEqual(enforceValueInSources(sources, fresh), fresh);
});

test("a changed value the sources do not state is also downgraded", () => {
  const fresh: FreshValue[] = [
    {
      claimId: 1,
      value: "$29/month",
      url: null,
      quote: null,
      status: "changed",
    },
  ];

  assert.equal(enforceValueInSources([], fresh)[0].status, "not_found");
});

test("extraction downgrades an echoed value that no source states", async () => {
  const claim = c(1, "Postgres hosting", "price", "$19/month", "2026-11-10");
  const { fresh } = await extractFreshValues(
    stubLlm({
      results: [
        {
          claimId: 1,
          value: "$19/month",
          url: "https://medium.com/hosting",
          quote: "$19/month",
          status: "unchanged",
        },
      ],
    }),
    [claim],
    [
      {
        title: "Hosting prices",
        url: "https://medium.com/hosting",
        content: "Some providers are free; see the linked table.",
      },
    ]
  );

  assert.equal(fresh[0].status, "not_found");
  assert.equal(fresh[0].valueNotInSources, true);
  assert.match(buildDiff([claim], fresh), /does not appear in any fresh source/);
});

test("an echoed value leads to an honest re-check answer", async () => {
  const db = freshDb();
  const claim = recordClaims(
    db, "s", [extracted("Postgres hosting", "price", "$19/month")], NOW, IST
  ).claims[0];

  const llm: Llm = {
    structured: async <T>() => ({
      data: {
        results: [
          {
            claimId: claim.id,
            value: "$19/month",
            url: "https://medium.com/hosting",
            quote: "$19/month",
            status: "unchanged",
          },
        ],
      } as T,
      usage: NO_USAGE,
    }),
    turn: async () => ({
      text: "No. The price is still $19/month, unchanged since your last Tuesday observation.",
      stopReason: "answered",
    }),
  };

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-17", phrase: "Has any pricing changed" },
    userText: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    now: NOW,
    llm,
    instructions: "You are a research assistant.",
    search: async () => [
      {
        title: "Hosting prices",
        url: "https://medium.com/hosting",
        content: "Some providers are free; see the linked table.",
      },
    ],
    maxSearches: 8,
  });

  assert.equal(report.fresh[0].status, "not_found");
  assert.match(report.answer, /could not verify a current value/);
  assert.doesNotMatch(report.answer, /price is still/);
  assert.equal(report.writeBack.verifications, 1);
  db.close();
});

test("extraction applies the attribute guard and the diff surfaces the mismatch", async () => {
  const claim = c(1, "Node.js", "latest stable release", "v26.13.1", "2026-11-03");
  const { fresh } = await extractFreshValues(
    stubLlm({
      results: [
        {
          claimId: 1,
          value: "v26.13.1",
          url: "https://neon.com/pricing",
          quote: "v26.13.1 Latest LTS",
          status: "unchanged",
          matchedAttribute: "latest LTS release",
        },
      ],
    }),
    [claim],
    SOURCES
  );

  assert.equal(fresh[0].status, "not_found");
  const text = buildDiff([claim], fresh);
  assert.match(text, /source describes/);
  assert.match(text, /latest LTS release/);
});

test("a search the answer turn runs is reported as used", async () => {
  const db = freshDb();
  const claim = recordClaims(
    db, "s", [extracted("A", "price", "$10")], NOW, IST
  ).claims[0];
  let searched = "";

  const llm: Llm = {
    structured: async <T>() => ({
      data: {
        results: [
          {
            claimId: claim.id,
            value: "$10",
            url: "https://neon.com/pricing",
            quote: "$10",
            status: "unchanged",
            matchedAttribute: "price",
          },
        ],
      } as T,
      usage: NO_USAGE,
    }),
    turn: async (request: TurnRequest) => {
      // The safety valve: the answer admits the diff is inconclusive and asks
      // for one more search, which must actually run.
      await request.search("A price");
      request.onEvent?.({
        type: "tool",
        call: { step: 1, name: "web_search", args: { query: "A price" }, ms: 1, results: [] },
      });
      return { text: "Still $10.", stopReason: "answered" };
    },
  };

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-17", phrase: "still correct" },
    userText: "Is A still correct?",
    now: NOW,
    llm,
    instructions: "You are a research assistant.",
    search: async (query) => {
      searched = query;
      return [{ title: "A", url: "https://neon.com/pricing", content: "$10" }];
    },
    maxSearches: 8,
  });

  assert.equal(searched, "A price");
  assert.equal(report.answer, "Still $10.");
  assert.equal(report.usedSearch, true);
  db.close();
});

test("a failed extraction is reported and leaves every claim not_found", async () => {
  const db = freshDb();
  recordClaims(
    db, "s", [extracted("A", "price", "$10")], NOW, IST
  );

  const llm: Llm = {
    structured: async () => {
      throw new Error("model unavailable");
    },
    turn: async () => ({ text: "I could not verify the current price.", stopReason: "answered" }),
  };

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-17", phrase: "still correct" },
    userText: "Is A still correct?",
    now: NOW,
    llm,
    instructions: "You are a research assistant.",
    search: async () => [
      { title: "A", url: "https://neon.com/pricing", content: "$10" },
    ],
    maxSearches: 8,
  });

  assert.equal(report.errors.extraction, "model unavailable");
  assert.equal(report.fresh[0].status, "not_found");
  assert.equal(report.answer, "I could not verify the current price.");
  assert.equal(report.writeBack.verifications, 1);
  db.close();
});

test("an answer that ignores the diff is rewritten to an honest statement", async () => {
  const db = freshDb();
  const claim = recordClaims(
    db, "s", [extracted("Postgres hosting", "price", "$19/month")], NOW, IST
  ).claims[0];

  const llm: Llm = {
    structured: async <T>() => ({
      data: {
        results: [
          {
            claimId: claim.id,
            value: "",
            url: null,
            quote: null,
            status: "not_found",
          },
        ],
      } as T,
      usage: NO_USAGE,
    }),
    turn: async () => ({
      text: "The current price is still $19/month.",
      stopReason: "answered",
    }),
  };

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-10", phrase: "changed since" },
    userText: "Has any pricing changed since last Tuesday?",
    now: NOW,
    llm,
    instructions: "You are a research assistant.",
    search: async () => [
      { title: "Hosting", url: "https://neon.com/pricing", content: "pricing page" },
    ],
    maxSearches: 8,
  });

  assert.equal(report.fresh[0].status, "not_found");
  assert.match(report.answer, /could not verify a current value/);
  assert.doesNotMatch(report.answer, /current price is still/);
  assert.equal(report.guard.rewritten.length, 1);
  db.close();
});

test("the answer call is told not_found rows are unverified", async () => {
  const db = freshDb();
  const claim = recordClaims(
    db, "s", [extracted("A", "price", "$10")], NOW, IST
  ).claims[0];
  let inputs: PromptMessage[] = [];

  const llm: Llm = {
    structured: async <T>() => ({
      data: {
        results: [
          {
            claimId: claim.id,
            value: "",
            url: null,
            quote: null,
            status: "not_found",
          },
        ],
      } as T,
      usage: NO_USAGE,
    }),
    turn: async (request: TurnRequest) => {
      inputs = request.input;
      return { text: "I could not verify a current price.", stopReason: "answered" };
    },
  };

  await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-17", phrase: "still correct" },
    userText: "Is A still correct?",
    now: NOW,
    llm,
    instructions: "You are a research assistant.",
    search: async () => [
      { title: "A", url: "https://neon.com/pricing", content: "$10" },
    ],
    maxSearches: 8,
  });

  const developer = inputs.filter((message) => message.role === "developer");
  assert.ok(
    developer.some((message) =>
      /Never present its recorded value as the current value/.test(message.content)
    ),
    "no hard-constraint developer message was injected"
  );
  assert.ok(
    developer.some((message) => message.content.includes("not_found")),
    "the diff should also name not_found rows"
  );
  db.close();
});
