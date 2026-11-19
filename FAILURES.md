# Failures

Run traces are large and machine-local, so only the ones cited here are
committed, under `traces/curated/` and `eval/curated/`. Each entry quotes the
run it is built from. Excerpts are verbatim from those files; the date and
question identify the run.

## F-001 — Search query anchored to a stale year
**Date:** 2026-11-16
**Input:** "What is the latest stable Node.js version?"
**Expected:** tool call with no year, or with 2026.
**Actual:** searched 2024, then a second search rescued it.
**Class:** temporal anchoring
**Locus:** code
**Fix:** inject "Today is 2026-11-16" from `new Date()` into the system prompt.
**Status:** fixed
**Eval:** temporal-001
**Evidence:** before the fix —
```
--- step 0, 2 messages ---
[tool] web_search(latest stable Node.js version 2024)
```
After (`2026-11-17`, prompt version `43209452`):
```
[tool] web_search(Node.js latest stable release official)
```

## F-002 — Unsupported breadth in a comparison answer
**Date:** 2026-11-16
**Input:** "compare the free tiers of Neon and Supabase"
**Expected:** only cells present in retrieved text; anything else marked unknown.
**Actual:** 25-cell table from 10 snippets, including PITR window, branch counts, connection limits, message sizes.
**Class:** unsupported synthesis
**Locus:** pipeline
**Fix:** `pages.ts` fetches the top two pages per domain through Tavily
`/extract`; `critic.ts` rewrites the answer so every factual claim carries an
inline URL from the retrieved set, and marks unsupported cells "not stated in
sources". Both phases appear in the trace.
**Status:** fixed. The latest live sweep (2026-11-18) passes `grounding-001`: every factual cell carries a retrieved URL, and cells the retrieved pages do not state are marked "not stated in sources" rather than asserted. Breadth is still limited by retrieval, but the answer no longer claims more than the sources support. Value-level support is F-012, also now closed. A 2026-11-19 run exposed a narrower version of the same defect: "5 GB per project per month" was accepted because the word "project" from "per project" counted as its feature, and a bare scraped "10" was accepted for "10 branches". Size quotas now fall back to their row label ("Traffic / egress", "Postgres storage") and framing words no longer count as identity, so the traffic cell is marked unknown while the row's true storage values survive. A currency amount is self-identifying, so a "$0" price is not marked unknown merely because the scraped page never repeats the word "price" beside it. Letter, number and whitespace boundaries are preserved when matching, because removing all whitespace made "Image 17" + "5 GB" look like "175 GB" and rejected a value that was present.
**Eval:** grounding-001
**Evidence:** two searches, then a table with cells no snippet supports —
```
[tool] web_search(Neon free tier limits 2025 serverless postgres storage compute hours)
[tool] web_search(Supabase free tier limits 2025 database storage bandwidth auth)
...
| Concurrent connections | Scales with compute tier | 200 peak |
| Realtime | "Live SQL" in beta | 2M messages/month, 256 KB max |
```

## F-003 — Citations do not map to claims
**Date:** 2026-11-16
**Input:** same
**Expected:** each claim carries a URL, or is dropped.
**Actual:** two URLs at the top, 25 claims below, no mapping.
**Class:** attribution granularity
**Locus:** pipeline
**Fix:** `critic.ts` returns one statement per factual claim with the URL used;
code strips any URL not in the retrieved set. Tables get a URL in the relevant
cell, not a sources list at the bottom.
**Status:** fixed. Only retrieved URLs survive, each statement carries one, and the live `citation-001` case passes (2026-11-18): the Neon values are beside the Neon docs URL that states them. A tracked variant of a fetched URL (`?ref=`, `www`, `.md`) is now resolved to the URL actually fetched instead of being stripped to an empty `[]`, and an invented URL is removed with its markdown wrapper. Value support is F-012, also now closed.
**Eval:** citation-001
**Evidence:**
```
**Sources:**
- Neon: https://neon.com/pricing
- Supabase: https://supabase.com/pricing

### Free-tier comparison table
| Feature | Neon Free | Supabase Free |
```

