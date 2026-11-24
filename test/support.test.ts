// support.ts is the deterministic half of grounding: a quote must be a
// verbatim excerpt of the cited page, and the claim's numbers must appear in
// that quote. There is no feature-word matching — that was the layer that
// rewrote a correct Bitcoin price as "not stated in sources".
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEvidence,
  assembleProse,
  checkClaim,
  claimMeasures,
  isVerbatimQuote,
  quoteStatesClaim,
  type VerifiedStatement,
} from "../src/support.js";

const statement = (
  text: string,
  supported = true
): VerifiedStatement => ({
  text,
  url: supported ? "https://example.test" : null,
  quote: null,
  supported,
});

const YAHOO =
  "CCC • USD\n\nRegular market price: 59,979.21 -1,623.04 (-2.63%) as of 2026-11-24 17:38 UTC\n\nMarket state: REGULAR";
const PRICE_QUOTE =
  "Regular market price: 59,979.21 -1,623.04 (-2.63%) as of 2026-11-24 17:38 UTC";

// --- verbatim quotes --------------------------------------------------------

test("a contiguous excerpt is a verbatim quote", () => {
  assert.equal(isVerbatimQuote(PRICE_QUOTE, YAHOO), true);
});

test("a paraphrase is not a verbatim quote", () => {
  assert.equal(
    isVerbatimQuote("Bitcoin currently trades around sixty thousand dollars", YAHOO),
    false
  );
});

test("whitespace differences do not break a quote", () => {
  assert.equal(
    isVerbatimQuote("Regular market price:  59,979.21\n-1,623.04", YAHOO),
    true
  );
});

test("a quote shorter than a phrase is not evidence", () => {
  assert.equal(isVerbatimQuote("USD", YAHOO), false);
});

// --- numeric presence -------------------------------------------------------

test("a rounded price is stated by a page publishing cents", () => {
  assert.equal(quoteStatesClaim("Bitcoin is $59,979 USD", PRICE_QUOTE), true);
});

test("the same value written differently is stated", () => {
  assert.equal(quoteStatesClaim("Bitcoin is 59979.21", PRICE_QUOTE), true);
});

test("a different price is not stated", () => {
  assert.equal(quoteStatesClaim("Bitcoin is $59,980 USD", PRICE_QUOTE), false);
});

test("a claim may not add precision the quote does not have", () => {
  assert.equal(quoteStatesClaim("Bitcoin is $59,979.213", PRICE_QUOTE), false);
});

test("a claim with no numbers only needs the quote", () => {
  assert.equal(
    quoteStatesClaim("Jensen Huang is president and CEO", "Jensen Huang is president and CEO of NVIDIA"),
    true
  );
});

test("numbers inside a citation URL are not claims", () => {
  const measures = claimMeasures(
    "Storage is 1 GB [https://example.test/2026/11/24/plan?limit=20]"
  );
  assert.equal(measures.length, 1);
  assert.equal(measures[0].value, 1);
});

// --- the evidence contract --------------------------------------------------

test("a verbatim quote that states the numbers verifies the claim", () => {
  assert.equal(checkClaim("Bitcoin is $59,979 USD", PRICE_QUOTE, YAHOO), true);
});

test("a quote that is not in the cited page does not verify", () => {
  assert.equal(
    checkClaim(
      "Bitcoin is $59,979 USD",
      "Bitcoin is $59,979 USD today",
      YAHOO
    ),
    false
  );
});

test("a numeric claim with no quote is checked against the page", () => {
  assert.equal(checkClaim("Bitcoin is $59,979 USD", null, YAHOO), true);
  assert.equal(checkClaim("Bitcoin is $60,000 USD", null, YAHOO), false);
});

test("a non-numeric claim with no quote is unverified", () => {
  assert.equal(checkClaim("Jensen Huang is president and CEO", null, YAHOO), false);
});

// --- removing unverified claims --------------------------------------------

test("an unverified sentence is removed whole, not spliced", () => {
  const answer =
    "Neon has 10 branches [https://neon.test/pricing]. Its free tier includes 1 GB of storage [https://neon.test/pricing]. Prices move continuously.";
  const result = applyEvidence(answer, [
    { text: "Neon has 10 branches", url: "https://neon.test/pricing", quote: null, supported: false },
    { text: "Its free tier includes 1 GB of storage", url: "https://neon.test/pricing", quote: null, supported: true },
  ]);

  assert.doesNotMatch(result.answer, /10 branches/);
  assert.doesNotMatch(result.answer, /not stated/i);
  assert.match(result.answer, /1 GB of storage/);
  assert.match(result.answer, /Prices move continuously/);
  assert.deepEqual(result.dropped, ["Neon has 10 branches [https://neon.test/pricing]."]);
});

test("a sentence with an unverified number and no statement is removed", () => {
  const result = applyEvidence("It costs $99 per month.", []);

  assert.equal(result.answer, "");
  assert.deepEqual(result.dropped, ["It costs $99 per month."]);
});

