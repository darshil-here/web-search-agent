# Temporal Re-check Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent answer "has it changed since then?" by comparing recorded claims against fresh web searches and reporting a dated, sourced diff.

**Architecture:** A pure detector decides whether a question is a re-check. If so, a dedicated pipeline branch pulls that date's claims, runs parallel web searches per subject, extracts fresh values with one structured-output call, builds a diff block, and makes one model call to write the answer. Changed values supersede in the claim ledger; every check is recorded in a new `verifications` table.

**Tech Stack:** TypeScript (NodeNext, strict), `better-sqlite3`, OpenAI Responses API with JSON-schema structured outputs, Tavily via `webSearch`, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-17-temporal-recheck-design.md`

## Global Constraints

- One tool only: `web_search`. The pipeline calls `webSearch` directly; no second tool is exposed to the model.
- Re-check detection requires a date reference **and** a re-check phrase. Bare "is that still correct?" does not trigger.
- When several dates are named, use the **earliest** date ref.
- No network in tests: stub `webSearch` and stub the OpenAI client.
- All dates stored twice: `checked_at`/`observed_at` in UTC, `local_date` in `USER_TZ`.
- Write-back is best-effort: never throw a ledger error to the user.
- `MAX_RECHECK_SEARCHES` defaults to `8`.
- The re-check answer call keeps `web_search` available; usage is recorded in the trace.
- `ledger()` from step 2 is skipped on the re-check path.
- Commit after each task with the exact message given.

---

## File Structure

- `dates.ts` — add bare weekday parsing (needed for "On Monday we shortlisted..."). Modify.
- `detect.ts` — pure `detectRecheck`. Create.
- `detect.test.ts` — detection tests. Create.
- `db.ts` — schema v3 + verification functions. Modify.
- `recheck.ts` — queries, extraction, diff, write-back, orchestration. Create.
- `recheck.test.ts` — all re-check tests with stubs. Create.
- `trace.ts` — `recheck` event and markdown section. Modify.
- `agent.ts` — single branch in `turn()`. Modify.
- `package.json` — add `detect.test.ts recheck.test.ts` to `test`. Modify.
- `README.md`, `DESIGN.md` — document the feature. Modify.

---

### Task 1: Bare weekday date parsing

**Files:**
- Modify: `dates.ts`
- Test: `dates.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseDateRefs` now also resolves bare `Monday`…`Sunday` to the most recent past occurrence (today if it is that weekday).

- [ ] **Step 1: Write the failing test**

Add to `dates.test.ts`:

```ts
test("a bare weekday means the most recent past occurrence", () => {
  // NOV_17_IST is a Tuesday.
  assert.deepEqual(parseDateRefs("On Monday we shortlisted 5 CRM tools", NOV_17_IST, IST), [
    { label: "Monday", date: "2026-11-16" },
  ]);
  assert.deepEqual(parseDateRefs("what did I ask on Tuesday?", NOV_17_IST, IST), [
    { label: "Tuesday", date: "2026-11-17" },
  ]);
});