## F-004 — Assertion no source could support
**Date:** 2026-11-16
**Input:** same
**Expected:** hedge, or state that free-tier longevity is not stated in retrieved sources.
**Actual:** "Both are genuinely free with no expiration."
**Class:** calibration
**Locus:** pipeline
**Fix:** `calibration.ts` rewrites absolute longevity claims ("permanent",
"doesn't expire", "genuinely free") into "the retrieved sources do not state
whether …" unless a source mentioning the same subject states the claim. A
universal claim ("neither…", "both…", "they don't expire") must be supported
for every product the question names, because one vendor's "permanent" cannot
license the same claim about another vendor. It is a pure function, runs after
the critic, and is traced.
**Status:** fixed. The latest live sweep (2026-11-18) passes `calibration-001`: Neon is described as permanent only because its pricing page says so, and Supabase is hedged. A 2026-11-19 run exposed two narrower forms the guard missed: "time-limited free trial" with a word between "limited" and "trial", and "doesn't have a set trial end date". Both are now absolute phrasings. The same run showed a subject can be misread when a vendor's markdown link list shares a paragraph with the next vendor's sentence; sentences now split at newlines and link targets are removed before subject detection.
**Eval:** calibration-001
**Evidence:**
```
Both are genuinely free with no expiration, but they serve different shapes
of workloads.
```

## F-005 — Answered a wider question than asked
**Date:** 2026-11-16
**Input:** "What is the latest stable Node.js version?"
**Expected:** the stable LTS line only.
**Actual:** also reported v27 alpha.
**Class:** scope
**Locus:** pipeline
**Fix:** `scope.ts` enforces scope in code after the answer: it normalizes
concept ids (so "stable" and "LTS" are one concept) and removes any sentence
naming a concept the question did not ask about. A sentence is split on
semicolons first, so a clause that answers the question survives when the next
clause volunteers an adjacent release; sentence-level removal had deleted the
LTS line along with the alpha clause. No model call, traced.
**Status:** fixed (clause-level as of 2026-11-19)
**Eval:** scope-001
**Evidence:**
```
- **Latest LTS:** v26.13.1 — recommended for most users and production environments
- **Latest Alpha:** v27.0.0-alpha.0.1.0 — experimental/early release, not for production
```
An early run on `2026-11-17` returned only the LTS line, but a later run the
same day reproduced it. `traces/curated/2026-11-17-151237-what-is-the-latest-stable-node-js-versio.md`:
```
The latest stable Node.js release is **v26.13.1 (LTS)**. The official Node.js
releases page lists it as the latest LTS; the 27.x line is currently Alpha.
```
Scope-001 is the eval case that guards it; it now passes with the code-level
guard in `scope.ts`, and the trace records any sentence removed.

## F-006 — Cited a source without checking its recency
**Input:** "What is the current price of the ChatGPT Plus subscription?"
**Expected:** prefer the official pricing page; note if the source has no visible date.
**Actual:** asserted $20 citing the Help Center, while results also included a
launch-era article and a 2026 piece about a separate Pro tier.
**Class:** source recency
**Locus:** pipeline
**Fix:** two changes. `source-date.ts` extracts publication dates from snippets
and fetched pages, and the answer always ends with a statement of date
visibility. `search.ts` now requests Tavily's `include_published_date` and
`rankByFreshness` puts dated results first, newest first, before the model sees
them — freshness became a retrieval decision rather than an instruction. The
eval judge is also shown the retrieved sources so it can tell what the agent
actually saw.
**Status:** fixed. A 2026-11-19 run surfaced the remaining case: Tavily's metadata supplied a `publishedAt`, so the answer skipped the date note even though the cited page showed only "Updated: 18 hours ago". A relative timestamp is now reported as exactly that — a relative update time, not a calendar date — before the absolute-date check.
**Eval:** recency-001
**Evidence:** result set mixed 2023 launch coverage with 2026 pricing coverage —
no source date was extracted, so the answer could not prefer the fresher one.

