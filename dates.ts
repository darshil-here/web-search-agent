// dates.ts
//
// One place that knows what "today" means. The system prompt, the notebook and
// date recall must all agree, and they must agree in the user's timezone rather
// than the machine's or UTC. Everything here is pure: pass `now` in, get
// strings out, so the tests can pin a clock.

export type DateRef = {
  /** The words the user used, for the trace. */
  label: string;
  /** YYYY-MM-DD in the user's timezone. */
  date: string;
};

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// 3-letter prefixes are unique across the twelve months, so both "nov" and
// "november" resolve with one pattern.
const MONTH_PATTERN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const WEEKDAY_PATTERN = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?";

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`USER_TZ "${timeZone}" is not a valid IANA timezone`);
  }
}

/** The calendar date of `now` in `timeZone`, as YYYY-MM-DD. */
export function localDateInTz(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** What the prompt tells the model "today" is. Never the model's own guess. */
export function describeNow(
  now: Date,
  timeZone: string
): { iso: string; human: string; weekday: string } {
  const iso = localDateInTz(now, timeZone);
  const [year, month, day] = iso.split("-").map(Number);

  return {
    iso,
    human: `${day} ${MONTHS[month - 1]} ${year}`,
    weekday: WEEKDAYS[weekdayOf(iso)],
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** YYYY-MM-DD or null if the day does not exist (31 February). */
function civil(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(
    utc.getUTCDate()
  )}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return civil(year, month, day + days)!;
}

function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function monthNumber(name: string): number {
  return MONTHS.findIndex((month) =>
    month.toLowerCase().startsWith(name.slice(0, 3).toLowerCase())
  ) + 1;
}

// A date without a year is the most recent past occurrence: "3 November"
// asked on 17 November is this year, asked on 2 January it is last year.
// Guessing forward would invent memories that have not happened.
function resolveMonthDay(
  month: number,
  day: number,
  explicitYear: number | undefined,
  today: string
): string | null {
  if (explicitYear !== undefined) return civil(explicitYear, month, day);

  const thisYear = Number(today.slice(0, 4));
  const candidate = civil(thisYear, month, day);
  if (candidate === null) return null;
  return candidate <= today ? candidate : civil(thisYear - 1, month, day);
}

/**
 * Every date the user referred to, in the order they said it. Empty means the
 * message carries no date reference, which is a different thing from "today".
 */
export function parseDateRefs(
  text: string,
  now: Date,
  timeZone: string
): DateRef[] {
  const today = localDateInTz(now, timeZone);
  const found: Array<DateRef & { index: number }> = [];

  const scan = (
    pattern: RegExp,
    build: (match: RegExpExecArray) => DateRef | null
  ): void => {
    for (const match of text.matchAll(pattern)) {
      const ref = build(match);
      if (ref) found.push({ ...ref, index: match.index });
    }
  };

  scan(/\b(\d{4})-(\d{2})-(\d{2})\b/gi, (m) => {
    const date = civil(Number(m[1]), Number(m[2]), Number(m[3]));
    return date ? { label: m[0], date } : null;
  });

  scan(
    new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?\\b`, "gi"),
    (m) => {
      const date = resolveMonthDay(
        monthNumber(m[2]),
        Number(m[1]),
        m[3] ? Number(m[3]) : undefined,
        today
      );
      return date ? { label: m[0], date } : null;
    }
  );

  scan(
    new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, "gi"),
    (m) => {
      const date = resolveMonthDay(
        monthNumber(m[1]),
        Number(m[2]),
        m[3] ? Number(m[3]) : undefined,
        today
      );
      return date ? { label: m[0], date } : null;
    }
  );

  scan(/\btoday\b/gi, (m) => ({ label: m[0], date: today }));

  scan(/\byesterday\b/gi, (m) => ({
    label: m[0],
    date: addDays(today, -1),
  }));

  // "last Tuesday" on a Tuesday means seven days ago, not today.
  scan(new RegExp(`\\blast\\s+(${WEEKDAY_PATTERN})\\b`, "gi"), (m) => {
    const target = WEEKDAY_INDEX[m[1].slice(0, 3).toLowerCase()];
    if (target === undefined) return null;
    const delta = (weekdayOf(today) - target + 7) % 7 || 7;
    return { label: m[0], date: addDays(today, -delta) };
  });

  // A bare weekday ("On Monday...") is the most recent past occurrence.
  // Placed after `last <weekday>` so the longer label wins the index sort.
  scan(new RegExp(`\\b(${WEEKDAY_PATTERN})\\b`, "gi"), (m) => {
    // "last Tuesday" is already handled above with a 7-day minimum. Its bare
    // match resolves to a different date, so dedupe by date would not catch it.
    const before = text.slice(Math.max(0, m.index - 5), m.index).toLowerCase();
    if (/\blast\s+$/.test(before)) return null;
    const target = WEEKDAY_INDEX[m[1].slice(0, 3).toLowerCase()];
    if (target === undefined) return null;
    const delta = (weekdayOf(today) - target + 7) % 7;
    return { label: m[0], date: addDays(today, -delta) };
  });

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .filter((ref) => {
      if (seen.has(ref.date)) return false;
      seen.add(ref.date);
      return true;
    })
    .map(({ label, date }) => ({ label, date }));
}