test("connective prose with no number survives an empty statement list", () => {
  const answer = "Prices move continuously, so the live price may differ.";
  assert.equal(applyEvidence(answer, []).answer, answer);
});

test("an unsupported table cell becomes Not stated and its neighbours survive", () => {
  const answer =
    "| Feature | Neon |\n|---|---|\n| Branching | 10 branches [https://neon.test/pricing] |\n| Storage | 1 GB [https://neon.test/pricing] |";
  const result = applyEvidence(answer, [
    { text: "10 branches", url: "https://neon.test/pricing", quote: null, supported: false },
    { text: "1 GB", url: "https://neon.test/pricing", quote: null, supported: true },
  ]);

  assert.match(result.answer, /\| Branching \| Not stated/);
  assert.match(result.answer, /\| Storage \| 1 GB/);
  assert.match(result.answer, /\| Feature \| Neon \|/);
  assert.doesNotMatch(result.answer, /10 branches/);
  assert.doesNotMatch(result.answer, /not stated in sources/i);
});

test("a table cell with a number and no statement is Not stated", () => {
  const result = applyEvidence("| Feature | Neon |\n|---|---|\n| Limits | 10 branches |", []);

  assert.match(result.answer, /\| Limits \| Not stated/);
});

test("a table header with a number is not rewritten", () => {
  const answer = "| Plan | 2026 quota |\n|---|---|\n| Free | 1 GB |";
  const result = applyEvidence(answer, [
    { text: "1 GB", url: "https://neon.test/pricing", quote: null, supported: true },
  ]);

  assert.match(result.answer, /\| Plan \| 2026 quota \|/);
  assert.match(result.answer, /\| Free \| 1 GB \|/);
});

test("the first table column is a row label, never Not stated", () => {
  const answer =
    "| Platform | Bandwidth |\n|---|---|\n| Netlify | 100 GB |\n| Vercel | 5 GB |";
  const result = applyEvidence(answer, [
    { text: "Netlify 100 GB", url: "https://netlify.test/pricing", quote: null, supported: true },
    { text: "Vercel 200 GB", url: "https://vercel.test/pricing", quote: null, supported: false },
  ]);

  assert.match(result.answer, /\| Netlify \| 100 GB \|/);
  assert.match(result.answer, /\| Vercel \| Not stated \|/);
  assert.doesNotMatch(result.answer, /^\| Not stated \|/m);
});

test("a cell's bracketed citation does not hide the claim", () => {
  const answer = "| Platform | Bandwidth |\n|---|---|\n| Netlify | 100 GB [https://netlify.test/pricing] |";
  const result = applyEvidence(answer, [
    { text: "Netlify 100 GB", url: "https://netlify.test/pricing", quote: null, supported: true },
  ]);

  assert.match(result.answer, /\| Netlify \| 100 GB \[https:\/\/netlify\.test\/pricing\] \|/);
});

// --- magnitudes -------------------------------------------------------------

test("a trillion in prose is stated by the raw total", () => {
  assert.equal(
    quoteStatesClaim("Apple's market cap is $5.13 trillion", "Market cap 5,133,702,791,168"),
    true
  );
});

test("a different magnitude is not stated by the raw total", () => {
  assert.equal(
    quoteStatesClaim("Apple's market cap is $5.14 trillion", "Market cap 5,133,702,791,168"),
    false
  );
});

test("a raw total does not verify a claim that adds precision", () => {
  assert.equal(
    quoteStatesClaim(
      "Apple's market cap is $5,133,702,791,168",
      "Market cap 5.13 trillion"
    ),
    false
  );
});

test("million and billion scale the same way", () => {
  assert.equal(quoteStatesClaim("1.2 million users", "1,200,000 users"), true);
  assert.equal(quoteStatesClaim("$459 billion", "459,000,000,000"), true);
});

// --- prose assembly ---------------------------------------------------------

test("verified statements are the prose, in order", () => {
  const answer = assembleProse([
    statement("Coinbase lists $60,300.83."),
    statement("A claim that failed.", false),
    statement("Yahoo Finance lists $60,051.88."),
  ]);
  assert.equal(
    answer,
    "Coinbase lists $60,300.83. Yahoo Finance lists $60,051.88."
  );
});

test("assembly never splits a sentence at an abbreviation", () => {
  const sentence =
    "Python 3.15.2 is a stable release dated Oct. 25, 2026.";
  assert.equal(assembleProse([statement(sentence)]), sentence);
});

test("bullets stay on separate lines", () => {
  const answer = assembleProse([
    statement("- **Node.js LTS:** v26.13.1."),
    statement("- **Python stable:** 3.15.2."),
  ]);
  assert.equal(answer, "- **Node.js LTS:** v26.13.1.\n- **Python stable:** 3.15.2.");
});

test("a paragraph broken into sentences is joined with spaces", () => {
  const answer = assembleProse([
    statement("The price rose."),
    statement("Volume fell."),
  ]);
  assert.equal(answer, "The price rose. Volume fell.");
});
