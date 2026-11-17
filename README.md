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

## Memory

Every user question and assistant answer is written to `data/agent.db` with two
timestamps: `created_at` (UTC, exact) and `local_date` (your date in `USER_TZ`).
Before each model call the loop reads a small `<notebook>` block — the turns for
a date you named, or the last few turns — and injects it as context. That is
retrieval, not a tool: the schema still holds exactly one tool.

The notebook is capped at 4 KB. When it drops turns it says so.

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

## Commands

```sh
npm run dev        # chat
npm test           # date, model, ledger, re-check and trace tests, no network
npm run typecheck  # tsc --noEmit
npm run db:check   # exercise the schema against data/db-check.db
npm run db:reset   # delete data/agent.db
```

## Traces

Each turn writes `traces/<date>-<time>-<slug>.md` and `.jsonl`: steps, tokens,
latency, search queries, sources, the notebook that was injected, the claims
recorded (including extraction errors), the re-check diff, and a verdict
(`ok`, `incomplete`, `error`). Set `TRACES_DIR` to move them. Traces are
gitignored; `FAILURES.md` quotes the runs it cites.
