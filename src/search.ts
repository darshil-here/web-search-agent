// The one web-search capability. Everything that reads the web goes through
// this function: the tool the model can call and the code-level retrieval the
// notebook and re-check paths do.

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  /** Tavily's published_date, when the source has one. */
  publishedAt?: string | null;
};

/** A search hit after page text and a publication date have been attached. */
export type EnrichedSource = SearchResult & {
  pageText: string | null;
  publishedAt: string | null;
};

const ENDPOINT = "https://api.tavily.com/search";

const DATE = /^20\d{2}-\d{2}-\d{2}$/;

/** Dated results first, newest first; undated keep their original order. */
export function rankByFreshness(results: SearchResult[]): SearchResult[] {
  const dated: Array<{ result: SearchResult; time: number }> = [];
  const undated: SearchResult[] = [];
  for (const result of results) {
    const value = result.publishedAt;
    const time =
      typeof value === "string" && DATE.test(value) ? Date.parse(value) : NaN;
    if (Number.isNaN(time)) undated.push(result);
    else dated.push({ result, time });
  }
  dated.sort((a, b) => b.time - a.time);
  return [...dated.map((d) => d.result), ...undated];
}

export function createSearch(
  apiKey: string
): (query: string) => Promise<SearchResult[]> {
  return async (query) => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: 5,
        include_published_date: true,
      }),
    });
    if (!response.ok) {
      throw new Error(`Tavily ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) {
      throw new Error("Tavily returned a body without results");
    }

    return body.results.map((row) => {
      const result = row as Partial<SearchResult>;
      return {
        title: result.title ?? "",
        url: result.url ?? "",
        content: result.content ?? "",
        publishedAt:
          typeof (result as { published_date?: unknown }).published_date ===
          "string"
            ? (result as { published_date: string }).published_date
            : null,
      };
    });
  };
}
