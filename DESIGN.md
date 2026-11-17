# Design

## How it works

1. **User speaks.** `agent.ts` runs a stdin REPL (single-question mode also works). A `SESSION_ID` scopes the conversation.
2. **Notebook recall — before the model sees the question.** `dates.ts` parses date references in the user's timezone; `notebook.ts` queries `db.ts` for turns on those dates, or the last 8 turns if none were named, and renders a `<notebook>` block capped at 4 KB. A date with no turns produces a literal "No turns on YYYY-MM-DD", not silence. Nothing is written yet, so the model is never handed its own prompt as "memory."
3. **Model + one tool.** `agent.ts` injects the notebook as a developer message plus the system prompt (with the current date rendered from `new Date()`), then calls the OpenAI Responses API with one tool, `web_search` (Tavily, top 5 results trimmed to title/url/content). Tool calls run, results are appended as `function_call_output`, and the loop repeats up to `MAX_STEPS` (default 5).
4. **Answer.** On a final response, the text is returned and saved. If the step budget is exhausted, the agent says so explicitly, reports the searches it ran, and exits non-zero — never a blank answer.
5. **Turn saved.** `db.ts` stores both turns with `created_at` (UTC, for ordering) and `local_date` (in `USER_TZ`, for date matching), behind a versioned SQLite migration.
6. **Claims recorded.** If the answer used search, `claims.ts` makes one structured-output call over the answer plus retrieved sources, extracts checkable facts (`subject / attribute / value / url / quote`), and reconciles them into a v2 `claims` table. An identical fact is a no-op; a changed value closes the old row with `valid_until`/`superseded_by` and inserts a new one. The call is best-effort and traced, never fatal to the answer. No search means no call.

**File ownership:** `agent.ts` — loop, tool, prompt, control flow. `db.ts` — persistence and retrieval queries for turns and claims. `notebook.ts` — what turn memory is injected and its byte budget. `claims.ts` — fact extraction and ledger reconciliation. `dates.ts` — pure time math and date-reference parsing. `trace.ts` — per-run `.md`/`.jsonl` traces (tokens, latency, searches, sources, notebook, claims, verdict).

## Why I built it this way

- **Pipeline, not autonomous agent.** A fixed recall → call → tool → answer loop is predictable and fast. The model never decides *whether* to think or search; it only decides *what query*. Bounded steps and a 4 KB notebook bound both latency and cost, which is what "answers fast" actually requires. A failed bound is reported, not hidden.
- **One tool, memory as retrieval.** Recall is a deterministic pre-model step, not a tool the model can call. This honors the "one tool: web search" rule honestly while still giving the agent memory — and it means abstention is grounded in a real empty query result rather than the model's imagination.
- **`local_date` + UTC.** Storing only UTC timestamps makes "what did I ask on 3 November" wrong for 5.5 hours a day in IST. `created_at` orders; `local_date` matches. All date parsing is pure and timezone-aware so the prompt, the notebook, and recall agree on what "today" means.
- **Dynamic date injection.** The system prompt states today's date from the clock, not the model's memory. A logged failure (searching "Node.js version 2024") disappeared after this. Rules name *stale* years, not all years, so freshness isn't accidentally forbidden.
- **Traces as a first-class layer.** Every run records its prompt hash, per-step cost/latency, queries, sources, injected memory, and a verdict. That is how the failure log and every fix claim are evidence-backed rather than vibes.
- **A claim ledger, not bigger memory.** Turn text tells you what was said; it cannot answer "has it changed". Storing facts as validity intervals — never overwriting, only superseding — is the Zep-style model that makes staleness a query the code can answer. Extraction is one traced pipeline call, not a second tool, so the single-tool rule still holds. It is best-effort and skipped when no search happened, so it does not tax latency or cost on questions with no external facts.

## What I considered and rejected

- **A bigger prompt holding all history.** Unbounded tokens, slower first step on every question, and no clean way to answer "on 3 November." The 4 KB notebook with explicit "no turns" statements does the same job for a fraction of the cost.
- **Giving the model a memory tool.** It would violate the single-tool rule and turn abstention into a model decision. Retrieval before the call keeps the rule intact and the behavior deterministic.
- **A framework (LangChain, CrewAI, etc.).** Orchestration libraries hide the exact parts being graded — memory model, staleness logic, failure behavior. A hand-written loop keeps every decision explainable, which the brief explicitly requires.

## What I'd do with another week

The brief's examples are temporal questions ("has pricing changed since then?", "is your answer still correct today?"), so the next work is **staleness**, not more generic memory:

- **Re-verification pipeline (next).** The ledger exists; nothing reads it yet. When a question references a past date and asks "still correct / changed / shipped since", pull that date's claims, re-search each subject, and emit a diff: old value → new value, changed/not-changed, dated sources. Parallelize per-vendor searches to keep it fast. No second tool — it stays in the loop.
- **Claim recall in the notebook.** Inject open claims (current beliefs) alongside turn text so follow-up questions can refer to facts, not just to prose.
- **Page fetching + grounding critic.** Tavily snippets cap quality. Fetch the top pages per vendor, drop table cells no source supports, require a URL per claim, extract source dates and prefer the freshest, and add a "sources do not state" hedge for unverifiable policy claims (closes the open F-002/F-003/F-004/F-006).
- **Eval set.** Build scripted acceptance tests from the three brief examples, the LongMemEval task taxonomy (extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention), and the nine logged failures. Then measure every change instead of asserting it.
- **Robustness.** Guard `reasoning: { effort: "low" }` against non-reasoning model slugs and commit a curated `traces/` subset, since `FAILURES.md` currently cites gitignored paths.

---
