# Answer Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank search results by publication date so current sources are preferred, and enforce a "sources do not state" contract for longevity claims.

**Architecture:** `search.ts` requests and maps Tavily's `published_date`, then a pure ranker puts dated results first. A pure calibration guard rewrites absolute longevity claims that no source states. Both feed the existing answer path, which is traced.

**Tech Stack:** TypeScript (NodeNext, strict), Tavily `/search` with `include_published_date`, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-17-answer-quality-design.md`

## Global Constraints

- Rank, never drop undated results. A malformed date counts as undated.
- `publishedAt` is optional on `SearchResult` so existing callers keep compiling.
- The calibration guard is pure, makes no model call, and never returns an empty answer.
- It rewrites only when no source states the same absolute claim.
- The re-check answer path is untouched.
- Every new phase is traced.
- Commit after each task with the exact message given.

---

## File Structure

- `src/search.ts` — request/map publication dates and expose the ranker. Modify.
- `src/calibration.ts` — the pure calibration guard. Create.
- `src/agent.ts` — wire ranking into search results and calibration into the answer path. Modify.
- `src/trace.ts` — calibration event and section. Modify.
- `test/search.test.ts`, `test/calibration.test.ts` (new); `test/trace.test.ts` (extend).
- `README.md`, `DESIGN.md`, `FAILURES.md` — document and update F-004/F-006.

---

### Task 1: Publication dates and freshness ranking

**Files:**
- Modify: `src/search.ts`
- Test: `test/search.test.ts` (new)

**Interfaces:**
- Consumes: Tavily `/search` response.
- Produces:
  - `SearchResult` gains `publishedAt?: string | null`
  - `rankByFreshness(results: SearchResult[]): SearchResult[]`

- [ ] **Step 1: Write the failing tests**

Create `test/search.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createSearch, rankByFreshness } from "../src/search.js";
import type { SearchResult } from "../src/search.js";

function result(url: string, publishedAt?: string): SearchResult {
  return { title: url, url, content: "text", publishedAt };
}

test("rankByFreshness puts dated results first, newest first", () => {
  const ranked = rankByFreshness([
    result("https://old.test", "2023-01-01"),
    result("https://undated.test"),
    result("https://new.test", "2026-11-01"),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.url),
    ["https://new.test", "https://old.test", "https://undated.test"]
  );
});

test("rankByFreshness keeps ties stable and treats bad dates as undated", () => {
  const ranked = rankByFreshness([
    result("https://a.test", "not-a-date"),
    result("https://b.test", "2026-05-01"),
    result("https://c.test", "2026-05-01"),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.url),
    ["https://b.test", "https://c.test", "https://a.test"]
  );
});

