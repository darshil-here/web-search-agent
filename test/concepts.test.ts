// Sibling concepts decide whether two attribute spellings describe the same
// thing, which is failure F-010. These tests pin the two directions: reword
// inside a family, never across families.
import test from "node:test";
import assert from "node:assert/strict";
import {
  anchorAttribute,
  attributeTokens,
  sameAttribute,
  SIBLING_CONCEPTS,
} from "../src/concepts.js";

test("anchoring swaps a sibling for the wording the question used", () => {
  assert.equal(
    anchorAttribute("latest LTS release", "What is the latest stable release?"),
    "latest stable release"
  );
  assert.equal(
    anchorAttribute("stable channel", "Is there a current channel?"),
    "current channel"
  );
});

test("anchoring leaves the attribute alone without a question or a sibling", () => {
  assert.equal(anchorAttribute("latest LTS release"), "latest LTS release");
  assert.equal(
    anchorAttribute("latest LTS release", "How much storage is free?"),
    "latest LTS release"
  );
});

test("anchoring never crosses families", () => {
  // "free tier" is not a sibling of "stable", so the question must not rewrite it.
  assert.equal(
    anchorAttribute("free tier", "What is the latest stable release?"),
    "free tier"
  );
});

test("anchoring a tier replaces the word, not the phrase twice", () => {
  assert.equal(
    anchorAttribute("free tier storage", "What does the paid plan include?"),
    "paid tier storage"
  );
  assert.equal(
    anchorAttribute("pro plan", "What does the free plan include?"),
    "free plan"
  );
});

test("the prompt vocabulary names every family once", () => {
  assert.match(SIBLING_CONCEPTS, /"stable"\/"LTS"\/"current"/);
  assert.match(SIBLING_CONCEPTS, /"alpha"\/"beta"/);
});

test("tokenizing an attribute ignores punctuation and case", () => {
  assert.deepEqual(attributeTokens("Latest Stable, release!"), [
    "latest",
    "stable",
    "release",
  ]);
});

test("the same attribute in different words still matches", () => {
  assert.equal(sameAttribute("latest stable release", "stable release"), true);
  assert.equal(sameAttribute("price", "price per month"), true);
});

test("contradictory siblings do not match", () => {
  assert.equal(sameAttribute("latest stable release", "latest LTS release"), false);
  assert.equal(sameAttribute("free tier", "paid tier"), false);
  assert.equal(sameAttribute("alpha release", "beta release"), false);
});

test("an empty attribute matches nothing", () => {
  assert.equal(sameAttribute("", "price"), false);
  assert.equal(sameAttribute("price", "  "), false);
});
