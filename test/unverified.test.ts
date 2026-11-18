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

test("rewrites a sentence that mixes a past observation with a current assertion", () => {
  const answer =
    "I recorded $19/month last Tuesday, but the current price is still $19/month.";

  const result = guardUnverified(answer, HOSTING);

  assert.equal(result.rewritten.length, 1);
  assert.match(result.answer, /could not verify a current value/);
  assert.doesNotMatch(result.answer, /current price is still/);
});

test("rewrites even a past-framed value unless the sentence explicitly hedges", () => {
  // A "recorded"/"last Tuesday" marker in the same sentence is not a promise
  // that the value is not also being asserted as current. The rewrite keeps
  // the value and its date, so no information is lost.
  const answer = "I recorded $19/month last Tuesday, so that is what I wrote then.";

  const result = guardUnverified(answer, HOSTING);

  assert.equal(result.rewritten.length, 1);
  assert.match(result.answer, /recorded on 2026-11-10/);
  assert.match(result.answer, /not confirmed as current/);
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
