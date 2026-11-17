// Two memories, not one:
//   turns  — what was said, when, in which session. Raw chat history.
//   claims — the factual claims those answers made, with validity intervals.
//            This is the ledger that makes "has it changed since then?" possible.
// Raw tool payloads never go in here; they live in traces.
//
// Two time columns on turns, on purpose:
//   created_at  UTC ISO-8601, exact instant, used for ordering.
//   local_date  YYYY-MM-DD in the user's timezone, used for "what did I ask on
//               3 November". Comparing local dates against UTC timestamps is how
//               date recall silently breaks by one day for five and a half hours
//               out of every day in IST.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localDateInTz } from "./dates.js";

/** Which conversation is being read and written, and in which timezone. */
export type SessionContext = {
  db: Database.Database;
  sessionId: string;
  timeZone: string;
};

export type Role = "user" | "assistant";

export type Turn = {
  id: number;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
  localDate: string;
};

export type NewTurn = Omit<Turn, "id">;

export type Claim = {
  id: number;
  sessionId: string;
  subject: string;
  attribute: string;
  value: string;
  url: string | null;
  quote: string | null;
  observedAt: string;
  localDate: string;
  validFrom: string;
  validUntil: string | null;
  supersededBy: number | null;
};

export type NewClaim = Omit<
  Claim,
  "id" | "validFrom" | "validUntil" | "supersededBy"
> & {
  /** Defaults to localDate when not supplied by an explicit source date. */
  validFrom?: string;
};

export type VerificationResult = "changed" | "unchanged" | "not_found";

export type Verification = {
  id: number;
  sessionId: string;
  claimId: number;
  checkedAt: string;
  localDate: string;
  result: VerificationResult;
  newValue: string | null;
  url: string | null;
};

export type NewVerification = Omit<Verification, "id">;

const SCHEMA_VERSION = 3;

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
  // A claim is an answer's checkable fact, versioned by validity interval.
  // We never overwrite a value: a new observation closes the old row
  // (valid_until, superseded_by) and inserts a new one. That chain is the diff.
  2: `
    CREATE TABLE claims (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT    NOT NULL,
      subject       TEXT    NOT NULL,
      attribute     TEXT    NOT NULL,
      value         TEXT    NOT NULL,
      url           TEXT,
      quote         TEXT,
      observed_at   TEXT    NOT NULL,
      local_date    TEXT    NOT NULL,
      valid_from    TEXT    NOT NULL,
      valid_until   TEXT,
      superseded_by INTEGER REFERENCES claims(id)
    );
    CREATE INDEX claims_open      ON claims(session_id, subject, attribute, valid_until);
    CREATE INDEX claims_date      ON claims(session_id, local_date);
    CREATE INDEX claims_subject   ON claims(session_id, subject, id);
  `,
  // A verification is the audit trail of a re-check. It exists so "unchanged"
  // is not lost: the claim ledger is idempotent, but knowing a fact was tested
  // today is a different fact from never having tested it.
  3: `
    CREATE TABLE verifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      claim_id    INTEGER NOT NULL REFERENCES claims(id),
      checked_at  TEXT NOT NULL,
      local_date  TEXT NOT NULL,
      result      TEXT NOT NULL CHECK (result IN ('changed','unchanged','not_found')),
      new_value   TEXT,
      url         TEXT
    );
    CREATE INDEX verifications_claim ON verifications(session_id, claim_id, id);
  `,
};

export function openDb(path: string): Database.Database {
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

/**
 * Append one message to the session, stamping both time columns from the same
 * instant. Callers pass the turn's `now` so a message's local date cannot land
 * on a different day from the question it belongs to.
 */
export function appendTurn(
  ctx: SessionContext,
  role: Role,
  content: string,
  now: Date
): Turn {
  return saveTurn(ctx.db, {
    sessionId: ctx.sessionId,
    role,
    content,
    createdAt: now.toISOString(),
    localDate: localDateInTz(now, ctx.timeZone),
  });
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

// --- Claim ledger -----------------------------------------------------------

type ClaimRow = {
  id: number;
  session_id: string;
  subject: string;
  attribute: string;
  value: string;
  url: string | null;
  quote: string | null;
  observed_at: string;
  local_date: string;
  valid_from: string;
  valid_until: string | null;
  superseded_by: number | null;
};

function toClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    sessionId: row.session_id,
    subject: row.subject,
    attribute: row.attribute,
    value: row.value,
    url: row.url,
    quote: row.quote,
    observedAt: row.observed_at,
    localDate: row.local_date,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
  };
}

