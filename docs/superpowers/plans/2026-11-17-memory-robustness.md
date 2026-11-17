# Memory Recall and Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject current beliefs into the notebook, tolerate non-reasoning model slugs, and commit every trace cited in the docs.

**Architecture:** `notebook.ts` appends an open-claims block after turn blocks so the 4 KB trim keeps beliefs. `llm.ts` retries once without `reasoning` on a reasoning-related 400. `traces/curated/` and `eval/curated/` are un-ignored and populated with the cited evidence.

**Tech Stack:** TypeScript (NodeNext, strict), better-sqlite3, OpenAI Responses API, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-17-memory-robustness-design.md`

## Global Constraints

- Claims block is appended last so the byte-budget trim drops old turns first.
- At most 12 claims; subject/attribute clipped to 80, value 160, url 120 chars.
- No block is emitted when there are no open claims.
- Reasoning fallback: retry once only on a 400 whose message matches `/reasoning/i`; no model-slug list; a failing retry throws.
- Only `traces/curated/*.md` and `eval/curated/*.md` are committed; other runtime output stays ignored.
- Offline eval stays 18/18 after every task.
- Commit after each task with the exact message given.

---

## File Structure

- `src/notebook.ts` — claim block in the recalled context. Modify.
- `src/trace.ts` — claim count in the recall event. Modify.
- `src/llm.ts` — reasoning fallback at the model boundary. Modify.
- `test/notebook.test.ts`, `test/trace.test.ts`, `test/llm.test.ts` — extend.
- `traces/curated/`, `eval/curated/` — committed evidence. New.
- `.gitignore`, `FAILURES.md`, `README.md`, `DESIGN.md` — documentation.

---

### Task 1: Claim recall in the notebook

**Files:**
- Modify: `src/notebook.ts`, `src/trace.ts`
- Test: `test/notebook.test.ts`, `test/trace.test.ts`

**Interfaces:**
- Consumes: `openClaims` from `db.ts`, `clip` from `text.ts`.
- Produces: `Notebook` gains `claims: number`; `Recall` gains `claims: number`.

- [ ] **Step 1: Write the failing tests**

Add to `test/notebook.test.ts` (extend its imports with `saveClaim` from
`../src/db.js`):

```ts
test("the notebook injects open claims after turns", () => {
  const db = freshDb();
  seed(db, "2026-11-16", "an earlier question");
  saveClaim(db, {
    sessionId: "s",
    subject: "Node.js",
    attribute: "latest stable version",
    value: "v26.13.1",
    url: "https://nodejs.org/en/download",
    quote: "v26.13.1",
    observedAt: "2026-11-17T05:00:00.000Z",
    localDate: "2026-11-17",
  });

  const notebook = buildNotebook(
    { db, sessionId: "s", timeZone: IST },
    "what do we know about Node?",
    NOW
  );

  assert.equal(notebook.claims, 1);
  assert.match(notebook.text, /Current beliefs/);
  assert.match(notebook.text, /Node\.js \/ latest stable version = v26\.13\.1/);
  assert.ok(
    notebook.text.indexOf("an earlier question") <
      notebook.text.indexOf("Current beliefs"),
    "claims must come after turns"
  );
  db.close();
});

test("no claims means no beliefs block", () => {
  const db = freshDb();
  const notebook = buildNotebook(
    { db, sessionId: "s", timeZone: IST }, "hello", NOW
  );
  assert.equal(notebook.claims, 0);
  assert.doesNotMatch(notebook.text, /Current beliefs/);
  db.close();
});

test("claims survive the budget while old turns are dropped", () => {
  const db = freshDb();
  for (let i = 0; i < 30; i++) {
    seed(db, "2026-11-16", `turn ${i} ${"x".repeat(300)}`);
  }
  saveClaim(db, {
    sessionId: "s", subject: "A", attribute: "price", value: "$10",
    url: null, quote: null, observedAt: "2026-11-17T05:00:00.000Z",
    localDate: "2026-11-17",
  });

  const notebook = buildNotebook(
    { db, sessionId: "s", timeZone: IST }, "what do we know?", NOW
  );

  assert.ok(notebook.bytes <= NOTEBOOK_MAX_BYTES);
  assert.equal(notebook.truncated, true);
  assert.match(notebook.text, /Current beliefs/);
  assert.match(notebook.text, /A \/ price = \$10/);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `notebook.claims` is undefined; no "Current beliefs" text.

- [ ] **Step 3: Implement in `src/notebook.ts`**

Add to imports:

```ts
import { openClaims } from "./db.js";
import { clip } from "./text.js";
```

Add fields and constants:

```ts
  claims: number;
```

```ts
const MAX_CLAIMS = 12;
const CLAIM_FIELD = { subject: 80, attribute: 80, value: 160, url: 120 };
```

Add a helper:

```ts
function claimLine(claim: Claim): string {
  const url = claim.url ? ` [${clip(claim.url, CLAIM_FIELD.url)}]` : "";
  return (
    `  - ${clip(claim.subject, CLAIM_FIELD.subject)} / ` +
    `${clip(claim.attribute, CLAIM_FIELD.attribute)} = ` +
    `${clip(claim.value, CLAIM_FIELD.value)} ` +
    `(observed ${claim.localDate})${url}`
  );
}
```

Import the `Claim` type from `db.ts` in the type import list.

In `buildNotebook`, after the if/else that builds turn blocks and before the
header:

```ts
  const beliefs = openClaims(ctx.db, ctx.sessionId).slice(0, MAX_CLAIMS);
  if (beliefs.length > 0) {
    blocks.push("Current beliefs recorded in this conversation:");
    for (const belief of beliefs) blocks.push(claimLine(belief));
  }
```

Return `claims: beliefs.length` in the result.

- [ ] **Step 4: Extend the trace recall**

In `src/agent.ts`, add `claims: notebook.claims` to the `tracer.recall({...})`
call so the new field is populated.

In `src/trace.ts`, add `claims: number;` to the `Recall` type. In the
"Notebook" markdown table, add a `claims` column:

```ts
        "| mode | rows | claims | bytes | truncated |",
        "|------|-----:|-------:|------:|:----------|",
        `| ${recall.mode} | ${recall.rows} | ${recall.claims} | ${recall.bytes} | ${recall.truncated} |`,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/notebook.ts src/trace.ts src/agent.ts test/notebook.test.ts test/trace.test.ts
git commit -m "feat(notebook): recall current beliefs alongside turns"
```

---

### Task 2: Reasoning fallback at the model boundary

**Files:**
- Modify: `src/llm.ts`
- Test: `test/llm.test.ts`

**Interfaces:**
- Consumes: `OpenAI` client.
- Produces: no new public types; `structured()` and `turn()` gain fallback behaviour and emit a `step: null, label: "answer (no reasoning)"` llm event on retry.

- [ ] **Step 1: Write the failing tests**

Add to `test/llm.test.ts`:

```ts
test("a reasoning 400 is retried once without the reasoning option", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let next = 0;
  const client = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        requests.push(request);
        if (next++ === 0) {
          const err = new Error("Unsupported parameter: reasoning") as Error & {
            status?: number;
          };
          err.status = 400;
          throw err;
        }
        return message("answer");
      },
    },
  } as unknown as OpenAI;

  const events: TurnEvent[] = [];
  const result = await createLlm(client, "test-model").turn({
    instructions: "sys",
    input: [{ role: "user", content: "hello" }],
    search: async () => [],
    toolDescription: "search",
    maxSteps: 1,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.text, "answer");
  assert.equal(requests.length, 2);
  assert.ok("reasoning" in requests[0]);
  assert.ok(!("reasoning" in requests[1]));
  assert.ok(
    events.some(
      (e) => e.type === "llm" && e.call.label === "answer (no reasoning)"
    )
  );
});

test("a non-reasoning 400 is not retried", async () => {
  let calls = 0;
  const client = {
    responses: {
      create: async () => {
        calls++;
        const err = new Error("bad api key") as Error & { status?: number };
        err.status = 400;
        throw err;
      },
    },
  } as unknown as OpenAI;

  await assert.rejects(
    createLlm(client, "test-model").structured({
      name: "x",
      schema: { type: "object", properties: {}, required: [] },
      instructions: "sys",
      input: "in",
    }),
    /bad api key/
  );
  assert.equal(calls, 1);
});

test("a failing reasoning retry propagates", async () => {
  let calls = 0;
  const client = {
    responses: {
      create: async () => {
        calls++;
        const err = new Error("reasoning unsupported") as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      },
    },
  } as unknown as OpenAI;

  await assert.rejects(
    createLlm(client, "test-model").structured({
      name: "x",
      schema: { type: "object", properties: {}, required: [] },
      instructions: "sys",
      input: "in",
    }),
    /reasoning unsupported/
  );
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — the first call throws and no fallback occurs.

- [ ] **Step 3: Implement in `src/llm.ts`**

Add a module-level helper before `class ModelLlm`:

```ts
type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type CreateResponse = OpenAI.Responses.Response;

function isReasoningError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const text = err instanceof Error ? err.message : String(err);
  return status === 400 && /reasoning/i.test(text);
}

async function createWithFallback(
  client: OpenAI,
  params: CreateParams,
  onFallback?: () => void
): Promise<CreateResponse> {
  try {
    return await client.responses.create(params);
  } catch (err) {
    if (!isReasoningError(err)) throw err;
    const { reasoning: _unused, ...withoutReasoning } = params;
    onFallback?.();
    return client.responses.create(withoutReasoning as CreateParams);
  }
}
```

In `structured()`, replace `this.client.responses.create({...})` with:

```ts
    const response = await createWithFallback(this.client, {
      model: this.model,
      instructions: request.instructions,
      input: request.input,
      text: {
        format: {
          type: "json_schema",
          name: request.name,
          schema: request.schema,
          strict: true,
        },
      },
    });
```

In `turn()`, replace the create call with:

```ts
      const response = await createWithFallback(
        this.client,
        {
          model: this.model,
          instructions: request.instructions,
          input,
          tools,
          reasoning: { effort: "low" },
        },
        () =>
          emit({
            type: "llm",
            call: {
              label: "answer (no reasoning)",
              step,
              ms: 0,
              usage: { prompt: 0, completion: 0, total: 0 },
            },
          })
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts test/llm.test.ts
git commit -m "fix(llm): retry once without reasoning on a reasoning 400"
```

---

### Task 3: Curate the cited evidence

**Files:**
- Modify: `.gitignore`, `FAILURES.md`
- Create: `traces/curated/*.md`, `eval/curated/final.md`

- [ ] **Step 1: Copy the cited traces**

```bash
mkdir -p traces/curated eval/curated
for f in \
  2026-11-17-001730-what-is-the-latest-stable-node-js-versio.md \
  2026-11-17-140139-what-did-i-ask-on-17-november-is-your-an.md \
  2026-11-17-151237-what-is-the-latest-stable-node-js-versio.md \
  2026-11-17-151457-is-your-answer-about-node-js-still-corre.md; do
  cp "traces/$f" "traces/curated/$f"
done
cp "$(ls -t eval/results/*.md | head -1)" eval/curated/final.md
```

- [ ] **Step 2: Update `.gitignore`**

Replace the `traces/` line with:

```
traces/*
!traces/curated/
!traces/curated/*.md
```

Replace the `eval/results/` line with:

```
eval/results/
!eval/curated/
!eval/curated/*.md
```

- [ ] **Step 3: Update the cited paths in FAILURES.md**

Replace each `traces/<name>.md` with `traces/curated/<name>.md` throughout
`FAILURES.md`. Change the evidence sentence that says traces are gitignored to
say only representative traces under `traces/curated/` are committed.

- [ ] **Step 4: Verify every cited path exists**

Run:

```bash
grep -oE '(traces|eval)/curated/[A-Za-z0-9._-]+\.md' FAILURES.md README.md DESIGN.md | \
  sed -E 's/^[^:]+://' | sort -u | while read -r p; do test -f "$p" || echo "MISSING $p"; done
```

Expected: no `MISSING` lines.

- [ ] **Step 5: Commit**

```bash
git add .gitignore FAILURES.md traces/curated eval/curated
git commit -m "docs: commit curated traces cited by the failure log"
```

---

### Task 4: Final verification and documentation

**Files:**
- Modify: `README.md`, `DESIGN.md`

- [ ] **Step 1: Update README**

In the "Memory" paragraph, add: "The notebook also injects the session's open
claims (current beliefs) after the turn history, capped at 12, so follow-up
questions can refer to facts as well as prose."

In the environment/config section, note that reasoning-effort is optional: a
400 complaining about `reasoning` triggers one retry without it, so swapping
`MODEL` to a non-reasoning slug does not break the agent.

- [ ] **Step 2: Update DESIGN.md**

Add to "How it works" step 2: open claims are appended after turns and survive
the 4 KB trim. Add a "Why" bullet about the reasoning fallback being driven by
the API response rather than a model-name list. Remove claim recall and the
reasoning guard from "What I'd do with another week".

- [ ] **Step 3: Full verification**

```bash
npm test && npm run typecheck && npm run db:check && npm run eval
```

Expected: all green, offline eval 18/18.

- [ ] **Step 4: Commit and push**

```bash
git add README.md DESIGN.md
git commit -m "docs: record memory recall and reasoning fallback"
git push origin main
```
