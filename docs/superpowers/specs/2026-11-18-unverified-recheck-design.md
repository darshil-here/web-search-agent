# Unverified re-check answers — design

**Date:** 2026-11-18
**Status:** design approved in dialogue; the live `brief-3` failure is the trigger

## Goal

Stop a temporal re-check answer from presenting a recorded value as the current
value when the fresh search could not verify it. This is the gap F-010 left
open, and it is the reason `brief-3` — one of the three questions in the brief —
fails the live judge: the answer asserts the price is still $19/month despite
having no retrieved source for it.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Enforcement | Deterministic post-guard in code, following `calibration.ts` and `scope.ts`. The prompt is secondary; the code is the contract. |
| Which rows | A recorded claim whose fresh status is `not_found`, including the attribute-mismatch downgrade from `enforceAttributeMatch`. |
| What is rewritten | A sentence that names an unverified value without framing it as a past observation and without saying it could not be verified. It becomes an explicit "could not verify a current value" statement that still names the subject, attribute, recorded value and observed date. |
| What is kept | Only sentences that explicitly hedge it ("could not verify", "did not confirm", "not found"…). A past-tense marker alone ("recorded", "last Tuesday") is not an exemption: the rewrite preserves the value and date, and the live brief-3 failure mixed a past observation with a current assertion in one sentence. |
| Hard constraint | The re-check answer call also gets a developer message stating that `not_found` rows are unverified and their values must never be presented as current. |
| Trace | The rewrite count and the rewritten sentences appear in the re-check trace. |
| Eval | Strengthen the existing `brief-3` case rather than adding a 19th case, so the brief's own example is the regression guard. |

## Architecture and data flow

```
recheck(...)
  → fresh values (status not_found / mismatch = unverified)
  → collect unverified = { subject, attribute, value, localDate }[]
  → answer call gets <recheck-diff> + UNVERIFIED_CONSTRAINT developer message
  → guardUnverified(answer, unverified)
      → split into sentences
      → value present && !HEDGE  ⇒  rewrite to "could not verify"
      → otherwise keep as-is
  → RecheckReport.guard = { rewritten: [...] }
  → tracer.recheck(report) renders the rewrites
```

## Components

### `src/unverified.ts` (new)

Pure, no model and no network. One export:

```ts
export type UnverifiedClaim = {
  subject: string;
  attribute: string;
  value: string;
  localDate: string;
};
export type UnverifiedResult = { answer: string; rewritten: string[] };
export function guardUnverified(
  answer: string,
  unverified: UnverifiedClaim[]
): UnverifiedResult;
```

- No unverified claims, or no rewrites: return the answer unchanged with an
  empty `rewritten` array (same contract as `guardScope` / `guardCalibration`).
- Split on the same sentence boundary as the other guards: `/(?<=[.!?])\s+/`.
- A sentence is offending when it contains an unverified value (case-insensitive
  substring) and matches neither the history nor the hedge pattern.
- Rewrite template:
  `I could not verify a current value for <subject>'s <attribute> from fresh sources; <value> was recorded on <date> but is not confirmed as current.`

### `src/recheck.ts` (modify)

- Add the `UNVERIFIED_CONSTRAINT` developer message to the answer call input,
  immediately after the diff.
- After the answer call and the empty/stop-reason check, apply `guardUnverified`
  with the unverified claims derived from `fresh`.
- Add `guard: { rewritten: string[] }` to `RecheckReport`; `newReport` defaults
  it to an empty array. Keep the existing error paths unchanged.

### `src/trace.ts` (modify)

- Add optional `guard?: { rewritten: string[] }` to `RecheckTrace`.
- Add `recheck_rewrites` to the front matter and a short "## Unverified claims"
  section listing each rewritten sentence, mirroring the Calibration section.

### `eval/cases.ts` (modify)

- Extend the `brief-3` probe to run `guardUnverified` on a canned answer that
  states the recorded value as current, and return the result.
- Extend `brief-3`'s `check` to require that the answer was rewritten and no
  longer contains the bare current-value assertion.

### `FAILURES.md`, `README.md`, `DESIGN.md` (modify)

- Record F-011 with the live `brief-3` evidence and close F-010's "remaining
  gap" paragraph.
- Mention the guard in the re-check documentation and remove the closed gap
  from "What I'd do with another week".

## Rejected alternatives

- **Hide the recorded value from the answer call.** It removes the model's
  ability to say "I recorded $19 last Tuesday but could not re-confirm it",
  which is the honest answer we want. The guard keeps history and forbids only
  the current-value assertion.
- **Rely on the prompt alone.** F-005 already showed prompt-only discipline is
  intermittent; the ordinary answer path has code guards for exactly this
  reason.
- **A model classifier for currency.** A second call per re-check adds latency
  and cost, and the discipline is deterministic — the code can decide it.

## Verification

1. Unit tests for `guardUnverified`: rewrite, history kept, hedge kept, no-op.
2. Integration test in `recheck.test.ts`: an answer that ignores the diff is
   rewritten by `recheck`, and the answer call is told `not_found` rows are
   unverified.
3. `npm test && npm run typecheck && npm run eval` — offline eval stays 18/18,
   with the strengthened `brief-3` case passing.
