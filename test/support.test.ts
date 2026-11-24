// The value-support guard is pure: no model, no network. It enforces the
// grounding contract in code — a numeric claim may appear only if the retrieved
// text actually states that value. The critic's "supported" flag is a hint, not
// the enforcement, because the model applied it inconsistently in F-002.
import test from "node:test";
import assert from "node:assert/strict";
import { guardValueSupport } from "../src/support.js";

const SOURCES = [
  {
    url: "https://neon.test/pricing",
    text: "Free: up to 100 projects, 1 GB of storage, 5 GB data transfer per project.",
  },
  {
    url: "https://supabase.test/pricing",
    text: "Free: 500 MB database, 5 GB egress, 50,000 MAUs.",
  },
];

test("a value absent from every source is marked not stated in sources", () => {
  const answer = "Neon includes 10 branches per project [https://neon.test/pricing].";

  const result = guardValueSupport(answer, SOURCES);

  assert.equal(result.replaced.length, 1);
  assert.match(result.answer, /not stated in sources/);
  assert.doesNotMatch(result.answer, /10 branches/);
});

test("a supported measure with a different qualifier is kept", () => {
  // "100 Free projects" and "1 GB per project" are stated in different words;
  // only the number and its unit are checked, so they survive.
  const answer = "Neon has 100 Free projects and 1 GB per project [https://neon.test/pricing].";

  assert.deepEqual(guardValueSupport(answer, SOURCES).replaced, []);
});

test("a value present in a source is kept", () => {
  const answer = "Neon offers 5 GB data transfer per project [https://neon.test/pricing].";

  const result = guardValueSupport(answer, SOURCES);

  assert.deepEqual(result.replaced, []);
  assert.equal(result.answer, answer);
});

test("a value stated only by a different source is marked unknown", () => {
  // A URL beside a cell is a claim about where the value came from. If that
  // source does not state it, another source stating it does not rescue it.
  const answer =
    "Neon has 20 GB total [https://neon.test/pricing].";
  const other = [
    ...SOURCES,
    { url: "https://other.test", text: "Neon offers 20 GB total storage." },
  ];

  const result = guardValueSupport(answer, other);

  assert.equal(result.replaced.length, 1);
  assert.match(result.answer, /not stated in sources/);
});

test("a cited source with the value is kept even if no other source has it", () => {
  const answer = "The free tier includes 5 GB egress [https://supabase.test/pricing].";

  assert.deepEqual(guardValueSupport(answer, SOURCES).replaced, []);
});

test("comma numbers and currency values are checked literally", () => {
  const answer =
    "Supabase allows 60,000 MAUs at $25/seat [https://supabase.test/pricing].";
  const result = guardValueSupport(answer, SOURCES);

  // Both 60,000 MAUs and $25/seat are absent from the sources.
  assert.equal(result.replaced.length, 2);
  assert.match(result.answer, /not stated in sources at not stated in sources/);
});

test("a markdown table cell with an unsupported value is rewritten in place", () => {
  const answer =
    "| Feature | Neon |\n|---|---|\n| Branching | 10 branches [https://neon.test/pricing] |";
  const result = guardValueSupport(answer, SOURCES);

  assert.equal(result.replaced.length, 1);
  // The URL stays beside the cell; only the value becomes an unknown marker.
  assert.match(result.answer, /\| Branching \| not stated in sources \[https:\/\/neon\.test\/pricing\] \|/);
  assert.match(result.answer, /\| Feature \| Neon \|/);
});

test("text with no checkable values is left untouched", () => {
  const answer = "Both plans are useful, but neither is time-limited.";

  assert.deepEqual(guardValueSupport(answer, SOURCES), {
    answer,
    replaced: [],
    checked: 0,
  });
});

// --- quote-level evidence (F-012) ------------------------------------------

test("a quote that states the value but not the feature does not support the claim", () => {
  // The live grounding-001 failure: the cited page says "500 MB database",
  // which is not evidence for "500 MB RAM" in a Compute row.
  const answer =
    "| Compute | Shared compute; 500 MB RAM [https://supabase.test/pricing] |";
  const evidence = [
    {
      url: "https://supabase.test/pricing",
      text: "Supabase free includes 500 MB RAM",
      quote: "Free: 500 MB database, 5 GB egress, 50,000 MAUs.",
    },
  ];

  const result = guardValueSupport(answer, SOURCES, evidence);

  assert.equal(result.replaced.length, 1);
  assert.doesNotMatch(result.answer, /500 MB RAM/);
});

