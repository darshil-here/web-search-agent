import test from "node:test";
import assert from "node:assert/strict";
import { dropSourcesBlock, sourceLabel, sourcesSection, stripCitations, urlsIn } from "../src/sources.js";
import type { EnrichedSource } from "../src/search.js";

const source = (title: string, url: string): EnrichedSource => ({
  title,
  url,
  content: "text",
  pageText: null,
  publishedAt: null,
});

test("a label names the site, not the URL", () => {
  assert.equal(
    sourceLabel(
      "Bitcoin (BTC) Price USD Today, News, Charts, Market Cap | Coinbase",
      "https://www.coinbase.com/price/bitcoin"
    ),
    "Coinbase"
  );
  assert.equal(
    sourceLabel(
      "Bitcoin BTC (BTC-USD) Live Price, News, Chart & Price History - Yahoo Finance",
      "https://finance.yahoo.com/quote/BTC-USD"
    ),
    "Yahoo Finance"
  );
  assert.equal(
    sourceLabel("Python Releases for Windows | Python.org", "https://www.python.org/downloads/windows"),
    "Python.org"
  );
  assert.equal(
    sourceLabel("Node.js — Node.js Releases", "https://nodejs.org/en/about/previous-releases"),
    "Node.js"
  );
});

test("a title without the brand falls back to the domain", () => {
  assert.equal(
    sourceLabel("$68,798.31 Bitcoin Price (BTC/USD) Today | Live Chart", "https://www.binance.com/en/price/bitcoin"),
    "Binance"
  );
});

test("a missing title falls back to the domain", () => {
  assert.equal(sourceLabel("", "https://www.intel.com/newsroom"), "Intel");
  assert.equal(
    sourceLabel("https://www.intel.com/newsroom", "https://www.intel.com/newsroom"),
    "Intel"
  );
});

test("raw bracketed citations leave the prose", () => {
  const text = "Coinbase says $60,300.83. [https://www.coinbase.com/price/bitcoin]";
  assert.equal(stripCitations(text), "Coinbase says $60,300.83.");
});

test("a bracketed URL without a scheme also leaves the prose", () => {
  assert.equal(
    stripCitations("Price is $10. [finance.example.com/quote/BTC]"),
    "Price is $10."
  );
});

test("a citation-only bullet disappears instead of leaving a dash", () => {
  assert.equal(stripCitations("- [https://x.test/page]\n- Real point"), "- Real point");
});

test("a bracketed product name is not a citation", () => {
  assert.equal(stripCitations("[Node.js] is a runtime."), "[Node.js] is a runtime.");
});

test("a bare URL is removed but the sentence keeps its punctuation", () => {
  assert.equal(
    stripCitations("Bitcoin is $60,051.88 as of 18:12 UTC. See https://finance.test/quote/BTC-USD."),
    "Bitcoin is $60,051.88 as of 18:12 UTC. See."
  );
});

test("a named markdown link keeps its readable label", () => {
  assert.equal(
    stripCitations("According to [Yahoo Finance](https://finance.test/quote), the price fell."),
    "According to Yahoo Finance, the price fell."
  );
});

test("a table row keeps its values but loses the citations", () => {
  const row ="| Netlify | 100 GB [https://netlify.test/pricing] |";
  assert.equal(stripCitations(row), "| Netlify | 100 GB |");
});

test("a model-written Sources section is not duplicated", () => {
  assert.equal(
    dropSourcesBlock("Answer.\n\n## Sources\n\n- [X](https://x.test)"),
    "Answer."
  );
});

test("urlsIn peels sentence punctuation", () => {
  assert.deepEqual(urlsIn("See https://x.test/a."), ["https://x.test/a"]);
});

test("only cited, retrieved pages appear, once each", () => {
  const sources = [
    source("Coinbase", "https://www.coinbase.com/price/bitcoin"),
    source("Yahoo Finance", "https://finance.yahoo.com/quote/BTC-USD"),
    source("Unused result", "https://unused.test/page"),
  ];
  const section = sourcesSection(
    [
      "https://www.coinbase.com/price/bitcoin",
      "https://finance.yahoo.com/quote/BTC-USD",
      "https://www.coinbase.com/price/bitcoin?ref=duplicate",
    ],
    sources
  );

  assert.equal(
    section,
    "\n\n**Sources:** [Coinbase](https://www.coinbase.com/price/bitcoin) · [Yahoo Finance](https://finance.yahoo.com/quote/BTC-USD)"
  );
});

test("no cited pages means no Sources heading", () => {
  assert.equal(sourcesSection([], [source("Coinbase", "https://www.coinbase.com")]), "");
});
