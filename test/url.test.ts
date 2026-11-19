import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, samePage } from "../src/url.js";

test("tracking params, www, scheme and .md are not page identity", () => {
  const base = "https://supabase.com/pricing";
  assert.equal(samePage(base, "https://supabase.com/pricing?ref=scrimba.com"), true);
  assert.equal(samePage(base, "http://www.supabase.com/pricing"), true);
  assert.equal(samePage(base, "https://supabase.com/pricing.md"), true);
  assert.equal(samePage(base, "https://supabase.com/pricing#compare-plans"), true);
  assert.equal(samePage(base, "https://supabase.com/pricing/"), true);
});

test("different paths or hosts are different pages", () => {
  assert.equal(samePage("https://neon.com/pricing", "https://neon.com/docs/introduction/plans"), false);
  assert.equal(samePage("https://neon.com/pricing", "https://supabase.com/pricing"), false);
});

test("a malformed URL degrades to a lowercased string", () => {
  assert.equal(canonicalUrl("not a url/"), "not a url");
});
