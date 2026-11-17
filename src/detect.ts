// Decides whether a question is a temporal re-check. Pure and cheap: no model
// call, no network. Requires both a date reference and a re-check phrase, so
// plain history recall ("what did I ask on 3 November?") stays on the ordinary
// path and does not burn searches.
import { parseDateRefs } from "./dates.js";

export type RecheckIntent = { date: string; phrase: string };

const RECHECK_PATTERNS: RegExp[] = [
  /\bstill\s+(?:correct|true|accurate|valid)\b/i,
  /\bhas\s+(?:any|it|anything|there)\b[^.?!]*\bchanged\b/i,
  /\bchanged\s+since\b/i,
  /\bshipped\s+since\b/i,
  /\b(?:any\s+)?updates?\s+since\b/i,
  /\bsince\s+then\b/i,
  /\bdifferent\s+now\b/i,
];

export function detectRecheck(
  text: string,
  now: Date,
  timeZone: string
): RecheckIntent | null {
  const refs = parseDateRefs(text, now, timeZone);
  if (refs.length === 0) return null;

  for (const pattern of RECHECK_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    // Earliest date ref: the re-check compares against a past observation,
    // while "today" is the comparison point, not the observation being tested.
    const earliest = refs.reduce((a, b) => (a.date <= b.date ? a : b));
    return { date: earliest.date, phrase: match[0] };
  }
  return null;
}