test("createSearch requests and maps published_date", async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return {
      ok: true,
      json: async () => ({
        results: [
          {
            title: "Pricing",
            url: "https://p.test",
            content: "$20",
            published_date: "2026-10-01",
          },
        ],
      }),
    } as Response;
  };
  try {
    const search = createSearch("tvly-test");
    const results = await search("ChatGPT Plus price");
    assert.equal(body.include_published_date, true);
    assert.equal(results[0].publishedAt, "2026-10-01");
  } finally {
    globalThis.fetch = original;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `rankByFreshness` not exported; `publishedAt` not mapped.

- [ ] **Step 3: Implement**

In `src/search.ts`, change the type:

```ts
export type SearchResult = {
  title: string;
  url: string;
  content: string;
  /** Tavily's published_date, when the source has one. */
  publishedAt?: string | null;
};
```

Add the ranker after the types:

```ts
const DATE = /^20\d{2}-\d{2}-\d{2}$/;

/** Dated results first, newest first; undated keep their original order. */
export function rankByFreshness(results: SearchResult[]): SearchResult[] {
  const dated: Array<{ result: SearchResult; time: number }> = [];
  const undated: SearchResult[] = [];
  for (const result of results) {
    const value = result.publishedAt;
    const time = typeof value === "string" && DATE.test(value)
      ? Date.parse(value)
      : Number.NaN;
    if (Number.isNaN(time)) undated.push(result);
    else dated.push({ result, time });
  }
  dated.sort((a, b) => b.time - a.time);
  return [...dated.map((d) => d.result), ...undated];
}
```

In `createSearch`, add `include_published_date: true` to the request body and map the field:

```ts
        body: JSON.stringify({
          query,
          max_results: 5,
          include_published_date: true,
        }),
```

```ts
        publishedAt: result.publishedAt ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts test/search.test.ts
git commit -m "feat(search): rank Tavily results by publication date"
```

---

### Task 2: Calibration guard

**Files:**
- Create: `src/calibration.ts`
- Test: `test/calibration.test.ts`

**Interfaces:**
- Consumes: `SearchResult` from `src/search.ts`.
- Produces:
  - `CalibrationResult = { answer: string; rewritten: string[] }`
  - `guardCalibration(question: string, answer: string, sources: SearchResult[]): CalibrationResult`

- [ ] **Step 1: Write the failing tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { guardCalibration } from "../src/calibration.js";
import type { SearchResult } from "../src/search.js";

const sources: SearchResult[] = [
  { title: "Docs", url: "https://n.test", content: "Free plan includes 10 GB storage." },
];

test("rewrites an unsupported longevity claim", () => {
  const answer = "Neon's free plan is permanent with no time limit.";
  const result = guardCalibration("What are the free tier limits?", answer, sources);
  assert.doesNotMatch(result.answer, /permanent/);
  assert.match(result.answer, /sources do not state/i);
  assert.equal(result.rewritten.length, 1);
});

test("keeps the claim when a source states it", () => {
  const withSource = [
    { ...sources[0], content: "The free plan is permanent with no time limit." },
  ];
  const answer = "Neon's free plan is permanent with no time limit.";
  const result = guardCalibration("What are the free tier limits?", answer, withSource);
  assert.match(result.answer, /permanent/);
  assert.equal(result.rewritten.length, 0);
});

test("does not rewrite when the question asked about expiry", () => {
  const answer = "The free plan never expires.";
  const result = guardCalibration("Does the free plan ever expire?", answer, sources);
  assert.match(result.answer, /never expires/);
  assert.equal(result.rewritten.length, 0);
});

test("never returns an empty answer", () => {
  const result = guardCalibration("Limits?", "Permanent.", sources);
  assert.equal(result.answer, "Permanent.");
  assert.equal(result.rewritten.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `calibration.js` not found.

- [ ] **Step 3: Implement**

```ts
// calibration.ts
//
// "Sources do not state" contract in code. F-004 was an unhedged claim the
// model produced when sources said nothing about longevity; a prompt line did
// not stop it, so the rule is enforced after the answer instead.
import type { SearchResult } from "./search.js";

export type CalibrationResult = { answer: string; rewritten: string[] };

const ABSOLUTE = /\b(?:permanent|no time limit|never expires?|genuinely free|always free|forever|indefinitely|no expiration)\b/i;
const EXPIRY_QUESTION = /\b(?:expire|expiry|permanent|forever|time limit|indefinite)\b/i;
const SENTENCE = /(?<=[.!?])\s+/;

function subjectOf(sentence: string): string {
  const match = /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)?)\b/.exec(sentence);
  return match ? match[1] : "this plan";
}

export function guardCalibration(
  question: string,
  answer: string,
  sources: SearchResult[]
): CalibrationResult {
  const parts = answer.split(SENTENCE);
  if (parts.length <= 1 || EXPIRY_QUESTION.test(question)) {
    return { answer, rewritten: [] };
  }

  const sourceText = sources.map((s) => `${s.title}\n${s.content}`).join("\n");
  const rewritten: string[] = [];
  const kept: string[] = [];

  for (const part of parts) {
    if (!ABSOLUTE.test(part) || ABSOLUTE.test(sourceText)) {
      kept.push(part);
      continue;
    }
    const subject = subjectOf(part);
    kept.push(
      `The retrieved sources do not state whether ${subject} expires or is time-limited.`
    );
    rewritten.push(part);
  }

  if (kept.length === 0) return { answer, rewritten: [] };
  return { answer: kept.join(" ").trim(), rewritten };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/calibration.ts test/calibration.test.ts
git commit -m "feat(calibration): enforce a sources-do-not-state contract"
```

---

### Task 3: Wire ranking and calibration into the answer path and trace

**Files:**
- Modify: `src/agent.ts`, `src/trace.ts`, `test/trace.test.ts`

**Interfaces:**
- Consumes: `rankByFreshness` from `search.ts`; `guardCalibration` and `CalibrationResult` from `calibration.ts`.
- Produces: ranked sources in traces and tool output; a calibration phase in the trace with frontmatter `calibration_rewrites`.

- [ ] **Step 1: Write the failing trace test**

Add to `test/trace.test.ts`:

```ts
test("calibration rewrites render in the trace", () => {
  const dir = tempDir();
  try {
    const tracer = new Tracer("test", dir);
    tracer.calibration({ rewritten: ["The plan is permanent."] });
    const original = console.log;
    console.log = () => {};
    let path: string;
    try {
      path = tracer.flush();
    } finally {
      console.log = original;
    }
    const text = readFileSync(path, "utf8");
    assert.match(text, /## Calibration/);
    assert.match(text, /calibration_rewrites: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `t.calibration is not a function`.

- [ ] **Step 3: Implement trace support**

In `src/trace.ts`, add the event type and field:

```ts
export type CalibrationTrace = { rewritten: string[] };
```

```ts
  private calibrationInfo: CalibrationTrace | undefined;
```

Method:

```ts
  calibration(result: CalibrationTrace): void {
    this.calibrationInfo = result;
    this.events.push({
      type: "calibration",
      ts: new Date().toISOString(),
      ...result,
    });
  }
```

Frontmatter after `scope_removed`:

```ts
      `calibration_rewrites: ${this.calibrationInfo?.rewritten.length ?? 0}`,
```

Markdown section after the Scope section:

```ts
    if (this.calibrationInfo) {
      lines.push("", "## Calibration", "");
      if (this.calibrationInfo.rewritten.length === 0) {
        lines.push("_No rewrites._", "");
      } else {
        for (const sentence of this.calibrationInfo.rewritten) {
          lines.push(`- rewrote: ${tableCell(sentence)}`);
        }
        lines.push("");
      }
    }
```

- [ ] **Step 4: Wire agent.ts**

Add the calibration import:

```ts
import { guardCalibration } from "./calibration.js";
```

Extend the existing `./search.js` import to include `rankByFreshness` — do not
add a second import from the same module:

```ts
import {
  createSearch,
  rankByFreshness,
  type SearchResult,
  type EnrichedSource,
} from "./search.js";
```

In the ordinary answer branch, after the sources array is collected and before the grounding block, rank the sources:

```ts
    const rankedSources = rankByFreshness(sources);
```

Use `rankedSources` everywhere in the grounding block instead of `sources`:
- the fast-path date check,
- `selectUrls(rankedSources, 2, config.maxPageFetches)`,
- the `enriched` mapping.

Prefer search metadata over text extraction when enriching:

```ts
        return {
          ...source,
          pageText,
          publishedAt: extractSourceDate(text) ?? source.publishedAt ?? null,
        };
```

After the grounding block and before `guardScope`, insert calibration:

```ts
    const calibrated = guardCalibration(userText, answer, rankedSources);
    tracer.calibration(calibrated);
    answer = calibrated.answer;
```

Keep the rest (`guardScope`, final log, ledger, conclude) unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test && npm run typecheck && npm run eval`
Expected: PASS; offline eval still 18/18.

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/trace.ts test/trace.test.ts
git commit -m "feat(agent): rank sources by freshness and calibrate answer claims"
```

---

### Task 4: Verify live eval and update documentation

**Files:**
- Modify: `README.md`, `DESIGN.md`, `FAILURES.md`

- [ ] **Step 1: Run the live sweep**

Run: `npm run eval:live`
Expected: report in `eval/results/<timestamp>.md`. `calibration-001` and
`recency-001` should pass more consistently. If either still fails, quote the
judge's reason in the relevant failure entry and keep it open.

- [ ] **Step 2: Update README**

In the "Answer grounding" section, add: "Search results are ranked by Tavily's
publication date before the model sees them, so a current source appears ahead
of a launch-era one. A calibration guard rewrites absolute longevity claims
that no retrieved source states into 'sources do not state' wording."

In the "Traces" section, add calibration to the list of recorded phases.

- [ ] **Step 3: Update DESIGN.md**

Add to "How it works" a short step about freshness ranking and calibration.
Add a "Why" bullet: "Freshness is a retrieval decision, not a model instruction:
the model can only prefer what it sees first. Calibration follows the same
rule as scope — enforce in code what a prompt only sometimes achieves." Remove
F-004 and F-006 from "What I'd do with another week" if the live eval passes;
if either remains flaky, describe precisely what is left.

- [ ] **Step 4: Update FAILURES.md**

For F-004 and F-006, append an evidence block with the live eval date, the
case id, the judge's reason, and the new status (`fixed` only if the case
passed; otherwise keep the current status with the new evidence).

- [ ] **Step 5: Final verification and push**

```bash
npm test && npm run typecheck && npm run db:check && npm run eval
git add README.md DESIGN.md FAILURES.md src/
git commit -m "docs: record freshness and calibration results"
git push origin main
```
