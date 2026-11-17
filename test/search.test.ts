import test from "node:test";
import assert from "node:assert/strict";
import { createSearch, rankByFreshness } from "../src/search.js";
import type { SearchResult } from "../src/search.js";

function result(url: string, publishedAt?: string): SearchResult {
  return { title: url, url, content: "text", publishedAt };
}

test("rankByFreshness puts dated results first, newest first", () => {
  const ranked = rankByFreshness([
    result("https://old.test", "2023-01-01"),
    result("https://undated.test"),
    result("https://new.test", "2026-11-01"),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.url),
    ["https://new.test", "https://old.test", "https://undated.test"]
  );
});

test("rankByFreshness keeps ties stable and treats bad dates as undated", () => {
  const ranked = rankByFreshness([
    result("https://a.test", "not-a-date"),
    result("https://b.test", "2026-05-01"),
    result("https://c.test", "2026-05-01"),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.url),
    ["https://b.test", "https://c.test", "https://a.test"]
  );
});

test("createSearch requests and maps published_date", async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return {
      ok: true,
      json: async () => ({
        results: [
          {
            title: "Pricing",
            url: "https://p.test",
            content: "$20",
            published_date: "2026-10-01",
          },
        ],
      }),
    } as Response;
  };
  try {
    const search = createSearch("tvly-test");
    const results = await search("ChatGPT Plus price");
    assert.equal(body.include_published_date, true);
    assert.equal(results[0].publishedAt, "2026-10-01");
  } finally {
    globalThis.fetch = original;
  }
});
