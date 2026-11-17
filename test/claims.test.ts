// The ledger's reconcile logic and the extraction sanitizer are pure given a
// DB and a stubbed model. No network, no API key. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  claimsBySubject,
  claimsForDate,
  openClaim,
  openClaims,
  openDb,
  saveVerification,
  verificationsForClaim,
} from "../src/db.js";
import {
  extractClaims,
  recordClaims,
  type ExtractedClaim,
} from "../src/claims.js";
import type { Llm, StructuredRequest, Usage } from "../src/llm.js";
import type { SearchResult } from "../src/search.js";

const PATH = "data/claims-test.db";
const IST = "Asia/Kolkata";
const NOW = new Date("2026-11-16T19:00:00Z"); // 00:30 on 17 Nov in IST
const NO_USAGE: Usage = { prompt: 0, completion: 0, total: 0 };

function freshDb() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(PATH + suffix, { force: true });
  return openDb(PATH);
}

function claim(
  subject: string,
  attribute: string,
  value: string
): ExtractedClaim {
  return { subject, attribute, value, url: "https://example.com/pricing", quote: "quoted" };
}

function stubLlm(data: unknown): Llm {
  return {
    // The real method is generic; a fake answers every request with one payload.
    structured: async <T>() => ({ data: data as T, usage: NO_USAGE }),
    turn: async () => {
      throw new Error("claim extraction does not run a tool loop");
    },
  };
}

// --- record / reconcile -----------------------------------------------------

test("a verification records a check in the user's timezone", () => {
  const db = freshDb();
  const c = recordClaims(
    db, "s", [claim("Neon free tier", "storage", "10 GB")], NOW, IST
  ).claims[0];
  const v = saveVerification(db, {
    sessionId: "s",
    claimId: c.id,
    checkedAt: NOW.toISOString(),
    localDate: "2026-11-17",
    result: "unchanged",
    newValue: null,
    url: null,
  });
  assert.equal(v.result, "unchanged");
  assert.equal(verificationsForClaim(db, "s", c.id).length, 1);
  db.close();
});

test("new claims are recorded with observed/valid dates in the user's timezone", () => {
  const db = freshDb();
  const result = recordClaims(
    db,
    "s",
    [claim("Neon free tier", "storage", "10 GB")],
    NOW,
    IST
  );

  assert.equal(result.inserted, 1);
  assert.equal(result.superseded, 0);
  assert.equal(result.unchanged, 0);
  const saved = result.claims[0];
  assert.equal(saved.observedAt, NOW.toISOString());
  assert.equal(saved.localDate, "2026-11-17"); // not 16 — the UTC date
  assert.equal(saved.validFrom, saved.localDate);
  assert.equal(saved.validUntil, null);
  db.close();
});

test("an identical re-observation is a no-op (idempotent)", () => {
  const db = freshDb();
  const first = recordClaims(db, "s", [claim("Neon free tier", "storage", "10 GB")], NOW, IST);
  const again = recordClaims(db, "s", [claim("Neon free tier", "storage", "10 GB")], NOW, IST);

  assert.equal(first.inserted, 1);
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 1);
  assert.equal(again.claims[0].id, first.claims[0].id); // no new row
  assert.equal(openClaims(db, "s").length, 1);
  db.close();
});

test("a changed value closes the old row and links it to the new one", () => {
  const db = freshDb();
  recordClaims(db, "s", [claim("Neon free tier", "storage", "10 GB")], NOW, IST);
  const later = new Date("2026-11-18T06:00:00Z");
  const second = recordClaims(db, "s", [claim("Neon free tier", "storage", "512 MB")], later, IST);

  assert.equal(second.inserted, 1);
  assert.equal(second.superseded, 1);

  const fresh = second.claims[0];
  const old = claimsBySubject(db, "s", "Neon free tier")[0];
  assert.equal(old.validUntil, "2026-11-18");
  assert.equal(old.supersededBy, fresh.id);
  assert.equal(fresh.validFrom, "2026-11-18");
  assert.equal(fresh.validUntil, null);
  assert.equal(openClaim(db, "s", "Neon free tier", "storage")?.value, "512 MB");
  db.close();
});

test("the version chain is readable oldest-first by subject", () => {
  const db = freshDb();
  recordClaims(db, "s", [claim("ChatGPT Plus", "price", "$20/month")], NOW, IST);
  recordClaims(
    db,
    "s",
    [claim("ChatGPT Plus", "price", "$25/month")],
    new Date("2026-11-18T06:00:00Z"),
    IST
  );

  const chain = claimsBySubject(db, "s", "ChatGPT Plus");
  assert.deepEqual(
    chain.map((c) => c.value),
    ["$20/month", "$25/month"]
  );
  assert.equal(openClaims(db, "s").length, 1); // only the new value is current
  db.close();
});

