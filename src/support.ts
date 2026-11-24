// support.ts
//
// Deterministic evidence checks for grounded answers.
//
// The critic is the language understanding: it decides which source sentence
// supports which claim. Code verifies two exact things:
//   1. the quote is a verbatim excerpt of the cited page;
//   2. every number in the claim appears in that quote (or, when the critic
//      gave no excerpt, on the cited page).
// A claim that fails those checks is unverified and is removed whole. There is
// deliberately no feature-word matching here: "is this number about the same
// feature" is a language question, and encoding it in code produced false
// negatives on live prices (a Yahoo quote publishing 59,979.21 was read as not
// stating "$59,979").
import { flatten } from "./text.js";

/** A number as written: its value and the precision the writer used. */
type Measure = { value: number; decimals: number };

/** A number with thousands separators and at most one decimal part. */
const NUMBER_TOKEN = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const URL = /https?:\/\/[^\s)\]|,]+/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase, collapse whitespace, drop markdown emphasis. */
function normalise(text: string): string {
  return flatten(text).replace(/\*/g, "").toLowerCase();
}

/** Text without markdown link targets or bare URLs, for claim matching. */
function plain(text: string): string {
  return flatten(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(URL, " ");
}

/**
 * Locate a needle, tolerating whitespace differences. Scraped pages sometimes
 * join words ("6 hoursor") or split them; an exact substring test lost evidence
 * a reader would call present.
 */
function findNeedle(
  hay: string,
  needle: string
): { index: number; length: number } | null {
  if (needle === "") return null;
  const direct = hay.indexOf(needle);
  if (direct !== -1) return { index: direct, length: needle.length };
  const pattern = new RegExp(
    needle.trim().split(/\s+/).map(escapeRegExp).join("\\s*")
  );
  const match = pattern.exec(hay);
  return match ? { index: match.index, length: match[0].length } : null;
}

/** True when the excerpt appears contiguously in the cited text. */
export function isVerbatimQuote(quote: string, text: string): boolean {
  const needle = normalise(quote);
  return needle.length >= 8 && findNeedle(normalise(text), needle) !== null;
}

function measure(raw: string): Measure | null {
  const cleaned = raw.replace(/,/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const fraction = cleaned.split(".")[1] ?? "";
  return { value, decimals: fraction.length };
}

/** Every number in a claim, in the order written. */
export function claimMeasures(text: string): Measure[] {
  return [...plain(text).matchAll(NUMBER_TOKEN)]
    .map((match) => measure(match[0]))
    .filter((item): item is Measure => item !== null);
}

/**
 * True when `text` states a number that rounds to the claim's value at the
 * claim's precision. A page publishing 59,979.21 states "$59,979"; a claim
 * cannot add precision the page does not have.
 */
function statesMeasure(text: string, claim: Measure): boolean {
  const factor = 10 ** claim.decimals;
  for (const match of plain(text).matchAll(NUMBER_TOKEN)) {
    const stated = measure(match[0]);
    if (stated === null) continue;
    const rounded = Math.round(stated.value * factor) / factor;
    if (Math.abs(rounded - claim.value) < 1e-9) return true;
  }
  return false;
}

/** True when the quote states every number the claim uses. */
export function quoteStatesClaim(claim: string, quote: string): boolean {
  return claimMeasures(claim).every((item) => statesMeasure(quote, item));
}

/**
 * The evidence contract for one claim. A verbatim quote is required; its
 * numbers must cover the claim's numbers. When the critic gave no excerpt, the
 * page itself may state a numeric claim, but a claim with no number has nothing
 * to check and stays unverified.
 */
export function checkClaim(
  text: string,
  quote: string | null,
  citedText: string
): boolean {
  const excerpt = (quote ?? "").trim();
  if (excerpt !== "") {
    return isVerbatimQuote(excerpt, citedText) && quoteStatesClaim(text, excerpt);
  }
  const measures = claimMeasures(text);
  return measures.length > 0 && measures.every((item) => statesMeasure(citedText, item));
}

/** A critic statement after code has resolved its URL and checked its quote. */
export type VerifiedStatement = {
  text: string;
  url: string | null;
  supported: boolean;
};

export type ApplyResult = {
  answer: string;
  /** The sentences or cells removed because they were not verified. */
  dropped: string[];
};

function matches(statementText: string, segment: string): boolean {
  const claim = normalise(plain(statementText));
  const part = normalise(plain(segment));
  if (claim === "" || part === "") return false;
  return part.includes(claim) || claim.includes(part);
}

function hasNumber(text: string): boolean {
  return claimMeasures(text).length > 0;
}

function isTableRow(line: string): boolean {
  return line.trimStart().startsWith("|");
}

function isSeparator(line: string): boolean {
  const cells = line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Remove the claims that did not verify. Prose is handled sentence by sentence;
 * a table cell becomes "Not stated". Nothing is spliced inside a sentence, so a
 * wrong value is never left behind with an error string around it.
 */
export function applyEvidence(
  answer: string,
  statements: VerifiedStatement[]
): ApplyResult {
  const lines = answer.split("\n");
  // A table's first row is its header; its labels are not claims to verify.
  const headers = new Set<number>();
  for (let i = 0; i + 1 < lines.length; i++) {
    if (isTableRow(lines[i]) && isSeparator(lines[i + 1])) headers.add(i);
  }

  const dropped: string[] = [];

  const gradeCell = (cell: string): string => {
    if (cell.trim() === "") return cell;
    const matched = statements.filter((item) => matches(item.text, cell));
    if (matched.length > 0) {
      if (matched.every((item) => item.supported)) return cell;
      dropped.push(cell.trim());
      return " Not stated ";
    }
    if (hasNumber(cell)) {
      dropped.push(cell.trim());
      return " Not stated ";
    }
    return cell;
  };

  const kept = lines.map((line, index) => {
    if (line.trim() === "") return line;

    if (isTableRow(line)) {
      if (isSeparator(line) || headers.has(index)) return line;
      return line.split("|").map(gradeCell).join("|");
    }

    const sentences = line.split(/(?<=[.!?;])\s+/);
    const survivors = sentences.filter((sentence) => {
      const matched = statements.filter((item) => matches(item.text, sentence));
      if (matched.length > 0) {
        if (matched.every((item) => item.supported)) return true;
        dropped.push(sentence.trim());
        return false;
      }
      if (hasNumber(sentence)) {
        dropped.push(sentence.trim());
        return false;
      }
      return true;
    });

    return survivors.join(" ");
  });

  return {
    answer: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    dropped,
  };
}
