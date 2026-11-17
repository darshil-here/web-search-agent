# Answer grounding — design

**Date:** 2026-11-17
**Status:** design approved in dialogue; awaiting written-spec review

## Goal

Close the four live-eval failures that remain open: F-002 (unsupported
breadth), F-003 (citations not mapped to claims), F-005 (scope), and F-006
(source recency). All four are answer-quality failures on the ordinary search
path; none require changing the claim ledger or the re-check pipeline.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Page fetching | Tavily `/extract`, top 2 URLs per distinct domain, max 6, parallel; fall back to snippets on failure. |
| Grounding critic | One structured LLM call that rewrites the answer with an inline URL per factual claim and marks unsupported claims. Runs only for table/numeric-heavy answers. |
| Source dates | Pure regex over snippet + fetched text; no model call. Standard note appended when no date is visible. |
| Scope | Deterministic post-process over the final answer using the sibling-concept vocabulary in `concepts.ts`. |
| Pipeline order | search → fetch+dates → answer → critic → scope guard → save/trace/ledger |

## Architecture and data flow

`agent.ts` owns the answer path. Today: `llm.turn` → save → `ledger` → trace.
After this change:

```
llm.turn (search + one tool)
  → pages.fetch(top URLs from collected sources)   // new, ~1s, parallel
  → sourceDate.extract(snippet, pageText) per source // new, pure
  → critic.ground(answer, sources)                  // new, conditional LLM call
  → scope.guard(question, answer)                  // new, pure
  → save → ledger → trace
```

The re-check path is unchanged: its answer is already written from a diff that
lists sources, and its eval cases pass. If the critic or scope guard proves
useful there later, it can be reused; it is not applied in this change.

## Components

### `src/pages.ts` (new)

`createFetch(apiKey): (urls: string[]) => Promise<FetchedPage[]>` where
`FetchedPage = { url: string; text: string | null }`.

- POST to `https://api.tavily.com/extract` with `{ urls, chunks_per_source: 2 }`.
- Read both `results` and `failed_results`; a failed URL yields `text: null`
  rather than throwing. A total HTTP failure is non-fatal: return empty list.
- `selectUrls(sources, perDomain = 2, max = 6): string[]` — dedupe by URL, take
  at most two per hostname, cap at six, so one vendor cannot eat the budget.
- Enrich the existing `SearchResult` into `EnrichedSource` with `pageText` and
  `publishedAt`. Snippet text is always kept as the fallback.

### `src/source-date.ts` (new)

`extractSourceDate(text: string): string | null` — pure. Match, in order:
`Published/Posted/Updated/Last modified/Released:` followed by a date,
ISO `YYYY-MM-DD`, and `DD Month YYYY` / `Month DD, YYYY`. Return the matched
date as `YYYY-MM-DD`; normalize two-digit years only if unambiguous. A miss
returns null — never guess from the model's training data.

### `src/critic.ts` (new)

`ground(llm, answer, sources, question): Promise<GroundResult>` where
`GroundResult = { answer: string; statements: number; dropped: number; note?: string; usage: Usage }`.

- Structured output schema: `{ statements: [{ text, url, supported }] }`.
  The critic must preserve the answer's markdown structure and attach a URL
  from the provided source list to every factual statement; unsupported
  statements get `supported: false` and are rendered as
  "not stated in sources" rather than deleted (so the answer stays coherent).
- Code validates every URL against `sources.map(s => s.url)` and strips any
  that is not present — the same guard used by `claims.ts` and `recheck.ts`.
- `needsGrounding(answer): boolean` — true if the answer contains a markdown
  table (a line beginning `|`) or at least three distinct numeric tokens.
  Simple answers skip the critic entirely.
- If no source has `publishedAt`, append a single sentence:
  "No publication date was visible in the retrieved sources." This satisfies
  F-006's rubric deterministically.
- Failure is non-fatal: on a thrown error or parse failure, return the original
  answer with `dropped: 0` and an error note in the trace.

### `src/scope.ts` (new)

`guardScope(question: string, answer: string): ScopeResult` where
`ScopeResult = { answer: string; removed: string[] }`.

- Split the answer into sentences. Remove a sentence if it mentions a sibling
  concept from `concepts.ts` that the question does **not** mention, and the
  question does mention a different member of that family. Example: question
  "latest stable Node.js", answer sentence "the 27.x line is currently Alpha"
  → removed. A question that asks "stable vs alpha" keeps both.
- If removal would empty the answer, leave the answer unchanged (never produce
  a blank reply).
- Pure, no model call. Returned removals go to the trace.

## Error handling

- Extract HTTP error or `failed_results`: keep snippets, continue.
- Critic LLM error or bad JSON: keep original answer, trace the error.
- Scope guard never throws; regex based.
- Every new step is best-effort except that it must never degrade a correct
  answer into an empty one. The final answer is always non-empty when the model
  produced one.

## Testing (no network)

Stub the fetch and LLM boundaries.

1. `selectUrls`: dedupes, two per domain, cap six.
2. `extractSourceDate`: ISO, `Published:`, `DD Month YYYY`; null on miss.
3. `needsGrounding`: table and 3+ numbers true; plain prose false.
4. `ground`: attaches URLs, strips invented URLs, marks unsupported statements,
   appends the no-date note, keeps original on failure.
5. `guardScope`: removes an unasked alpha sentence for a stable question; keeps
   it when the question asked for it; never returns empty.
6. Trace: new phases appear in `.md`/`.jsonl`.
7. Re-run the 18-case eval: offline stays 18/18; live should move from 8/12 to
   12/12, or document precisely which rubric item remains unmet.

## Files touched

`src/pages.ts`, `src/source-date.ts`, `src/critic.ts`, `src/scope.ts` (new);
`src/search.ts`, `src/agent.ts`, `src/trace.ts`, `src/config.ts` (new limits);
new test files in `test/`; `README.md`, `DESIGN.md`, `FAILURES.md`.

## Out of scope

Page fetching and the critic are not applied to the re-check answer path.
No new npm dependency. No change to the claim ledger schema.
