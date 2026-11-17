# Temporal re-check pipeline (step 3) — design

**Date:** 2026-11-17
**Status:** design approved in dialogue; awaiting written-spec review

## Goal

Make the agent answer the brief's temporal questions — "has pricing changed
since then?", "is your answer still correct today?" — by comparing claims it
previously recorded against fresh web data, with dated, sourced deltas. The
claim ledger (schema v2) already has a writer; this feature adds its first
reader. No new capability is exposed to the model as a tool.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Detection | Pure code: date reference + re-check phrase. No classifier call. |
| Answer path | Build a structured diff, inject as developer context, one model call writes the conversational answer. |
| Re-check answer call | Still offers `web_search` as a safety valve; prompt says answer from the diff; trace records whether it was used. |
| Write-back | Changed values supersede via `recordClaims`; every check also writes a `verifications` row. |
| Structure | Dedicated pipeline branch with parallel searches (approach A), not a guided model loop. |
| Detection module | Separate `detect.ts`, independently testable. |
| Date requirement | A date reference is required. A bare "is that still correct?" does not trigger. |

## Architecture and control flow

`agent.ts` remains the orchestrator. Up to and including saving the user turn,
`turn()` is unchanged. It then branches:

```
detectRecheck(userText, now, tz)  →  null | { date, phrase }
   ├─ null  →  existing tool loop, unchanged
   └─ match →  recheck() branch:
        1. claimsForDate(session, date); if empty, use openClaims(session)
        2. one search query per distinct subject, fired in Promise.all
           (bounded by MAX_RECHECK_SEARCHES, default 8)
        3. one structured-output call extracts fresh value/url/quote/status
           per claim from all search results
        4. build a diff block: subject, old value → new value,
           changed/unchanged/not_found, dated sources
        5. one model call with the diff block as developer context,
           web_search still available, writes the user-facing answer
   both branches → save answer → trace
```

The re-check branch performs its own write-back (section "Write-back rules").
The ordinary `ledger()` call from step 2 is skipped on the re-check path: its
facts are already recorded by `writeBack`, so a second extraction would be a
duplicate LLM call.

The model's `web_search` tool definition is untouched. On the re-check path the
pipeline calls the same `webSearch` function directly — code-level retrieval,
exactly as the notebook already does. The "one tool" rule therefore still holds:
there is one search function and the model cannot call anything else.

Two model calls maximum on the re-check path (extract, answer), independent of
`MAX_STEPS`. This is fewer than the normal path can use.

## Components

### `detect.ts` (new, pure)

`detectRecheck(text, now, tz): RecheckIntent | null`

- Uses `parseDateRefs` from `dates.ts` for the date reference.
- Re-check phrases (case-insensitive): `still correct`, `still true`, `still
  accurate`, `has ... changed`, `changed since`, `shipped since`, `any updates
  since`, `since then`, `different now`.
- Requires **both** a date ref and a phrase. The date ref may be in an earlier
  sentence ("Last Tuesday I asked about Postgres. Has any pricing changed since
  then?").
- Must return null for plain history recall ("what did I ask on 3 November?")
  and for non-temporal questions ("compare the free tiers of Neon and
  Supabase").
- Returns `{ date, phrase }` — the resolved `YYYY-MM-DD` local date and the
  phrase that matched, both recorded in the trace. When a message names several
  dates ("what did I ask on 3 November? is it still correct today?"), use the
  **earliest** date ref: the re-check compares against a past observation, and
  "today" is the comparison point, not the observation being tested.

### `recheck.ts` (new)

- `buildQueries(claims): string[]` — one query per distinct `subject`,
  combining subject and attribute (e.g. `Node.js latest LTS release`). Dedupe
  repeated subjects.
- `extractFreshValues(oldClaims, sources, ...)` — one structured-output call.
  Returns one result per claim: `{ value, url, quote, status }` where status is
  `changed | unchanged | not_found`. A URL not present in the retrieved sources
  is stripped (same guard as `claims.ts`). `not_found` when the sources do not
  state a current value. If extraction returns no row for a claim, that claim
  is treated as `not_found` — never silently dropped from the diff.
- `buildDiff(oldClaims, fresh): { text, results }` — renders the developer
  context block with old value, new value, status, observed dates and URLs;
  returns the structured results for write-back and tracing.
- `recheck(ctx, intent, userText, ...)` — orchestrates the five steps above and
  returns the answer text. Calls `writeBack` after the answer is saved.

### `db.ts` (schema v3)

```sql
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
```

Functions: `saveVerification`, `verificationsForClaim`, `recentVerifications`.
Migration is additive; existing v2 databases upgrade via the existing
`user_version` mechanism.

### `trace.ts`

A `recheck` event and a "Re-check" markdown section recording: matched date and
phrase, claims checked, queries run, per-claim status, number of searches that
failed, write-back counts, latency, and whether the answer call used
`web_search`.

## Write-back rules

| diff status | `claims` table | `verifications` row |
|---|---|---|
| `changed` | `recordClaims` inserts new row; old row gets `valid_until` and `superseded_by` | yes, with new value + URL |
| `unchanged` | no new row (idempotent) | yes — proves the belief was re-tested |
| `not_found` | old claim stays open; absence of evidence is not evidence of change | yes, no value |

Write-back is best-effort: failures are traced, never thrown.

## Error handling and edge cases

- **Nothing to check** — no claims on the named date and no open claims: answer
  directly that no prior claim exists for that date, with zero searches.
- **Partial search failure** — proceed with successful subjects; mark failed
  subjects `not_found`.
- **All searches fail** — answer that the re-check could not be performed. No
  comparison is fabricated from an empty result set.
- **Extraction failure** — trace the error and answer that the re-check could
  not be completed rather than guessing from raw snippets.
- **Mixed results** — report every claim, including unchanged and not_found
  rows, with dates and URLs.
- **Write-back failure** — traced, non-fatal.
- **Model drift** — the answer call retains `web_search`; the trace records use
  so drift is observable.

## Testing (no network)

Stubbed `webSearch` and stubbed model throughout.

1. Detection: all three brief examples detected; plain history recall and
   non-temporal comparison not detected; date ref from a prior sentence works.
2. Query building: one per distinct subject, includes attribute, dedupes.
3. Fresh extraction: maps results to the correct claim, strips invented URLs,
   returns `not_found` when sources are silent.
4. Diff rendering: old → new, status labels, dates, URLs.
5. Write-back: changed supersedes; unchanged writes only a verification;
   not_found leaves the claim open.
6. Fallback: no claims on the named date uses `openClaims`.
7. End-to-end with stubs: recheck returns a diff and makes the expected calls.
8. Migration: a v2 database opens at v3 with the verifications table.

## Files touched

`detect.ts`, `recheck.ts`, `detect.test.ts`, `recheck.test.ts` (new); `db.ts`,
`agent.ts`, `trace.ts`, `package.json` (test script); `README.md`, `DESIGN.md`.

## Out of scope

Page fetching beyond Tavily snippets, source-date extraction, a grounding
critic on ordinary answers, and the general eval set remain later steps. This
change is only the re-check path and its persistence.
