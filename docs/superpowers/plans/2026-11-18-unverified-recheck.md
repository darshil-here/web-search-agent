# Unverified re-check answers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: test-driven-development. Write
> each test, watch it fail, then implement. Commit once at the end.

**Goal:** stop a re-check answer from presenting an unverified recorded value
as current; close the live `brief-3` failure.
**Spec:** `docs/superpowers/specs/2026-11-18-unverified-recheck-design.md`

## Global constraints

- `guardUnverified` is pure: no model, no network, no DB.
- Same sentence splitter and no-op contract as `scope.ts` / `calibration.ts`.
- The hard-constraint message is a developer message in the re-check answer
  call, not a change to the global system prompt.
- Offline eval stays 18/18 and 112 existing tests stay green.
- One commit at the end.

## File structure

- `src/unverified.ts` — new pure guard.
- `src/recheck.ts` — constraint message, guard wiring, new report field.
- `src/trace.ts` — render the rewrites.
- `test/unverified.test.ts`, `test/recheck.test.ts`, `test/trace.test.ts` — extend.
- `eval/cases.ts` — strengthen `brief-3`.
- `FAILURES.md`, `README.md`, `DESIGN.md` — documentation.

---

### Task 1: Write the failing tests

**Files:** `test/unverified.test.ts` (new), `test/recheck.test.ts`, `test/trace.test.ts`

1. New `test/unverified.test.ts` with four cases:
   - `rewrites a sentence that states an unverified value as current` — expect
     the answer to contain "could not verify a current value", the subject,
     attribute, value and recorded date, and `rewritten.length === 1`.
   - `keeps a recorded value framed as a past observation` — "I recorded
     $19/month last Tuesday…" is unchanged.
   - `keeps a sentence that says the value could not be verified` — hedge kept.
   - `is a no-op with no unverified claims` — answer identical, no rewrites.

2. Extend `test/recheck.test.ts` with two cases:
   - `an answer that ignores the diff is rewritten`: stub `turn` returns "The
     current price is still $19/month." with the claim's fresh status
     `not_found`; assert `report.answer` contains "could not verify" and
     `report.guard.rewritten.length === 1`.
   - `the answer call is told not_found rows are unverified`: capture
     `request.input` from a stub `turn`; assert a developer message contains
     "not_found" and "Never present its recorded value as the current value".

3. Extend `test/trace.test.ts`: a recheck report with a `guard` rewrite renders
   `recheck_rewrites: 1` and the rewritten sentence in the markdown.

Run `npm test` and confirm each new test fails because the feature is missing.

### Task 2: Implement the guard

**Files:** `src/unverified.ts` (new)

Implement `guardUnverified` exactly as the spec describes: sentence split,
value substring match, history and hedge patterns, canonical rewrite, no-op
when there is nothing to rewrite.

Run `npm test test/unverified.test.ts` until green.

### Task 3: Wire it into the re-check path

**Files:** `src/recheck.ts`, `src/trace.ts`

1. Add `UNVERIFIED_CONSTRAINT` and append it as a developer message to the
   answer call input, after the diff.
2. Derive `unverified` from `fresh` (`status === "not_found"` or `mismatch`),
   apply `guardUnverified` to the model's answer after the empty/stop-reason
   check, and set `report.guard`.
3. Add optional `guard` to `RecheckTrace`, `recheck_rewrites` to the front matter,
   and the "## Unverified claims" markdown section.

Run `npm test && npm run typecheck` until green.

### Task 4: Strengthen the eval regression

**Files:** `eval/cases.ts`

Extend `brief-3`'s probe with a canned current-value answer through
`guardUnverified`; extend `check` to require the rewrite. Run `npm run eval` —
expect 18/18.

### Task 5: Documentation and commit

**Files:** `FAILURES.md`, `README.md`, `DESIGN.md`

- Add F-011 with the live `brief-3` judge evidence; close F-010's remaining gap.
- Document the guard in README and DESIGN; remove the closed gap from
  "another week".
- Run `npm test && npm run typecheck && npm run eval`.
- Commit with: `fix(recheck): never present unverified values as current`.
