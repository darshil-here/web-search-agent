# web-search-agent

A TypeScript chat agent with one tool: `web_search`. It remembers what you asked
and when, in SQLite, and answers questions about earlier turns from that record
rather than from a bigger prompt.

## Run

```sh
npm install
cp .env.example .env
# fill in the values in .env
npm run dev
```

`npm run dev` opens a chat session on stdin. `exit` or Ctrl-D ends it. A single
question can also be passed as an argument: `npm start -- "what is 17 times 23"`.

## Layout

- `src/` — the agent, split by responsibility (see `DESIGN.md`).
- `test/` — unit and pipeline tests; `npm test` discovers them.
- `eval/` — the acceptance set: `cases.ts` (brief + LongMemEval + failure
  regressions), the offline/live runners, and gitignored reports.
- `scripts/` — `db-check.ts`, a schema smoke check against a throwaway database.
- `data/` and `traces/` — runtime output, gitignored.

## Required environment variables

- `OPENAI_API_KEY` — API key used by the model client.
- `TAVILY_API_KEY` — API key used by the web search tool.
- `MODEL` — model identifier to run.

Optional, with defaults:

- `SESSION_ID` (default `local`) — which conversation's turns are read and written.
- `USER_TZ` (default `UTC`) — the timezone "today" and "yesterday" resolve in.
- `DB_PATH` (default `data/agent.db`) — SQLite file.
- `TRACES_DIR` (default `traces`) — where the per-run `.md`/`.jsonl` evidence goes.
- `MAX_STEPS` (default `5`) — model turns before the loop gives up and says so.
- `MAX_RECHECK_SEARCHES` (default `8`) — subjects a single temporal re-check may search.
- `MAX_PAGE_FETCHES` (default `6`) — pages fetched to ground one answer.

## Memory

Every user question and assistant answer is written to `data/agent.db` with two
timestamps: `created_at` (UTC, exact) and `local_date` (your date in `USER_TZ`).
Before each model call the loop reads a small `<notebook>` block — the turns for
a date you named, or the last few turns — and injects it as context. That is
retrieval, not a tool: the schema still holds exactly one tool.

The notebook is capped at 4 KB. When it drops turns it says so. It also
injects the session's open claims (current beliefs) after the turn history,
capped at 12, so follow-up questions can refer to facts as well as prose.

Reasoning effort is optional: if the model rejects `reasoning` with a 400, the
agent retries once without it, so swapping `MODEL` to a non-reasoning slug does
not break the agent. The fallback is visible in the trace.

## Claim ledger (schema v3)

Answers that used web search get one extra, non-fatal pipeline step: a
structured-output call extracts checkable facts as
`subject / attribute / value / url / quote` and stores them in a `claims` table.
A fact is never overwritten. If a later answer asserts a different value for
the same subject+attribute, the old row gets a `valid_until` date and a
`superseded_by` pointer to the new row. That validity chain is what makes
"has it changed since then?" answerable later.

Each claim stores both `observed_at` (UTC instant) and `local_date` (in
`USER_TZ`), for the same reason turns do: date recall must not break for the
hours when UTC and the user's date disagree. `valid_from` defaults to the
observed local date, since we only know when we *saw* a fact, not when it became
true.

Recording runs after the answer is saved. It is best-effort: extraction errors
are written to the trace, never thrown, so a ledger problem cannot fail a good
answer. Questions that needed no search skip the extra call entirely.

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

## Answer grounding

On the ordinary search path, answers that contain a table or at least three
numbers get one extra step: Tavily `/extract` fetches the top pages (two per
domain, `MAX_PAGE_FETCHES` total), publication dates are read from the text, and
a critic rewrites the answer so every factual claim carries an inline URL from
the retrieved set. Unsupported claims are marked "not stated in sources".
Simpler answers skip the fetch and critic, but every sourced answer still gets
a statement of whether the sources showed a publication date. Tavily's
publication dates rank search results before the model sees them, so a current
source appears ahead of a launch-era one. Two deterministic guards finish the
answer: `calibration.ts` rewrites absolute longevity claims no source states
into "sources do not state" wording, and `scope.ts` removes sentences
volunteering concepts the user did not ask about. All phases appear in the
trace.

## Commands

```sh
npm run dev        # chat
npm test           # date, model, ledger, re-check and trace tests, no network
npm run typecheck  # tsc --noEmit
npm run db:check   # exercise the schema against data/db-check.db
npm run db:reset   # delete data/agent.db
npm run eval       # 18 offline acceptance cases, no network
npm run eval:live  # same cases through the real CLI, answers judged by the model
```

## Eval set

`eval/cases.ts` holds 18 cases from three sources: the three examples in the
brief, the five LongMemEval categories, and one regression per logged failure.
Each case has a deterministic probe of the real pipeline (with stubbed model
and search) and a rubric describing a good answer.

`npm run eval` runs the probes — free and repeatable, and also part of `npm test`.
`npm run eval:live` runs each case through the real CLI in a throwaway session,
then asks the model to judge the answer against its rubric; the report is written
to `eval/results/`. A nonzero exit means at least one case failed. The four
failures still expected in the live sweep are F-002, F-003, F-005 and F-006 —
the open grounding, citation, scope and recency failures in `FAILURES.md`.

## Traces

Each turn writes `traces/<date>-<time>-<slug>.md` and `.jsonl`: steps, tokens,
latency, search queries, sources, the notebook that was injected, the claims
recorded (including extraction errors), the re-check diff, the grounding
critic and scope phases, and a verdict
(`ok`, `incomplete`, `error`). Set `TRACES_DIR` to move them. Runtime traces are
gitignored; the ones `FAILURES.md` cites are committed under `traces/curated/`
and `eval/curated/`, so every citation resolves.
