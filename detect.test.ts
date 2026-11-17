// detect.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { detectRecheck } from "./detect.js";

const NOW = new Date("2026-11-17T06:00:00Z"); // Tuesday in IST
const IST = "Asia/Kolkata";

test("detects all three brief examples", () => {
  const cases = [
    "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    "What did I ask you on 3 November? Is your answer still correct today?",
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
  ];
  for (const text of cases) {
    const intent = detectRecheck(text, NOW, IST);
    assert.ok(intent, text);
    assert.match(intent!.date, /^2026-11-\d{2}$/);
  }
});

test("uses the earliest date when several are named", () => {
  const intent = detectRecheck(
    "What did I ask you on 3 November? Is your answer still correct today?",
    NOW,
    IST
  );
  assert.equal(intent?.date, "2026-11-03");
});

test("ignores plain history recall and non-temporal questions", () => {
  for (const text of [
    "What did I ask you on 3 November?",
    "compare the free tiers of Neon and Supabase",
    "what is 17 times 23",
  ]) {
    assert.equal(detectRecheck(text, NOW, IST), null, text);
  }
});

test("a re-check phrase without a date does not trigger", () => {
  assert.equal(detectRecheck("Is your answer still correct?", NOW, IST), null);
});
