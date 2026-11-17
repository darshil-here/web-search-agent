# Answer Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four live-eval failures F-002, F-003, F-005 and F-006 with page fetching, a grounding critic, source-date extraction and a deterministic scope guard.

**Architecture:** On the ordinary search path only, after the model answers, fetch full page text for the top sources, extract publication dates, run a conditional critic that attaches a source URL to every factual claim, then apply a code-level scope guard. The re-check path is unchanged. All new steps are best-effort and traced.

**Tech Stack:** TypeScript (NodeNext, strict), Tavily `/extract` via `fetch`, OpenAI Responses API structured outputs, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-17-answer-grounding-design.md`

## Global Constraints

- No new npm dependency. Page text comes from Tavily `/extract` (same API key).
- One tool only: `web_search`. Page fetching is code-level retrieval, never a model tool.
- `selectUrls`: at most 2 URLs per hostname, at most 6 total (configurable).
- The critic runs only when `needsGrounding(answer)` is true: a markdown table line or at least 3 distinct numeric tokens.
- Every URL the critic emits is validated against the URLs actually retrieved; invalid ones are stripped.
- Unsupported claims are rendered as "not stated in sources", never silently deleted.
- The scope guard is pure, uses the concept vocabulary, and never produces an empty answer.
- All new steps are non-fatal: a failure returns the original answer and records an error in the trace.
- The re-check answer path is untouched.
- Commit after each task with the exact message given.

---

## File Structure

- `src/search.ts` — add the `EnrichedSource` type next to `SearchResult`. Modify.
- `src/pages.ts` — URL selection and Tavily extract. Create.
- `src/source-date.ts` — pure date regex. Create.
- `src/critic.ts` — grounding decision, structured call, URL validation. Create.
- `src/concepts.ts` — add `unaskedSibling`. Modify.
- `src/scope.ts` — sentence-level scope guard. Create.
- `src/config.ts` — `maxPageFetches` (default 6). Modify.
- `src/agent.ts` — wire the four steps into the answer path. Modify.
- `src/trace.ts` — `critic` and `scope` events + markdown sections. Modify.
- `test/*.test.ts` — one new test file per new module; extend config and trace tests.
- `README.md`, `DESIGN.md`, `FAILURES.md` — document and update statuses from live eval.

---

### Task 1: Enriched source type and page fetching

**Files:**
- Modify: `src/search.ts`
- Create: `src/pages.ts`
- Modify: `src/config.ts`
- Test: `test/pages.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `SearchResult` from `src/search.ts`, config env.
- Produces:
  - `EnrichedSource = SearchResult & { pageText: string | null; publishedAt: string | null }`
  - `selectUrls(sources: SearchResult[], perDomain?: number, max?: number): string[]`
  - `createFetch(apiKey: string): (urls: string[]) => Promise<FetchedPage[]>`
  - `FetchedPage = { url: string; text: string | null }`
  - config field `maxPageFetches: number` (default 6)

- [ ] **Step 1: Write the failing tests**

Create `test/pages.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { selectUrls, createFetch } from "../src/pages.js";
import type { SearchResult } from "../src/search.js";

const results: SearchResult[] = [
  { title: "a", url: "https://neon.com/pricing", content: "x" },
  { title: "b", url: "https://neon.com/docs", content: "x" },
  { title: "c", url: "https://neon.com/blog", content: "x" },
  { title: "d", url: "https://supabase.com/pricing", content: "x" },
  { title: "e", url: "https://supabase.com/docs", content: "x" },
  { title: "f", url: "https://example.com/other", content: "x" },
  { title: "g", url: "https://example.com/again", content: "x" },
];

test("selectUrls allows at most two URLs per domain and six total", () => {
  const selected = selectUrls(results, 2, 6);
  assert.equal(selected.length, 6);
  assert.equal(selected.filter((u) => u.includes("neon.com")).length, 2);
  assert.equal(selected.filter((u) => u.includes("supabase.com")).length, 2);
});

test("selectUrls drops exact duplicate URLs", () => {
  const dupes = [...results, { ...results[0] }];
  assert.equal(new Set(selectUrls(dupes, 2, 20)).size, selectUrls(dupes, 2, 20).length);
});

test("createFetch maps results and failed_results without throwing on a failed URL", async () => {
  const calls: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return {
      ok: true,
      json: async () => ({
        results: [{ url: "https://a.test", raw_content: "page text" }],
        failed_results: [{ url: "https://b.test" }],
      }),
    } as Response;
  };
  try {
    const fetch = createFetch("tvly-test");
    const pages = await fetch(["https://a.test", "https://b.test"]);
    assert.deepEqual(pages, [
      { url: "https://a.test", text: "page text" },
      { url: "https://b.test", text: null },
    ]);
    assert.equal((calls[0] as { body: { chunks_per_source: number } }).body.chunks_per_source, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("createFetch returns an empty list when the HTTP call fails", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" }) as Response;
  try {
    assert.deepEqual(await createFetch("tvly-test")(["https://a.test"]), []);
  } finally {
    globalThis.fetch = original;
  }
});
```

Add to `test/config.test.ts`:

```ts
// In "the required keys are read and the rest default":
assert.equal(config.maxPageFetches, 6);
// In "every optional key overrides its default", add to the env:
MAX_PAGE_FETCHES: "3",
// and assert:
assert.equal(config.maxPageFetches, 3);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules `pages.js` not found; `maxPageFetches` undefined.

- [ ] **Step 3: Implement**

In `src/search.ts`, add after `SearchResult`:

```ts
/** A search hit after page text and a publication date have been attached. */
export type EnrichedSource = SearchResult & {
  pageText: string | null;
  publishedAt: string | null;
};
```

Create `src/pages.ts`:

```ts
// Code-level page retrieval. Tavily /extract returns clean text for URLs we
// already have from /search, so the model can be graded on full pages rather
// than snippets without adding a scraping dependency.
import type { SearchResult } from "./search.js";

