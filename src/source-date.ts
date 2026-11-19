// source-date.ts
//
// Publication dates, when a source shows one. Pure and conservative: a bare
// year is not a date, and a miss returns null rather than guessing.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const DAY_MONTH =
  /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(20\d{2})\b/gi;
const MONTH_DAY =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2})\b/gi;

function valid(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function extractSourceDate(text: string): string | null {
  const search = (
    pattern: RegExp,
    build: (m: RegExpExecArray) => string | null
  ): string | null => {
    for (const match of text.matchAll(pattern)) {
      const date = build(match);
      if (date) return date;
    }
    return null;
  };

  return (
    search(ISO, (m) => valid(Number(m[1]), Number(m[2]), Number(m[3]))) ??
    search(DAY_MONTH, (m) =>
      valid(
        Number(m[3]),
        Number(MONTHS[m[2].slice(0, 3).toLowerCase()]),
        Number(m[1])
      )
    ) ??
    search(MONTH_DAY, (m) =>
      valid(
        Number(m[3]),
        Number(MONTHS[m[1].slice(0, 3).toLowerCase()]),
        Number(m[2])
      )
    )
  );
}

/**
 * A relative timestamp ("Updated: 18 hours ago") is a freshness signal, not a
 * calendar date. Tavily's metadata can supply a publishedAt even when the page
 * shows only a relative string, so the answer should say what is visible.
 */
export function relativeDateMention(text: string): string | null {
  return (
    text.match(/\b\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b/i)?.[0] ?? null
  );
}
