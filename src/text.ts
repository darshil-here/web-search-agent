// One-line strings for prompts, ledger columns and trace tables. Every caller
// needs the same "collapse whitespace, cap length" behaviour, so it lives here
// rather than being re-derived per module.

/** Collapse every whitespace run to one space and trim the ends. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut to `max` characters. No marker: callers that must signal a cut use clipWithEllipsis. */
export function clip(text: string, max: number): string {
  return flatten(text).slice(0, max);
}

/** Cut to `max` characters, marking the cut so the reader knows text is missing. */
export function clipWithEllipsis(text: string, max: number): string {
  const flat = flatten(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
