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

test("needsGrounding ignores years in a single-claim answer", () => {
  assert.equal(
    needsGrounding(
      "As of November 2026, the latest stable Node.js release is v26.13.1 [https://nodejs.org]."
    ),
    false
  );
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

test("a tracked variant of a retrieved URL keeps the citation", async () => {
  const variant: EnrichedSource[] = [
    {
      title: "S",
      url: "https://supabase.test/pricing?ref=scrimba.com",
      content: "Free: 2 active projects.",
      pageText: "Free: 2 active projects.",
      publishedAt: null,
    },
  ];
  const result = await ground(
    llmReturning({
      revisedAnswer:
        "| Projects | up to 2 active projects [https://supabase.test/pricing] |",
      statements: [
        {
          text: "up to 2 active projects",
          url: "https://supabase.test/pricing",
          quote: "Free: 2 active projects.",
          supported: true,
        },
      ],
    }),
    "| Projects | up to 2 active projects [https://supabase.test/pricing] |",
    variant,
    "Compare the tiers"
  );

  // The critic's URL is the same page as the tracked one search returned, so
  // the answer points at the URL that was actually fetched.
  assert.doesNotMatch(result.answer, /\[\]/);
  assert.match(result.answer, /supabase\.test\/pricing\?ref=scrimba\.com/);
});

test("an invented URL is removed with its brackets, not left empty", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Neon has 10 GB [https://invented.test].",
      statements: [
        {
          text: "Neon has 10 GB",
          url: "https://invented.test",
          quote: null,
          supported: false,
        },
      ],
    }),
    "Neon has 10 GB.",
    sources,
    "How much storage?"
  );

  assert.doesNotMatch(result.answer, /invented\.test/);
  assert.doesNotMatch(result.answer, /\[\]/);
});

test("a snippet that states the value survives a fetched page that omits it", async () => {
  const snippetOnly: EnrichedSource[] = [
    {
      title: "N",
      url: "https://n.test/pricing",
      content: "Free: up to 6 hours or 1 GB of data changes.",
      pageText: "Pricing overview. Free plan available.",
      publishedAt: null,
    },
  ];
  const result = await ground(
    llmReturning({
      revisedAnswer:
        "Neon includes up to 6 hours of recovery [https://n.test/pricing].",
      statements: [
        {
          text: "Neon includes up to 6 hours of recovery",
          url: "https://n.test/pricing",
          quote: "Free: up to 6 hours or 1 GB of data changes.",
          supported: true,
        },
      ],
    }),
    "Neon includes up to 6 hours of recovery.",
    snippetOnly,
    "How much recovery?"
  );

  // The fetch returned a page without the limit, but the retrieved snippet had
  // it; one must not hide the other.
  assert.doesNotMatch(result.answer, /not stated in sources/);
  assert.match(result.answer, /6 hours/);
});

test("ground cleans a qualifier left before the critic's marker", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer:
        "| Auth | Up to **not stated in sources** [https://n.test] |",
      statements: [
        {
          text: "Auth quota",
          url: "https://n.test",
          quote: null,
          supported: false,
        },
      ],
    }),
    "| Auth | Up to 60,000 MAUs [https://n.test] |",
    sources,
    "Compare auth quotas"
  );

  assert.doesNotMatch(result.answer, /up to \*{0,2}not stated/i);
  assert.match(result.answer, /not stated in sources/);
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

test("ground keeps a value supported by a verbatim quote naming its feature", async () => {
  const quoted: EnrichedSource[] = [
    {
      title: "N",
      url: "https://n.test",
      content: "Free: 10 GB storage, 2 active projects.",
      pageText: "Free: 10 GB storage, 2 active projects.",
      publishedAt: null,
    },
  ];
  const result = await ground(
    llmReturning({
      revisedAnswer: "Neon has 10 GB storage [https://n.test].",
      statements: [
        {
          text: "Neon has 10 GB storage",
          url: "https://n.test",
          quote: "Free: 10 GB storage",
          supported: true,
        },
      ],
    }),
    "Neon has 10 GB storage.",
    quoted,
    "How much storage?"
  );

  assert.doesNotMatch(result.answer, /not stated in sources/);
  assert.equal(result.replaced.length, 0);
});

test("ground rejects a quote that is not verbatim in the cited source", async () => {
  const quoted: EnrichedSource[] = [
    {
      title: "N",
      url: "https://n.test",
      content: "Free: 10 GB storage, 2 active projects.",
      pageText: "Free: 10 GB storage, 2 active projects.",
      publishedAt: null,
    },
  ];
  const result = await ground(
    llmReturning({
      revisedAnswer: "Neon has 10 GB RAM [https://n.test].",
      statements: [
        {
          text: "Neon has 10 GB RAM",
          url: "https://n.test",
          quote: "Neon has 10 GB RAM",
          supported: true,
        },
      ],
    }),
    "Neon has 10 GB RAM.",
    quoted,
    "How much RAM?"
  );

  // The critic invented the quote; an unverified quote is not evidence, so the
  // value is marked rather than accepted because the number happens to exist.
  assert.match(result.answer, /not stated in sources/);
  assert.doesNotMatch(result.answer, /10 GB RAM/);
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

test("a relative update is noted instead of metadata dates", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Costs $20 [https://n.test].",
      statements: [],
    }),
    "Costs $20.",
    [
      {
        title: "N",
        url: "https://n.test",
        content: "Updated: 18 hours ago\nPrice: $20/month.",
        pageText: null,
        publishedAt: "Wed, 01 Feb 2023 00:00:00 GMT",
      },
    ],
    "What is the price?"
  );

  assert.match(result.answer, /relative update time/i);
  assert.match(result.answer, /18 hours ago/);
  assert.doesNotMatch(result.answer, /2023/);
});

test("a date visible in the page text is still listed", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Costs $20 [https://n.test].",
      statements: [],
    }),
    "Costs $20.",
    [
      {
        title: "N",
        url: "https://n.test",
        content: "Updated 2026-11-04\nPrice: $20/month.",
        pageText: null,
        publishedAt: null,
      },
    ],
    "What is the price?"
  );

  assert.match(result.answer, /2026-11-04/);
});

test("canonicalising a cleaned URL does not append its fragment twice", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Price: $20 [https://supabase.test/pricing#compare-plans].",
      statements: [
        {
          text: "Price: $20",
          url: "https://supabase.test/pricing",
          quote: null,
          supported: true,
        },
      ],
    }),
    "Price: $20.",
    [
      {
        title: "S",
        url: "https://supabase.test/pricing#compare-plans",
        content: "Price: $20.",
        pageText: null,
        publishedAt: null,
      },
    ],
    "What is the price?"
  );

  assert.equal(
    result.answer.match(/#compare-plans/g)?.length,
    1,
    result.answer
  );
});

test("ground keeps the original answer when the critic fails", async () => {
  const result = await ground(llmReturning({}, true), "Original.", sources, "Q");
  assert.equal(result.answer, "Original.");
  assert.equal(result.dropped, 0);
  assert.ok(result.error);
});
