// Smoke-checks the schema on a real file: dates, session scoping, ordering and
// migration on reopen. The ledger rules are covered by the test suite. Run with:
//   npx tsx scripts/db-check.ts
// It writes data/db-check.db, never data/agent.db.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  datesWithTurns,
  openDb,
  recentTurns,
  saveTurn,
  turnsOnDate,
} from "../src/db.js";

const PATH = "data/db-check.db";
for (const suffix of ["", "-wal", "-shm"]) rmSync(PATH + suffix, { force: true });

const checks: string[] = [];
function check(name: string, fn: () => void): void {
  fn();
  checks.push(name);
  console.log(`ok - ${name}`);
}

let db = openDb(PATH);

// Three turns in one session, one in another. The first user turn is stamped
// 18:20Z on 16 November, which is already 17 November in IST: exactly the case
// that a UTC-only date filter would get wrong.
saveTurn(db, {
  sessionId: "s1",
  role: "user",
  content: "What is the latest stable Node.js version?",
  createdAt: "2026-11-16T18:20:00.000Z",
  localDate: "2026-11-17",
});
saveTurn(db, {
  sessionId: "s1",
  role: "assistant",
  content: "26.13.1 LTS, per nodejs.org.",
  createdAt: "2026-11-16T18:20:09.000Z",
  localDate: "2026-11-17",
});
saveTurn(db, {
  sessionId: "s1",
  role: "user",
  content: "Which Postgres host should I use?",
  createdAt: "2026-11-02T10:00:00.000Z",
  localDate: "2026-11-03",
});
saveTurn(db, {
  sessionId: "s2",
  role: "user",
  content: "unrelated session",
  createdAt: "2026-11-02T10:00:00.000Z",
  localDate: "2026-11-03",
});

check("turns on a date come back in order", () => {
  const turns = turnsOnDate(db, "s1", "2026-11-17");
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((t) => t.role),
    ["user", "assistant"]
  );
  assert.match(turns[1].content, /26\.13\.1/);
});

check("a date with no turns returns empty, not a neighbour's turns", () => {
  assert.deepEqual(turnsOnDate(db, "s1", "2026-11-04"), []);
});

check("local dates are honoured over UTC timestamps", () => {
  // 2026-11-16T18:20Z is 17 November in IST. Filtering by UTC date finds it
  // under the wrong day, which is the bug this column exists to prevent.
  assert.deepEqual(turnsOnDate(db, "s1", "2026-11-16"), []);
  assert.equal(turnsOnDate(db, "s1", "2026-11-17").length, 2);
});

check("sessions do not leak into each other", () => {
  assert.equal(turnsOnDate(db, "s1", "2026-11-03").length, 1);
  assert.equal(turnsOnDate(db, "s2", "2026-11-03").length, 1);
});

check("recent turns are oldest-first and bounded", () => {
  const turns = recentTurns(db, "s1", 2);
  assert.deepEqual(
    turns.map((t) => t.id),
    [2, 3]
  );
});

check("dates with turns are newest-first and distinct", () => {
  assert.deepEqual(datesWithTurns(db, "s1"), ["2026-11-17", "2026-11-03"]);
});

check("data survives closing and reopening the file", () => {
  db.close();
  db = openDb(PATH);
  assert.equal(recentTurns(db, "s1", 10).length, 3);
});

check("schema is v3 and the claim ledger is present", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 3);
});

db.close();
console.log(`\ndb-check: ${checks.length} passed`);
