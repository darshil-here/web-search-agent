# Failures

## F-001 — Search query anchored to a stale year
**Date:** 2026-11-16
**Trace:** traces/2026-11-16-node-version.md, traces/2026-11-16-231921-what-is-the-latest-stable-node-js-versio.md
**Input:** "What is the latest stable Node.js version?"
**Expected:** tool call with no year, or with 2026.
**Actual:** web_search("latest stable Node.js version 2024"), then a second search that rescued it.
**Class:** temporal anchoring
**Locus:** code
**Fix:** inject "Today is 2026-11-16" from `new Date()` into the system prompt.
**Status:** fixed
**Eval:** temporal-001

## F-002 — Unsupported breadth in a comparison answer
**Date:** 2026-11-16
**Trace:** traces/2026-11-16-neon-supabase.md
**Input:** "compare the free tiers of Neon and Supabase"
**Expected:** only cells present in retrieved text; anything else marked unknown.
**Actual:** 25-cell table from 10 snippets, including PITR window, branch counts, connection limits, message sizes.
**Class:** unsupported synthesis
**Locus:** pipeline
**Fix:** fetch top 2 pages per vendor before composing; critic pass flags cells with no source.
**Status:** open
**Eval:** grounding-001

## F-003 — Citations do not map to claims
**Date:** 2026-11-16
**Trace:** traces/2026-11-16-neon-supabase.md
**Input:** same
**Expected:** each claim carries a URL, or is dropped.
**Actual:** two URLs at the top, 25 claims below, no mapping.
**Class:** attribution granularity
**Locus:** pipeline
**Fix:** post-process answer into claims, require a URL per claim, strip the rest.
**Status:** open
**Eval:** citation-001

## F-004 — Assertion no source could support
**Date:** 2026-11-16
**Trace:** traces/2026-11-16-neon-supabase.md
**Input:** same
**Expected:** hedge, or state that free-tier longevity is not stated in retrieved sources.
**Actual:** "Both are genuinely free with no expiration."
**Class:** calibration
**Locus:** prompt
**Fix:** add hedging rule; require "sources do not state" for unverifiable policy claims.
**Status:** open
**Eval:** calibration-001

## F-005 — Answered a wider question than asked
**Date:** 2026-11-16
**Trace:** traces/2026-11-16-node-version.md
**Input:** "What is the latest stable Node.js version?"
**Expected:** the stable LTS line only.
**Actual:** also reported v27 alpha.
**Class:** scope
**Locus:** prompt
**Fix:** "Answer the question asked. Mention adjacent releases only if the user asks."
**Status:** open
**Eval:** scope-001

## F-006 — Cited a source without checking its recency
**Input:** "What is the current price of the ChatGPT Plus subscription?"
**Expected:** prefer the official pricing page; note if the source has no visible date.
**Actual:** asserted $20 citing the Help Center, while results also included a
launch-era article and a 2026 piece about a separate Pro tier.
**Class:** source recency
**Locus:** pipeline
**Eval:** recency-001

## F-007 — Searched the web for its own conversation history
**Input:** "What did I ask you on 3 November?"
**Expected:** state immediately that it has no memory of past conversations.
**Actual:** web_search("conversation history retrieve previous chat 3 November
user asks"); results were Slack docs and a YouTube tutorial. Correct answer
given anyway, after wasted work.
**Class:** capability self-knowledge
**Locus:** prompt now, memory later
**Eval:** memory-abstain-001

## F-008 — Rule and behavior disagree about years
**Input:** comparison queries
**Actual:** queries appended "2026". The prompt says not to add a year.
**Class:** rule gap
**Locus:** prompt
**Note:** adding the *current* year is good for freshness. The rule should
forbid stale years only. Fix the rule, not the model.
**Eval:** none
