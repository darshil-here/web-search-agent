# Answer quality — freshness and calibration

**Date:** 2026-11-17
**Status:** design approved in dialogue; awaiting written-spec review

## Goal

Finish F-006 (source recency) by ranking search results by freshness at search
time, and finish F-004 (calibration) by enforcing a "sources do not state"
contract in code. Both are answer-quality changes on the ordinary search path.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Freshness | Request `include_published_date`, rank dated results newest-first, undated last; relevance score breaks ties. Rank, do not drop undated results. |
| Dates in context | Pass `publishedAt` through the result so the model can prefer a current source. |
| Calibration | Pure post-process rewriting absolute longevity claims that no retrieved source states into "sources do not state" wording. |
| Order | Freshness at search time; calibration after the critic, before the scope guard. |
| Re-check path | Unchanged. |

## Architecture and data flow

```
search(query) → map published_date → rankByFreshness → model sees dated results
                                                       ↓
answer → critic (URL per claim) → calibration guard → scope guard → save/trace
```

## Components

### `src/search.ts` (modify)

`SearchResult` gains `publishedAt?: string | null`. `createSearch` sends
`include_published_date: true` and maps `published_date` to `publishedAt`.
`score` is captured for ranking but not exposed in the result (it is a Tavily
implementation detail).

`rankByFreshness(results: SearchResult[]): SearchResult[]` — pure. Dated
results first, descending by `publishedAt`; undated after, in original order.
Ties keep original order (Tavily's relevance ranking). A malformed date counts
as undated.

### `src/calibration.ts` (new)

`CalibrationResult = { answer: string; rewritten: string[] }`.

`guardCalibration(question, answer, sources): CalibrationResult`:

- Absolute-claim patterns: `permanent`, `no time limit`, `never expires`,
  `genuinely free`, `always free`, `forever`, `indefinitely`, `no expiration`.
- For each answer sentence matching a pattern, check whether any source's text
  (snippet + fetched page) contains the same pattern. If yes, keep the sentence
  — the source supports the claim. If no, replace it with:
  `The retrieved sources do not state whether <subject> expires or is time-limited.`
  where `<subject>` is the nearest subject noun in the sentence, or "this plan"
  as a neutral fallback.
- Never return an empty answer; never rewrite when the question asked whether
  something expires (that question invites the answer).
- Pure, no model call. Traced.

### Trace (modify)

`calibration` event and markdown section recording the rewritten sentences;
frontmatter `calibration_rewrites`.

## Testing (no network)

1. Search maps `published_date` and sends `include_published_date`.
2. `rankByFreshness`: dated before undated, newest first, ties stable, bad dates
   treated as undated.
3. Calibration rewrites an unsupported "permanent" sentence; keeps it when a
   source states it; never empties the answer; skips when the question asked
   about expiry.
4. Trace renders the new phase.
5. Offline eval stays 18/18. Live `calibration-001` and `recency-001` should
   pass more consistently, with the caveat that source selection still varies.

## Files touched

`src/search.ts`, `src/calibration.ts` (new), `src/agent.ts`, `src/trace.ts`,
new tests in `test/`, `README.md`, `DESIGN.md`, `FAILURES.md`.

## Out of scope

No change to the claim ledger, re-check pipeline, notebook, or config. No new
dependency.
