---
date: 2026-11-17
model: "gpt-6-luna"
session: "f010check2"
timezone: "Asia/Kolkata"
command: "npm start -- \"What is the latest stable Node.js version?\""
prompt_version: "7d6ea648"
steps: 2
tool_calls: 1
claims: 1
recheck_claims: 0
tokens:
  prompt: 2830
  completion: 86
  total: 2916
latency_ms:
  llm: 4818
  tools: 1186
  total: 6006
verdict: ok
failures: []
---

# Run: What is the latest stable Node.js version?

## Raw output

````

--- step 0, 2 items ---
[tool] web_search(Node.js latest stable release official)
[result] 5 hits

--- step 1, 4 items ---

FINAL:
The latest stable Node.js release is **v26.13.1 (LTS)**. The official Node.js releases page lists it as the latest LTS; the 27.x line is currently Alpha. [Node.js Releases](https://nodejs.org/en/about/previous-releases)
````

## Summary

| step | llm ms | tools ms | tool calls | prompt tokens | completion tokens | total tokens |
|-----:|-------:|---------:|-----------:|--------------:|------------------:|-------------:|
| 0 | 2709 | 1186 | 1 | 417 | 23 | 440 |
| 1 | 2109 | 0 | 0 | 2413 | 63 | 2476 |
| **total** | **4818** | **1186** | **1** | **2830** | **86** | **2916** |

## Notebook

| mode | rows | bytes | truncated |
|------|-----:|------:|:----------|
| recent | 0 | 139 | false |


## Claim ledger

| extracted | inserted | superseded | unchanged |
|----------:|---------:|-----------:|----------:|
| 1 | 1 | 0 | 0 |

| subject | attribute | value | url |
|---------|-----------|-------|-----|
| Node.js | latest stable version | v26.13.1 | https://nodejs.org/en/about/previous-releases |


## Sources

| step | title | URL | content length |
|-----:|-------|-----|---------------:|
| 0 | Node.js — Node.js Releases | https://nodejs.org/en/about/previous-releases | 792 |
| 0 | Node.js — Node.js 26.13.0 (LTS) | https://nodejs.org/en/blog/release/v26.13.0 | 1278 |
| 0 | Node.js — Node.js 24.22.1 (LTS) | https://nodejs.org/en/blog/release/v24.22.1 | 993 |
| 0 | Node.js 24 is here: What’s new and what to expect - LogRocket Blog | https://blog.logrocket.com/node-js-24-new | 1358 |
| 0 | Node.js \| endoflife.date | https://endoflife.date/nodejs | 405 |
