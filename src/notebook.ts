// What the model is allowed to remember, per turn. This is retrieval, not a
// tool: the loop decides what goes in the prompt, so the rule "one tool" is
// kept and the model cannot improvise a memory.
//
// Two shapes:
//   dates  — the user named a date ("3 November", "yesterday"), so fetch that
//            date. A miss is stated explicitly, never left as silence.
//   recent — no date named, so hand over the last few turns.
//
// The output has a hard byte budget. Memory that grows without a bound is a
// token bill and a slower first step on every question.
import {
  openClaims,
  recentTurns,
  turnsOnDate,
  type Claim,
  type SessionContext,
  type Turn,
} from "./db.js";
import { describeNow, parseDateRefs, type DateRef } from "./dates.js";
import { clip, clipWithEllipsis, flatten } from "./text.js";

export type Notebook = {
  text: string;
  mode: "dates" | "recent";
  refs: DateRef[];
  dates: string[];
  rows: number;
  claims: number;
  bytes: number;
  truncated: boolean;
};

export const NOTEBOOK_MAX_BYTES = 4096;
const TURN_CLIP = 600;
const RECENT_TURNS = 8;
const MAX_CLAIMS = 12;
const CLAIM_FIELD = { subject: 80, attribute: 80, value: 160, url: 120 };

function turnLine(turn: Turn): string {
  return `  ${turn.role} (${turn.createdAt}): ${clipWithEllipsis(
    turn.content,
    TURN_CLIP
  )}`;
}

function claimLine(claim: Claim): string {
  const url = claim.url ? ` [${clip(claim.url, CLAIM_FIELD.url)}]` : "";
  return (
    `  - ${clip(claim.subject, CLAIM_FIELD.subject)} / ` +
    `${clip(claim.attribute, CLAIM_FIELD.attribute)} = ` +
    `${clip(claim.value, CLAIM_FIELD.value)} ` +
    `(observed ${claim.localDate})${url}`
  );
}

function render(
  header: string,
  blocks: string[]
): { text: string; truncated: boolean } {
  const kept = [...blocks];
  let truncated = false;

  const build = (): string => {
    const lines = ["<notebook>", header];
    if (truncated) {
      lines.push("(Earlier turns omitted to fit the notebook budget.)");
    }
    lines.push(...kept, "</notebook>");
    return lines.join("\n");
  };

  // Drop whole blocks from the oldest end. A turn is never half-injected.
  while (
    kept.length > 0 &&
    Buffer.byteLength(build(), "utf8") > NOTEBOOK_MAX_BYTES
  ) {
    kept.shift();
    truncated = true;
  }

  return { text: build(), truncated };
}

export function buildNotebook(
  ctx: SessionContext,
  userText: string,
  now: Date
): Notebook {
  const refs = parseDateRefs(userText, now, ctx.timeZone);
  const blocks: string[] = [];
  const dates: string[] = [];
  let rows = 0;

  if (refs.length > 0) {
    for (const ref of refs) {
      dates.push(ref.date);
      const turns = turnsOnDate(ctx.db, ctx.sessionId, ref.date);
      rows += turns.length;

      if (turns.length === 0) {
        // Stated, not omitted. Silence invites the model to fill the gap.
        blocks.push(`No turns on ${ref.date} (${ref.label}).`);
        continue;
      }

      blocks.push(`Turns on ${ref.date} (${ref.label}):`);
      for (const turn of turns) blocks.push(turnLine(turn));
    }
  } else {
    const turns = recentTurns(ctx.db, ctx.sessionId, RECENT_TURNS);
    rows = turns.length;

    if (turns.length === 0) {
      blocks.push("No earlier turns.");
    } else {
      blocks.push(`Last ${turns.length} turns, oldest first:`);
      for (const turn of turns) blocks.push(turnLine(turn));
    }
  }

  // Appended last so the budget trims old turns before current beliefs.
  const beliefs = openClaims(ctx.db, ctx.sessionId).slice(0, MAX_CLAIMS);
  if (beliefs.length > 0) {
    blocks.push("Current beliefs recorded in this conversation:");
    for (const belief of beliefs) blocks.push(claimLine(belief));
  }

  const header =
    `Earlier turns in this conversation. Session "${ctx.sessionId}", ` +
    `timezone ${ctx.timeZone}, today ${describeNow(now, ctx.timeZone).iso}.`;

  const { text, truncated } = render(header, blocks);

  return {
    text,
    mode: refs.length > 0 ? "dates" : "recent",
    refs,
    dates,
    rows,
    claims: beliefs.length,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated,
  };
}

// A question about the conversation's own history, not about the world.
const ASKS_RECALL =
  /\b(what did i ask|what was my question|what did we discuss|remind me what i asked)\b/i;

/**
 * A recall question expects the earlier question itself, not only the fact that
 * was recorded. The re-check answer is written from the claim diff, which does
 * not contain the original wording, so put it back in code when the answer
 * omits it. Only explicit recall questions are touched.
 */
export function withRecalledQuestion(
  ctx: SessionContext,
  date: string,
  question: string,
  answer: string
): string {
  if (!ASKS_RECALL.test(question)) return answer;
  const asked = turnsOnDate(ctx.db, ctx.sessionId, date)
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content.trim())
    .find((content) => content !== "");
  if (!asked || answer.includes(asked)) return answer;
  return `You asked: “${flatten(asked)}”\n\n${answer}`;
}
