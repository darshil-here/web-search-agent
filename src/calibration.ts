// calibration.ts
//
// "Sources do not state" contract in code. F-004 was an unhedged claim the
// model produced when sources said nothing about longevity; a prompt line did
// not stop it, so the rule is enforced after the answer instead.
import type { SearchResult } from "./search.js";

export type CalibrationResult = { answer: string; rewritten: string[] };

const ABSOLUTE =
  /\b(?:permanent|no time limit|no expiration|no expiry|genuinely free|always free|remains free|forever|indefinitely|not a trial|time-limited(?:\s+[a-z]+){0,2}\s+trial|trial (?:end|expiry|expiration)|no (?:set )?trial (?:end|expiry|expiration)|(?:never|doesn['’]t|does not|don['’]t|do not|not|isn['’]t|is not)\s+(?:described\s+as\s+)?(?:expire|expiring|expires|time out|timeout))\b/i;
// A universal sentence that talks about expiry at all is a longevity claim even
// when it avoids the guarded phrasings ("neither tier has a time limit that
// makes it expire"). Without this, a reworded claim slipped past ABSOLUTE.
const LONGEVITY = /\b(?:expire|expires|expiration|time limit|time-limited|trial|permanent|forever)\b/i;
// A newline is a claim boundary even when the previous sentence ends in a
// markdown link, and splitting there keeps one vendor's sentence from borrowing
// another vendor's subject. Closing emphasis after the period ("expire.** But")
// must not hide the sentence break.
const SENTENCE = /(?<=[.!?]\*{0,2})\s+|\n+/;

const NOT_SUBJECTS = new Set([
  "The", "Neither", "Both", "This", "That", "It", "Its", "So", "But",
  "Yes", "No", "One", "Two", "And", "For", "On", "In",
  "Do", "Does", "Did", "Is", "Are", "Was", "Were", "Can", "Could",
  "Will", "Would", "What", "When", "Where", "Which", "Who", "Why", "How",
]);

/**
 * A sentence that claims something about every plan at once. One vendor's
 * source saying "permanent" cannot license the same claim about another
 * vendor, so these need support for each product the question names.
 */
const UNIVERSAL = /\b(?:both|neither|they|these)\b/i;

function subjectOf(sentence: string): string {
  // Link text and URLs are not prose: "[Neon pricing](https://neon.com/…)"
  // must not make a sentence about Supabase look like a sentence about Neon.
  const text = sentence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ");
  const words = text.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? [];
  const candidate = words.find((word) => !NOT_SUBJECTS.has(word));
  return candidate ?? "this plan";
}

/** Products the question names that any retrieved source actually mentions. */
function productsIn(question: string, sources: SearchResult[]): string[] {
  const names = (question.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []).filter(
    (word) => !NOT_SUBJECTS.has(word)
  );
  return [...new Set(names)].filter((name) =>
    sources.some((source) =>
      `${source.title}\n${source.content}`.toLowerCase().includes(name.toLowerCase())
    )
  );
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

  const products = productsIn(question, sources);
  const rewritten: string[] = [];
  const kept: string[] = [];

  const supportedBy = (name: string | null): boolean =>
    sources.some((source) => {
      const text = `${source.title}\n${source.content}`;
      return (
        (name === null || text.toLowerCase().includes(name.toLowerCase())) &&
        ABSOLUTE.test(text)
      );
    });

  for (const part of parts) {
    const subject = subjectOf(part);
    // "Both", "neither" and "they" cover every product the question names, so
    // each one needs a source that states the absolute fact. Otherwise the
    // claim is about the subject alone. One vendor's "permanent" must not
    // license the same claim about another vendor.
    const universal = UNIVERSAL.test(part.slice(0, 80));
    const supported =
      universal && products.length > 1
        ? products.every((name) => supportedBy(name))
        : supportedBy(subject === "this plan" ? null : subject);

    const absolute = ABSOLUTE.test(part) || (universal && LONGEVITY.test(part));
    if (!absolute || supported) {
      kept.push(part);
      continue;
    }

    const who = universal ? "these free tiers" : subject;
    const verb = universal ? "are" : "is";
    kept.push(
      `The retrieved sources do not state whether ${who} ${verb} time-limited; check the current plan page before relying on it.`
    );
    rewritten.push(part);
  }

  if (kept.length === 0) return { answer, rewritten: [] };
  return { answer: kept.join(" ").trim(), rewritten };
}
