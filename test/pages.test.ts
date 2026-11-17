import test from "node:test";
import assert from "node:assert/strict";
import { selectUrls, createFetch } from "../src/pages.js";
import type { SearchResult } from "../src/search.js";

const results: SearchResult[] = [
  { title: "a", url: "https://neon.com/pricing", content: "x" },
  { title: "b", url: "https://neon.com/docs", content: "x" },
  { title: "c", url: "https://neon.com/blog", content: "x" },
  { title: "d", url: "https://supabase.com/pricing", content: "x" },
  { title: "e", url: "https://supabase.com/docs", content: "x" },
  { title: "f", url: "https://example.com/other", content: "x" },
  { title: "g", url: "https://example.com/again", content: "x" },
];

test("selectUrls allows at most two URLs per domain and six total", () => {
  const selected = selectUrls(results, 2, 6);
  assert.equal(selected.length, 6);
  assert.equal(selected.filter((u) => u.includes("neon.com")).length, 2);
  assert.equal(selected.filter((u) => u.includes("supabase.com")).length, 2);
});

test("selectUrls drops exact duplicate URLs", () => {
  const dupes = [...results, { ...results[0] }];
  const selected = selectUrls(dupes, 2, 20);
  assert.equal(new Set(selected).size, selected.length);
});

test("createFetch maps results and failed_results without throwing on a failed URL", async () => {
  const calls: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return {
      ok: true,
      json: async () => ({
        results: [{ url: "https://a.test", raw_content: "page text" }],
        failed_results: [{ url: "https://b.test" }],
      }),
    } as Response;
  };
  try {
    const fetch = createFetch("tvly-test");
    const pages = await fetch(["https://a.test", "https://b.test"]);
    assert.deepEqual(pages, [
      { url: "https://a.test", text: "page text" },
      { url: "https://b.test", text: null },
    ]);
    assert.equal(
      (calls[0] as { body: { chunks_per_source: number } }).body.chunks_per_source,
      2
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("createFetch returns an empty list when the HTTP call fails", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    ({ ok: false, status: 500, text: async () => "boom" }) as Response;
  try {
    assert.deepEqual(await createFetch("tvly-test")(["https://a.test"]), []);
  } finally {
    globalThis.fetch = original;
  }
});
