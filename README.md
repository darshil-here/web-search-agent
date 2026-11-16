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

## Required environment variables

- `OPENAI_API_KEY` — API key used by the model client.
- `TAVILY_API_KEY` — API key used by the web search tool.
- `MODEL` — model identifier to run.

Optional, with defaults:

- `SESSION_ID` (default `local`) — which conversation's turns are read and written.
- `USER_TZ` (default `UTC`) — the timezone "today" and "yesterday" resolve in.
- `DB_PATH` (default `data/agent.db`) — SQLite file.
- `MAX_STEPS` (default `5`) — model turns before the loop gives up and says so.

## Memory

Every user question and assistant answer is written to `data/agent.db` with two
timestamps: `created_at` (UTC, exact) and `local_date` (your date in `USER_TZ`).
Before each model call the loop reads a small `<notebook>` block — the turns for
a date you named, or the last few turns — and injects it as context. That is
retrieval, not a tool: the schema still holds exactly one tool.

The notebook is capped at 4 KB. When it drops turns it says so.

## Commands

```sh
npm run dev        # chat
npm test           # date parsing and notebook tests, no network
npm run typecheck  # tsc --noEmit
npm run db:check   # exercise the schema against data/db-check.db
npm run db:reset   # delete data/agent.db
```

## Traces

Each turn writes `traces/<date>-<time>-<slug>.md` and `.jsonl`: steps, tokens,
latency, search queries, sources, the notebook that was injected, and a verdict
(`ok`, `incomplete`, `error`). Traces are gitignored; `FAILURES.md` quotes the
runs it cites.
