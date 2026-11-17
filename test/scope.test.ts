import test from "node:test";
import assert from "node:assert/strict";
import { guardScope } from "../src/scope.js";

test("removes an unprompted adjacent release sentence", () => {
  const answer =
    "The latest stable release is v26.13.1 (LTS). The 27.x line is currently Alpha.";
  const result = guardScope("What is the latest stable Node.js version?", answer);
  assert.match(result.answer, /v26\.13\.1/);
  assert.doesNotMatch(result.answer, /Alpha/);
  assert.equal(result.removed.length, 1);
});

test("keeps the sibling when the question asked for it", () => {
  const answer = "v26.13.1 is LTS. v27 alpha is experimental.";
  const result = guardScope("Compare stable and alpha Node.js", answer);
  assert.match(result.answer, /alpha/);
  assert.equal(result.removed.length, 0);
});

test("never returns an empty answer", () => {
  const result = guardScope("latest stable", "v27 alpha is experimental.");
  assert.equal(result.answer, "v27 alpha is experimental.");
});
