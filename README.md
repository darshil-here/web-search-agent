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
- `MAX_RECHECK_SEARCHES` (default `12`) — queries (attribute plus change) a single temporal re-check may run.
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
empty), then searches each subject twice in parallel: once for the recorded
attribute and once for "changelog / release notes / new features since DATE".
The second query exists because "has anything changed?" is not only a price
question; brief-1 also asks whether a vendor shipped something big. One
structured-output call reads fresh values and any sourced notable change from
the retrieved text, and the model writes the answer from a dated diff.

The answer call is a single call with no tools. The per-subject searches have
already run, so letting the model search again let it spend its whole step
budget searching and return nothing (F-013). If that call still returns no text,
`renderDiffAnswer` renders the same diff in code — every subject, its recorded
value, the fresh status and the source — so a re-check always answers. The trace
records `answer_kind: model|fallback`, the re-check sources, and any fallback
reason; the live judge receives those sources too.

Changed values supersede in the ledger; every check — including "unchanged"
and "not found" — is written to a `verifications` table, so a fact that was
re-verified today is not mistaken for one never checked. Set
`MAX_RECHECK_SEARCHES` (default 12) to bound the fan-out.

"Not found" never becomes "still correct," and neither does a value whose
source never stated it: `enforceValueInSources` downgrades an `unchanged` or
`changed` result to `not_found` when the reported value appears in none of the
fresh sources, so the model cannot verify a claim against its own echo. The
answer call is told explicitly that an unverified row's recorded value is history, and `unverified.ts` rewrites
any sentence that presents it as current into a "could not verify" statement
that still names the recorded value and its date. Only sentences that assert
currency ("still", "current", "unchanged") are rewritten; an explicit hedge or
a sentence that merely mentions the value in the past is left alone. The answer
call never gets a search tool, so it cannot waste its step budget and return an
empty answer; if it returns nothing anyway, the diff is rendered in code. Every
rewrite is traced as `recheck_rewrites`.

## Answer grounding

On the ordinary search path, answers that contain a table or at least three
numbers get one extra step: Tavily `/extract` fetches the top pages (two per
domain, `MAX_PAGE_FETCHES` total), publication dates are read from the text, and
a critic rewrites the answer so every factual claim carries an inline URL from
the retrieved set. Unsupported claims are marked "not stated in sources".
`support.ts` then checks every numeric and absence claim against the source
cited beside it, cell by cell in a table. A value is kept when the cited text
states the full measure near the feature it belongs to, states the bare number
near that feature (sources often put the feature first: "Edge function
invocations | 500,000 per month"), or a verbatim quote from that page states
both. Anything else is replaced with "not stated in sources"; in a table the
whole clause is replaced, so a cell never reads "not stated in sources
snapshot". Citation URLs are matched by host and path and fragments of the same
page are merged before grading, so a tracked variant keeps its citation and a
value stated in one excerpt is not graded against only another excerpt of the
same page. The count is traced as `critic_replaced`. Simpler answers skip the fetch and
critic, but every sourced answer still gets a statement of whether the sources
showed a publication date. Tavily's
publication dates rank search results before the model sees them, so a current
source appears ahead of a launch-era one. Two deterministic guards finish the
answer: `calibration.ts` rewrites absolute longevity claims no source states
into "sources do not state" wording, and a universal claim ("both…", "neither…",
"they don't expire") needs that support for every product the question names,
and `scope.ts` removes sentences
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
EVAL_ONLY=grounding-001,calibration-001 npm run eval:live  # only those live cases
```

## Eval set

`eval/cases.ts` holds 18 cases from three sources: the three examples in the
brief, the five LongMemEval categories, and one regression per logged failure.
Each case has a deterministic probe of the real pipeline (with stubbed model
and search) and a rubric describing a good answer.

`npm run eval` runs the probes — free and repeatable, and also part of `npm test`.
`npm run eval:live` runs each case through the real CLI in a throwaway session,
then asks the model to judge the answer against its rubric; the report is written
to `eval/results/`. A nonzero exit means at least one case failed. The report
names the answer kind (`model` or `fallback`) next to each result, and failing
answers are printed with the sources the agent saw. Old reports are kept, not
overwritten.

**Latest full sweep, 2026-11-19** (`eval/curated/2026-11-19-full.md`): offline
**18/18**, live **9/12**. `brief-1` and `brief-2` pass (per-vendor coverage and
the recalled question); the nine passing live cases include every temporal,
memory, budget, citation and scope case. The three failures were then traced to
specific code paths and fixed: `support.ts` rejected a value glued to a
preceding word (`Image 17` + `5 GB`) and could not match a plural feature word;
`calibration.ts` missed reworded longevity claims; `agent.ts` trusted a
metadata date when the page showed only "Updated: 18 hours ago".

Re-running those three cases individually (`EVAL_ONLY`) confirms the fixes:
`grounding-001` and `recency-001` pass in
`eval/curated/2026-11-19-targeted-grounding-recency.md`, and `calibration-001`
passes in `eval/curated/2026-11-19-targeted-calibration.md`. A full 12-case
sweep was not repeated after the last fix because each sweep spends real model
and search credits; the report above is the measured full run, and the two
targeted reports are the measured verification of what changed.

## Traces

Each turn writes `traces/<date>-<time>-<slug>.md` and `.jsonl`: steps, tokens,
latency, search queries, sources, the notebook that was injected, the claims
recorded (including extraction errors), the re-check diff, the grounding
critic and scope phases, and a verdict
(`ok`, `incomplete`, `error`). Re-check runs also record `answer_kind:
model|fallback`, the re-check sources, and the reason for any fallback. Set
`TRACES_DIR` to move them. Runtime traces are
gitignored; the ones `FAILURES.md` cites are committed under `traces/curated/`
and `eval/curated/`, so every citation resolves.
