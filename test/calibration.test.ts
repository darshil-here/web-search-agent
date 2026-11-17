import test from "node:test";
import assert from "node:assert/strict";
import { guardCalibration } from "../src/calibration.js";
import type { SearchResult } from "../src/search.js";

const sources: SearchResult[] = [
  {
    title: "Docs",
    url: "https://n.test",
    content: "Free plan includes 10 GB storage.",
  },
];

test("rewrites an unsupported longevity claim", () => {
  const answer = "Neon's free plan is permanent with no time limit.";
  const result = guardCalibration(
    "What are the free tier limits?",
    answer,
    sources
  );
  assert.doesNotMatch(result.answer, /permanent/);
  assert.match(result.answer, /sources do not state/i);
  assert.equal(result.rewritten.length, 1);
});

test("keeps the claim when a source states it", () => {
  const withSource = [
    {
      ...sources[0],
      content: "The free plan is permanent with no time limit.",
    },
  ];
  const answer = "Neon's free plan is permanent with no time limit.";
  const result = guardCalibration(
    "What are the free tier limits?",
    answer,
    withSource
  );
  assert.match(result.answer, /permanent/);
  assert.equal(result.rewritten.length, 0);
});

test("does not rewrite when the question asked about expiry", () => {
  const answer = "The free plan never expires.";
  const result = guardCalibration(
    "Does the free plan ever expire?",
    answer,
    sources
  );
  assert.match(result.answer, /never expires/);
  assert.equal(result.rewritten.length, 0);
});

test("never returns an empty answer", () => {
  const result = guardCalibration("Limits?", "Permanent.", sources);
  assert.ok(result.answer.trim().length > 0);
});
