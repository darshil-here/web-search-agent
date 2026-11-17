// calibration.ts
//
// "Sources do not state" contract in code. F-004 was an unhedged claim the
// model produced when sources said nothing about longevity; a prompt line did
// not stop it, so the rule is enforced after the answer instead.
import type { SearchResult } from "./search.js";

export type CalibrationResult = { answer: string; rewritten: string[] };

const ABSOLUTE =
  /\b(?:permanent|no time limit|no expiration|no expiry|genuinely free|always free|remains free|forever|indefinitely|(?:never|doesn't|does not|don't|do not|not|isn't|is not)\s+(?:described\s+as\s+)?(?:expire|expiring|expires|time out|timeout))\b/i;
const SENTENCE = /(?<=[.!?])\s+/;

const NOT_SUBJECTS = new Set([
  "The", "Neither", "Both", "This", "That", "It", "Its", "So", "But",
  "Yes", "No", "One", "Two", "And", "For", "On", "In",
]);

function subjectOf(sentence: string): string {
  const words = sentence.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? [];
  const candidate = words.find((word) => !NOT_SUBJECTS.has(word));
  return candidate ?? "this plan";
}

export function guardCalibration(
  question: string,
  answer: string,
  sources: SearchResult[]
): CalibrationResult {
  const parts = answer.split(SENTENCE);
  // An expiry question is exactly when F-004 bites: the model asserts "never
  // expires" without a source. The guard still applies; the source check below
  // keeps a hedged or source-backed answer intact.

  const rewritten: string[] = [];
  const kept: string[] = [];

  for (const part of parts) {
    const subject = subjectOf(part);
    // A claim is supported only when a source that mentions the same subject
    // states the absolute fact. One vendor's "permanent" must not license the
    // same claim about another vendor.
    const supported = sources.some((source) => {
      const text = `${source.title}\n${source.content}`;
      return (
        (subject === "this plan" ||
          text.toLowerCase().includes(subject.toLowerCase())) &&
        ABSOLUTE.test(text)
      );
    });
    if (!ABSOLUTE.test(part) || supported) {
      kept.push(part);
      continue;
    }
    kept.push(
      `The retrieved sources do not state whether ${subject} expires or is time-limited.`
    );
    rewritten.push(part);
  }

  if (kept.length === 0) return { answer, rewritten: [] };
  return { answer: kept.join(" ").trim(), rewritten };
}