## F-007 — Searched the web for its own conversation history
**Input:** "What did I ask you on 3 November?"
**Expected:** state immediately that it has no memory of past conversations.
**Actual:** web_search("conversation history retrieve previous chat 3 November
user asks"); results were Slack docs and a YouTube tutorial. Correct answer
given anyway, after wasted work.
**Class:** capability self-knowledge
**Locus:** prompt now, memory later
**Eval:** memory-abstain-001
**Status:** fixed (notebook)
**Evidence:** before —
```
[tool] web_search(conversation history retrieve previous chat 3 November user asks)
[result] 5 hits
...
FINAL:
I can't see your other conversations or chat history from 3 November in this chat.
```
The answer was right; the search was pure waste and a sign the model does not
know what it is. After the notebook, same question, no tool call:
```
--- step 0, 2 items ---
FINAL:
You didn't ask me anything on 3 November; there are no turns recorded for that date.
```
One step, zero searches, and the abstention is backed by an empty query result
rather than by the model's imagination. The live judge initially failed this
answer because it could not see the recall: the runner now passes the memory
lookup (queried dates, turns found, claims found) and the tool log alongside
the retrieved sources, so "no turns on 3 November" is judged against the same
evidence the agent had.

## F-008 — Rule and behavior disagree about years
**Input:** comparison queries
**Actual:** queries appended "2026". The prompt says not to add a year.
**Class:** rule gap
**Locus:** prompt
**Note:** adding the *current* year is good for freshness. The rule should
forbid stale years only. Fix the rule, not the model.
**Status:** fixed (prompt rule now names stale years)
**Eval:** none

## F-009 — Step-bound exhaustion returned nothing
**Date:** 2026-11-17
**Input:** "What is the latest stable Node.js version?" with `MAX_STEPS=1`
**Expected:** an explicit failure the caller can detect.
**Actual:** loop exited, printed no `FINAL`, trace `content: ""`, `verdict: unset`,
process exit code 0. A user sees a blank line; a script sees success.
**Class:** silent failure
**Locus:** code
**Fix:** return a `stopReason`, print what was searched, `verdict: incomplete`,
`process.exitCode = 1`.
**Status:** fixed
**Eval:** budget-001
**Evidence:** after the fix —
```
FINAL (incomplete):
I stopped after 1 steps without an answer. Searches run: Node.js latest stable release official.
trace: traces/curated/2026-11-17-001730-what-is-the-latest-stable-node-js-versio.md
exit=1
verdict: incomplete
```

## F-010 — Re-check verified a narrower attribute than the one asked about
**Date:** 2026-11-17
**Input:** "What did I ask on 17 November? Is your answer still correct today?"
(against the recorded claim `Node.js / latest LTS release = v26.13.1`)
**Expected:** the re-check should notice that the original question was about
the latest *stable* release while the stored claim says *LTS*, and either
re-verify that exact attribute or mark the comparison `not_found` with the
mismatch stated. "LTS is unchanged" does not establish "stable is unchanged".
**Actual:** extraction collapsed the original "latest stable" answer into the
attribute `latest LTS release`. The fresh source described only LTS, so the
re-check recorded `unchanged` against that narrower attribute and the ledger
now says the original claim was re-verified today. The model noticed the gap
in prose, but the ledger did not.
**Class:** claim granularity / attribute drift
**Locus:** `claims.ts` (extraction) and `recheck.ts` (fresh-value matching)
**Fix:** two changes. (1) `claims.ts` now receives the user's question and
applies a deterministic `anchorAttribute` step (`concepts.ts`) in `sanitise`, so
a sibling word in the answer ("LTS") cannot overwrite the concept the question
asked about ("stable"); the recorded attribute is now `latest stable version`. (2)
`recheck.ts` extraction must report `matchedAttribute` (the concept the source
actually describes) and `enforceAttributeMatch` downgrades `unchanged` to
`not_found` when that concept differs from the recorded attribute. The diff
rendered to the model states the mismatch explicitly.
**Status:** fixed (ledger, trace and answer prose — the remaining prose gap is closed by F-011)
**Eval:** temporal-002
**Evidence:**

Before — `traces/curated/2026-11-17-140139-what-did-i-ask-on-17-november-is-your-an.md`:
```
| 1 | 1 | 0 | false | 0 | 0 | 1 |
- claim 1: unchanged — v26.13.1 https://endoflife.date/nodejs
```

After — fresh claim in session `f010check2` recorded as
`Node.js / latest stable version = v26.13.1`, then re-checked in
`traces/curated/2026-11-17-151457-is-your-answer-about-node-js-still-corre.md`:
```
| 1 | 1 | 0 | true | 0 | 0 | 1 |
- claim 2: not_found — v26.13.1 https://nodejs.org/en/about/previous-releases
```
And the `verifications` row is `result: not_found`, not `unchanged` — the
ledger no longer claims the "latest stable" attribute was re-verified by an
LTS-only source. The prose gap noted here — an answer that still says "still
correct" over a `not_found` row — is closed by F-011.

Also fixed while here: the answer call's `web_search` safety valve was declared
but never executed, so a tool request produced an empty answer. `recheck.ts`
briefly ran a bounded two-step tool loop and executed the call. That loop was
itself the cause of F-013 (it let the model spend both steps searching and
return nothing), so the final design removes the tool from the answer call
entirely and renders the diff in code when the model writes nothing.

## F-011 — An unverified value was asserted as current
**Input:** "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" (brief example 3)
**Expected:** state the recorded $19/month as history and say a fresh price could not be verified.
**Actual:** the live judge found "the answer asserts the current price is still $19/month despite having no retrieved source, so the current price is unsupported and appears asserted from memory."
**Class:** unverified assertion / temporal discipline
**Locus:** pipeline
**Fix:** four changes in the re-check path. `recheck.ts` injects a hard-constraint developer message telling the answer call that a `not_found` row is unverified and its recorded value must never be presented as current. `enforceValueInSources` downgrades any `unchanged`/`changed` result whose reported value appears in none of the retrieved sources — the second live run showed extraction echoing the recorded $19/month back as "unchanged" while citing an article that never quotes it, i.e. verifying the claim against itself. `unverified.ts` then rewrites any sentence that names an unverified value as current into "I could not verify a current value for …; the recorded value was … but is not confirmed as current." A sentence is rewritten only when it asserts currency ("still", "current", "unchanged", "now"…); an explicit hedge, or a sentence that merely mentions the value in the past, survives. The second tightening was needed because the first made brief-2 fail by rewriting away the recalled question. Finally, when every row is unverified the answer call's tool is removed (`useTools: false`): the per-subject searches already ran, and letting the model search again made brief-1 return an empty answer. Every downgrade and rewrite is traced.
**Status:** closed for brief-3 by a live sweep (8/12 overall on that run; brief-1 and brief-2 were transient failures from the two issues above, both fixed afterwards and covered by new tests). A later live sweep then exposed a new failure in the same path — brief-1 returning an empty answer because the answer call spent its step budget searching — which is recorded and fixed separately as F-013.
**Eval:** brief-3 (probe strengthened to feed the failed answer shape through the guard)
**Evidence:** the failing live rows. `eval/curated/final.md`:
```
| brief-3 | FAIL | The answer asserts the current price is still $19/month despite having no retrieved source, so the current price is unsupported and appears asserted from memory. |
```
Second live run, answer from the preserved trace:
```
No. The price is still $19/month, unchanged since your last Tuesday observation. Source: [Medium](…).
```
with the re-check section reading `- claim 1: unchanged — $19/month https://medium.com/@vosarat1995/…` — the source text never contained $19/month. Offline regression: `npm run eval` — `PASS brief-3`, 18/18 overall.

## F-012 — Unsupported numeric values in a grounded table
**Input:** "Compare the free tiers of Neon and Supabase"
**Expected:** a table cell whose value no retrieved page states is marked "not stated in sources".
**Actual:** the live judge repeatedly found such cells stated as facts, e.g. "5 GB Object Storage per project", "2 million Realtime messages/month", "500,000 Edge Function invocations", "10 branches". Each cell carried a valid URL, which is why the URL-stripping fix (F-003) did not catch it.
**Class:** unsupported synthesis / value grounding
**Locus:** pipeline
**Fix:** `support.ts` adds a deterministic value-support guard inside the critic. Claims are graded per table cell, so one row cannot pool its evidence across two vendors. A value is kept when the cited text contains the full measure inside a window that also names the feature, or the bare number inside such a window (sources often put the feature before the number: "Edge function invocations | 500,000 per month"), or when a verbatim quote from the cited page states both. A bare number cannot match inside a larger one: "1" is not evidence for a source that only says "100". Unsupported values are replaced with "not stated in sources"; in a table the whole clause is replaced so a cell never reads "not stated in sources snapshot". Absence claims ("No automatic backups") require the cited page to mention the feature. Citation URLs are compared by host and path, and fragments of one page are merged before grading, so a tracked variant is resolved rather than stripped and evidence in one excerpt is not hidden by another excerpt of the same page. The search snippet and the fetched page are also unioned: a fetch that omits a section must not hide the snippet that stated the value. Every rewrite is traced as `critic_replaced`.
**Status:** fixed. The latest live sweep (2026-11-18) passes both `grounding-001` and `citation-001`. Earlier judge complaints had two causes: real unsupported cells (closed by per-cell windows and the standalone-number rule) and rendering artefacts ("not stated in sources snapshot", truncated judge excerpts), both fixed.
**Eval:** grounding-001 and citation-001 (probes replay unsupported cells through the guard)
**Evidence:** live judge reason from the second run:
```
Several table values are not present in the retrieved sources, including Neon's 5 GB egress, 5 GB Object Storage, 60,000 MAUs, one snapshot, and 10 branches.
```
Replaying that run's answer through the guard: 20 numeric claims checked, 5 rewritten (including the fabricated "2 million" and "500,000 Edge" quotas), down from 37 before the precision tightening.

## F-013 — A re-check spent its answer budget searching, then returned nothing

**Date:** 2026-11-18
**Input:** brief-1 — "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
**Expected:** a per-vendor answer saying what changed and what could not be verified.
**Actual:** five per-subject searches ran, extraction returned four `not_found` and one `changed`, then the answer call spent both of its steps on more searches. The CLI printed "I stopped while writing the re-check for 2026-11-16 without an answer", and — worse — the trace recorded `content: ""`, so the live judge graded an empty answer and a script could not see what the user saw.
**Class:** budget exhaustion / silent failure
**Locus:** `recheck.ts` (answer call), `agent.ts` (`conclude`)
**Fix:** three changes. (1) The answer call is now a single call with `useTools: false`: the per-subject searches already ran, so another search cannot add evidence and only consumes the budget. (2) When that call still returns no text or ends on `budget`, `renderDiffAnswer` renders the diff in code — every subject, its recorded value, the fresh status, the URL and any notable change — so a re-check always answers. (3) `conclude()` traces the text the user actually saw, with `answerKind: "model" | "fallback"`; the eval runner reads that field and the re-check sources, so the judge grades the real answer with the evidence the agent saw.
**Status:** fixed
**Eval:** brief-1 plus unit tests "the answer call never re-searches, however many rows are verified", "an empty answer text falls back to a deterministic re-check answer" and "the deterministic fallback lists every claim and keeps history honest".
**Evidence:** preserved pre-fix trace, `traces/curated/2026-11-18-161429-brief-1-budget.md`:
```
| extract | – | 8645 | ... |
| answer | 0 | 2881 | ... | 28 |
| answer | 1 | 3286 | ... | 139 |
verdict: incomplete
...
- claim 1: not_found — $20/seat per month https://fairlycompared.com/crm/hubspot
- claim 5: changed — $11/month https://saaspricehub.io/questions/how-often-does-freshsales-change-prices
...
FINAL (incomplete):
I stopped while writing the re-check for 2026-11-16 without an answer.
```
The same turn's JSONL event was `{"type":"final",...,"content":"","stopReason":"budget"}`, which is why the report showed `(empty)`. After the fix the answer call has no tool to call, and a stub model that returns no text still yields the per-vendor fallback in the unit test above.

## Live eval evidence for the grounding changes (2026-11-17)

`npm run eval:live` after adding `pages.ts`, `critic.ts`, `source-date.ts` and
`scope.ts`. Reports are at `eval/curated/1794917952295.md`,
`eval/curated/1794918492260.md`, `eval/curated/1794918790042.md` and `eval/curated/1794919036927.md`. Across those
runs: offline 18/18 every time; live between 8/12 and 11/12. The variation is
in which sources Tavily returns and how the judge weighs them, not in the
pipeline — `grounding-001`, `citation-001` and `scope-001` passed in the final
runs, and `recency-001` passed in one of them. `calibration-001` (F-004) also
varies and remains open. Two robustness fixes came out of these runs: a dated
source list is now stated on every sourced answer, and a re-check whose answer
call returns empty text is rendered in code rather than saved as a blank (F-013).

## Live eval evidence for the re-check fix (2026-11-18)

`eval/curated/1795005488403.md`: offline 18/18, live 10/12. All three brief
examples pass, including brief-1, which now returns a model-written answer for
all five vendors and states that no fresh pricing or release information could
be verified. The two remaining failures are `grounding-001` and
`citation-001`, both value-support defects in table cells (F-012), not temporal
recall or answer-budget failures. `brief-1`'s answer kind was `model`; the
deterministic path is covered by unit tests rather than this run.

## F-014 — A collective re-check answer hid the per-vendor results

**Date:** 2026-11-18
**Input:** brief-1 — "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
**Expected:** a result per vendor: what changed, what did not, what could not be verified.
**Actual:** the pipeline checked every claim and had the per-vendor diff, but the model wrote one collective sentence naming all five ("I can't verify whether any of them changed…"). Because every vendor name appeared in that sentence, the coverage check that appended missing subjects saw nothing missing, and the judge failed the case for having no per-vendor result.
**Class:** answer coverage / summarisation
**Locus:** `recheck.ts` (`coversSubject`, `renderMissingSubjects`)
**Fix:** coverage is now a per-subject verdict, not a name match. A subject counts as covered only when a sentence names it and carries a status ("unchanged", "changed", "could not verify") or the value that was checked. Any subject without one gets its diff line appended under "Per-vendor results from the diff". A single-subject re-check is never padded, and an answer that already reports each vendor is left alone.
**Status:** fixed
**Eval:** brief-1 plus unit tests "naming every vendor in one collective sentence is not a per-vendor result" and "an answer that already reports each vendor is not duplicated".

## F-015 — A correct fresh value was downgraded by wording

**Date:** 2026-11-19
**Input:** brief-1 — five CRM pricing claims against fresh search results.
**Expected:** four unchanged prices and one changed price, each sourced.
**Actual:** every fresh value was downgraded to `not_found`, so the answer said no current pricing existed even though the pages stated it.
**Class:** verification / false negative
**Locus:** `recheck.ts` (`enforceValueInSources`)
**Fix:** the check compared the whole composed value (`"$25 per user per month for Starter Suite"`) against the page and required that exact string. Extraction composes values from table rows, so a correct value almost never appears verbatim. The check now validates the measure and its identity: the number must be standalone in the corpus, and either the verbatim quote names it or one of the value's own feature words sits beside it. A named value with no number ("Neon") must still appear whole. A fabricated value is still downgraded because its number is absent.
**Status:** fixed
**Eval:** brief-1 plus unit tests "a composed price value is kept when the source states it in a table row", "a named fresh value is kept when the source names it", and "a changed value is kept only when its measure and feature agree".
**Evidence:** the run's own re-check report (`eval/curated/2026-11-19-brief-fixes.md`) shows five rows all saying "could not verify a current value" while the sources listed Pipedrive at $14, Zoho at $14 and Freshsales at $9.

## F-016 — A recall answer omitted the question it was asked to recall

**Date:** 2026-11-19
**Input:** brief-2 — "What did I ask you on 3 November? Is your answer still correct today?"
**Expected:** the earlier question, then the re-check result.
**Actual:** the answer reported the recorded claim and its date but never restated the question. The model had the notebook and the diff, and chose to summarise only the diff.
**Class:** conversational recall
**Locus:** `notebook.ts` (`withRecalledQuestion`), called on the re-check path
**Fix:** when the user explicitly asks what they asked, the earlier user turn for that date is quoted into the answer in code if the model omitted it. Only explicit recall questions are touched, so a pricing re-check is not prefixed. This does not add a tool or a model call.
**Status:** fixed
**Eval:** brief-2 plus unit tests "a recall answer names the earlier question, quoted from the store" and "a non-recall question is not prefixed".
**Evidence:** `eval/curated/2026-11-19-brief-fixes.md` — "I could not verify a current value for Postgres hosting's recommended host…" with no mention of the original question.
