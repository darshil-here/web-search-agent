// test/eval.test.ts
//
// The offline half of the eval set runs inside `npm test`: free, deterministic,
// and backed by the real pipeline modules with external calls stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { CASES, coverage } from "../eval/cases.js";
import { runOfflineAll } from "../eval/runner.js";

test("every eval case passes its deterministic probe", async () => {
  const results = await runOfflineAll(CASES);
  const failures = results.filter((r) => !r.passed);
  assert.deepEqual(
    failures.map((r) => `${r.id}: ${r.failure}`),
    [],
    "eval cases failed"
  );
});

test("the eval set covers all three brief examples and all ten failures", () => {
  const ids = new Set(CASES.map((c) => c.id));
  for (const id of ["brief-1", "brief-2", "brief-3"]) {
    assert.ok(ids.has(id), `missing brief case ${id}`);
  }
  for (let n = 1; n <= 10; n++) {
    const tag = `F-${String(n).padStart(3, "0")}`;
    assert.ok(
      CASES.some((c) => c.source === tag),
      `no eval case maps to ${tag}`
    );
  }
});

test("the eval set covers all five LongMemEval categories", () => {
  const covered = coverage();
  for (const category of [
    "information-extraction",
    "multi-session-reasoning",
    "temporal-reasoning",
    "knowledge-update",
    "abstention",
  ]) {
    assert.ok((covered[category] ?? 0) > 0, `missing category ${category}`);
  }
});

test("every live case has a rubric with at least one must", () => {
  for (const c of CASES.filter((c) => c.live !== false)) {
    assert.ok(c.rubric.must.length > 0, `${c.id} has no rubric`);
  }
});
