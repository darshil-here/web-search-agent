// Scope enforcement in code, not in a prompt that the model may ignore. F-005
// was a rule the model followed intermittently; this makes it deterministic.
import { unaskedSibling } from "./concepts.js";

export type ScopeResult = { answer: string; removed: string[] };

const SENTENCE = /(?<=[.!?])\s+/;

export function guardScope(question: string, answer: string): ScopeResult {
  const parts = answer.split(SENTENCE);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const part of parts) {
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
