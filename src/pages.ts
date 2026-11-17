// Code-level page retrieval. Tavily /extract returns clean text for URLs we
// already have from /search, so grounding can grade a full page rather than a
// snippet without adding a scraping dependency.
import type { SearchResult } from "./search.js";

export type FetchedPage = { url: string; text: string | null };

const ENDPOINT = "https://api.tavily.com/extract";
export const DEFAULT_PER_DOMAIN = 2;
export const DEFAULT_MAX_PAGES = 6;

/** Dedupe by URL, cap per hostname, then cap total. */
export function selectUrls(
  sources: SearchResult[],
  perDomain = DEFAULT_PER_DOMAIN,
  max = DEFAULT_MAX_PAGES
): string[] {
  const perHost = new Map<string, number>();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    if (!source.url || seen.has(source.url)) continue;
    let host: string;
    try {
      host = new URL(source.url).hostname;
    } catch {
      continue;
    }
    const used = perHost.get(host) ?? 0;
    if (used >= perDomain) continue;
    seen.add(source.url);
    perHost.set(host, used + 1);
    out.push(source.url);
    if (out.length >= max) break;
  }
  return out;
}

export function createFetch(
  apiKey: string
): (urls: string[]) => Promise<FetchedPage[]> {
  return async (urls) => {
    if (urls.length === 0) return [];
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ urls, chunks_per_source: 2 }),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as {
        results?: Array<{ url: string; raw_content?: string }>;
        failed_results?: Array<{ url: string }>;
      };
      return [
        ...(body.results ?? []).map((r) => ({
          url: r.url,
          text: r.raw_content ?? null,
        })),
        ...(body.failed_results ?? []).map((r) => ({ url: r.url, text: null })),
      ];
    } catch {
      return [];
    }
  };
}
