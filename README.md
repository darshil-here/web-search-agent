# web-search-agent

A chat agent with one tool, web search, and a memory of facts rather than chat logs. Ask about something from last week, and whether the answer still holds. It answers from its own record instead of guessing.

## Run

Requires **Node >= 24.22.1**.

```sh
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>. If a required key is missing, the server names it and exits.

## Try these

**On a fresh database** (the three questions from the brief):

1. "On Monday we shortlisted 5 CRM tools for a 20 person sales team. Has any of them changed pricing or shipped something big since?"
2. "What did I ask you on 3 November? Is your answer still correct today?"
3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

With no facts recorded for those dates, it says so and asks for the details it needs instead of pretending it ran a recheck.

**To watch the memory work**, ask a live question first, then follow up:

1. "What does Notion Plus cost per member per month?"
2. "Earlier today I asked you about Notion. Has the price changed?"

The second turn reads the fact stored by the first, searches again, and answers from the difference.

## What makes it different

Most search agents just pass the raw chat history back into the prompt and hope the model finds the right message. That breaks down when you ask about a specific day or whether a number from last month is still accurate.

- **Saves facts separately from chat:** Messages are logged by date, while extracted facts (like prices or specs) are stored in their own table with the value, source URL, and date. When a fact updates, the old version is kept instead of overwritten, so you never lose history.
- **Compares changes in code, not in the prompt:** When you ask *"has it changed?"*, the app fetches the saved facts from that date, runs a fresh search, and compares the old and new values in code. The LLM only writes the reply, the code decides whether something actually changed.
- **Built-in fact checks:** Before returning an answer with a table or several figures, the app verifies them against the cited pages and rewrites anything it can't trace back to a source. Because these checks are tested code rather than prompt rules, they behave the same way every time.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Web chat at <http://localhost:3000> |
| `npm test` | Offline tests, no network or keys |
| `npm run eval` | The 18 acceptance cases with a stubbed model |
| `npm run db:reset` | Clear the local database and start clean |

## Configuration

Copy `.env.example` to `.env` and fill in the required variables:

- **API keys:** Set your OpenAI and Tavily keys.
- **`MODEL`:** Set to `gpt-6-luna`, or any model your account can access.
- **`USER_TZ`:** Set to `Asia/Kolkata`. (Ensures relative dates like "today", "yesterday", and "last Tuesday" resolve against your local calendar.)

Everything else has working defaults and can be left alone.

> The server binds to localhost and has no login.

## Layout

- `src/` : Agent code
  - `agent.ts` : Runs one turn
  - `notebook.ts` : Builds memory
  - `recheck.ts` : Compares facts
  - `server.ts` : Serves the web chat
- `test/` : 215 offline tests
- `eval/` : The 18 acceptance cases and how to run them
- `web/` : HTML, CSS, and JS for the chat (no build step)
- `data/`, `traces/` : Runtime output (gitignored)