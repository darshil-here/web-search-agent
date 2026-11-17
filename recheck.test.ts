// recheck.test.ts
//
// All re-check tests use a stubbed webSearch and a stubbed OpenAI client:
// no network, no API key. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type OpenAI from "openai";
import {
  openClaim,
  openDb,
  verificationsForClaim,
  type Claim,
} from "./db.js";
import { recordClaims } from "./claims.js";
import { Tracer } from "./trace.js";
import {
  buildQueries,
  extractFreshValues,
  buildDiff,
  writeBack,
  recheck,
  enforceAttributeMatch,
  type FreshValue,
} from "./recheck.js";

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

function stub(payload: unknown): OpenAI {
  return {
    responses: { create: async () => ({ output_text: JSON.stringify(payload) }) },
  } as unknown as OpenAI;
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
  const fresh = await extractFreshValues(
    stub({
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
    "stub",
    claims,
    SOURCES
  );
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].value, "512 MB");
  assert.equal(fresh[0].url, "https://neon.com/pricing");
});

test("a claim with no extraction row becomes not_found", async () => {
  const claims = [c(1, "Neon free tier", "storage", "10 GB", "2026-11-03")];
  const fresh = await extractFreshValues(stub({ results: [] }), "stub", claims, SOURCES);
  assert.deepEqual(fresh, [
    { claimId: 1, value: "", url: null, quote: null, status: "not_found" },
  ]);
});

test("buildDiff renders old -> new with status and dates", () => {
  const claims = [c(1, "Neon free tier", "storage", "10 GB", "2026-11-03")];
  const fresh: import("./recheck.js").FreshValue[] = [
    {
      claimId: 1,
      value: "512 MB",
      url: "https://neon.com/pricing",
      quote: "512 MB",
      status: "changed",
    },
  ];
  const { text, results } = buildDiff(claims, fresh);
  assert.match(text, /Neon free tier/);
  assert.match(text, /10 GB/);
  assert.match(text, /512 MB/);
  assert.match(text, /changed/);
  assert.match(text, /2026-11-03/);
  assert.equal(results.length, 1);
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

function stubFull(payload: unknown): OpenAI {
  return {
    responses: {
      create: async () => ({ output_text: JSON.stringify(payload), output: [] }),
    },
  } as unknown as OpenAI;
}

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
    openai: stubFull({
      results: [
        {
          claimId: claim.id,
          value: "v26.13.1",
          url: "https://nodejs.org/en/download",
          quote: "v26.13.1 Latest LTS",
          status: "unchanged",
        },
      ],
    }),
    model: "stub",
    instructions: "You are a research assistant.",
    search: async (q) => {
      searches.push(q);
      return [
        {
          title: "Node",
          url: "https://nodejs.org/en/download",
          content: "v26.13.1 Latest LTS",
        },
      ];
    },
  });

  assert.equal(report.claimsChecked, 1);
  assert.equal(searches.length, 1);
  assert.equal(report.fresh[0].status, "unchanged");
  assert.equal(report.writeBack.verifications, 1);
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
    openai: stubFull({ results: [] }),
    model: "stub",
    instructions: "You are a research assistant.",
    search: async () => {
      called = true;
      return [];
    },
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

test("extraction applies the attribute guard and the diff surfaces the mismatch", async () => {
  const claim = c(1, "Node.js", "latest stable release", "v26.13.1", "2026-11-03");
  const fresh = await extractFreshValues(
    stub({
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
    "stub",
    [claim],
    SOURCES
  );

  assert.equal(fresh[0].status, "not_found");
  const { text } = buildDiff([claim], fresh);
  assert.match(text, /source describes/);
  assert.match(text, /latest LTS release/);
});

test("an answer call that requests a search gets it executed", async () => {
  const db = freshDb();
  const claim = recordClaims(
    db, "s", [extracted("A", "price", "$10")], NOW, IST
  ).claims[0];
  let calls = 0;
  const client = {
    responses: {
      create: async () => {
        calls++;
        if (calls === 1) {
          return {
            output_text: JSON.stringify({
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
            }),
            output: [],
          };
        }
        if (calls === 2) {
          return {
            output_text: "",
            output: [
              {
                type: "function_call",
                call_id: "call-1",
                name: "web_search",
                arguments: JSON.stringify({ query: "A price" }),
              },
            ],
          };
        }
        return { output_text: "Still $10.", output: [] };
      },
    },
  } as unknown as OpenAI;
  let searched = "";

  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-17", phrase: "still correct" },
    userText: "Is A still correct?",
    now: NOW,
    openai: client,
    model: "stub",
    instructions: "You are a research assistant.",
    search: async (q) => {
      searched = q;
      return [{ title: "A", url: "https://neon.com/pricing", content: "$10" }];
    },
  });

  assert.equal(searched, "A price");
  assert.equal(report.answer, "Still $10.");
  assert.equal(report.usedSearch, true);
  db.close();
});

test("tracer records a recheck event and renders its section", () => {
  const t = new Tracer("test");
  t.recheck({
    answer: "no change",
    intent: { date: "2026-11-03", phrase: "still correct" },
    queries: ["Node.js latest LTS release"],
    claimsChecked: 1,
    failedSearches: 0,
    writeBack: { inserted: 0, superseded: 0, verifications: 1 },
    usedSearch: false,
    fresh: [
      {
        claimId: 1,
        value: "v26.13.1",
        url: null,
        quote: null,
        status: "unchanged",
      },
    ],
    llmCalls: [
      {
        step: 0,
        ms: 10,
        usage: { prompt: 100, completion: 20, total: 120 },
        toolCallCount: 0,
      },
    ],
  });
  const path = t.flush();
  assert.ok(path.endsWith(".md"));
});
