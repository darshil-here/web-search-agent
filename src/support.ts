// support.ts
//
// Grounding enforcement in code. The critic attaches URLs and proposes which
// claims are supported, but F-002 showed the model asserting table values that
// no retrieved page states. A URL beside a cell is not evidence for the value
// in it, so this guard checks the value itself against the retrieved text and
// replaces anything unstated with "not stated in sources".
//
// Pure: no model, no network. The same discipline as scope.ts, calibration.ts
// and unverified.ts — trust code for the rule, the model for the language.
import { flatten } from "./text.js";

export type SupportSource = { url: string; text: string };

export type SupportResult = {
  answer: string;
  replaced: string[];
  checked: number;
};

// A measure: number (with commas/decimals), optional /unit, and at most one
// following word. Checking one unit word keeps the guard precise: "100 projects"
// and "1 GB" are stated in the sources, while "60,000 MAUs", "10 branches" and
// "5 minutes" are not. Capturing two words marked supported values as unknown
// whenever the source used a synonym ("100 CU-hours" for "100 compute-hours").
const MEASURE =
  /\$?\d[\d.,]*(?:\s*\/\s*[A-Za-z]+)?(?:\s+[A-Za-z][A-Za-z0-9-]*)?/g;

// Words that carry no measuring meaning. Dropping them means "1 GB per project"
// is checked as "1 GB", which a source saying "1 GB of storage" does state.
const STOP = new Set([
  "of", "per", "the", "a", "an", "and", "to", "for", "in", "on", "with",
  "by", "from", "is", "are", "as", "at", "each", "that", "this",
  "free", "pro", "team", "enterprise",
]);

const MARKER = "not stated in sources";

function normalise(text: string): string {
  return flatten(text).replace(/\*/g, "").toLowerCase().replace(/\s+/g, "");
}

/** Strip connective tail words so a supported measure is not marked wrong. */
function measureValue(raw: string): string {
  let out = raw.trimEnd();
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of STOP) {
      const suffix = ` ${word}`;
      if (out.toLowerCase().endsWith(suffix)) {
        out = out.slice(0, -suffix.length).trimEnd();
        changed = true;
      }
    }
  }
  return out;
}

/** A bare integer (a year, a list index) is not a checkable claim. */
function checkable(raw: string): boolean {
  return /[A-Za-z$]/.test(raw) || raw.includes(".");
}

/**
 * Replace every numeric claim absent from all retrieved sources with a marker.
 * Values that a source states, values present in any source, and non-numeric
 * prose are left exactly as they are. Markdown structure is preserved because
 * only the matched value span is replaced.
 */
export function guardValueSupport(
  answer: string,
  sources: SupportSource[]
): SupportResult {
  const corpus = sources.map((source) => normalise(source.text)).join(" ");
  if (corpus.trim() === "") return { answer, replaced: [], checked: 0 };

  const matches = [...answer.matchAll(MEASURE)]
    .filter((match) => checkable(match[0]))
    .map((match) => {
      const raw = measureValue(match[0]);
      return { raw, value: normalise(raw), index: match.index };
    });

  const replaced: string[] = [];
  let result = answer;

  // Work back to front so earlier indices stay valid as the string changes.
  for (const match of matches.reverse()) {
    if (match.value === "" || corpus.includes(match.value)) continue;
    result =
      result.slice(0, match.index) + MARKER + result.slice(match.index + match.raw.length);
    replaced.push(flatten(match.raw));
  }

  return { answer: result, replaced: replaced.reverse(), checked: matches.length };
}
