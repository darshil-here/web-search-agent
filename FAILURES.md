# Failures

Trace files are not committed (they are large and machine-local), so each entry
quotes the run it is built from. Excerpts are verbatim from
`traces/<date>-<time>-<slug>.md`; the date and question identify the file.

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
**Fix:** fetch top 2 pages per vendor before composing; critic pass flags cells with no source.
**Status:** open
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
**Fix:** post-process answer into claims, require a URL per claim, strip the rest.
**Status:** open
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
**Locus:** prompt
**Fix:** add hedging rule; require "sources do not state" for unverifiable policy claims.
**Status:** open
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
**Locus:** prompt
**Fix:** "Answer the question asked. Mention adjacent releases only if the user asks."
**Status:** open
**Eval:** scope-001
**Evidence:**
```
- **Latest LTS:** v26.13.1 — recommended for most users and production environments
- **Latest Alpha:** v27.0.0-alpha.0.1.0 — experimental/early release, not for production
```
Not reproduced on `2026-11-17`: the same question returned only the LTS line.
Still marked open because the rule is prompt-only, not enforced.

## F-006 — Cited a source without checking its recency
**Input:** "What is the current price of the ChatGPT Plus subscription?"
**Expected:** prefer the official pricing page; note if the source has no visible date.
**Actual:** asserted $20 citing the Help Center, while results also included a
launch-era article and a 2026 piece about a separate Pro tier.
**Class:** source recency
**Locus:** pipeline
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
**Evidence:**
```
[tool] web_search(conversation history retrieve previous chat 3 November user asks)
[result] 5 hits
...
FINAL:
I can't see your other conversations or chat history from 3 November in this chat.
```
The answer was right; the search was pure waste and a sign the model does not
know what it is. Left open until the notebook exists, then it becomes a
retrieval path instead of a refusal.

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
trace: traces/2026-11-17-001730-what-is-the-latest-stable-node-js-versio.md
exit=1
verdict: incomplete
```
