import test from "node:test";
import assert from "node:assert/strict";
import type { Llm } from "../src/llm.js";
import { needsGrounding, ground } from "../src/critic.js";
import type { EnrichedSource } from "../src/search.js";

const sources: EnrichedSource[] = [
  {
    title: "N",
    url: "https://n.test",
    content: "10 GB",
    pageText: null,
    publishedAt: null,
  },
];

function llmReturning(payload: unknown, fail = false): Llm {
  return {
    structured: async () => {
      if (fail) throw new Error("model down");
      return {
        data: payload as never,
        usage: { prompt: 1, completion: 1, total: 2 },
      };
    },
    turn: async () => ({ text: "", stopReason: "budget" }),
  };
}

test("needsGrounding is true for tables and number-heavy prose", () => {
  assert.equal(needsGrounding("| a | b |\n|---|---|\n| 1 | 2 |"), true);
  assert.equal(needsGrounding("One is 10 GB, two is 20 GB, three is 30 GB."), true);
});

test("needsGrounding is false for plain prose", () => {
  assert.equal(needsGrounding("I do not know the answer."), false);
  assert.equal(needsGrounding("It costs $10 per month."), false);
});

test("ground attaches source URLs and marks unsupported statements", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer:
        "Neon has 10 GB [https://n.test]. Supabase has 99 GB [https://invented.test].",
      statements: [
        { text: "Neon has 10 GB", url: "https://n.test", supported: true },
        {
          text: "Supabase has 99 GB",
          url: "https://invented.test",
          supported: false,
        },
      ],
    }),
    "Neon has 10 GB. Supabase has 99 GB.",
    sources,
    "Compare the tiers"
  );
  assert.match(result.answer, /https:\/\/n\.test/);
  assert.doesNotMatch(result.answer, /invented\.test/);
  assert.match(result.answer, /not stated in sources/);
  assert.equal(result.dropped, 1);
  // The critic's own unsupported flag is enforced in the answer text, not just
  // counted and accompanied by a vague global note.
  assert.doesNotMatch(result.answer, /Supabase has 99 GB/);
  assert.equal(result.replaced.length, 1);
});

test("ground marks a numeric claim whose value no source states", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer:
        "Neon has 10 branches [https://n.test].",
      statements: [
        {
          text: "Neon has 10 branches",
          url: "https://n.test",
          supported: true,
        },
      ],
    }),
    "Neon has 10 branches.",
    sources,
    "Compare the free tiers"
  );

  assert.match(result.answer, /not stated in sources/);
  assert.doesNotMatch(result.answer, /10 branches/);
  assert.equal(result.replaced.length, 1);
});

test("ground appends a no-date note when no source has a date", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Costs $10 [https://n.test].",
      statements: [],
    }),
    "Costs $10.",
    sources,
    "What is the price?"
  );
  assert.match(result.answer, /no publication date/i);
  assert.ok(result.note);
});

test("ground keeps the original answer when the critic fails", async () => {
  const result = await ground(llmReturning({}, true), "Original.", sources, "Q");
  assert.equal(result.answer, "Original.");
  assert.equal(result.dropped, 0);
  assert.ok(result.error);
});
