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
import { recentTurns, turnsOnDate, type SessionContext, type Turn } from "./db.js";
import { describeNow, parseDateRefs, type DateRef } from "./dates.js";
import { clipWithEllipsis } from "./text.js";

export type Notebook = {
  text: string;
  mode: "dates" | "recent";
  refs: DateRef[];
  dates: string[];
  rows: number;
  bytes: number;
  truncated: boolean;
};

export const NOTEBOOK_MAX_BYTES = 4096;
const TURN_CLIP = 600;
const RECENT_TURNS = 8;

function turnLine(turn: Turn): string {
  return `  ${turn.role} (${turn.createdAt}): ${clipWithEllipsis(
    turn.content,
    TURN_CLIP
  )}`;
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
    bytes: Buffer.byteLength(text, "utf8"),
    truncated,
  };
}
