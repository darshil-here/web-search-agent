// notebook.test.ts
//
// The notebook is retrieval logic, so it gets tests rather than trust. No
// model, no network: seed a temp sqlite file and read what would be injected.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { openDb, saveTurn } from "./db.js";
import { buildNotebook, NOTEBOOK_MAX_BYTES } from "./notebook.js";

const PATH = "data/notebook-test.db";
const IST = "Asia/Kolkata";
const NOW = new Date("2026-11-17T06:00:00Z");

function freshDb() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(PATH + suffix, { force: true });
  return openDb(PATH);
}

function seed(
  db: ReturnType<typeof freshDb>,
  date: string,
  content: string,
  role: "user" | "assistant" = "user"
) {
  saveTurn(db, {
    sessionId: "s",
    role,
    content,
    createdAt: `${date}T05:00:00.000Z`,
    localDate: date,
  });
}

test("a named date fetches that date only", () => {
  const db = freshDb();
  seed(db, "2026-11-03", "Which Postgres host should I use?");
  seed(db, "2026-11-16", "What is the latest Node version?");

  const notebook = buildNotebook({ db, sessionId: "s", timeZone: IST }, "what did I ask on 3 November?", NOW);

  assert.equal(notebook.mode, "dates");
  assert.deepEqual(notebook.dates, ["2026-11-03"]);
  assert.equal(notebook.rows, 1);
  assert.match(notebook.text, /Postgres host/);
  assert.doesNotMatch(notebook.text, /Node version/);
  db.close();
});

test("a date with nothing says so, in words the model can repeat", () => {
  const db = freshDb();
  seed(db, "2026-11-03", "Which Postgres host should I use?");

  const notebook = buildNotebook({ db, sessionId: "s", timeZone: IST }, "what did I ask on 4 November?", NOW);

  assert.equal(notebook.rows, 0);
  assert.match(notebook.text, /No turns on 2026-11-04/);
  db.close();
});

test("no date falls back to recent turns, oldest first", () => {
  const db = freshDb();
  seed(db, "2026-11-16", "first question");
  seed(db, "2026-11-17", "second question");

  const notebook = buildNotebook({ db, sessionId: "s", timeZone: IST }, "summarise what we discussed", NOW);

  assert.equal(notebook.mode, "recent");
  assert.ok(
    notebook.text.indexOf("first question") < notebook.text.indexOf("second question")
  );
  db.close();
});

test("an empty notebook still says there is no history", () => {
  const db = freshDb();
  const notebook = buildNotebook({ db, sessionId: "s", timeZone: IST }, "what did I ask earlier?", NOW);
  assert.match(notebook.text, /No earlier turns\./);
  db.close();
});

test("sessions do not read each other's turns", () => {
  const db = freshDb();
  seed(db, "2026-11-17", "secret from another session");
  const notebook = buildNotebook({ db, sessionId: "other", timeZone: IST }, "what did I ask earlier?", NOW);
  assert.doesNotMatch(notebook.text, /secret/);
  db.close();
});

test("the notebook respects its byte budget and says what it dropped", () => {
  const db = freshDb();
  for (let i = 0; i < 40; i++) {
    seed(db, "2026-11-16", `question ${i} ${"x".repeat(600)}`, "user");
    seed(db, "2026-11-16", `answer ${i} ${"y".repeat(600)}`, "assistant");
  }

  const notebook = buildNotebook({ db, sessionId: "s", timeZone: IST }, "what did I ask yesterday?", NOW);

  assert.ok(
    notebook.bytes <= NOTEBOOK_MAX_BYTES,
    `${notebook.bytes} bytes exceeds ${NOTEBOOK_MAX_BYTES}`
  );
  assert.equal(notebook.truncated, true);
  assert.match(notebook.text, /omitted to fit the notebook budget/);
  // The newest turn survives; the oldest is what gets dropped.
  assert.match(notebook.text, /answer 39/);
  assert.doesNotMatch(notebook.text, /question 0 /);
  db.close();
});

test("a single huge turn is clipped, not allowed to eat the budget", () => {
  const db = freshDb();
  seed(db, "2026-11-17", "z".repeat(50_000));

  const notebook = buildNotebook({ db, sessionId: "s", timeZone: IST }, "what did I ask earlier?", NOW);

  assert.ok(notebook.bytes <= NOTEBOOK_MAX_BYTES);
  assert.equal(notebook.truncated, false);
  db.close();
});
