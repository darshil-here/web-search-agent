// Sibling concepts: the same idea at different values. A source that says "LTS"
// where the question said "stable" describes a different attribute, and trading
// one for the other is failure F-010. Extraction anchoring, ledger keying, the
// re-check guard and the extraction prompt all need that vocabulary, so it is
// defined once, here.

type Concept = { word: string; pattern: RegExp };

const FAMILIES: Concept[][] = [
  [
    { word: "stable", pattern: /\bstable\b/i },
    { word: "LTS", pattern: /\blts\b|long[- ]term support/i },
    { word: "current", pattern: /\bcurrent\b/i },
  ],
  [
    { word: "alpha", pattern: /\balpha\b/i },
    { word: "beta", pattern: /\bbeta\b/i },
  ],
  [
    { word: "free", pattern: /\bfree\b/i },
    { word: "paid", pattern: /\bpaid\b|\bpro\b|\bpremium\b/i },
  ],
];

/** Families as prose, for prompts that must state the same rule in words. */
export const SIBLING_CONCEPTS = FAMILIES.map((family) =>
  family.map((concept) => `"${concept.word}"`).join("/")
).join("; ");

/**
 * Anchor an attribute to the wording of the question. A sibling the source
 * prefers ("LTS") is replaced by the sibling the question used ("stable"),
 * but only within the same family: "free tier" is never rewritten to "stable".
 */
export function anchorAttribute(attribute: string, question?: string): string {
  if (!question) return attribute;

  let anchored = attribute;
  for (const family of FAMILIES) {
    const used = family.find((concept) => concept.pattern.test(anchored));
    const asked = family.find((concept) => concept.pattern.test(question));
    if (!used || !asked || used.word === asked.word) continue;
    anchored = anchored.replace(used.pattern, asked.word);
  }
  return anchored;
}

/** Lowercased word tokens, for comparing attribute spellings. */
export function attributeTokens(attribute: string): string[] {
  return (
    attribute
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .match(/[a-z0-9]+/g) ?? []
  );
}

function contradicts(a: string, b: string): boolean {
  return FAMILIES.some((family) => {
    const inA = family.find((concept) => concept.pattern.test(a));
    const inB = family.find((concept) => concept.pattern.test(b));
    return inA !== undefined && inB !== undefined && inA.word !== inB.word;
  });
}

/**
 * Whether two spellings name the same attribute: one's words are all in the
 * other, and neither names a sibling concept the other contradicts.
 */
export function sameAttribute(recorded: string, observed: string): boolean {
  if (contradicts(recorded, observed)) return false;

  const a = attributeTokens(recorded);
  const b = attributeTokens(observed);
  if (a.length === 0 || b.length === 0) return false;

  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const bigSet = new Set(big);
  return small.every((token) => bigSet.has(token));
}
