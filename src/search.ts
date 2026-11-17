// The one web-search capability. Everything that reads the web goes through
// this function: the tool the model can call and the code-level retrieval the
// notebook and re-check paths do.

export type SearchResult = { title: string; url: string; content: string };

/** A search hit after page text and a publication date have been attached. */
export type EnrichedSource = SearchResult & {
  pageText: string | null;
  publishedAt: string | null;
};

const ENDPOINT = "https://api.tavily.com/search";

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
      body: JSON.stringify({ query, max_results: 5 }),
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
      };
    });
  };
}
