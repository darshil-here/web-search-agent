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

/** A number as written: its base value and the step its writer rounded to. */
type Measure = { value: number; step: number };

/**
 * A number with thousands separators, at most one decimal part, and an
 * optional magnitude word. "$5.13 trillion" is the same value as
 * 5,133,702,791,168 rounded to the claim's precision; readers should not have
 * to dump 13-digit integers.
 */
const MEASURE_TOKEN =
  /(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*(thousand|million|billion|trillion)\b)?/gi;
const SCALE: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
};
const URL = /https?:\/\/[^\s)\]|,]+/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase, collapse whitespace, drop markdown emphasis. */
function normalise(text: string): string {
  return flatten(text).replace(/\*/g, "").toLowerCase();
}

/** Text without markdown links, bracketed citations or bare URLs. */
function plain(text: string): string {
  return flatten(text)
    .replace(/\[\s*https?:\/\/[^\]]*\]/gi, " ")
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

function measure(raw: string, scaleWord?: string): Measure | null {
  const cleaned = raw.replace(/,/g, "");
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return null;
  const decimals = cleaned.split(".")[1]?.length ?? 0;
  const scale = scaleWord === undefined ? 1 : (SCALE[scaleWord.toLowerCase()] ?? 1);
  return { value: number * scale, step: 10 ** -decimals * scale };
}

/** Every number in a claim, in the order written. */
export function claimMeasures(text: string): Measure[] {
  return [...plain(text).matchAll(MEASURE_TOKEN)]
    .map((match) => measure(match[1] ?? "", match[2]))
    .filter((item): item is Measure => item !== null);
}

/**
 * True when `text` states a number that rounds to the claim's value at the
 * claim's precision. A page publishing 59,979.21 states "$59,979"; a page
 * publishing 5,133,702,791,168 states "$5.13 trillion". A claim cannot add
 * precision the page does not have.
 */
function statesMeasure(text: string, claim: Measure): boolean {
  for (const match of plain(text).matchAll(MEASURE_TOKEN)) {
    const stated = measure(match[1] ?? "", match[2]);
    if (stated === null) continue;
    const rounded = Math.round(stated.value / claim.step) * claim.step;
    const tolerance = Math.abs(claim.value) * 1e-12 + 1e-9;
    if (Math.abs(rounded - claim.value) <= tolerance) return true;
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
  quote: string | null;
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
 * Remove the claims that did not verify. This path is used for answers with a
 * markdown table, where the table itself delimits the claims. Prose answers do
 * not use it: they are assembled from verified statements instead.
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
      // The first visible column is the row's name (a platform, plan or
      // feature). Never replace it with "Not stated": an unsupported value in
      // another column must not erase which row it belonged to.
      return line
        .split("|")
        .map((cell, column) => (column === 1 ? cell : gradeCell(cell)))
        .join("|");
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

/**
 * A statement that carries no URL and no quote may only be a lead-in. A
 * heading or a phrase ending in a colon introduces what follows; it does not
 * assert anything about a product. Anything else must be evidenced, even when
 * it states no number: otherwise a qualitative claim ("Neon is faster") could
 * reach the reader through the connective-prose path without verification.
 */
export function isLeadIn(text: string): boolean {
  const raw = flatten(text).trim();
  if (raw === "") return false;
  if (/^#{1,6}\s/.test(raw)) return true;
  return raw.endsWith(":");
}

/** A markdown line that must stand on its own, not be merged into a paragraph. */
function isBlockLine(text: string): boolean {
  return (
    /^\s*(?:[-*•]|\d+[.)])\s+/.test(text) ||
    /^\s*#{1,6}\s+/.test(text) ||
    /^\s*>\s?/.test(text)
  );
}

function isBullet(text: string): boolean {
  return /^\s*(?:[-*•]|\d+[.)])\s+/.test(text);
}

/**
 * Assemble a prose answer from the critic's statements, in reading order. The
 * statements are the answer: there is no draft to split into sentences and no
 * text to match back. A statement the verifier rejected is simply absent.
 * Consecutive sentences form a paragraph; bullets and headings stay on their
 * own lines. This removes the paraphrase and abbreviation failures that lost
 * verified answers.
 */
export function assembleProse(statements: VerifiedStatement[]): string {
  const kept = statements
    .filter((statement) => statement.supported)
    .map((statement) => statement.text.trim())
    .filter((text) => text !== "");

  const parts: Array<{ text: string; bullet: boolean }> = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      parts.push({ text: paragraph.join(" "), bullet: false });
      paragraph = [];
    }
  };
  for (const text of kept) {
    if (isBlockLine(text)) {
      flush();
      parts.push({ text, bullet: isBullet(text) });
    } else {
      paragraph.push(text);
    }
  }
  flush();

  let out = "";
  let previousBullet = false;
  for (const part of parts) {
    if (out !== "") out += part.bullet && previousBullet ? "\n" : "\n\n";
    out += part.text;
    previousBullet = part.bullet;
  }
  return out;
}
