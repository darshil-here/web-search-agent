# Failures

## F-001 — Search query anchored to a stale year
**Date:** 2026-11-16
**Trace:** traces/2026-11-16-node-version.md
**Input:** "What is the latest stable Node.js version?"
**Expected:** tool call with no year, or with 2026.
**Actual:** web_search("latest stable Node.js version 2024"), then a second search that rescued it.
**Class:** temporal anchoring
**Locus:** code
**Fix:** inject "Today is 2026-11-16" from `new Date()` into the system prompt.
**Status:** open
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
