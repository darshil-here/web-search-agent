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