export type FetchedPage = { url: string; text: string | null };

const ENDPOINT = "https://api.tavily.com/extract";
export const DEFAULT_PER_DOMAIN = 2;
export const DEFAULT_MAX_PAGES = 6;

/** Dedupe by URL, cap per hostname, then cap total. */
export function selectUrls(
  sources: SearchResult[],
  perDomain = DEFAULT_PER_DOMAIN,
  max = DEFAULT_MAX_PAGES
): string[] {
  const perHost = new Map<string, number>();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    if (!source.url || seen.has(source.url)) continue;
    let host: string;
    try {
      host = new URL(source.url).hostname;
    } catch {
      continue;
    }
    const used = perHost.get(host) ?? 0;
    if (used >= perDomain) continue;
    seen.add(source.url);
    perHost.set(host, used + 1);
    out.push(source.url);
    if (out.length >= max) break;
  }
  return out;
}

export function createFetch(
  apiKey: string
): (urls: string[]) => Promise<FetchedPage[]> {
  return async (urls) => {
    if (urls.length === 0) return [];
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ urls, chunks_per_source: 2 }),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as {
        results?: Array<{ url: string; raw_content?: string }>;
        failed_results?: Array<{ url: string }>;
      };
      return [
        ...(body.results ?? []).map((r) => ({
          url: r.url,
          text: r.raw_content ?? null,
        })),
        ...(body.failed_results ?? []).map((r) => ({ url: r.url, text: null })),
      ];
    } catch {
      return [];
    }
  };
}
```

In `src/config.ts`, add `maxPageFetches: number;` to `Config`, and in `loadConfig`:

```ts
    maxPageFetches: positiveInt(env, "MAX_PAGE_FETCHES", 6),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts src/pages.ts src/config.ts test/pages.test.ts test/config.test.ts
git commit -m "feat(pages): fetch top source pages through Tavily extract"
```

---

### Task 2: Pure source-date extraction

**Files:**
- Create: `src/source-date.ts`
- Test: `test/source-date.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractSourceDate(text: string): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { extractSourceDate } from "../src/source-date.js";

test("extracts an ISO date after a label", () => {
  assert.equal(extractSourceDate("Updated: 2026-11-14\nPricing..."), "2026-11-14");
});

test("extracts a spelled-out date without a label", () => {
  assert.equal(extractSourceDate("Last reviewed 14 November 2025"), "2025-11-14");
});

test("extracts a month-first date", () => {
  assert.equal(extractSourceDate("Published March 3, 2026"), "2026-03-03");
});