test("a verified quote that names the feature supports the value", () => {
  const answer =
    "Supabase includes 2 active projects [https://supabase.test/pricing].";
  const evidence = [
    {
      url: "https://supabase.test/pricing",
      text: "Supabase includes 2 active projects",
      quote: "Supabase Free allows only 2 active projects per user.",
    },
  ];
  const sources = [
    {
      url: "https://supabase.test/pricing",
      text: "Supabase Free allows only 2 active projects per user. Free: 500 MB database.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources, evidence).replaced, []);
});

test("a quote about another vendor does not support a misattributed value", () => {
  // The live citation-001 failure: "1 GB" appears on the page, but in a
  // Supabase sentence, not a Neon Postgres storage sentence.
  const answer =
    "Neon's Free plan includes 1 GB of Postgres storage per project [https://neon.test/guide].";
  const sources = [
    {
      url: "https://neon.test/guide",
      text: "Neon Free includes 100 projects. Supabase file storage is 1 GB.",
    },
  ];
  const evidence = [
    {
      url: "https://neon.test/guide",
      text: "Neon's Free plan includes 1 GB of Postgres storage per project",
      quote: "Supabase file storage is 1 GB.",
    },
  ];

  const result = guardValueSupport(answer, sources, evidence);

  assert.equal(result.replaced.length, 1);
  assert.match(result.answer, /not stated in sources/);
  assert.doesNotMatch(result.answer, /1 GB of Postgres storage/);
});

test("digits inside a citation URL are not rewritten", () => {
  const answer =
    "Neon has 10 branches [https://neon.test/2026/plans?limit=20].";
  const result = guardValueSupport(answer, SOURCES);

  assert.equal(result.replaced.length, 1);
  assert.match(result.answer, /https:\/\/neon\.test\/2026\/plans\?limit=20/);
});

test("a paraphrased quote does not turn a true value into an unknown", () => {
  // Quotes are a supplement, not the only path: the cited page states the
  // value next to the feature, so a bad critic quote must not erase it.
  const answer = "Neon has 10 GB storage [https://neon.test/pricing].";
  const sources = [
    { url: "https://neon.test/pricing", text: "Free: 10 GB storage per project." },
  ];
  const evidence = [
    {
      url: "https://neon.test/pricing",
      text: "Neon has 10 GB storage",
      quote: "ten gigabytes of storage",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources, evidence).replaced, []);
});

test("a value in the cited text but attached to another feature is marked", () => {
  // citation-001: the cited guide mentions "1 GB" only as Supabase file
  // storage, not as Neon Postgres storage.
  const answer =
    "Neon's Free plan includes 1 GB of Postgres storage per project [https://neon.test/guide].";
  const sources = [
    {
      url: "https://neon.test/guide",
      text: "Neon Free includes 100 projects. Supabase file storage is 1 GB.",
    },
  ];

  const result = guardValueSupport(answer, sources);

  assert.equal(result.replaced.length, 1);
  assert.match(result.answer, /not stated in sources/);
});

test("the same value next to the right feature is kept", () => {
  const answer =
    "Neon's Free plan includes 1 GB of Postgres storage per project [https://neon.test/plans].";
  const sources = [
    {
      url: "https://neon.test/plans",
      text: "The Free plan includes 1 GB of Postgres storage per project.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("an absence claim no cited source states is marked", () => {
  const answer =
    "| Exclusions | No automatic backups or branching [https://supabase.test/pricing] |";
  const sources = [
    {
      url: "https://supabase.test/pricing",
      text: "Free: 500 MB database, 2 active projects, 5 GB egress.",
    },
  ];

  const result = guardValueSupport(answer, sources);

  assert.doesNotMatch(result.answer, /automatic backups/);
  assert.doesNotMatch(result.answer, /branching/);
  assert.match(result.answer, /not stated in sources/);
});

test("an absence claim the source states is kept", () => {
  const answer =
    "| Exclusions | No automatic backups [https://supabase.test/pricing] |";
  const sources = [
    {
      url: "https://supabase.test/pricing",
      text: "Free projects include no automatic backups.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("a value stated after its feature is supported", () => {
  // Real page shape: "| Edge function invocations | 500,000 per month |".
  // The answer puts the number first, so the literal measure is absent even
  // though the page states exactly this allowance.
  const answer =
    "| Other | 500,000 Edge Function invocations per month [https://supabase.test/pricing] |";
  const sources = [
    {
      url: "https://supabase.test/pricing",
      text: "| Edge function invocations | 500,000 per month |",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("an unsupported cell value is replaced with its whole clause", () => {
  const answer =
    "| Other | 10 branches [https://neon.test/pricing]; 1 manual snapshot [https://neon.test/pricing] |";
  const sources = [
    { url: "https://neon.test/pricing", text: "Free: 100 projects and 10 branches." },
  ];

  const result = guardValueSupport(answer, sources);

  assert.deepEqual(result.replaced, ["1 manual snapshot"]);
  assert.match(result.answer, /not stated in sources/);
  assert.doesNotMatch(result.answer, /not stated in sources snapshot/);
});

test("a tracked variant of the cited page supplies the evidence", () => {
  // The answer cites the clean URL; search returned the same page under a
  // tracked URL with the plan list. Exact URL matching graded the value against
  // a short snippet and marked it unknown.
  const answer =
    "| Compute | up to 2 CU [https://neon.test/pricing] |";
  const sources = [
    {
      url: "https://neon.test/pricing?bb=174788",
      text: "Free: 100 CU-hours per project. Sizes up to 2 CU (8 GB RAM).",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("merged fragments do not let one vendor rescue another", () => {
  // The Supabase page is cited; it states 1 GB of file storage, not Postgres
  // storage. The Neon page states Postgres storage but is not the citation.
  const answer =
    "| Database storage | 1 GB Postgres storage [https://supabase.test/pricing] |";
  const sources = [
    {
      url: "https://supabase.test/pricing",
      text: "Free: 1 GB file storage, 500 MB database.",
    },
    { url: "https://neon.test/pricing", text: "1 GB of Postgres storage." },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, [
    "1 GB Postgres storage",
  ]);
});

test("a paraphrased recovery limit is kept when the number and topic match", () => {
  const answer =
    "| Backups | Limited recovery on Free: up to 6 hours or 1 GB of change history [https://neon.test/pricing] |";
  const sources = [
    {
      url: "https://neon.test/pricing",
      text: "Free: up to 6 hours or 1 GB of data changes; 1 snapshot.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("a size quota is not grounded by the word project in \"per project\"", () => {
  // "5 GB per project per month" on a Traffic/egress row. The page states a
  // 5 GB object-storage allowance, not a traffic one. The framing words "per
  // project" appear everywhere and must not tie the number to a feature.
  const answer =
    "| **Traffic / egress** | **5 GB per project per month** [https://neon.test/pricing] |";
  const sources = [
    {
      url: "https://neon.test/pricing",
      text: "Free plan: 100 projects, 1 GB of storage, 5 GB of Object Storage.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, [
    "5 GB per project per month",
  ]);
});

test("a size quota keeps its feature when the feature follows the unit", () => {
  const answer =
    "| **File/object storage** | **5 GB object storage** [https://neon.test/pricing] |";
  const sources = [
    {
      // The number is glued to the preceding image label after scraping.
      url: "https://neon.test/pricing",
      text: "Managed AuthImage 17Image 18 5 GB of Object StorageImage 19",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("a row label grounds a quota when its synonyms differ from the source", () => {
  const answer =
    "| **Postgres storage** | **1 GB per project** [https://neon.test/pricing] |";
  const sources = [
    {
      url: "https://neon.test/pricing",
      text: "Free: 1 GB of storage per project.",
    },
  ];

  // "storage" is one of the row's words, so the value is tied to the row even
  // though the source does not say "Postgres".
  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("a bare scraped number does not support a named quota", () => {
  // The page's plan grid renders the branch count as a bare "10" with no label.
  const answer =
    "| **Other limits** | Up to **10 branches per project** [https://neon.test/pricing] |";
  const sources = [
    {
      url: "https://neon.test/pricing",
      text: "Free $0: 100 projects, 10, 100 CU-hours per project. Branching.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, [
    "10 branches per project",
  ]);
});

test("a leading qualifier is replaced with the value", () => {
  const answer =
    "| **Auth** | Up to **60,000 MAUs per project** [https://neon.test/pricing] |";
  const sources = [
    { url: "https://neon.test/pricing", text: "Free: 100 projects." },
  ];

  const result = guardValueSupport(answer, sources);
  assert.doesNotMatch(result.answer, /up to not stated/);
  assert.doesNotMatch(result.answer, /up to \*\*not stated/);
});

test("a plural feature word supports the singular claim", () => {
  const answer =
    "| **Other included services** | Instant restore history capped at **1 GB of changes** [https://neon.test/pricing] |";
  const sources = [
    {
      url: "https://neon.test/pricing",
      text: "Instant restore history | 6 hours, capped at 1 GB of change history.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("a currency amount is its own feature on a generic Price row", () => {
  const answer =
    "| **Price** | **$0**; no time limit or credit card required [https://neon.test/pricing] |";
  const sources = [
    {
      url: "https://neon.test/pricing",
      text: "Free plan: $0. No time limits and no credit card required.",
    },
  ];

  assert.deepEqual(guardValueSupport(answer, sources).replaced, []);
});

test("the absence guard does not rewrite an already marked cell", () => {
  const answer =
    "| **Price** | not stated in sources; no time limit required [https://neon.test/pricing] |";
  const sources = [
    { url: "https://neon.test/pricing", text: "Free plan: $0." },
  ];

  const once = guardValueSupport(answer, sources);
  const twice = guardValueSupport(once.answer, sources);

  assert.equal(twice.answer, once.answer);
  assert.match(twice.answer, /\[https:\/\/neon\.test\/pricing\]/);
  assert.doesNotMatch(twice.answer, /sourceshttps/);
});

// --- live prices ------------------------------------------------------------
//
// The live failure: the model answered "$59,979 USD" from a Yahoo Finance
// quote whose price line reads "Regular market price: 59,979.21". The guard
// compared the strings literally, found "$59,979" nowhere (the page has no
// dollar sign on that line and publishes cents), and rewrote a correct answer
// as "Bitcoin is not stated in sources".
const LIVE_PRICE = [
  {
    url: "https://finance.test/quote/BTC-USD",
    text: "CCC • USD\n\nRegular market price: 59,979.21 -1,623.04 (-2.63%) as of 2026-11-24 17:38 UTC\n\nMarket state: REGULAR",
  },
];

test("a rounded price is supported when the page publishes cents", () => {
  const answer =
    "Bitcoin is $59,979 USD as of Nov 24, 2026 17:38 UTC [https://finance.test/quote/BTC-USD].";

  assert.deepEqual(guardValueSupport(answer, LIVE_PRICE).replaced, []);
});

test("the dollar sign is display, not evidence", () => {
  // The page writes the price without "$"; the answer adds it. Same value.
  const answer =
    "Bitcoin is $59,979.21 USD [https://finance.test/quote/BTC-USD].";

  assert.deepEqual(guardValueSupport(answer, LIVE_PRICE).replaced, []);
});

test("a price framed by a prose word keeps its value", () => {
  // "today" and "right now" say when the price was read, not what it measures.
  const answer =
    "Bitcoin is $59,979 today and 59,979.21 right now [https://finance.test/quote/BTC-USD].";

  assert.deepEqual(guardValueSupport(answer, LIVE_PRICE).replaced, []);
});

test("rounding is not a licence to change the value", () => {
  // 59,979.21 rounds to 59,979, not 59,980.
  const answer = "Bitcoin is $59,980 USD [https://finance.test/quote/BTC-USD].";

  assert.deepEqual(guardValueSupport(answer, LIVE_PRICE).replaced, ["$59,980 USD"]);
});

test("the answer may not add precision the page does not state", () => {
  const answer = "Bitcoin is $59,979.213 USD [https://finance.test/quote/BTC-USD].";

  assert.deepEqual(guardValueSupport(answer, LIVE_PRICE).replaced, [
    "$59,979.213 USD",
  ]);
});

test("a number the page never states is still replaced", () => {
  const answer = "Bitcoin is $60,000 USD [https://finance.test/quote/BTC-USD].";

  assert.deepEqual(guardValueSupport(answer, LIVE_PRICE).replaced, ["$60,000 USD"]);
});

test("two vendor cells on one table row are not graded against one pooled corpus", () => {
  const sources = [
    { url: "https://neon.test/pricing", text: "Free: up to 100 projects." },
    { url: "https://supabase.test/pricing", text: "Free: 500 MB database." },
  ];
  const answer =
    "| Projects | 100 projects [https://neon.test/pricing] | 2 active projects [https://supabase.test/pricing] |";

  const result = guardValueSupport(answer, sources);

  // The Neon value is stated; the Supabase value is not in the Supabase page,
  // even though the Neon page was on the same line.
  assert.deepEqual(result.replaced, ["2 active projects"]);
  assert.match(result.answer, /\| not stated in sources \[https:\/\/supabase\.test\/pricing\]/);
  assert.doesNotMatch(result.answer, /2 active/);
  assert.match(result.answer, /\| 100 projects \[https:\/\/neon\.test\/pricing\] \|/);
});
