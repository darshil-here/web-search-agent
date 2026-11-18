// unverified.ts
//
// "Not found" is not "unchanged". A re-check diff can show a recorded value
// next to a fresh search that never confirmed it; the model then quotes the
// old value as if it were current. F-011 (the live brief-3 failure) was exactly
// that, so the rule is enforced after the answer instead of trusted to a prompt.
// Same contract as scope.ts and calibration.ts: pure, best-effort, traced.
import { clip } from "./text.js";

export type UnverifiedClaim = {
  subject: string;
  attribute: string;
  value: string;
  localDate: string;
};

export type UnverifiedResult = { answer: string; rewritten: string[] };

const SENTENCE = /(?<=[.!?])\s+/;

// Only an explicit hedge makes a sentence honest. A past-tense marker such as
// "recorded" or "last Tuesday" is NOT enough: the live brief-3 failure put the
// recorded price and a current-price assertion in the same sentence. The
// rewrite already states the recorded value and its date, so applying it to a
// past-framed sentence loses nothing. The cost of a false positive is a
// needlessly cautious sentence; the cost of a false negative is a price
// asserted from memory — the failure this guard exists to prevent.
const HEDGE =
  /\b(?:could(?:n't| not)|can(?:'t|not)|unable|no (?:fresh )?(?:source|data)|not found|unverif(?:ied|iable)|don't know|do not know|unknown|(?:did|do|does) not (?:find|confirm)|didn't (?:find|confirm))\b/i;

function rewriteValue(claim: UnverifiedClaim): string {
  return (
    `I could not verify a current value for ${clip(claim.subject, 200)}'s ` +
    `${clip(claim.attribute, 200)} from fresh sources; ` +
    `${clip(claim.value, 300)} was recorded on ${claim.localDate} ` +
    `but is not confirmed as current.`
  );
}

/**
 * Replace any sentence that presents an unverified recorded value as the
 * current value with an explicit "could not verify" statement. A sentence that
 * already says it could not be verified is left intact; the rewrite keeps the
 * recorded value and its observed date. Returns the answer untouched when there
 * is nothing to do.
 */
export function guardUnverified(
  answer: string,
  unverified: UnverifiedClaim[]
): UnverifiedResult {
  const checkable = unverified.filter((claim) => claim.value.trim() !== "");
  if (checkable.length === 0) return { answer, rewritten: [] };

  const parts = answer.split(SENTENCE);
  const kept: string[] = [];
  const rewritten: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    const hit = checkable.find((claim) =>
      lower.includes(claim.value.toLowerCase())
    );
    if (!hit || HEDGE.test(part)) {
      kept.push(part);
      continue;
    }
    kept.push(rewriteValue(hit));
    rewritten.push(part);
  }

  if (rewritten.length === 0) return { answer, rewritten: [] };
  return { answer: kept.join(" ").trim(), rewritten };
}
