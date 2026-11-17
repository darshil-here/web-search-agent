// calibration.ts
//
// "Sources do not state" contract in code. F-004 was an unhedged claim the
// model produced when sources said nothing about longevity; a prompt line did
// not stop it, so the rule is enforced after the answer instead.
import type { SearchResult } from "./search.js";

export type CalibrationResult = { answer: string; rewritten: string[] };

const ABSOLUTE =
  /\b(?:permanent|no time limit|never expires?|genuinely free|always free|forever|indefinitely|no expiration)\b/i;
const EXPIRY_QUESTION =
  /\b(?:expire|expiry|permanent|forever|time limit|indefinite)\b/i;
const SENTENCE = /(?<=[.!?])\s+/;

function subjectOf(sentence: string): string {
  const match = /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)?)\b/.exec(
    sentence
  );
  return match ? match[1] : "this plan";
}

export function guardCalibration(
  question: string,
  answer: string,
  sources: SearchResult[]
): CalibrationResult {
  const parts = answer.split(SENTENCE);
  if (EXPIRY_QUESTION.test(question)) {
    return { answer, rewritten: [] };
  }

  const sourceText = sources
    .map((source) => `${source.title}\n${source.content}`)
    .join("\n");
  const rewritten: string[] = [];
  const kept: string[] = [];

  for (const part of parts) {
    if (!ABSOLUTE.test(part) || ABSOLUTE.test(sourceText)) {
      kept.push(part);
      continue;
    }
    const subject = subjectOf(part);
    kept.push(
      `The retrieved sources do not state whether ${subject} expires or is time-limited.`
    );
    rewritten.push(part);
  }

  if (kept.length === 0) return { answer, rewritten: [] };
  return { answer: kept.join(" ").trim(), rewritten };
}