test("returns null when no date is visible", () => {
  assert.equal(extractSourceDate("Free plan includes 10 GB storage."), null);
});

test("does not invent a date from a bare year", () => {
  assert.equal(extractSourceDate("Pricing updated for 2026"), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `source-date.js` not found.

- [ ] **Step 3: Implement**

```ts
// source-date.ts
//
// Publication dates, when a source shows one. Pure and conservative: a bare
// year is not a date, and a miss returns null rather than guessing.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/;
const DAY_MONTH = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(20\d{2})\b/i;
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2})\b/i;

function valid(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function extractSourceDate(text: string): string | null {
  // A label nearby is preferred, but a date anywhere in the text still counts.
  const search = (pattern: RegExp, build: (m: RegExpExecArray) => string | null) => {
    for (const match of text.matchAll(pattern)) {
      const date = build(match);
      if (date) return date;
    }
    return null;
  };

  return (
    search(ISO, (m) => valid(Number(m[1]), Number(m[2]), Number(m[3]))) ??
    search(DAY_MONTH, (m) =>
      valid(Number(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]))
    ) ??
    search(MONTH_DAY, (m) =>
      valid(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]))
    )
  );
}
```

Labels like "Published" or "Updated" are not required. The three patterns match
the date regardless of the word before it, which is enough: a date visible in
the source is what F-006 asks for, not the label attached to it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/source-date.ts test/source-date.test.ts
git commit -m "feat(dates): extract publication dates from source text"
```

---

### Task 3: Grounding critic

**Files:**
- Create: `src/critic.ts`
- Test: `test/critic.test.ts`

**Interfaces:**
- Consumes: `Llm`, `Usage` from `src/llm.ts`; `EnrichedSource` from `src/search.ts`.
- Produces:
  - `needsGrounding(answer: string): boolean`
  - `GroundResult = { answer: string; statements: number; dropped: number; note: string | null; error?: string; usage: Usage }`
  - `ground(llm: Llm, answer: string, sources: EnrichedSource[], question: string): Promise<GroundResult>`

- [ ] **Step 1: Write the failing tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { Llm } from "../src/llm.js";
import { needsGrounding, ground } from "../src/critic.js";
import type { EnrichedSource } from "../src/search.js";

const sources: EnrichedSource[] = [
  { title: "N", url: "https://n.test", content: "10 GB", pageText: null, publishedAt: null },
];

function llmReturning(payload: unknown, fail = false): Llm {
  return {
    structured: async () => {
      if (fail) throw new Error("model down");
      return { data: payload as never, usage: { prompt: 1, completion: 1, total: 2 } };
    },
    turn: async () => ({ text: "", stopReason: "budget" }),
  };
}

test("needsGrounding is true for tables and number-heavy prose", () => {
  assert.equal(needsGrounding("| a | b |\n|---|---|\n| 1 | 2 |"), true);
  assert.equal(needsGrounding("One is 10 GB, two is 20 GB, three is 30 GB."), true);
});

test("needsGrounding is false for plain prose", () => {
  assert.equal(needsGrounding("I do not know the answer."), false);
  assert.equal(needsGrounding("It costs $10 per month."), false);
});

test("ground attaches source URLs and marks unsupported statements", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Neon has 10 GB [https://n.test]. Supabase has 99 GB [https://invented.test].",
      statements: [
        { text: "Neon has 10 GB", url: "https://n.test", supported: true },
        { text: "Supabase has 99 GB", url: "https://invented.test", supported: false },
      ],
    }),
    "Neon has 10 GB. Supabase has 99 GB.",
    sources,
    "Compare the tiers"
  );
  assert.match(result.answer, /https:\/\/n\.test/);
  assert.doesNotMatch(result.answer, /invented\.test/);
  assert.match(result.answer, /not stated in sources/);
  assert.equal(result.dropped, 1);
});

test("ground appends a no-date note when no source has a date", async () => {
  const result = await ground(
    llmReturning({ revisedAnswer: "Costs $10 [https://n.test].", statements: [] }),
    "Costs $10.",
    sources,
    "What is the price?"
  );
  assert.match(result.answer, /no publication date/i);
  assert.ok(result.note);
});

test("ground keeps the original answer when the critic fails", async () => {
  const result = await ground(llmReturning({}, true), "Original.", sources, "Q");
  assert.equal(result.answer, "Original.");
  assert.equal(result.dropped, 0);
  assert.ok(result.error);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `critic.js` not found.

- [ ] **Step 3: Implement**

```ts
// critic.ts
//
// Post-answer grounding. The model rewrites its own answer so every factual
// claim carries an inline URL from the retrieved set. Code validates those
// URLs and marks unsupported claims; the model never gets a new tool.
import type { Llm, Usage } from "./llm.js";
import type { EnrichedSource } from "./search.js";

export type GroundResult = {
  answer: string;
  statements: number;
  dropped: number;
  note: string | null;
  error?: string;
  usage: Usage;
};

const NUMBER = /\b\d+(?:\.\d+)?\b/g;

export function needsGrounding(answer: string): boolean {
  const hasTable = answer.split("\n").some((line) => line.trimStart().startsWith("|"));
  const numbers = new Set(answer.match(NUMBER) ?? []);
  return hasTable || numbers.size >= 3;
}

const CRITIC_INSTRUCTIONS = `You revise a research answer so every factual claim is grounded.

You are given the original answer and the sources that were retrieved. Return:
- revisedAnswer: the same answer with the same markdown structure, but with an
  inline source URL beside every factual claim, written as [URL]. For a table,
  put the URL in the relevant cell. Use ONLY URLs from the source list.
- statements: one entry per factual claim with its text, the URL used, and
  supported: true if the source states it, false if it does not.
  A statement with supported: false must be rendered as "not stated in sources"
  in revisedAnswer instead of being asserted.

Do not add facts. Do not remove the answer's structure. If there are no sources,
return the original answer and an empty statements list.`;

const CRITIC_SCHEMA = {
  type: "object",
  properties: {
    revisedAnswer: { type: "string" },
    statements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          url: { anyOf: [{ type: "string" }, { type: "null" }] },
          supported: { type: "boolean" },
        },
        required: ["text", "url", "supported"],
        additionalProperties: false,
      },
    },
  },
  required: ["revisedAnswer", "statements"],
  additionalProperties: false,
};

