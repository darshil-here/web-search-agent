import test from "node:test";
import assert from "node:assert/strict";
import { expandInlineTables } from "../src/markdown.js";

test("a one-line table becomes rows the renderer can read", () => {
  const input =
    "Assuming list prices. | CRM | Plan | Price | |---|---|---:| | HubSpot | Starter | $9 | | Pipedrive | Lite | $14 |";
  assert.equal(
    expandInlineTables(input),
    [
      "Assuming list prices.",
      "| CRM | Plan | Price |",
      "|---|---|---:|",
      "| HubSpot | Starter | $9 |",
      "| Pipedrive | Lite | $14 |",
    ].join("\n")
  );
});

test("a table that already has rows is left alone", () => {
  const input = [
    "| CRM | Plan |",
    "|---|---|",
    "| HubSpot | Starter |",
  ].join("\n");
  assert.equal(expandInlineTables(input), input);
});

test("prose with a pipe but no table is left alone", () => {
  const input = "The pipe | is just punctuation here.";
  assert.equal(expandInlineTables(input), input);
});

test("escaped pipes stay inside their cell", () => {
  const input = "| A | B | |---|---| | one \\| two | three |";
  assert.equal(
    expandInlineTables(input),
    ["| A | B |", "|---|---|", "| one \\| two | three |"].join("\n")
  );
});

test("prose after a one-line table stays prose", () => {
  const input = "| A | B | |---|---| | 1 | 2 | In short: it depends.";
  assert.equal(
    expandInlineTables(input),
    ["| A | B |", "|---|---|", "| 1 | 2 |", "In short: it depends."].join("\n")
  );
});

test("a separator line on its own is not a table", () => {
  assert.equal(expandInlineTables("|---|---|"), "|---|---|");
});

test("an empty cell keeps its column position", () => {
  const input = "| A | B | C | |---|---|---| | 1 | | 3 | | 4 | 5 | 6 |";
  assert.equal(
    expandInlineTables(input),
    ["| A | B | C |", "|---|---|---|", "| 1 | | 3 |", "| 4 | 5 | 6 |"].join(
      "\n"
    )
  );
});

test("a four-column one-line table with a trailing note", () => {
  const input =
    "| CRM | Plan | Price | Seats | |---|---|---:|---:| | HubSpot | Starter | $9 | $180 | | Zoho | Standard | $14 | $280 | Note: list prices.";
  assert.equal(
    expandInlineTables(input),
    [
      "| CRM | Plan | Price | Seats |",
      "|---|---|---:|---:|",
      "| HubSpot | Starter | $9 | $180 |",
      "| Zoho | Standard | $14 | $280 |",
      "Note: list prices.",
    ].join("\n")
  );
});
