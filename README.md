# web-search-agent

A chat agent with one tool, web search, and a memory of facts rather than chat
history. Ask a current question and it answers with cited sources. Ask what you
asked last week, and whether the answer still holds, and it answers from its own
record instead of guessing.

Built for the minimi take-home.

## Quick start

```sh
npm install
cp .env.example .env   # add OPENAI_API_KEY and TAVILY_API_KEY
npm run dev
```

Open <http://localhost:3000>.

Node 20.12 or newer. Two keys: OpenAI (set `MODEL` to any model that supports
tool calling and JSON schema output) and Tavily for search. `npm install`
compiles one native dependency, `better-sqlite3`. If a key is missing the server
names it and exits.

## What to try

The three questions from the brief:

1. `On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?`
2. `What did I ask you on 3 November? Is your answer still correct today?`
3. `Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?`

On a cold start all three are honest: with no facts recorded for that date the
agent says so and asks for the missing detail. It does not announce a re-check
it cannot run.

To watch the memory work, ask a live question first, then ask about it:

1. `What does Notion Plus cost per member per month?`
2. `Earlier today I asked you about Notion. Has the price changed?`

The second turn reads the fact the first turn stored, searches again, and
answers from a dated diff.

## How it works

Each turn has four stages, all in `src/agent.ts`:

1. Recall. Build a small notebook from SQLite: the turns for a date you named,
   or the last few, plus the session's current facts.
2. Route. A question that names a date and asks whether something still holds
   takes the re-check path. Everything else runs the normal loop.
3. Answer. The normal path gives the model one tool, `web_search`, for at most
   five steps. Code ranks sources by freshness, then grounds table and
   number-heavy answers against the fetched pages.
4. Remember. One structured-output call extracts checkable facts (subject,
   attribute, value, URL, quote) into a ledger. A new value supersedes the old
   row instead of overwriting it, which is what makes "has it changed since?"
   answerable later.

The re-check path does not let the model search. It searches each recorded
subject twice (the value, then changelog or release notes), compares the fresh
values with the ledger in code, and writes the answer from that diff. If the
model returns nothing, code renders the diff itself.

Guards are functions, not prompt requests. `support.ts` checks each number and
absence claim against the page cited beside it. `unverified.ts` rewrites a
sentence that presents an unverified value as current. `calibration.ts` hedges
absolute claims no source supports. `scope.ts` removes sentences about things
you did not ask about. Every rewrite is traced.

More detail: [DESIGN.md](DESIGN.md) for the design, the tradeoffs, and three
failures that shaped the guards.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Web chat at <http://localhost:3000> |
| `npm run chat` | Chat in the terminal |
| `npm test` | Unit and pipeline tests, no network |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run eval` | Acceptance cases with stubbed model and search |
| `npm run eval:live` | The same cases through the real model, judged by the model |
| `npm run db:check` | Exercise the schema on a throwaway database |
| `npm run db:reset` | Delete the local conversation database |

`npm start` is an alias for `npm run chat`. `npm run chat -- "question"` answers
one question and exits.

## Configuration

`.env.example` lists every variable. Required: `OPENAI_API_KEY`,
`TAVILY_API_KEY`, `MODEL`.

Optional: `USER_TZ` (default `UTC`), `SESSION_ID` (default `local`), `PORT`
(default `3000`), `DB_PATH`, `TRACES_DIR`, `MAX_STEPS`,
`MAX_RECHECK_SEARCHES`, `MAX_PAGE_FETCHES`.

The web server binds to `127.0.0.1` and rejects other `Host` headers. It is
unauthenticated and spends your keys.

## Layout

- `src/` agent code, one module per responsibility. `agent.ts` is the turn
  pipeline, `server.ts` the HTTP and SSE wrapper, `db.ts` the schema.
- `test/` unit and pipeline tests, run with `node:test`.
- `eval/cases.ts` the acceptance set: the three brief questions, five
  LongMemEval categories, and regressions for the bugs that became guards.
- `web/` plain HTML, CSS and JS. No build step.
- `traces/` and `data/` runtime output, gitignored.

## Eval

`npm run eval` runs the probes with a stubbed model and search, so it is free
and repeatable. `npm run eval:live` runs each case through the real pipeline and
asks the model to judge the answer against a rubric. The last full sweep, on
2026-11-19, scored 18/18 offline and 10/12 live; both live failures were eval
visibility, not wrong answers.
