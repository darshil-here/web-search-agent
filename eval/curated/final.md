# Eval report

Offline: 18/18 passed
Live: 10/12 passed

## Offline (deterministic)

| case | source | result | note |
|------|--------|:------:|------|
| brief-1 | brief | pass |  |
| brief-2 | brief | pass |  |
| brief-3 | brief | pass |  |
| tax-extraction | LongMemEval | pass |  |
| tax-multisession | LongMemEval | pass |  |
| tax-temporal | LongMemEval | pass |  |
| tax-update | LongMemEval | pass |  |
| tax-abstention | LongMemEval | pass |  |
| temporal-001 | F-001 | pass |  |
| grounding-001 | F-002 | pass |  |
| citation-001 | F-003 | pass |  |
| calibration-001 | F-004 | pass |  |
| recency-001 | F-006 | pass |  |
| memory-abstain-001 | F-007 | pass |  |
| budget-001 | F-009 | pass |  |
| year-rule-001 | F-008 | pass |  |
| temporal-002 | F-010 | pass |  |
| scope-001 | F-005 | pass |  |

## Live (LLM-judged)

| case | result | reasons |
|------|:------:|---------|
| brief-1 | pass | The answer gives a pricing result for all five vendors and addresses releases across the five.; It provides URLs for the vendors described as showing no pricing change, and explicitly says fresh sources did not confirm Zoho CRM or Freshsales pricing.; It does not assert an unverified price or product change. |
| brief-2 | pass | It recalls the seeded question: “Which Postgres host should I use?”; It explicitly says it cannot verify whether the earlier answer is still correct.; The recalled question matches the seeded history; no past question is invented. |
| brief-3 | FAIL | The answer asserts the current price is still $19/month despite having no retrieved source, so the current price is unsupported and appears asserted from memory. |
| tax-extraction | pass | The answer gives the verbatim question: “Which Postgres host should I use?” |
| tax-abstention | pass | The answer states there were no turns on 4 November.; It does not invent a question. |
| grounding-001 | FAIL | Several table entries assert details not present in the retrieved source excerpts, including that Supabase branching is not included, Neon includes 5 GB object storage, Supabase lacks automatic backups/PITR, and Neon lists object storage and an AI gateway.; Unsupported table entries are stated as facts rather than marked unknown. Although the cells include URLs, those sources as retrieved do not substantiate the claims. |
| citation-001 | pass | Both factual claims about Neon’s Free plan storage limits have the source URL beside them. |
| calibration-001 | pass | The answer notes that the sources do not describe either free plan as expiring after a set time, rather than claiming indefinite longevity.; It hedges the longevity claim with “isn’t described as expiring” and “isn’t described as a time-limited trial.”; It does not assert that either plan is genuinely free with no expiration. |
| recency-001 | pass | Cites the official OpenAI Help Center source for the $20/month price.; The cited source has a visible update date in the retrieved material, so no note about an undated source was required.; Does not use a launch-era article as current evidence. |
| memory-abstain-001 | pass | Directly states that there is no recorded history for 3 November.; No web search for chat history is indicated. |
| temporal-002 | pass | The answer notes that there is no earlier version claim to verify and asks which software or product the user means, avoiding a claim about an unspecified concept. |
| scope-001 | pass | Identifies Node.js v26 as the LTS line and gives v26.13.1 as its latest release.; Does not mention an alpha or beta release. |
