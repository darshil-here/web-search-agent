import test from "node:test";
import assert from "node:assert/strict";
import type { Llm } from "../src/llm.js";
import { needsGrounding, ground } from "../src/critic.js";
import type { EnrichedSource } from "../src/search.js";

const sources: EnrichedSource[] = [
  {
    title: "N",
    url: "https://n.test",
    content: "Neon offers 10 GB of storage.",
    pageText: null,
    publishedAt: null,
  },
];

const PRICE_QUOTE =
  "Regular market price: 59,979.21 -1,623.04 (-2.63%) as of 2026-11-24 17:38 UTC";

const price: EnrichedSource[] = [
  {
    title: "Bitcoin BTC (BTC-USD) Live Price, News, Chart & Price History",
    url: "https://finance.test/quote/BTC-USD",
    content: `CCC • USD\n\n${PRICE_QUOTE}\n\nMarket state: REGULAR`,
    pageText: null,
    publishedAt: "2026-11-24",
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

test("needsGrounding covers tables, numbers and citations", () => {
  assert.equal(needsGrounding("| a | b |\n|---|---|\n| 1 | 2 |"), true);
  assert.equal(needsGrounding("One is 10 GB, two is 20 GB, three is 30 GB."), true);
  // A short factual answer used to be skipped because it had only one number.
  assert.equal(needsGrounding("It costs $10 per month."), true);
  // A citation with no number is still a claim to verify.
  assert.equal(needsGrounding("Yes. [https://investor.nvidia.com/announcement]"), true);
});

test("needsGrounding skips answers with no fact to check", () => {
  assert.equal(needsGrounding("I do not know the answer."), false);
  // A calendar year is not a measurement.
  assert.equal(needsGrounding("In 2026 nothing changed."), false);
});

test("ground keeps a claim backed by a verbatim quote", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Neon offers 10 GB storage [https://n.test].",
      statements: [
        {
          text: "Neon offers 10 GB storage",
          url: "https://n.test",
          quote: "Neon offers 10 GB of storage.",
        },
      ],
    }),
    "Neon offers 10 GB storage.",
    sources,
    "How much storage?"
  );

  assert.match(result.answer, /10 GB storage/);
  assert.deepEqual(result.droppedClaims, []);
  assert.equal(result.dropped, 0);
});

test("a live price survives when the quote publishes cents", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer:
        "Bitcoin is $59,979 USD (Yahoo Finance quote, timestamped Nov 24, 2026 at 17:38 UTC). [https://finance.test/quote/BTC-USD]",
      statements: [
        {
          text: "Bitcoin is $59,979 USD",
          url: "https://finance.test/quote/BTC-USD",
          quote: PRICE_QUOTE,
        },
      ],
    }),
    "Bitcoin is $59,979 USD (Yahoo Finance quote, timestamped Nov 24, 2026 at 17:38 UTC).",
    price,
    "What is the bitcoin price today? in usd"
  );

  assert.match(result.answer, /\$59,979 USD/);
  assert.deepEqual(result.droppedClaims, []);
});

test("a claim whose quote is not in the page is removed", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Bitcoin is $59,979 USD today [https://finance.test/quote/BTC-USD].",
      statements: [
        {
          text: "Bitcoin is $59,979 USD today",
          url: "https://finance.test/quote/BTC-USD",
          quote: "Bitcoin is $59,979 USD today",
        },
      ],
    }),
    "Bitcoin is $59,979 USD today.",
    price,
    "What is the bitcoin price today? in usd"
  );

  assert.doesNotMatch(result.answer, /\$59,979/);
  assert.match(result.answer, /could not verify/i);
  assert.equal(result.droppedClaims.length, 1);
});

test("a quote that omits the claim's number does not verify it", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Neon has 10 branches [https://n.test].",
      statements: [
        {
          text: "Neon has 10 branches",
          url: "https://n.test",
          quote: "Neon offers storage.",
        },
      ],
    }),
    "Neon has 10 branches.",
    sources,
    "How many branches?"
  );

  assert.doesNotMatch(result.answer, /10 branches/);
  assert.doesNotMatch(result.answer, /not stated in sources/i);
});

test("an unsupported table cell becomes Not stated in place", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer:
        "| Feature | Neon |\n|---|---|\n| Branching | 10 branches [https://n.test] |",
      statements: [
        {
          text: "10 branches",
          url: "https://n.test",
          quote: "Neon offers branching features.",
        },
      ],
    }),
    "| Feature | Neon |\n|---|---|\n| Branching | 10 branches |",
    sources,
    "Compare the tiers"
  );

  assert.match(result.answer, /\| Branching \| Not stated/);
  assert.match(result.answer, /\| Feature \| Neon \|/);
  assert.doesNotMatch(result.answer, /10 branches/);
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
        },
      ],
    }),
    "| Projects | up to 2 active projects [https://supabase.test/pricing] |",
    variant,
    "Compare the tiers"
  );

  assert.doesNotMatch(result.answer, /\[\]/);
  assert.match(result.answer, /supabase\.test\/pricing\?ref=scrimba\.com/);
});

test("an invented URL cannot verify a claim and is removed", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Neon has 10 GB [https://invented.test].",
      statements: [
        {
          text: "Neon has 10 GB",
          url: "https://invented.test",
          quote: "Neon has 10 GB.",
        },
      ],
    }),
    "Neon has 10 GB.",
    sources,
    "How much storage?"
  );

  assert.doesNotMatch(result.answer, /invented\.test/);
  assert.doesNotMatch(result.answer, /\[\]/);
  assert.doesNotMatch(result.answer, /10 GB/);
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
        },
      ],
    }),
    "Neon includes up to 6 hours of recovery.",
    snippetOnly,
    "How much recovery?"
  );

  assert.doesNotMatch(result.answer, /could not verify/i);
  assert.match(result.answer, /6 hours/);
});

test("ground appends a no-date note when no source has a date", async () => {
  const result = await ground(
    llmReturning({
      revisedAnswer: "Costs $10 [https://n.test].",
      statements: [
        { text: "Costs $10", url: "https://n.test", quote: "Neon offers 10 GB of storage." },
      ],
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
      statements: [
        { text: "Costs $20", url: "https://n.test", quote: "Price: $20/month." },
      ],
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
      statements: [
        { text: "Costs $20", url: "https://n.test", quote: "Price: $20/month." },
      ],
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
          quote: "Price: $20.",
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

  assert.equal(result.answer.match(/#compare-plans/g)?.length, 1, result.answer);
});

test("ground keeps the original answer when the critic fails", async () => {
  const result = await ground(llmReturning({}, true), "Original.", sources, "Q");
  assert.equal(result.answer, "Original.");
  assert.equal(result.dropped, 0);
  assert.ok(result.error);
});
