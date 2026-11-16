// dates.test.ts
//
// Run with: npm test  (node:test via tsx)
// These are the date maths the whole memory feature stands on. They are pure
// functions with an injected clock, so every case is exact, not "roughly now".
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTimeZone,
  describeNow,
  localDateInTz,
  parseDateRefs,
} from "./dates.js";

const IST = "Asia/Kolkata";
// 19:00Z on 16 November is already 00:30 on 17 November in IST.
const LATE_NIGHT_IST = new Date("2026-11-16T19:00:00Z");
const NOV_17_IST = new Date("2026-11-17T06:00:00Z");

test("local date respects the timezone, not UTC", () => {
  assert.equal(localDateInTz(LATE_NIGHT_IST, IST), "2026-11-17");
  assert.equal(localDateInTz(LATE_NIGHT_IST, "UTC"), "2026-11-16");
  assert.equal(localDateInTz(LATE_NIGHT_IST, "America/New_York"), "2026-11-16");
});

test("the prompt date is rendered in the user's timezone", () => {
  const now = describeNow(NOV_17_IST, IST);
  assert.deepEqual(now, {
    iso: "2026-11-17",
    human: "17 November 2026",
    weekday: "Tuesday",
  });
});

test("yesterday is yesterday in the user's timezone", () => {
  // In UTC it is still 16 November, so a naive UTC implementation says the
  // 15th here. That is the bug this test exists for.
  assert.deepEqual(parseDateRefs("what did I ask you yesterday?", LATE_NIGHT_IST, IST), [
    { label: "yesterday", date: "2026-11-16" },
  ]);
  assert.deepEqual(
    parseDateRefs("what did I ask you yesterday?", LATE_NIGHT_IST, "UTC"),
    [{ label: "yesterday", date: "2026-11-15" }]
  );
});

test("today means the user's today", () => {
  assert.deepEqual(parseDateRefs("what am I asking today?", LATE_NIGHT_IST, IST), [
    { label: "today", date: "2026-11-17" },
  ]);
});

test("last Tuesday is seven days back when today is Tuesday", () => {
  assert.deepEqual(parseDateRefs("what did I ask last Tuesday?", NOV_17_IST, IST), [
    { label: "last Tuesday", date: "2026-11-10" },
  ]);
});

test("last Tuesday resolves from a different weekday", () => {
  const thursday = new Date("2026-11-19T06:00:00Z");
  assert.deepEqual(parseDateRefs("what did I ask last tuesday?", thursday, IST), [
    { label: "last tuesday", date: "2026-11-17" },
  ]);
});

test("day-month, month-day and ISO all parse to the same date", () => {
  const cases: Array<[string, string]> = [
    ["what did I ask you on 3 November?", "3 November"],
    ["what did I ask you on Nov 3?", "Nov 3"],
    ["what did I ask you on 2026-11-03?", "2026-11-03"],
    ["what did I ask you on 3 Nov 2026?", "3 Nov 2026"],
  ];
  for (const [text, label] of cases) {
    assert.deepEqual(parseDateRefs(text, NOV_17_IST, IST), [
      { label, date: "2026-11-03" },
    ], text);
  }
});

test("an explicit year wins over the default year", () => {
  assert.deepEqual(parseDateRefs("what did I ask on 3 November 2023?", NOV_17_IST, IST), [
    { label: "3 November 2023", date: "2023-11-03" },
  ]);
});

test("a bare future month means last year, not next year", () => {
  // Nothing has happened in December 2026 yet, and inventing a future memory
  // is a hard fail. 20 December therefore means 2025.
  assert.deepEqual(parseDateRefs("what did I ask on 20 December?", NOV_17_IST, IST), [
    { label: "20 December", date: "2025-12-20" },
  ]);
});

test("two dates come back in the order they were said", () => {
  assert.deepEqual(
    parseDateRefs("on 3 November I asked about Postgres; yesterday I asked about Node", NOV_17_IST, IST),
    [
      { label: "3 November", date: "2026-11-03" },
      { label: "yesterday", date: "2026-11-16" },
    ]
  );
});

test("the same date said twice appears once", () => {
  assert.deepEqual(parseDateRefs("yesterday, 16 November", NOV_17_IST, IST), [
    { label: "yesterday", date: "2026-11-16" },
  ]);
});

test("no date reference returns nothing rather than defaulting to today", () => {
  assert.deepEqual(
    parseDateRefs("compare the free tiers of Neon and Supabase", NOV_17_IST, IST),
    []
  );
});

test("an impossible date is ignored, not coerced", () => {
  assert.deepEqual(parseDateRefs("what did I ask on 31 February?", NOV_17_IST, IST), []);
});

test("timezones are validated before the first turn, not mid-answer", () => {
  assert.doesNotThrow(() => assertTimeZone("UTC"));
  assert.doesNotThrow(() => assertTimeZone("Europe/London"));
  assert.throws(() => assertTimeZone("Mars/Olympus"), /not a valid IANA timezone/);
});
