---
date: 2026-11-16
model: nvidia/nemotron-3.5-super-vl:free
command: npm start -- "What is the latest stable Node.js version?"
prompt_version: v1
steps: 3
tool_calls: 2
verdict: fail
failures: [F-001, F-005]
---

# Run: latest stable Node.js version

## Raw output

```
--- step 0, 2 messages ---
[tool] web_search(latest stable Node.js version 2024)
[result] 5 hits

--- step 1, 4 messages ---
[tool] web_search(site:nodejs.org download latest LTS version)
[result] 5 hits

--- step 2, 6 messages ---

FINAL:
Based on the official Node.js download page, the latest stable (LTS) version is **Node.js v26.13.1** (codename: Lithium).

**Key details:**
- **Latest LTS:** v26.13.1 — recommended for most users and production environments
- **Latest Alpha:** v27.0.0-alpha.0.1.0 — experimental/early release, not for production

Source: [Node.js Downloads](https://nodejs.org/en/download)

Note: Node.js uses "LTS" (Long Term Support) for its stable releases that are recommended for production use. There is also a "Current" release line that includes newer features but is less stable.
```

## Sonnet notes (what I noticed, not part of the record)

- The answer itself is **correct**. I verified against `nodejs.org/dist/index.json`: v26.13.1, LTS, codename Lithium, released 2026-11-10.
- But the first query embedded `2024`. The model recovered on the second search, which is luck, not design. See F-001.
- The answer volunteered the alpha release when only the stable version was asked. See F-005.
- Messages grew 2 → 4 → 6. Context is never released. This is the thing to watch as the conversation gets longer.
