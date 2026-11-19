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
import { canonicalUrl } from "./url.js";

export type SupportSource = { url: string; text: string };

/**
 * A claim the critic grounded, with the source excerpt it says supports it.
 * `quote` is "" when the critic gave no excerpt or the excerpt was not found
 * verbatim in the cited source. An empty quote is not a fallback: it means the
 * claim has no verified evidence, so its value must not survive.
 */
export type SupportEvidence = {
  url: string;
  text: string;
  quote: string;
};

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
  "of", "per", "the", "a", "an", "and", "or", "to", "for", "in", "on", "with",
  "by", "from", "is", "are", "as", "at", "each", "that", "this",
  "free", "pro", "team", "enterprise",
]);

// Size units carry no identity: "1 GB" of storage and "1 GB" of egress are
// different allowances. They are dropped from context words so they cannot make
// an unrelated measure look supported.
const SIZE_UNITS = new Set(["kb", "mb", "gb", "tb", "pb"]);

// Words that frame a quota rather than name it. "5 GB per project per month"
// must be tied to its row ("Traffic / egress"), not to "project": every page
// mentions projects, so accepting that word marked an unsupported traffic
// allowance as grounded.
const FRAMING = new Set([
  "project", "projects", "month", "months", "monthly", "week", "weeks",
  "day", "days", "year", "years", "annual", "annually", "billing", "billed",
  "user", "users", "account", "accounts", "seat", "seats", "member", "members",
]);

// Words that describe the act of reporting rather than the measured feature.
// They are dropped before deciding whether a quote is about the same thing.
const GENERIC = new Set([
  ...STOP,
  "include", "includes", "included", "offer", "offers", "provide", "provides",
  "get", "gets", "has", "have", "listed", "lists", "according", "official",
  "page", "pages", "pricing", "plan", "plans", "tier", "tiers", "use", "using",
  "than", "more", "less", "about", "around", "over", "under", "minimum",
  "maximum", "min", "max", "available", "currently", "also", "only", "up",
  "starts", "starting", "costs", "cost", "allows", "allow", "supports",
]);

const MARKER = "not stated in sources";
const URL = /https?:\/\/[^\s)\]|,]+/g;