type CriticData = {
  revisedAnswer: string;
  statements: Array<{ text: string; url: string | null; supported: boolean }>;
};

export async function ground(
  llm: Llm,
  answer: string,
  sources: EnrichedSource[],
  question: string
): Promise<GroundResult> {
  const allowed = new Set(sources.map((s) => s.url));
  const sourceBlock = sources
    .map(
      (s) =>
        `[${s.url}] ${s.title}` +
        (s.publishedAt ? ` (published ${s.publishedAt})` : "") +
        `\n${s.pageText ?? s.content}`
    )
    .join("\n\n");

  try {
    const { data, usage } = await llm.structured<CriticData>({
      name: "grounding_critic",
      schema: CRITIC_SCHEMA,
      instructions: CRITIC_INSTRUCTIONS,
      input: `QUESTION:\n${question}\n\nANSWER:\n${answer}\n\nSOURCES:\n${sourceBlock || "(none)"}`,
    });

    let revised = data.revisedAnswer || answer;
    // Strip URLs the critic invented. The transform is literal so markdown
    // structure and surrounding prose survive unchanged.
    for (const statement of data.statements ?? []) {
      if (statement.url && !allowed.has(statement.url)) {
        revised = revised.split(statement.url).join("");
      }
    }
    const dropped = (data.statements ?? []).filter((s) => !s.supported).length;
    if (dropped > 0 && !revised.includes("not stated in sources")) {
      revised += "\n\nClaims not stated in sources were marked as such.";
    }

    const hasDate = sources.some((s) => s.publishedAt !== null);
    const note = hasDate
      ? null
      : "No publication date was visible in the retrieved sources.";
    if (note) revised += `\n\n${note}`;

    return {
      answer: revised.trim() || answer,
      statements: (data.statements ?? []).length,
      dropped,
      note,
      usage,
    };
  } catch (err) {
    return {
      answer,
      statements: 0,
      dropped: 0,
      note: null,
      error: err instanceof Error ? err.message : String(err),
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/critic.ts test/critic.test.ts
git commit -m "feat(critic): ground answer claims with retrieved sources"
```

---

### Task 4: Deterministic scope guard

**Files:**
- Modify: `src/concepts.ts`
- Create: `src/scope.ts`
- Test: `test/scope.test.ts`, `test/concepts.test.ts`

**Interfaces:**
- Consumes: concept vocabulary in `src/concepts.ts`.
- Produces:
  - `unaskedSibling(question: string, text: string): string | null` (added to concepts.ts)
  - `ScopeResult = { answer: string; removed: string[] }`
  - `guardScope(question: string, answer: string): ScopeResult`

- [ ] **Step 1: Write the failing tests**

Add to `test/concepts.test.ts`:

```ts
import { unaskedSibling } from "../src/concepts.js";

test("an unasked release sibling is detected", () => {
  assert.equal(unaskedSibling("latest stable Node.js", "v27 alpha is experimental"), "alpha");
});

test("an asked-for sibling is not flagged", () => {
  assert.equal(unaskedSibling("stable vs alpha releases", "v27 alpha is experimental"), null);
});
```

Create `test/scope.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { guardScope } from "../src/scope.js";

test("removes an unprompted adjacent release sentence", () => {
  const answer =
    "The latest stable release is v26.13.1 (LTS). The 27.x line is currently Alpha.";
  const result = guardScope("What is the latest stable Node.js version?", answer);
  assert.match(result.answer, /v26\.13\.1/);
  assert.doesNotMatch(result.answer, /Alpha/);
  assert.equal(result.removed.length, 1);
});

test("keeps the sibling when the question asked for it", () => {
  const answer = "v26.13.1 is LTS. v27 alpha is experimental.";
  const result = guardScope("Compare stable and alpha Node.js", answer);
  assert.match(result.answer, /alpha/);
  assert.equal(result.removed.length, 0);
});

test("never returns an empty answer", () => {
  const result = guardScope("latest stable", "v27 alpha is experimental.");
  assert.equal(result.answer, "v27 alpha is experimental.");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `unaskedSibling` and `scope.js` not found.

- [ ] **Step 3: Implement**

Add to `src/concepts.ts` (scope uses a merged release family so "stable" and "alpha" count as siblings, unlike the attribute families above):

```ts
const SCOPE_FAMILIES: Array<Array<{ word: string; pattern: RegExp }>> = [
  [
    { word: "stable", pattern: /\bstable\b/i },
    { word: "LTS", pattern: /\blts\b|long[- ]term support/i },
    { word: "current", pattern: /\bcurrent\b/i },
    { word: "alpha", pattern: /\balpha\b/i },
    { word: "beta", pattern: /\bbeta\b/i },
    { word: "preview", pattern: /\bpreview\b/i },
  ],
  [
    { word: "free", pattern: /\bfree\b/i },
    { word: "paid", pattern: /\bpaid\b|\bpro\b|\bpremium\b/i },
  ],
];

/** A sibling concept present in `text` but absent from `question`, if any. */
export function unaskedSibling(question: string, text: string): string | null {
  for (const family of SCOPE_FAMILIES) {
    const inQuestion = family.filter((c) => c.pattern.test(question)).map((c) => c.word);
    if (inQuestion.length === 0) continue;
    const inText = family.find((c) => c.pattern.test(text));
    if (inText && !inQuestion.includes(inText.word)) return inText.word;
  }
  return null;
}
```

Create `src/scope.ts`:

```ts
// Scope enforcement in code, not in a prompt that the model may ignore. F-005
// was a rule the model followed intermittently; this makes it deterministic.
import { unaskedSibling } from "./concepts.js";

export type ScopeResult = { answer: string; removed: string[] };

const SENTENCE = /(?<=[.!?])\s+/;

export function guardScope(question: string, answer: string): ScopeResult {
  const parts = answer.split(SENTENCE);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const part of parts) {
    const sibling = unaskedSibling(question, part);
    if (sibling && parts.length > 1) {
      removed.push(part);
    } else {
      kept.push(part);
    }
  }

  if (kept.length === 0) return { answer, removed: [] };
  return { answer: kept.join(" ").trim(), removed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/concepts.ts src/scope.ts test/concepts.test.ts test/scope.test.ts
git commit -m "feat(scope): enforce answer scope in code, not the prompt"
```

---

### Task 5: Trace events for critic and scope

**Files:**
- Modify: `src/trace.ts`
- Test: `test/trace.test.ts`

**Interfaces:**
- Consumes: `GroundResult` from `critic.ts`, `ScopeResult` from `scope.ts`.
- Produces: `tracer.critic(result: GroundResult): void`, `tracer.scope(result: ScopeResult): void`; markdown sections "Grounding critic" and "Scope"; frontmatter `critic_statements`, `critic_dropped`, `scope_removed`.

- [ ] **Step 1: Write the failing tests**

Add to `test/trace.test.ts`:

```ts
import type { GroundResult } from "../src/critic.js";

test("critic and scope phases render in the trace", () => {
  const t = new Tracer("test", traceDir); // reuse the test's temp dir helper
  t.critic({
    answer: "revised", statements: 3, dropped: 1,
    note: "No publication date was visible in the retrieved sources.",
    usage: { prompt: 1, completion: 1, total: 2 },
  });
  t.scope({ answer: "revised", removed: ["the 27.x line is Alpha."] });
  const path = t.flush();
  const text = readFileSync(path, "utf8");
  assert.match(text, /## Grounding critic/);
  assert.match(text, /## Scope/);
  assert.match(text, /critic_statements: 3/);
  assert.match(text, /scope_removed: 1/);
});
```

Use the same temp-dir helper the existing trace tests use.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `t.critic is not a function`.

- [ ] **Step 3: Implement**

Add to `src/trace.ts`:

```ts
export type CriticTrace = {
  statements: number;
  dropped: number;
  note: string | null;
  error?: string;
};
export type ScopeTrace = { removed: string[] };
```

Add private fields `criticInfo: CriticTrace | undefined`, `scopeInfo: ScopeTrace | undefined`, and methods:

```ts
  critic(result: CriticTrace): void {
    this.criticInfo = result;
    this.events.push({ type: "critic", ts: new Date().toISOString(), ...result });
  }

  scope(result: ScopeTrace): void {
    this.scopeInfo = result;
    this.events.push({ type: "scope", ts: new Date().toISOString(), ...result });
  }
```

Add to frontmatter after `recheck_claims`:

```ts
      `critic_statements: ${this.criticInfo?.statements ?? 0}`,
      `critic_dropped: ${this.criticInfo?.dropped ?? 0}`,
      `scope_removed: ${this.scopeInfo?.removed.length ?? 0}`,
```

Add markdown sections after the "Claim ledger" block (use `tableCell` for any values containing `|`):

```ts
    if (this.criticInfo) {
      const c = this.criticInfo;
      lines.push(
        "", "## Grounding critic", "",
        "| statements | dropped | note |", "|----------:|--------:|------|",
        `| ${c.statements} | ${c.dropped} | ${tableCell(c.note ?? "—")} |`, ""
      );
      if (c.error) lines.push(`**Critic error:** ${c.error}`, "");
    }
    if (this.scopeInfo) {
      lines.push("", "## Scope", "");
      if (this.scopeInfo.removed.length === 0) {
        lines.push("_Nothing removed._", "");
      } else {
        for (const sentence of this.scopeInfo.removed) {
          lines.push(`- removed: ${tableCell(sentence)}`);
        }
        lines.push("");
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace.ts test/trace.test.ts
git commit -m "feat(trace): record grounding critic and scope phases"
```

---

### Task 6: Wire the four steps into the answer path

**Files:**
- Modify: `src/agent.ts`

**Interfaces:**
- Consumes: `createFetch`, `selectUrls` from `pages.ts`; `extractSourceDate` from `source-date.ts`; `needsGrounding`, `ground` from `critic.ts`; `guardScope` from `scope.ts`; `EnrichedSource` from `search.ts`; config `maxPageFetches`.
- Produces: the ordinary answer path now saves and traces the grounded, scoped answer.

- [ ] **Step 1: Add imports**

At the top of `src/agent.ts`, add:

```ts
import { createFetch, selectUrls } from "./pages.js";
import { extractSourceDate } from "./source-date.js";
import { ground, needsGrounding } from "./critic.js";
import { guardScope } from "./scope.js";
import type { EnrichedSource } from "./search.js";
```

Next to the existing `search`/`llm` setup:

```ts
const fetchPages = createFetch(config.tavilyApiKey);
```

- [ ] **Step 2: Insert the grounding pipeline before the final log**

In `turn()`, the ordinary branch currently does:

```ts
    tracer.log("\nFINAL:\n" + result.text);
    if (result.text.trim() !== "") {
      await ledger(ctx, tracer, result.text, sources, now, userText);
    }

    return conclude(ctx, tracer, result.text, "answered", modelCalls, runStart, now);
```

Replace it with:

```ts
    let answer = result.text;

    if (answer.trim() !== "" && sources.length > 0 && needsGrounding(answer)) {
      const pages = await fetchPages(
        selectUrls(sources, 2, config.maxPageFetches)
      );
      const enriched: EnrichedSource[] = sources.map((source) => {
        const pageText = pages.find((p) => p.url === source.url)?.text ?? null;
        const text = `${source.content}\n${pageText ?? ""}`;
        return {
          ...source,
          pageText,
          publishedAt: extractSourceDate(text),
        };
      });

      const grounded = await ground(llm, answer, enriched, userText);
      tracer.llmCall({
        label: "critic",
        step: null,
        ms: 0,
        usage: grounded.usage,
      });
      tracer.critic(grounded);
      if (grounded.error) {
        tracer.log(`(grounding critic failed: ${grounded.error}; using original answer)`);
      }
      answer = grounded.answer;
    }

    const scoped = guardScope(userText, answer);
    tracer.scope(scoped);

    tracer.log("\nFINAL:\n" + scoped.answer);
    if (scoped.answer.trim() !== "") {
      await ledger(ctx, tracer, scoped.answer, sources, now, userText);
    }

    return conclude(ctx, tracer, scoped.answer, "answered", modelCalls, runStart, now);
```

Note: the critic's own timing is folded into the answer call today; the trace still records its token usage and a `critic` event. The re-check branch above is untouched.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run eval`
Expected: PASS; offline eval stays 18/18.

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "feat(agent): ground and scope-check answers before saving"
```

---

### Task 7: Verify live eval and update documentation

**Files:**
- Modify: `README.md`, `DESIGN.md`, `FAILURES.md`

- [ ] **Step 1: Run the live sweep**

Run: `npm run eval:live`
Expected: report at `eval/results/<timestamp>.md`. The four cases `grounding-001`, `citation-001`, `recency-001`, `scope-001` should now pass. If any still fails, quote the judge's reason in that failure's entry and leave its status open — do not claim a fix that did not happen.

- [ ] **Step 2: Update README**

Add to the "Re-checks" area of `README.md`:

```markdown
## Answer grounding

On the ordinary search path, answers that contain a table or several numbers
get one extra step: Tavily `/extract` fetches the top pages, publication dates
are read from the text, and a critic rewrites the answer so every factual claim
carries an inline URL from the retrieved set. Unsupported claims are marked
"not stated in sources". A deterministic scope guard then removes sentences
volunteering concepts the user did not ask about. Both phases appear in the
trace. `MAX_PAGE_FETCHES` (default 6) bounds the page fan-out.
```

Add the env var to the optional list: `MAX_PAGE_FETCHES` (default `6`) — maximum pages fetched to ground one answer.

- [ ] **Step 3: Update DESIGN.md**

Add step 9 to "How it works" describing fetch → dates → critic → scope, and add a "Why" bullet: "Grounding is a pipeline concern. The model writes prose; code decides which URLs exist and which claims are supported. That is the same separation as memory-as-retrieval and the scope guard — enforce in code what the model otherwise follows only sometimes." Update "File ownership" with the four new modules. Move the now-closed failures out of "What I'd do with another week".

- [ ] **Step 4: Update FAILURES.md**

For each of F-002, F-003, F-005 and F-006 that the live eval now passes, set `**Status:** fixed` and append an evidence block quoting the eval case id, the date, and the judge's passing reason from the report. For any that still fails, append the judge's reason and keep the status open.

- [ ] **Step 5: Final verification and push**

Run:

```bash
npm test && npm run typecheck && npm run db:check && npm run eval
```

Expected: all green, 18/18 offline eval. Then:

```bash
git add README.md DESIGN.md FAILURES.md src/ scripts/
git commit -m "docs: record grounding results and close fixed failures"
git push origin main
```