export function saveClaim(db: Database.Database, claim: NewClaim): Claim {
  const row = db
    .prepare(
      `INSERT INTO claims
        (session_id, subject, attribute, value, url, quote,
         observed_at, local_date, valid_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      claim.sessionId,
      claim.subject,
      claim.attribute,
      claim.value,
      claim.url,
      claim.quote,
      claim.observedAt,
      claim.localDate,
      claim.validFrom ?? claim.localDate
    ) as ClaimRow;

  return toClaim(row);
}

/** The currently-believed value for one subject/attribute, or null. */
export function openClaim(
  db: Database.Database,
  sessionId: string,
  subject: string,
  attribute: string
): Claim | null {
  const row = db
    .prepare(
      `SELECT * FROM claims
       WHERE session_id = ? AND subject = ? AND attribute = ?
         AND valid_until IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId, subject, attribute) as ClaimRow | undefined;
  return row ? toClaim(row) : null;
}

/** Close a claim at a date and point it at its replacement. Used on re-check. */
export function closeClaim(
  db: Database.Database,
  id: number,
  validUntil: string,
  supersededBy: number
): void {
  db.prepare(
    `UPDATE claims SET valid_until = ?, superseded_by = ?
     WHERE id = ? AND valid_until IS NULL`
  ).run(validUntil, supersededBy, id);
}

/** Every claim observed on a local date, oldest first. */
export function claimsForDate(
  db: Database.Database,
  sessionId: string,
  localDate: string
): Claim[] {
  return (
    db
      .prepare(
        `SELECT * FROM claims
         WHERE session_id = ? AND local_date = ? ORDER BY id ASC`
      )
      .all(sessionId, localDate) as ClaimRow[]
  ).map(toClaim);
}

/** All versions of a claim, oldest first — the chain a diff is read from. */
export function claimsBySubject(
  db: Database.Database,
  sessionId: string,
  subject: string
): Claim[] {
  return (
    db
      .prepare(
        `SELECT * FROM claims
         WHERE session_id = ? AND subject = ? ORDER BY id ASC`
      )
      .all(sessionId, subject) as ClaimRow[]
  ).map(toClaim);
}

/** The current beliefs for a session. This is what a "what do we know now" recall reads. */
export function openClaims(
  db: Database.Database,
  sessionId: string
): Claim[] {
  return (
    db
      .prepare(
        `SELECT * FROM claims
         WHERE session_id = ? AND valid_until IS NULL ORDER BY id ASC`
      )
      .all(sessionId) as ClaimRow[]
  ).map(toClaim);
}

// --- Verification audit trail ----------------------------------------------

type VerificationRow = {
  id: number;
  session_id: string;
  claim_id: number;
  checked_at: string;
  local_date: string;
  result: VerificationResult;
  new_value: string | null;
  url: string | null;
};

function toVerification(row: VerificationRow): Verification {
  return {
    id: row.id,
    sessionId: row.session_id,
    claimId: row.claim_id,
    checkedAt: row.checked_at,
    localDate: row.local_date,
    result: row.result,
    newValue: row.new_value,
    url: row.url,
  };
}

export function saveVerification(
  db: Database.Database,
  verification: NewVerification
): Verification {
  const row = db
    .prepare(
      `INSERT INTO verifications
        (session_id, claim_id, checked_at, local_date, result, new_value, url)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      verification.sessionId,
      verification.claimId,
      verification.checkedAt,
      verification.localDate,
      verification.result,
      verification.newValue,
      verification.url
    ) as VerificationRow;
  return toVerification(row);
}

export function verificationsForClaim(
  db: Database.Database,
  sessionId: string,
  claimId: number
): Verification[] {
  return (
    db
      .prepare(
        `SELECT * FROM verifications
         WHERE session_id = ? AND claim_id = ? ORDER BY id ASC`
      )
      .all(sessionId, claimId) as VerificationRow[]
  ).map(toVerification);
}