function normalise(text: string): string {
  // Keep single spaces. Removing them glued a number to the preceding word
  // ("Image 17" + "5 GB" became "image175gb"), and the standalone-number check
  // then rejected a value that was plainly there. Word boundaries still work
  // because findNeedle tolerates whitespace runs of different widths.
  return flatten(text).replace(/\*/g, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate a needle, tolerating whitespace differences. Scraped pages sometimes
 * join words ("6 hoursor") or split them; an exact substring test lost evidence
 * that a reader would call present.
 */
function findNeedle(
  hay: string,
  needle: string,
  from = 0
): { index: number; length: number } | null {
  if (needle === "") return null;
  const direct = hay.indexOf(needle, from);
  if (direct !== -1) return { index: direct, length: needle.length };
  const pattern = new RegExp(
    needle.trim().split(/\s+/).map(escapeRegExp).join("\\s*"),
    "g"
  );
  pattern.lastIndex = from;
  const match = pattern.exec(hay);
  return match ? { index: match.index, length: match[0].length } : null;
}

/** True when the excerpt appears contiguously in the cited text. */
export function isVerbatimQuote(quote: string, text: string): boolean {
  const needle = normalise(quote);
  return needle.length >= 8 && findNeedle(normalise(text), needle) !== null;
}

/** Strip URLs and markdown so link targets are not graded as feature words. */
function plain(text: string): string {
  return flatten(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\*/g, " ");
}

/** Feature words around a measure, excluding generic reporting vocabulary. */
function featureTokens(text: string): string[] {
  const words = plain(text).toLowerCase().match(/[a-z][a-z0-9-]+/g) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (GENERIC.has(word) || SIZE_UNITS.has(word) || /^\d/.test(word)) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/**
 * The words that say *what* a measure measures. Prefer the feature noun that
 * follows the value ("1 GB of Postgres storage"). Table row labels are only a
 * fallback when neither the measure nor its tail names a feature, because a
 * label like "Other" would otherwise require a word the source never uses.
 */
function afterTokens(text: string, index: number, length: number): string[] {
  const after = text
    .slice(index + length, index + length + 60)
    .split(/[.;|)\n]/)[0];
  return featureTokens(after);
}

function localFeatureTokens(
  text: string,
  index: number,
  length: number,
  rowLabel: string | null
): string[] {
  const after = afterTokens(text, index, length);
  if (after.length > 0) return after;
  return rowLabel ? featureTokens(rowLabel).slice(0, 2) : [];
}

/** True when a number at [at, at+len) is not part of a larger number. */
function standaloneNumber(hay: string, at: number, len: number): boolean {
  const digit = (ch: string | undefined) => ch !== undefined && /\d/.test(ch);
  const before = at === 0 ? "" : hay[at - 1];
  const after = hay[at + len] ?? "";
  const after2 = hay[at + len + 1] ?? "";
  const before2 = at > 1 ? hay[at - 2] : "";
  return !(
    digit(before) ||
    digit(after) ||
    ((after === "." || after === ",") && digit(after2)) ||
    ((before === "." || before === ",") && digit(before2))
  );
}

/**
 * A short uppercase unit ("2 CU", "50 MAU") is itself evidence about what the
 * number measures. When the measure has no feature word of its own and the only
 * context would come from a table row label, the label is not required: a page
 * that states "2 CU" is stating the compute allowance, even if its sentence
 * never uses the word "compute".
 */
function distinctiveUnit(raw: string): boolean {
  const unit = raw.match(/\d[\d.,]*\s*([A-Z]{2,})/)?.[1]?.toLowerCase();
  return unit !== undefined && !SIZE_UNITS.has(unit);
}

/** Words inside and after a measure that say what it measures. */
function contextTokens(
  text: string,
  index: number,
  raw: string,
  rowLabel: string | null
): { tokens: string[]; any: boolean } {
  const inMatch = featureTokens(raw.replace(/^\$?\d[\d.,]*/, ""));
  if (inMatch.length > 0) {
    // The measure names its own feature ("10 branches", "100 CU-hours").
    // Words after it ("per project") are framing, not extra identity.
    return { tokens: inMatch, any: false };
  }
  // The regex spends its one following word on the unit ("5 GB", "6 hours"),
  // so the feature is the next meaningful word: "5 GB of data changes" -> data.
  const feature = afterTokens(text, index, raw.length).find(
    (token) => !FRAMING.has(token)
  );
  if (feature) return { tokens: [feature], any: false };
  if (distinctiveUnit(raw)) return { tokens: [], any: false };
  // A currency amount is self-identifying. A "Price" row is generic, and a
  // pricing page need not repeat the word "price" beside every "$0".
  if (/^[$€£]/.test(raw.trim())) return { tokens: [], any: false };
  // A row label is a set of synonyms ("Postgres storage" vs "storage"); any one
  // of them ties the value to the row.
  return rowLabel
    ? { tokens: featureTokens(rowLabel).slice(0, 2), any: true }
    : { tokens: [], any: false };
}

/** Match a feature word, tolerating a simple plural ("changes" ~ "change"). */
function sameWord(hay: string, token: string): boolean {
  return (
    hay.includes(token) ||
    (token.length >= 5 && token.endsWith("s") && hay.includes(token.slice(0, -1)))
  );
}

/** Does one verified quote state this measure *about the same feature*? */
function quoteSupports(
  context: { tokens: string[]; any: boolean },
  raw: string,
  quote: string
): boolean {
  const quoted = normalise(quote);
  const full = normalise(raw);
  const number = normalise(raw.match(/^\$?\d[\d.,]*/)?.[0] ?? "");
  if (full === "" || number === "") return false;
  const stated = (needle: string, numeric: boolean): boolean => {
    const hit = findNeedle(quoted, needle);
    if (!hit) return false;
    return !numeric || standaloneNumber(quoted, hit.index, hit.length);
  };
  const hasValue =
    stated(full, false) ||
    (context.tokens.length > 0 && stated(number, true));
  if (!hasValue) return false;
  const matches = (token: string) => sameWord(quoted, token);
  return context.any
    ? context.tokens.some(matches)
    : context.tokens.every(matches);
}

/**
 * Deterministic attribution: the value must appear in the cited text in a
 * window that also names the feature. This is what stops a number that exists
 * somewhere on a page ("1 GB file storage" for Supabase) from supporting a
 * claim about a different vendor or feature ("1 GB Postgres storage" for Neon).
 * Quotes supplement this check, they do not replace it: a paraphrased quote
 * must not turn a true value into an unknown.
 *
 * Sources often put the feature before the number ("Edge function invocations
 * | 500,000 per month") or use a different unit word. Try the full measure
 * first, then the bare number with the feature words required in the window.
 */
function windowSupports(
  texts: string[],
  raw: string,
  context: { tokens: string[]; any: boolean }
): boolean {
  const full = normalise(raw);
  const number = normalise(raw.match(/^\$?\d[\d.,]*/)?.[0] ?? "");
  if (full === "" && number === "") return false;

  const found = (hay: string, needle: string): boolean => {
    if (needle === "") return false;
    const numeric = /^\$?\d/.test(needle);
    let at = 0;
    for (;;) {
      const hit = findNeedle(hay, needle, at);
      if (!hit) break;
      // A number must not match inside a larger one: "1" is not evidence for a
      // source that only says "100".
      if (!numeric || standaloneNumber(hay, hit.index, hit.length)) {
        const window = hay.slice(
          Math.max(0, hit.index - 60),
          hit.index + hit.length + 100
        );
        const matches = (token: string) => sameWord(window, token);
        if (context.any ? context.tokens.some(matches) : context.tokens.every(matches)) {
          return true;
        }
      }
      at = hit.index + 1;
    }
    return false;
  };

  for (const source of texts) {
    const hay = normalise(source);
    if (found(hay, full)) return true;
    // A bare number is only evidence when a feature word ties it to the claim.
    // Without one ("2 CU", "5 GB" on a page of many 5s), the full measure is
    // the minimum evidence.
    if (context.tokens.length > 0 && number !== full && found(hay, number)) {
      return true;
    }
  }
  return false;
}

/**
 * Extend a replacement to the end of the feature phrase so a cell does not read
 * "not stated in sources snapshot". Only used inside tables, where a cell is a
 * clause; prose keeps the tight replacement.
 */
function clauseEnd(text: string, from: number): number {
  const rest = text.slice(from);
  const stop = rest.search(/[.;,|)\](\n\[*:–—]|\s(?:and|or)\s/i);
  return stop === -1 ? text.length : from + stop;
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
 * Absence claims ("No automatic backups or branching") need the same treatment
 * as numbers: if the cited source never mentions the feature, silence is not
 * evidence that it is excluded. Only table cells are graded here, because a
 * cell is a discrete claim; prose absence is calibration's territory.
 */
function guardAbsence(
  segment: string,
  corpus: string,
  rowLabel: string | null
): { answer: string; replaced: string[] } {
  // Already marked cells are finished; grading them again would treat the
  // marker's own words as an absence claim. The marker is also a guard against
  // rewriting the same clause twice when this function is reused.
  if (
    rowLabel === null ||
    segment.includes(MARKER) ||
    !/\bno\b/i.test(plain(segment))
  ) {
    return { answer: segment, replaced: [] };
  }

  const replaced: string[] = [];
  // Keep the "[" with the URL so a replacement never separates a citation from
  // its markdown wrapper, and the marker's words are not read as claim words.
  const parts = segment.split(/(\[?https?:\/\/[^\s)\]|,]+)/);
  const answer = parts
    .map((part) => {
      if (/^https?:\/\//.test(part)) return part;
      const tokens = featureTokens(part);
      if (tokens.length === 0) return part;
      if (tokens.every((token) => corpus.includes(token))) return part;

      const lead = part.match(/^\s*/)?.[0] ?? "";
      const tail = part.match(/\s*$/)?.[0] ?? "";
      const phrase = part.trim();
      if (phrase === "") return part;
      replaced.push(phrase);
      return `${lead}${MARKER}${tail}`;
    })
    .join("");

  return { answer, replaced };
}

function guardSegment(
  segment: string,
  sources: SupportSource[],
  byUrl: Map<string, string>,
  evidence: SupportEvidence[],
  rowLabel: string | null
): { answer: string; replaced: string[]; checked: number } {
  // A URL beside a claim names its source. Grade the value against that source,
  // not against whatever another vendor's page happens to say. Host and path
  // identify the page: the answer often cites the clean URL while search
  // returned a tracked variant or a longer page fragment under another URL, and
  // treating those as different pages marked true values unknown.
  const cited = [...segment.matchAll(URL)].map((match) => match[0]);
  const known = [...new Set(cited.map(canonicalUrl))].filter((url) =>
    byUrl.has(url)
  );
  const citedTexts = known.length
    ? known.map((url) => byUrl.get(url)!)
    : sources.map((source) => source.text);
  const corpus = citedTexts.map(normalise).join(" ");
  if (corpus.trim() === "") return { answer: segment, replaced: [], checked: 0 };
  const allowed = known.length > 0 ? new Set(known) : null;

  const absence = guardAbsence(segment, corpus, rowLabel);
  let result = absence.answer;
  const replaced: string[] = [...absence.replaced];

  // Measured after the absence rewrite so offsets refer to the text the
  // measure scan actually runs over.
  const urlSpans = [...result.matchAll(URL)].map((match) => [
    match.index ?? 0,
    (match.index ?? 0) + match[0].length,
  ]);

  const matches = [...result.matchAll(MEASURE)]
    // Digits inside a URL are an address, not a claim. Rewriting them would
    // corrupt the citation the guard is supposed to preserve.
    .filter(
      (match) =>
        !urlSpans.some(
          ([start, end]) => (match.index ?? 0) >= start && (match.index ?? 0) < end
        )
    )
    .filter((match) => checkable(match[0]))
    .map((match) => {
      const raw = measureValue(match[0]);
      // Context is read from the text as it stood before any replacement.
      // Recomputing it inside the loop let an earlier rewrite ("not stated in
      // sources") become a feature word for the next claim.
      return {
        raw,
        value: normalise(raw),
        index: match.index,
        context: contextTokens(result, match.index!, raw, rowLabel),
        local: localFeatureTokens(result, match.index!, raw.length, rowLabel),
      };
    });

  // Work back to front so earlier indices stay valid as the string changes.
  for (const match of matches.reverse()) {
    if (match.value === "") continue;

    // Claims the critic grounded with a quote are additionally checked against
    // that quote. A value can appear somewhere on the cited page and still be
    // about a different vendor or feature; the quote is what ties it to this
    // claim. The deterministic window stays the primary test.
    const candidates = evidence.filter(
      (item) =>
        (!allowed || allowed.has(canonicalUrl(item.url))) &&
        (findNeedle(normalise(item.text), match.value) !== null ||
          match.local.some((token) => normalise(item.text).includes(token)))
    );

    const supported =
      windowSupports(citedTexts, match.raw, match.context) ||
      candidates.some(
        (item) =>
          item.quote !== "" &&
          quoteSupports(match.context, match.raw, item.quote)
      );

    if (supported) continue;

    let start = match.index!;
    // Carry a leading qualifier into the marker: "up to not stated in sources"
    // reads as if the ceiling survived. The qualifier is part of the claim.
    const lead = result.slice(0, start).match(/(?:up to|as much as|about|around|over|under)\s+$/i);
    if (lead) start -= lead[0].length;
    let end =
      rowLabel !== null
        ? clauseEnd(result, match.index! + match.raw.length)
        : match.index! + match.raw.length;
    while (end > start && /\s/.test(result[end - 1])) end -= 1;
    replaced.push(flatten(result.slice(start, end)));
    result = result.slice(0, start) + MARKER + result.slice(end);
  }

  return { answer: result, replaced: replaced.reverse(), checked: matches.length };
}

/**
 * Grade one line. A markdown row is split into cells so two vendors in the same
 * row are not graded against one pooled corpus: a value can be true of Supabase
 * and false of Neon while both URLs sit on the same table line.
 */
function guardLine(
  line: string,
  sources: SupportSource[],
  byUrl: Map<string, string>,
  evidence: SupportEvidence[]
): { answer: string; replaced: string[]; checked: number } {
  if (!line.trimStart().startsWith("|")) {
    return guardSegment(line, sources, byUrl, evidence, null);
  }

  const cells = line.split("|");
  const rowLabel =
    cells.find((cell) => cell.trim() !== "" && !/^[-: ]+$/.test(cell.trim())) ?? null;
  const replaced: string[] = [];
  let checked = 0;
  const graded = cells.map((cell) => {
    const result = guardSegment(cell, sources, byUrl, evidence, rowLabel);
    replaced.push(...result.replaced);
    checked += result.checked;
    return result.answer;
  });

  return { answer: graded.join("|"), replaced, checked };
}

/**
 * Replace every numeric claim whose cited source does not state its value with
 * a marker. When the critic supplied a verified quote, the value must appear in
 * that quote together with the feature it is attached to; otherwise the full
 * cited text is used. Markdown structure is preserved because only the matched
 * value span is replaced.
 */
export function guardValueSupport(
  answer: string,
  sources: SupportSource[],
  evidence: SupportEvidence[] = []
): SupportResult {
  // Merge page fragments by host and path. Search often returns the same page
  // twice (a tracked URL and a clean one), each with a different excerpt; a
  // value stated in one fragment must not be graded against only the other.
  const byUrl = new Map<string, string>();
  for (const source of sources) {
    const key = canonicalUrl(source.url);
    const previous = byUrl.get(key);
    byUrl.set(key, previous ? `${previous}\n${source.text}` : source.text);
  }
  const lines = answer.split("\n");
  const replaced: string[] = [];
  let checked = 0;
  const kept = lines.map((line) => {
    const result = guardLine(line, sources, byUrl, evidence);
    replaced.push(...result.replaced);
    checked += result.checked;
    return result.answer;
  });

  return { answer: kept.join("\n"), replaced, checked };
}
