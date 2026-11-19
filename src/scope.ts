// Scope enforcement in code, not in a prompt that the model may ignore. F-005
// was a rule the model followed intermittently; this makes it deterministic.
import { unaskedSibling } from "./concepts.js";

export type ScopeResult = { answer: string; removed: string[] };

const SENTENCE = /(?<=[.!?])\s+/;
// A semicolon joins two independent statements. Treating it as a clause
// boundary matters when one clause answers the question and the next volunteers
// an adjacent release: the live scope-001 answer named both the LTS line and an
// alpha in one sentence, and sentence-level removal deleted the answer.
const CLAUSE = /;\s+/;

export function guardScope(question: string, answer: string): ScopeResult {
  const parts = answer.split(SENTENCE);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const part of parts) {
    const clauses = part.split(CLAUSE).filter((clause) => clause.trim() !== "");
    if (clauses.length > 1) {
      const keptClauses = clauses.filter(
        (clause) => unaskedSibling(question, clause) === null
      );
      if (keptClauses.length === 0) {
        removed.push(part);
        continue;
      }
      removed.push(...clauses.filter((clause) => !keptClauses.includes(clause)));
      kept.push(keptClauses.join("; "));
      continue;
    }

    const sibling = unaskedSibling(question, part);
    if (sibling && parts.length > 1) {
      removed.push(part);
    } else {
      kept.push(part);
    }
  }

  if (kept.length === 0) return { answer, removed: [] };
  return { answer: kept.join(" ").trim(), removed };
}
