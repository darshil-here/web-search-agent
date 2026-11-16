// db.ts
//
// The notebook. One table, because there is exactly one thing we need to
// remember: what was said, when, and in which session. Claims (milestone 3) get
// their own table; raw tool payloads never go in here, they live in traces.
//
// Two time columns on purpose:
//   created_at  UTC ISO-8601, exact instant, used for ordering.
//   local_date  YYYY-MM-DD in USER_TZ, used for "what did I ask on 3 November".
// Comparing local dates against UTC timestamps is how date recall silently
// breaks by one day for five and a half hours out of every day in IST.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

export type Turn = {
  id: number;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
  localDate: string;
};

export type NewTurn = {
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
  localDate: string;
};

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE turns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
      content    TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      local_date TEXT    NOT NULL
    );
    CREATE INDEX turns_session    ON turns(session_id, id);
    CREATE INDEX turns_local_date ON turns(session_id, local_date);
  `,
};

export function defaultDbPath(): string {
  return process.env.DB_PATH ?? "data/agent.db";
}

export function openDb(path: string = defaultDbPath()): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  // user_version is SQLite's built-in migration marker. Throwing on an unknown
  // version beats silently running against a schema written by newer code.
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Database at ${path} has schema v${version}, code knows v${SCHEMA_VERSION}`
    );
  }
  for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[next]);
      db.pragma(`user_version = ${next}`);
    })();
  }

  return db;
}

type Row = {
  id: number;
  session_id: string;
  role: Role;
  content: string;
  created_at: string;
  local_date: string;
};

function toTurn(row: Row): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    localDate: row.local_date,
  };
}

export function saveTurn(db: Database.Database, turn: NewTurn): Turn {
  const info = db
    .prepare(
      `INSERT INTO turns (session_id, role, content, created_at, local_date)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      turn.sessionId,
      turn.role,
      turn.content,
      turn.createdAt,
      turn.localDate
    );

  return { id: Number(info.lastInsertRowid), ...turn };
}

// Oldest first, so the caller can join them into one block without reversing.
export function recentTurns(
  db: Database.Database,
  sessionId: string,
  limit: number
): Turn[] {
  return db
    .prepare(
      `SELECT * FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, limit)
    .map((row) => toTurn(row as Row))
    .reverse();
}

export function turnsOnDate(
  db: Database.Database,
  sessionId: string,
  localDate: string
): Turn[] {
  return db
    .prepare(
      `SELECT * FROM turns
       WHERE session_id = ? AND local_date = ?
       ORDER BY id ASC`
    )
    .all(sessionId, localDate)
    .map((row) => toTurn(row as Row));
}

export function datesWithTurns(
  db: Database.Database,
  sessionId: string
): string[] {
  return db
    .prepare(
      `SELECT DISTINCT local_date FROM turns
       WHERE session_id = ? ORDER BY local_date DESC`
    )
    .all(sessionId)
    .map((row) => (row as { local_date: string }).local_date);
}
