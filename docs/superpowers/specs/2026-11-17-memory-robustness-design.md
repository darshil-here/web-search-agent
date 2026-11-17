# Memory recall and robustness — design

**Date:** 2026-11-17
**Status:** design approved in dialogue (all four items); awaiting written-spec review

## Goal

Make current beliefs available to ordinary conversation (not just the re-check
path), make the model boundary tolerate non-reasoning model slugs, and make
every trace path cited in `FAILURES.md` resolvable in the public repo.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Claim recall | Inject open claims into the notebook as a block appended after turn blocks, so the byte-budget trim drops old turns first. |
| Claim cap | At most 12 claims, fields clipped to a small fixed length. |
| Reasoning guard | Retry once without `reasoning` when the model rejects a 400 mentioning it. No model-slug list. |
| Curated traces | Copy the four cited traces into `traces/curated/`, un-ignore that directory, and update `FAILURES.md` paths. Curate the final eval report too. |

## Architecture and data flow

```
buildNotebook(ctx, question, now)
  → turns (as today)
  → open claims block appended last
  → 4 KB budget trims oldest turn blocks first, claims survive
  → trace recall gains a claims count

ModelLlm.turn / structured
  → call with reasoning: { effort: "low" }
  → on 400 mentioning reasoning: retry once without it
  → on any other error: throw as today
```

## Components

### `src/notebook.ts` (modify)

Import `openClaims` from `db.ts`. After the turn blocks are built, append:

```
Current beliefs recorded in this conversation:
  - Node.js / latest stable version = v26.13.1 (observed 2026-11-17) [url]
```

- At most 12 open claims, oldest first.
- Each field clipped: subject 80, attribute 80, value 160, url 120 characters.
- Add `claims: number` to the `Notebook` type.
- The existing `render()` drops blocks from the front of `kept`; because the
  claims block is appended last, it survives the trim. The truncation notice
  still says earlier turns were omitted.
- If there are no claims, emit no block at all (no "No beliefs" noise).

### `src/trace.ts` (modify)

Add `claims: number` to the `Recall` type and to the "Notebook" markdown table
so the recall section shows how many beliefs were injected.

### `src/llm.ts` (modify)

Add a private helper:

```ts
async function createWithReasoningFallback(
  client: OpenAI,
  params: OpenAI.Responses.ResponseCreateParamsNonStreaming
): Promise<OpenAI.Responses.Response>
```

It calls `client.responses.create(params)`, and on an error whose `status` is
400 and whose message matches `/reasoning/i`, retries once with the `reasoning`
key removed. Both `structured()` and `turn()` call this helper instead of
`client.responses.create` directly. `turn()` keeps `reasoning: { effort: "low" }`
in its params; `structured()` sends no reasoning key.

Every retry is reported through `onEvent` as an llm call with the label
`"answer (no reasoning)"` so the fallback is visible in the trace rather than
silent. If the retry also fails, the error propagates.

### `traces/curated/` and `eval/curated/` (new, committed)

- Copy these four traces into `traces/curated/` with their original names:
  - `2026-11-17-001730-what-is-the-latest-stable-node-js-versio.md`
  - `2026-11-17-140139-what-did-i-ask-on-17-november-is-your-an.md`
  - `2026-11-17-151237-what-is-the-latest-stable-node-js-versio.md`
  - `2026-11-17-151457-is-your-answer-about-node-js-still-corre.md`
- Update `.gitignore` from `traces/` to `traces/*` plus `!traces/curated/` and
  `!traces/curated/*.md`, so only curated traces are committed.
- Update the four paths in `FAILURES.md` to `traces/curated/<name>`.
- Copy the most recent `eval/results/<timestamp>.md` (the one cited in
  `FAILURES.md`) into `eval/curated/final.md`; change `.gitignore` from
  `eval/results/` to `eval/results/` plus `!eval/curated/` and
  `!eval/curated/*.md`.

## Testing (no network)

1. Notebook injects open claims with the right shape and does not emit a block
   when there are none.
2. Under the 4 KB budget with many turns, the claims block survives while old
   turns are dropped; `claims` count appears in the result.
3. Reasoning fallback: a client that throws a 400 mentioning `reasoning` on the
   first call and succeeds on the second, with `reasoning` absent from the
   second params; a non-reasoning 400 is not retried; a failing retry throws.
4. Trace renders the claim count.
5. Every path cited in `FAILURES.md` exists as a committed file.
6. Offline eval stays 18/18.

## Files touched

`src/notebook.ts`, `src/trace.ts`, `src/llm.ts` (modify); new tests in `test/`;
`traces/curated/`, `eval/curated/`, `.gitignore`, `FAILURES.md`, `README.md`,
`DESIGN.md`.

## Out of scope

No ledger schema change, no change to the re-check or grounding pipelines, no
new dependency.
