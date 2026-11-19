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
      content: "Neon's free plan is permanent with no time limit.",
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

test("rewrites an unsupported claim even when the question asked about expiry", () => {
  const answer = "The free plan never expires.";
  const result = guardCalibration(
    "Does the free plan ever expire?",
    answer,
    sources
  );
  assert.doesNotMatch(result.answer, /never expires/);
  assert.match(result.answer, /sources do not state/i);
  assert.equal(result.rewritten.length, 1);
});

test("catches contracted forms like doesn't expire", () => {
  const answer = "Neon's free plan doesn't expire. It is genuinely free.";
  const result = guardCalibration("Do the free tiers expire?", answer, sources);
  assert.doesNotMatch(result.answer, /doesn't expire/);
  assert.doesNotMatch(result.answer, /genuinely free/);
});

test("a universal claim needs support for every product named in the question", () => {
  const two = [
    {
      title: "Neon pricing",
      url: "https://neon.test",
      content: "The Neon Free plan is permanent, not a trial.",
    },
    {
      title: "Supabase pricing",
      url: "https://supabase.test",
      content: "Free projects pause after one week of inactivity.",
    },
  ];
  const answer = "Neither is a time-limited trial.";
  const result = guardCalibration(
    "Do the Neon and Supabase free tiers expire?",
    answer,
    two
  );

  // Neon's page states permanence, Supabase's says nothing about it, so the
  // claim about both is not grounded.
  assert.doesNotMatch(result.answer, /Neither is a time-limited trial/);
  assert.match(result.answer, /sources do not state/i);
  assert.equal(result.rewritten.length, 1);
});

test("a universal claim both products' sources state is kept", () => {
  const two = [
    {
      title: "Neon pricing",
      url: "https://neon.test",
      content: "The Neon Free plan is permanent, not a trial.",
    },
    {
      title: "Supabase pricing",
      url: "https://supabase.test",
      content: "The Supabase Free plan is permanent and not a trial.",
    },
  ];
  const answer = "Both free tiers are permanent.";
  const result = guardCalibration(
    "Do the Neon and Supabase free tiers expire?",
    answer,
    two
  );

  assert.match(result.answer, /Both free tiers are permanent/);
  assert.equal(result.rewritten.length, 0);
});

test("a trial claim with an intervening word is still hedged", () => {
  const answer =
    "Neither is a time-limited free trial, but Supabase's free projects can be paused.";
  const result = guardCalibration(
    "Do the Neon and Supabase free tiers expire?",
    answer,
    [
      {
        title: "Neon limits",
        url: "https://neon.test",
        content: "The Neon Free plan is not a trial.",
      },
    ]
  );

  // Supabase's source states no longevity policy, so the universal claim
  // cannot stand even though Neon's does.
  assert.doesNotMatch(result.answer, /Neither is a time-limited free trial/);
  assert.match(result.answer, /do not state whether/);
  assert.equal(result.rewritten.length, 1);
});

test("a per-vendor trial-end claim without support is hedged", () => {
  const answer = "Supabase's Free plan doesn't have a set trial end date.";
  const result = guardCalibration(
    "Does Supabase's free tier expire?",
    answer,
    [
      {
        title: "Supabase pausing",
        url: "https://supabase.test",
        content: "Supabase pauses projects after a week of inactivity.",
      },
    ]
  );

  assert.doesNotMatch(result.answer, /trial end date/);
  assert.match(result.answer, /do not state whether/);
});

test("a source that says 'not a time-limited trial' keeps the claim", () => {
  const answer = "Neon is not a time-limited trial.";
  const result = guardCalibration("Does Neon's free tier expire?", answer, [
    {
      title: "Neon pricing",
      url: "https://neon.test",
      content: "Neon says the Free plan is not a time-limited trial.",
    },
  ]);

  assert.equal(result.answer, answer);
  assert.equal(result.rewritten.length, 0);
});

test("a link list from one vendor does not lend its subject to the next bullet", () => {
  const answer =
    "- **Neon:** Its plan is permanent. [Neon pricing](https://neon.test) · [Neon limits](https://neon.test/limits)\n" +
    "- **Supabase:** Its Free plan doesn’t have a set trial end date, but projects may pause.";
  const result = guardCalibration(
    "Do the Neon and Supabase free tiers expire?",
    answer,
    [
      {
        title: "Neon pricing",
        url: "https://neon.test",
        content: "The Neon Free plan is permanent, not a trial.",
      },
    ]
  );

  // The Supabase sentence must be hedged; the Neon sentence is supported.
  assert.match(result.answer, /Neon Free plan is permanent|Its plan is permanent/);
  assert.doesNotMatch(result.answer, /set trial end date/);
  assert.match(result.answer, /do not state whether Supabase is time-limited/);
});

test("a reworded universal expiry claim is hedged", () => {
  const answer =
    "Neither free tier has a routine time limit that makes it expire.";
  const result = guardCalibration(
    "Do the Neon and Supabase free tiers expire?",
    answer,
    [
      {
        title: "Neon plans",
        url: "https://neon.test/plans",
        content: "Neon's Free plan costs $0 and suspends compute after inactivity.",
      },
      {
        title: "Supabase pausing",
        url: "https://supabase.test/pausing",
        content: "Supabase pauses projects after a week of inactivity. The time limit to restore is one year.",
      },
    ]
  );

  assert.doesNotMatch(result.answer, /Neither free tier has a routine time limit/);
  assert.match(result.answer, /do not state whether/);
});

test("never returns an empty answer", () => {
  const result = guardCalibration("Limits?", "Permanent.", sources);
  assert.ok(result.answer.trim().length > 0);
});
