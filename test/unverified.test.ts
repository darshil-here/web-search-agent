// The unverified-value guard is pure: no model, no network, no DB. These tests
// pin the one rule it enforces — a value that could not be re-checked is history,
// never a statement about the current value.
import test from "node:test";
import assert from "node:assert/strict";
import { guardUnverified, type UnverifiedClaim } from "../src/unverified.js";

const HOSTING: UnverifiedClaim[] = [
  {
    subject: "Postgres hosting",
    attribute: "price",
    value: "$19/month",
    localDate: "2026-11-10",
  },
];

test("rewrites a sentence that states an unverified value as current", () => {
  const result = guardUnverified(
    "The current price is still $19/month.",
    HOSTING
  );

  assert.deepEqual(result.rewritten, ["The current price is still $19/month."]);
  assert.match(result.answer, /could not verify a current value/);
  assert.match(result.answer, /Postgres hosting/);
  assert.match(result.answer, /price/);
  assert.match(result.answer, /\$19\/month/);
  assert.match(result.answer, /2026-11-10/);
  assert.doesNotMatch(result.answer, /current price is still/);
});

test("keeps a recorded value framed as a past observation", () => {
  const answer = "I recorded $19/month last Tuesday, so that is what I wrote then.";

  assert.deepEqual(guardUnverified(answer, HOSTING), {
    answer,
    rewritten: [],
  });
});

test("keeps a sentence that says the value could not be verified", () => {
  const answer =
    "I could not verify a fresh price, so I cannot say $19/month is still current.";

  assert.deepEqual(guardUnverified(answer, HOSTING), {
    answer,
    rewritten: [],
  });
});

test("is a no-op with no unverified claims", () => {
  const answer = "The current price is still $19/month.";

  assert.deepEqual(guardUnverified(answer, []), { answer, rewritten: [] });
});