test("same subject, different attribute are separate claims", () => {
  const db = freshDb();
  recordClaims(
    db,
    "s",
    [
      claim("Neon free tier", "storage", "10 GB"),
      claim("Neon free tier", "compute", "100 CU-hours"),
    ],
    NOW,
    IST
  );
  assert.equal(openClaims(db, "s").length, 2);
  assert.equal(openClaim(db, "s", "Neon free tier", "storage")?.value, "10 GB");
  assert.equal(
    openClaim(db, "s", "Neon free tier", "compute")?.value,
    "100 CU-hours"
  );
  db.close();
});

test("claims are queried by local date and scoped to a session", () => {
  const db = freshDb();
  recordClaims(db, "s1", [claim("Neon free tier", "storage", "10 GB")], NOW, IST);
  recordClaims(db, "other", [claim("Secret tool", "price", "$9")], NOW, IST);

  assert.equal(claimsForDate(db, "s1", "2026-11-17").length, 1);
  assert.equal(claimsForDate(db, "s1", "2026-11-16").length, 0); // UTC date, wrong
  assert.equal(claimsForDate(db, "other", "2026-11-17").length, 1);
  assert.equal(openClaim(db, "other", "Neon free tier", "storage"), null);
  db.close();
});

// --- extraction sanitizer (stubbed model, still no network) -----------------

const SOURCES: SearchResult[] = [
  { title: "Neon", url: "https://neon.com/pricing", content: "10 GB storage free" },
];

test("extraction drops invented URLs, empty fields and duplicates", async () => {
  const { claims: extracted } = await extractClaims(
    stubLlm({
      claims: [
        {
          subject: "Neon free tier",
          attribute: "storage",
          value: "10 GB",
          url: "https://neon.com/pricing", // allowed
          quote: "10 GB storage free",
        },
        {
          subject: "Invented",
          attribute: "price",
          value: "$1",
          url: "https://not-a-retrieved-source.com", // invented -> dropped URL
          quote: "made up",
        },
        { subject: "  ", attribute: "x", value: "y", url: null, quote: null }, // empty -> dropped
        {
          subject: "Neon free tier",
          attribute: "storage",
          value: "10 GB",
          url: "https://neon.com/pricing",
          quote: "10 GB storage free",
        }, // duplicate -> dropped
      ],
    }),
    "Neon gives 10 GB free.",
    SOURCES
  );

  assert.equal(extracted.length, 2);
  assert.deepEqual(
    extracted.map((c) => c.subject),
    ["Neon free tier", "Invented"]
  );
  assert.equal(extracted[0].url, "https://neon.com/pricing");
  assert.equal(extracted[1].url, null); // the invented URL was stripped
});

test("extraction returns empty for a model that finds no claims", async () => {
  const { claims: extracted } = await extractClaims(
    stubLlm({ claims: [] }),
    "I don't know.",
    SOURCES
  );
  assert.deepEqual(extracted, []);
});

test("attribute uses the question's concept, not a sibling from the answer", async () => {
  const sources = [
    {
      title: "Node releases",
      url: "https://nodejs.org/en/about/previous-releases",
      content: "v26.13.1 Latest LTS",
    },
  ];
  const { claims: extracted } = await extractClaims(
    stubLlm({
      claims: [
        {
          subject: "Node.js",
          attribute: "latest LTS release",
          value: "v26.13.1",
          url: sources[0].url,
          quote: "v26.13.1 Latest LTS",
        },
      ],
    }),
    "v26.13.1 is the latest LTS.",
    sources,
    "What is the latest stable Node.js version?"
  );

  assert.equal(extracted[0].attribute, "latest stable release");
});

test("extraction is given the user's question so attributes stay grounded", async () => {
  let captured: StructuredRequest | undefined;
  const capturing: Llm = {
    structured: async <T>(request: StructuredRequest) => {
      captured = request;
      return { data: { claims: [] } as T, usage: NO_USAGE };
    },
    turn: async () => {
      throw new Error("claim extraction does not run a tool loop");
    },
  };

  await extractClaims(
    capturing,
    "v26.13.1 is the latest LTS.",
    SOURCES,
    "What is the latest stable Node.js version?"
  );

  assert.ok(captured);
  assert.match(captured.input, /latest stable Node\.js version/);
  assert.match(captured.input, /v26\.13\.1 is the latest LTS/);
  assert.match(captured.input, /neon\.com\/pricing/);
});
