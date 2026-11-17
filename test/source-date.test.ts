import test from "node:test";
import assert from "node:assert/strict";
import { extractSourceDate } from "../src/source-date.js";

test("extracts an ISO date after a label", () => {
  assert.equal(extractSourceDate("Updated: 2026-11-14\nPricing..."), "2026-11-14");
});

test("extracts a spelled-out date without a label", () => {
  assert.equal(extractSourceDate("Last reviewed 14 November 2025"), "2025-11-14");
});

test("extracts a month-first date", () => {
  assert.equal(extractSourceDate("Published March 3, 2026"), "2026-03-03");
});

test("returns null when no date is visible", () => {
  assert.equal(extractSourceDate("Free plan includes 10 GB storage."), null);
});

test("does not invent a date from a bare year", () => {
  assert.equal(extractSourceDate("Pricing updated for 2026"), null);
});
