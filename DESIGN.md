# Design

I built a chat agent with one tool, web search, and a memory that can answer
questions about time: "what did I ask on 3 November", "has that price changed".
The brief said the best architecture wins, so most of the work went into what
happens between model calls, not into the interface.

## The problem behind the search

Search is the easy part. Tavily returns pages and the model writes a paragraph.

The hard part is that a chat agent forgets, and the usual fix, pasting the whole
transcript into the prompt, fails the moment someone asks about a specific day.
It also gives the model no way to tell a fact it saw last week from one it saw
last year.

So I split memory in two. Turns are the transcript: who said what, when, stored
with a UTC timestamp for ordering and a local date for matching. Claims are
facts: subject, attribute, value, URL, quote, and a validity interval. A new
observation closes the old row with `valid_until` and `superseded_by`, then
inserts a new one. Nothing is overwritten.

That second table is the design. Once facts have validity intervals, "has it
changed since then" stops being a prompt trick and becomes a query.

## The turn pipeline

Every turn is the same four stages, orchestrated by `agent.ts`.

1. Recall. Build a notebook from SQLite: the turns for a date you named, or the
   last few, plus current claims. Cap it at 4 KB and say when turns were
   dropped.
2. Route. `detect.ts` decides from the text whether this is a dated re-check.
   No classifier call, no extra latency.
3. Answer. Either the normal loop or the re-check path.
4. Remember. Extract claims from sourced answers, best effort, never fatal.

The guarded answer is emitted as soon as it is ready. Claim extraction runs
after it and finishes before `done`, so the reader sees the text without waiting
for the ledger, and the next turn still sees the fact.

The normal loop gives the model exactly one tool, `web_search`, and five steps.
Code ranks sources by freshness before the model sees them. If an answer has a
table, a citation, or any real number, a grounding pass fetches the cited pages.
The model rewrites the answer so each claim carries an inline URL and a verbatim
quote from that page; code verifies only two things: the quote is contiguous in
the cited text, and the claim's numbers appear in that quote. A claim that fails
is removed whole (a table cell becomes "Not stated"), never spliced with an
error string. Feature attribution — is this number about the same thing as the
sentence — is left to the model, because encoding it in code produced false
negatives on live prices.

The re-check path is deliberately not an agent. It pulls the claims recorded on
the named date, searches each subject twice (the recorded attribute, then
changelog or release notes), and compares the fresh values in code. The answer
call gets no tools. Letting it search again meant it could spend the whole
budget searching and return nothing. If the call returns no text, code renders
the diff itself, so a re-check always answers.

If the named date has no claims, the pipeline does not pretend to re-check. It
falls through to the normal path, which says there is no record for that date
and asks for the missing detail. A new user hits this on the brief's own
examples, so it has to be right.

## Why a pipeline and not an autonomous agent

An autonomous loop is more fun to demo and worse to reason about. I wanted the
control flow readable in one file: recall, route, answer, remember. The model
decides what to search. It does not decide whether to think, how much memory to
load, or whether a value is supported.

The same reason put the guards in functions instead of the system prompt.
`support.ts` checks a claim's verbatim quote and numeric presence.
`unverified.ts` rewrites a sentence that presents an unverified value as current.
`calibration.ts` hedges absolute claims no source supports. `scope.ts` removes
sentences about concepts the user did not ask about. Prompts drift. Functions
have tests.

## Three failures behind the guards

- A re-check once recorded `unchanged` for "latest stable" because extraction
  had collapsed it into "latest LTS" and the fresh source only described LTS.
  `claims.ts` now anchors the attribute to the question, and `recheck.ts`
  downgrades a mismatched attribute to `not_found`.
- A re-check once presented a recorded $19/month as the current price with no
  retrieved source behind it. `enforceValueInSources` drops a value no source
  states, and `unverified.ts` rewrites only the sentences that assert it as
  current.
- A re-check once spent its whole answer budget on more searches and returned an
  empty answer with exit code 0. The answer call now gets no tools, and if it
  still returns nothing, code renders the per-subject diff.

Each one was a wrong answer a judge caught, and each is now a guard with a test.

## Timezones

This one is small and easy to get wrong. If I stored only UTC, "what did I ask
on 3 November" would be wrong for five and a half hours a day in IST. So every
turn and claim stores `created_at` for ordering and `local_date` for matching,
and all date parsing goes through `USER_TZ`. The cost is one extra column. The
alternative is a bug that only appears at 5:30am.

## What I rejected

**The whole transcript in the prompt.** Unbounded tokens, a slower first step,
and still no clean answer to a date question.

**A memory tool.** It breaks the one-tool rule and turns abstention into a model
guess. Recall is a pre-model step so the model cannot skip it.

**A framework.** LangChain or CrewAI would hide the memory model, the staleness
logic and the failure behavior. Those are the parts being judged.

**Embeddings for recall.** The questions I need to answer are about dates and
subjects, not semantic similarity. SQL is exact and debuggable. I would reach
for vectors only if the eval showed recall failing on paraphrase, and it has
not.

## What is weak

Re-check detection is regex, so it catches the phrasings I tested and misses
others. Entity resolution is string matching, so "Postgres hosting" and
"Postgres" can become different subjects. The live judge is noisy: the same code
has ranged 8–11/12 across sweeps, depending on what Tavily returned that day, so
it is a sanity check rather than a score. Cold start is honest but unhelpful. If
you name a date before the conversation has facts, the agent can only ask for the
context it is missing.

## Another week

I would measure a model-based intent classifier against the regex before adding
it, since the current path costs nothing. I would add entity aliasing in the
ledger. I would fix re-attribution, where a correct value is withheld because
the critic cited the wrong page. And I would pin a source snapshot for the live
eval, so a score change means a code change and not a different search result.

The acceptance set is `eval/cases.ts`; every bug that became a guard has a
regression case there. `npm run eval` runs it with stubs and `npm run eval:live`
runs it through the real model.