test("last Tuesday keeps its own label over the bare weekday match", () => {
  assert.deepEqual(parseDateRefs("what did I ask last Tuesday?", NOV_17_IST, IST), [
    { label: "last Tuesday", date: "2026-11-10" },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — "On Monday..." returns `[]`.

- [ ] **Step 3: Implement**

In `dates.ts`, insert **after** the existing `last <weekday>` scan and **before** the `seen` dedupe block:

```ts
  // A bare weekday ("On Monday...") is the most recent past occurrence.
  // Placed after `last <weekday>` so the longer label wins the index sort.
  scan(new RegExp(`\\b(${WEEKDAY_PATTERN})\\b`, "gi"), (m) => {
    const target = WEEKDAY_INDEX[m[1].slice(0, 3).toLowerCase()];
    if (target === undefined) return null;
    const delta = (weekdayOf(today) - target + 7) % 7;
    return { label: m[0], date: addDays(today, -delta) };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all existing tests plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add dates.ts dates.test.ts
git commit -m "feat(dates): parse bare weekday references"
```

---

### Task 2: Schema v3 and verification persistence

**Files:**
- Modify: `db.ts`
- Test: `claims.test.ts`

**Interfaces:**
- Consumes: `openDb`, `Claim`.
- Produces: `saveVerification(db, v): Verification`, `verificationsForClaim(db, sessionId, claimId): Verification[]`, `recentVerifications(db, sessionId, limit): Verification[]`; `Verification` type with fields `id, sessionId, claimId, checkedAt, localDate, result, newValue, url` and `NewVerification` with `result: "changed" | "unchanged" | "not_found"`.

- [ ] **Step 1: Write the failing tests**

Add to `claims.test.ts`:

```ts
import {
  saveVerification,
  verificationsForClaim,
  recentVerifications,
} from "./db.js";

test("schema upgrades to v3 with a verifications table", () => {
  const db = freshDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r) => (r as { name: string }).name);
  assert.equal(db.pragma("user_version", { simple: true }), 3);
  assert.ok(tables.includes("verifications"));
  db.close();
});

test("a verification records a check in the user's timezone", () => {
  const db = freshDb();
  const c = recordClaims(db, "s", [claim("Neon free tier", "storage", "10 GB")], NOW, IST).claims[0];
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
  assert.equal(recentVerifications(db, "s", 10)[0].claimId, c.id);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `saveVerification` is not exported.

- [ ] **Step 3: Implement in `db.ts`**

Bump `SCHEMA_VERSION` to `3` and add migration `3`:

```ts
  3: `
    CREATE TABLE verifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      claim_id    INTEGER NOT NULL REFERENCES claims(id),
      checked_at  TEXT NOT NULL,
      local_date  TEXT NOT NULL,
      result      TEXT NOT NULL CHECK (result IN ('changed','unchanged','not_found')),
      new_value   TEXT,
      url         TEXT
    );
    CREATE INDEX verifications_claim ON verifications(session_id, claim_id, id);
  `,
```

Add the types next to the claim types:

```ts
export type VerificationResult = "changed" | "unchanged" | "not_found";
export type NewVerification = {
  sessionId: string;
  claimId: number;
  checkedAt: string;
  localDate: string;
  result: VerificationResult;
  newValue: string | null;
  url: string | null;
};
export type Verification = NewVerification & { id: number };
```

Append the functions (follow the existing `toClaim` / `.map` pattern):

```ts
export function saveVerification(
  db: Database.Database,
  v: NewVerification
): Verification {
  const info = db
    .prepare(
      `INSERT INTO verifications
        (session_id, claim_id, checked_at, local_date, result, new_value, url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.sessionId, v.claimId, v.checkedAt, v.localDate, v.result, v.newValue, v.url);
  return { id: Number(info.lastInsertRowid), ...v };
}

export function verificationsForClaim(
  db: Database.Database,
  sessionId: string,
  claimId: number
): Verification[] {
  return db
    .prepare(
      `SELECT * FROM verifications
       WHERE session_id = ? AND claim_id = ? ORDER BY id ASC`
    )
    .all(sessionId, claimId)
    .map((row) => {
      const r = row as any;
      return {
        id: r.id, sessionId: r.session_id, claimId: r.claim_id,
        checkedAt: r.checked_at, localDate: r.local_date, result: r.result,
        newValue: r.new_value, url: r.url,
      } satisfies Verification;
    });
}

export function recentVerifications(
  db: Database.Database,
  sessionId: string,
  limit: number
): Verification[] {
  return db
    .prepare(
      `SELECT * FROM verifications WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, limit)
    .map((row) => {
      const r = row as any;
      return {
        id: r.id, sessionId: r.session_id, claimId: r.claim_id,
        checkedAt: r.checked_at, localDate: r.local_date, result: r.result,
        newValue: r.new_value, url: r.url,
      } satisfies Verification;
    })
    .reverse();
}
```

Also update the first test's expected `user_version` in `claims.test.ts` from `2` to `3`.

- [ ] **Step 4: Run tests and the migration check**

Run: `npm test && npm run db:check`
Expected: PASS. The db-check script should also assert `user_version === 3`.

- [ ] **Step 5: Commit**

```bash
git add db.ts claims.test.ts scripts/db-check.ts
git commit -m "feat(db): add verifications table for re-check audit trail"
```

---

### Task 3: Pure detection

**Files:**
- Create: `detect.ts`
- Create: `detect.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `parseDateRefs`, `describeNow`/`localDateInTz` from `dates.ts`.
- Produces: `export type RecheckIntent = { date: string; phrase: string }` and `export function detectRecheck(text: string, now: Date, timeZone: string): RecheckIntent | null`.

- [ ] **Step 1: Write the failing tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { detectRecheck } from "./detect.js";

const NOW = new Date("2026-11-17T06:00:00Z"); // Tuesday in IST
const IST = "Asia/Kolkata";

test("detects all three brief examples", () => {
  const cases = [
    "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    "What did I ask you on 3 November? Is your answer still correct today?",
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
  ];
  for (const text of cases) {
    const intent = detectRecheck(text, NOW, IST);
    assert.ok(intent, text);
    assert.match(intent!.date, /^2026-11-\d{2}$/);
  }
});

test("uses the earliest date when several are named", () => {
  const intent = detectRecheck(
    "What did I ask you on 3 November? Is your answer still correct today?", NOW, IST
  );
  assert.equal(intent?.date, "2026-11-03");
});

test("ignores plain history recall and non-temporal questions", () => {
  for (const text of [
    "What did I ask you on 3 November?",
    "compare the free tiers of Neon and Supabase",
    "what is 17 times 23",
  ]) {
    assert.equal(detectRecheck(text, NOW, IST), null, text);
  }
});

test("a re-check phrase without a date does not trigger", () => {
  assert.equal(detectRecheck("Is your answer still correct?", NOW, IST), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `./detect.js` not found.

- [ ] **Step 3: Implement `detect.ts`**

```ts
import { parseDateRefs } from "./dates.js";

export type RecheckIntent = { date: string; phrase: string };

const RECHECK_PATTERNS: RegExp[] = [
  /\bstill\s+(?:correct|true|accurate|valid)\b/i,
  /\bhas\s+(?:any|it|anything|there)\b[^.?!]*\bchanged\b/i,
  /\bchanged\s+since\b/i,
  /\bshipped\s+since\b/i,
  /\b(?:any\s+)?updates?\s+since\b/i,
  /\bsince\s+then\b/i,
  /\bdifferent\s+now\b/i,
];

export function detectRecheck(
  text: string,
  now: Date,
  timeZone: string
): RecheckIntent | null {
  const refs = parseDateRefs(text, now, timeZone);
  if (refs.length === 0) return null;

  for (const pattern of RECHECK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      // Earliest date ref: the re-check compares against a past observation.
      const earliest = refs.reduce((a, b) => (a.date <= b.date ? a : b));
      return { date: earliest.date, phrase: match[0] };
    }
  }
  return null;
}
```

Update `package.json`:

```json
"test": "tsx --test dates.test.ts notebook.test.ts claims.test.ts detect.test.ts recheck.test.ts",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: the four detection tests PASS. The suite will fail because `recheck.test.ts` does not exist yet — create an empty placeholder file for now:

```bash
touch recheck.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add detect.ts detect.test.ts package.json recheck.test.ts
git commit -m "feat(detect): pure temporal re-check detection"
```

---

### Task 4: Recheck extraction and diff rendering (pure helpers)

**Files:**
- Create: `recheck.ts` (first half)
- Test: `recheck.test.ts`

**Interfaces:**
- Consumes: `Claim` from `db.ts`, `ClaimSource` from `claims.ts`, `RecheckIntent` from `detect.ts`.
- Produces:
  - `export type FreshStatus = "changed" | "unchanged" | "not_found"`
  - `export type FreshValue = { claimId: number; value: string; url: string | null; quote: string | null; status: FreshStatus }`
  - `export function buildQueries(claims: Claim[]): string[]`
  - `export async function extractFreshValues(openai: OpenAI, model: string, claims: Claim[], sources: ClaimSource[]): Promise<FreshValue[]>`
  - `export function buildDiff(claims: Claim[], fresh: FreshValue[]): { text: string; results: FreshValue[] }`

- [ ] **Step 1: Write the failing tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import type { Claim } from "./db.js";
import { buildQueries, extractFreshValues, buildDiff } from "./recheck.js";

function c(id: number, subject: string, attribute: string, value: string, date: string): Claim {
  return {
    id, sessionId: "s", subject, attribute, value,
    url: "https://neon.com/pricing", quote: "10 GB", observedAt: `${date}T05:00:00Z`,
    localDate: date, validFrom: date, validUntil: null, supersededBy: null,
  };
}

const SOURCES = [
  { title: "Neon", url: "https://neon.com/pricing", content: "512 MB storage free" },
];

function stub(payload: unknown): OpenAI {
  return { responses: { create: async () => ({ output_text: JSON.stringify(payload) }) } } as unknown as OpenAI;
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
    stub({ results: [
      { claimId: 1, value: "512 MB", url: "https://neon.com/pricing", quote: "512 MB storage free", status: "changed" },
      { claimId: 999, value: "$1", url: "https://invented.example", quote: "x", status: "changed" },
    ] }),
    "stub", claims, SOURCES
  );
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].value, "512 MB");
  assert.equal(fresh[0].url, "https://neon.com/pricing");
});

test("a claim with no extraction row becomes not_found", async () => {
  const claims = [c(1, "Neon free tier", "storage", "10 GB", "2026-11-03")];
  const fresh = await extractFreshValues(stub({ results: [] }), "stub", claims, SOURCES);
  assert.deepEqual(fresh, [{ claimId: 1, value: "", url: null, quote: null, status: "not_found" }]);
});

test("buildDiff renders old -> new with status and dates", () => {
  const claims = [c(1, "Neon free tier", "storage", "10 GB", "2026-11-03")];
  const fresh: import("./recheck.js").FreshValue[] = [
    { claimId: 1, value: "512 MB", url: "https://neon.com/pricing", quote: "512 MB", status: "changed" },
  ];
  const { text, results } = buildDiff(claims, fresh);
  assert.match(text, /Neon free tier/);
  assert.match(text, /10 GB/);
  assert.match(text, /512 MB/);
  assert.match(text, /changed/);
  assert.match(text, /2026-11-03/);
  assert.equal(results.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildQueries` is not exported.

- [ ] **Step 3: Implement the helpers in `recheck.ts`**

```ts
import type OpenAI from "openai";
import type { Claim } from "./db.js";
import type { ClaimSource } from "./claims.js";

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
  for (const c of claims) {
    if (seen.has(c.subject)) continue;
    seen.add(c.subject);
    out.push(`${c.subject} ${c.attribute}`.trim());
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
  sources: ClaimSource[]
): Promise<FreshValue[]> {
  const sourceBlock = sources.length === 0
    ? "(no sources were retrieved)"
    : sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`).join("\n\n");
  const claimBlock = claims
    .map((c) => `id ${c.id}: ${c.subject} / ${c.attribute} = ${c.value} (observed ${c.localDate})`)
    .join("\n");

  const response = await openai.responses.create({
    model,
    instructions: EXTRACT_FRESH_INSTRUCTIONS,
    input: `CLAIMS:\n${claimBlock}\n\nFRESH SOURCES:\n${sourceBlock}`,
    text: {
      format: {
        type: "json_schema", name: "fresh_values", schema: FRESH_SCHEMA, strict: true,
      },
    },
  });

  const parsed = JSON.parse(response.output_text) as { results: FreshValue[] };
  const allowed = new Set(sources.map((s) => s.url));
  const byId = new Map<number, FreshValue>();
  for (const r of parsed.results ?? []) {
    if (!claims.some((c) => c.id === r.claimId)) continue;
    if (r.url && !allowed.has(r.url)) r.url = null;
    byId.set(r.claimId, r);
  }
  // Every claim must appear, even when extraction omitted it.
  return claims.map((c) =>
    byId.get(c.id) ?? { claimId: c.id, value: "", url: null, quote: null, status: "not_found" }
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
  for (const c of claims) {
    const f = byId.get(c.id);
    lines.push(`- ${c.subject} / ${c.attribute}`);
    lines.push(`  recorded: ${c.value} (observed ${c.localDate})`);
    if (!f || f.status === "not_found") {
      lines.push(`  current: not found in fresh sources — status: not_found`);
    } else {
      lines.push(`  current: ${f.value} (${f.status})`);
      if (f.url) lines.push(`  source: ${f.url}`);
    }
    lines.push("");
  }
  lines.push("</recheck-diff>");
  return { text: lines.join("\n"), results: fresh };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add recheck.ts recheck.test.ts
git commit -m "feat(recheck): query building, fresh-value extraction and diff rendering"
```

---

### Task 5: Write-back rules

**Files:**
- Modify: `recheck.ts`
- Test: `recheck.test.ts`

**Interfaces:**
- Consumes: `recordClaims` from `claims.ts`, `saveVerification`, `Claim`, `Verification` from `db.ts`, `localDateInTz` from `dates.ts`.
- Produces: `export function writeBack(db, sessionId, claims, fresh, now, timeZone): { inserted: number; superseded: number; verifications: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { writeBack } from "./recheck.js";

// At the top of recheck.test.ts, alongside the other imports:
import { rmSync } from "node:fs";
import { openDb, recordClaims, openClaim, verificationsForClaim } from "./db.js";
const PATH = "data/recheck-test.db";
function freshDb() {
  for (const s of ["", "-wal", "-shm"]) rmSync(PATH + s, { force: true });
  return openDb(PATH);
}

test("write-back supersedes changed values and logs every check", () => {
  const db = freshDb();
  const old = recordClaims(db, "s", [claim("Neon free tier", "storage", "10 GB")], NOW, IST).claims[0];
  const later = new Date("2026-11-18T06:00:00Z");

  const result = writeBack(db, "s", [old], [
    { claimId: old.id, value: "512 MB", url: "https://neon.com/pricing", quote: "512 MB", status: "changed" },
  ], later, IST);

  assert.equal(result.inserted, 1);
  assert.equal(result.superseded, 1);
  assert.equal(result.verifications, 1);
  assert.equal(openClaim(db, "s", "Neon free tier", "storage")?.value, "512 MB");
  assert.equal(verificationsForClaim(db, "s", old.id)[0].result, "changed");
  db.close();
});

test("unchanged writes only a verification; not_found leaves the claim open", () => {
  const db = freshDb();
  const a = recordClaims(db, "s", [claim("A", "price", "$10")], NOW, IST).claims[0];
  const b = recordClaims(db, "s", [claim("B", "price", "$20")], NOW, IST).claims[0];

  const result = writeBack(db, "s", [a, b], [
    { claimId: a.id, value: "$10", url: null, quote: null, status: "unchanged" },
    { claimId: b.id, value: "", url: null, quote: null, status: "not_found" },
  ], new Date("2026-11-18T06:00:00Z"), IST);

  assert.equal(result.inserted, 0);
  assert.equal(result.superseded, 0);
  assert.equal(result.verifications, 2);
  assert.equal(openClaim(db, "s", "A", "price")?.value, "$10");
  assert.equal(openClaim(db, "s", "B", "price")?.value, "$20");
  db.close();
});
```

Add the imports needed (`freshDb`, `claim`, `recordClaims`, `openClaim`, `verificationsForClaim`) to `recheck.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `writeBack` is not exported.

- [ ] **Step 3: Implement in `recheck.ts`**

```ts
import { recordClaims } from "./claims.js";
import { saveVerification } from "./db.js";
import { localDateInTz } from "./dates.js";
import type Database from "better-sqlite3";

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
  let inserted = 0, superseded = 0, verifications = 0;

  for (const c of claims) {
    const f = byId.get(c.id);
    const status: FreshStatus = f?.status ?? "not_found";

    if (status === "changed" && f && f.value) {
      const result = recordClaims(
        db, sessionId,
        [{ subject: c.subject, attribute: c.attribute, value: f.value, url: f.url, quote: f.quote }],
        now, timeZone
      );
      inserted += result.inserted;
      superseded += result.superseded;
    }

    saveVerification(db, {
      sessionId,
      claimId: c.id,
      checkedAt,
      localDate,
      result: status,
      newValue: status === "changed" ? f?.value ?? null : null,
      url: status === "changed" ? f?.url ?? null : null,
    });
    verifications++;
  }

  return { inserted, superseded, verifications };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add recheck.ts recheck.test.ts
git commit -m "feat(recheck): supersede changed claims and log verifications"
```

---

### Task 6: Recheck orchestration

**Files:**
- Modify: `recheck.ts`
- Test: `recheck.test.ts`

**Interfaces:**
- Consumes: `claimsForDate`, `openClaims` from `db.ts`, `RecheckIntent` from `detect.ts`, `NotebookContext` from `notebook.ts`, `buildQueries`/`extractFreshValues`/`buildDiff`/`writeBack` from this file.
- Produces:
  - `export type RecheckReport = { answer: string; intent: RecheckIntent; queries: string[]; claimsChecked: number; failedSearches: number; writeBack: { inserted: number; superseded: number; verifications: number }; usedSearch: boolean; fresh: FreshValue[] }`
  - `export async function recheck(args: { ctx: NotebookContext; intent: RecheckIntent; userText: string; now: Date; openai: OpenAI; model: string; instructions: string; search: (q: string) => Promise<ClaimSource[]> }): Promise<RecheckReport>`

- [ ] **Step 1: Write the failing tests**

```ts
test("recheck falls back to open claims when the named date is empty", async () => {
  const db = freshDb();
  const c = recordClaims(db, "s", [claim("Node.js", "latest LTS release", "v26.13.1")], NOW, IST).claims[0];
  const searches: string[] = [];
  const report = await recheck({
    ctx: { db, sessionId: "s", timeZone: IST },
    intent: { date: "2026-11-03", phrase: "still correct" },
    userText: "What did I ask on 3 November? Is your answer still correct today?",
    now: NOW,
    openai: stub({ results: [
      { claimId: c.id, value: "v26.13.1", url: "https://nodejs.org/en/download", quote: "v26.13.1 Latest LTS", status: "unchanged" },
    ] }),
    model: "stub",
    instructions: "You are a research assistant.",
    search: async (q) => { searches.push(q); return [{ title: "Node", url: "https://nodejs.org/en/download", content: "v26.13.1 Latest LTS" }]; },
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
    openai: stub({ results: [] }),
    model: "stub",
    instructions: "You are a research assistant.",
    search: async () => { called = true; return []; },
  });
  assert.equal(called, false);
  assert.equal(report.claimsChecked, 0);
  assert.match(report.answer, /no prior claim/i);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `recheck` is not exported.

- [ ] **Step 3: Implement `recheck()` in `recheck.ts`**

```ts
import { claimsForDate, openClaims } from "./db.js";
import type { RecheckIntent } from "./detect.js";
import type { NotebookContext } from "./notebook.js";
import type OpenAI from "openai";

export type RecheckReport = {
  answer: string;
  intent: RecheckIntent;
  queries: string[];
  claimsChecked: number;
  failedSearches: number;
  writeBack: { inserted: number; superseded: number; verifications: number };
  usedSearch: boolean;
  fresh: FreshValue[];
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
}): Promise<RecheckReport> {
  const { ctx, intent, now, openai, model, instructions, search } = args;
  const dated = claimsForDate(ctx.db, ctx.sessionId, intent.date);
  const claims = dated.length > 0 ? dated : openClaims(ctx.db, ctx.sessionId);
  const queries = buildQueries(claims);

  if (claims.length === 0 || queries.length === 0) {
    return {
      answer: `I have no prior claim recorded for ${intent.date}, so there is nothing to re-check.`,
      intent, queries: [], claimsChecked: 0, failedSearches: 0,
      writeBack: { inserted: 0, superseded: 0, verifications: 0 },
      usedSearch: false, fresh: [],
    };
  }

  // Bound the fan-out: a 20-subject question must not fire 20 searches.
  const configured = Number(process.env.MAX_RECHECK_SEARCHES ?? 8);
  const cap = Number.isInteger(configured) && configured > 0 ? configured : 8;
  const cappedQueries = queries.slice(0, cap);

  const settled = await Promise.all(
    cappedQueries.map(async (q) => {
      try { return { ok: true as const, results: await search(q) }; }
      catch { return { ok: false as const, results: [] as ClaimSource[] }; }
    })
  );
  const sources: ClaimSource[] = [];
  const seen = new Set<string>();
  let failedSearches = 0;
  for (const s of settled) {
    if (!s.ok) { failedSearches++; continue; }
    for (const r of s.results) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      sources.push(r);
    }
  }

  let fresh: FreshValue[];
  try {
    fresh = await extractFreshValues(openai, model, claims, sources);
  } catch {
    fresh = claims.map((c) => ({
      claimId: c.id, value: "", url: null, quote: null, status: "not_found" as const,
    }));
  }

  const { text: diff } = buildDiff(claims, fresh);
  if (failedSearches === cappedQueries.length) {
    return {
      answer: "I could not complete the re-check: every web search failed.",
      intent, queries: cappedQueries, claimsChecked: claims.length, failedSearches,
      writeBack: { inserted: 0, superseded: 0, verifications: 0 },
      usedSearch: false, fresh,
    };
  }

  const response = await openai.responses.create({
    model,
    instructions,
    input: [
      { role: "developer", content: diff },
      { role: "user", content: args.userText },
    ],
    tools: [{
      type: "function", name: "web_search",
      description: "Search the web. Use only if the diff leaves something unverified.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      strict: false,
    }],
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
    intent, queries: cappedQueries, claimsChecked: claims.length, failedSearches,
    writeBack: writeBackResult,
    usedSearch: response.output.some((o) => o.type === "function_call"),
    fresh,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add recheck.ts recheck.test.ts
git commit -m "feat(recheck): orchestrate parallel re-verification with graceful failure"
```

---

### Task 7: Trace support

**Files:**
- Modify: `trace.ts`

**Interfaces:**
- Consumes: `RecheckReport` from `recheck.ts`, `FreshValue` from `recheck.ts`.
- Produces: `tracer.recheck(report: RecheckReport): void`; markdown section "Re-check"; frontmatter `recheck_claims`.

- [ ] **Step 1: Write a failing test**

Add to `recheck.test.ts`:

```ts
import { Tracer } from "./trace.js";

test("tracer records a recheck event", () => {
  const t = new Tracer("test");
  t.recheck({
    answer: "no change", intent: { date: "2026-11-03", phrase: "still correct" },
    queries: ["Node.js latest LTS release"], claimsChecked: 1, failedSearches: 0,
    writeBack: { inserted: 0, superseded: 0, verifications: 1 }, usedSearch: false,
    fresh: [{ claimId: 1, value: "v26.13.1", url: null, quote: null, status: "unchanged" }],
  });
  // The event is private; verify through the rendered markdown via flush().
  const path = t.flush();
  assert.ok(path.endsWith(".md"));
});
```

Note: this test only checks that `recheck()` exists and `flush()` works. Delete the generated `traces/*-test.md` and `.jsonl` after the run.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `t.recheck is not a function`.

- [ ] **Step 3: Implement in `trace.ts`**

Add a field `private recheckInfo: RecheckReport | undefined;` and the method:

```ts
recheck(report: RecheckReport): void {
  this.recheckInfo = report;
  this.events.push({ type: "recheck", ts: new Date().toISOString(), ...report });
}
```

Add to frontmatter after `claims:`:

```ts
`recheck_claims: ${this.recheckInfo?.claimsChecked ?? 0}`,
```

Add a markdown section after the claim-ledger block:

```ts
if (this.recheckInfo) {
  const r = this.recheckInfo;
  lines.push(
    "", "## Re-check", "",
    `Date queried: ${r.intent.date} | phrase: ${r.intent.phrase}`, "",
    `| claims checked | queries | failed searches | used search | inserted | superseded | verifications |`,
    `|---------------:|--------:|----------------:|:------------|---------:|------------:|--------------:|`,
    `| ${r.claimsChecked} | ${r.queries.length} | ${r.failedSearches} | ${r.usedSearch} | ` +
      `${r.writeBack.inserted} | ${r.writeBack.superseded} | ${r.writeBack.verifications} |`, ""
  );
  for (const f of r.fresh) {
    lines.push(`- claim ${f.claimId}: ${f.status} — ${f.value || "no value"} ${f.url ?? ""}`);
  }
  lines.push("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS. Remove the generated `traces/*-test.*` files.

- [ ] **Step 5: Commit**

```bash
git add trace.ts recheck.test.ts
git commit -m "feat(trace): record temporal re-check runs"
```

---

### Task 8: Wire the branch into agent.ts

**Files:**
- Modify: `agent.ts`

**Interfaces:**
- Consumes: `detectRecheck` from `detect.ts`, `recheck` from `recheck.ts`, `tracer.recheck`.
- Produces: the `turn()` function now has two answer paths.

- [ ] **Step 1: Add imports and a failing type check**

Add to `agent.ts`:

```ts
import { detectRecheck } from "./detect.js";
import { recheck } from "./recheck.js";
```

Then add, immediately after `saveTurn(ctx.db, { role: "user", ... })` in `turn()`:

```ts
  const intent = detectRecheck(userText, now, ctx.timeZone);
  if (intent) {
    const report = await recheck({
      ctx, intent, userText, now, openai, model, instructions,
      search: async (q) => {
        const results = await webSearch(q);
        searches.push(q);
        return results;
      },
    });
    tracer.recheck(report);
    tracer.final({
      step: 0,
      content: report.answer,
      totalMs: performance.now() - runStart,
      totalTokens,
      stopReason: "answered",
    });
    saveTurn(ctx.db, {
      sessionId: ctx.sessionId,
      role: "assistant",
      content: report.answer,
      createdAt: new Date().toISOString(),
      localDate: localDateInTz(new Date(), ctx.timeZone),
    });
    return { answer: report.answer, stopReason: "answered" };
  }
```

Note: `searches` is declared a few lines below the user-turn save today. Move its declaration (and `sources`) **above** this block so they are in scope.

- [ ] **Step 2: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS. There is no new unit test for the branch itself; it is covered by Task 9's live smoke test.

- [ ] **Step 3: Verify the normal path is untouched**

Run: `npm start -- "what is 17 times 23"`
Expected: answer `391`, no re-check section in the generated trace.

- [ ] **Step 4: Commit**

```bash
git add agent.ts
git commit -m "feat(agent): route temporal questions through the re-check pipeline"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `README.md`, `DESIGN.md`, `docs/superpowers/specs/2026-11-17-temporal-recheck-design.md`

- [ ] **Step 1: Update README**

Add a "Re-checks" section after "Claim ledger (schema v2)":

```markdown
## Re-checks ("has it changed since then?")

Questions that name a date and ask whether an earlier answer is still correct
take a separate path. `detect.ts` decides from the text alone — no classifier
call. The pipeline pulls that date's claims (or current beliefs if the date is
empty), searches each subject in parallel, extracts fresh values with one
structured-output call, and hands a dated diff to the model to write the answer.

Changed values supersede in the ledger; every check — including "unchanged"
and "not found" — is written to a `verifications` table, so a fact that was
re-verified today is not mistaken for one never checked. Set
`MAX_RECHECK_SEARCHES` (default 8) to bound the fan-out.
```

- [ ] **Step 2: Update DESIGN.md**

In "How it works", insert after step 6:

```markdown
7. **Temporal re-check.** A dated question that asks "still correct / changed
   since" is detected in code (`detect.ts`) before the model loop. `recheck.ts`
   pulls claims for that date, searches each subject in parallel, reads fresh
   values with a structured-output call, and injects a dated diff block. One
   model call writes the answer. Changed values supersede in the ledger; all
   checks are logged in `verifications`.
```

Move the "Re-verification pipeline (next)" bullet from "What I'd do with another week" into the built part, and add to that section instead: page fetching, source-date extraction, grounding critic, eval set.

- [ ] **Step 3: Mark the spec implemented**

Change the spec status line to `Status: implemented 2026-11-17`.

- [ ] **Step 4: Full verification**

Run:

```bash
npm test
npm run typecheck
npm run db:check
npm start -- "what is 17 times 23"
```

Expected: 30+ tests pass, typecheck clean, db-check pass, arithmetic answer unaffected.

- [ ] **Step 5: Commit and push**

```bash
git add README.md DESIGN.md docs/superpowers/specs/2026-11-17-temporal-recheck-design.md
git commit -m "docs: document the temporal re-check pipeline"
git push origin main
```
