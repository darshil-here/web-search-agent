// sources.ts
//
// Citations belong in one place at the end of an answer, not inline. The critic
// still attaches a URL to each claim so code can resolve it to a retrieved
// page; once the claim is verified, this module lifts the citation out of the
// prose and renders a short Sources list with human labels. Code never invents
// a link: a cited page that was not retrieved is dropped.
import { clipWithEllipsis } from "./text.js";
import { canonicalUrl } from "./url.js";

const URL_PATTERN = /https?:\/\/[^\s)\]|,]+/g;
const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BRACKET_URL =
  /\[\s*(?:https?:\/\/[^\]]*|(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\]]*)\s*\]/gi;
const TRAILING = /[.,;:!?]+$/;
const SEPARATOR = /\s+[|—–]\s+|\s+-\s+/;

/** Every URL in a text, with sentence punctuation peeled off. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(new RegExp(URL_PATTERN.source, "g"))].map((match) =>
    match[0].replace(TRAILING, "")
  );
}

/**
 * Remove citations from prose and table cells. A bare bracketed URL disappears
 * with its brackets; a named markdown link keeps its label, which is already
 * readable. A URL that ends a sentence leaves the punctuation behind.
 */
export function stripCitations(text: string): string {
  return text
    .replace(LINK, (_match, label: string) =>
      /^https?:\/\//i.test(label.trim()) ? "" : label
    )
    .replace(BRACKET_URL, "")
    .replace(URL_PATTERN, (url) => url.slice(url.replace(TRAILING, "").length))
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/^[ \t]*[-*•][ \t]*$/gm, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove a Sources section the model wrote itself; code renders the only one. */
export function dropSourcesBlock(text: string): string {
  return text.replace(/\n*^#{1,6}\s*Sources\s*$[\s\S]*$/im, "").trim();
}

/** Lowercase letters and digits only, for comparing a title to a domain. */
function letters(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The brand label of a host: finance.yahoo.com -> yahoo. */
function brandFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length === 0) return "";
    const secondLevel = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
    let index = parts.length - 2;
    if (index > 0 && secondLevel.has(parts[index] ?? "")) index -= 1;
    return parts[index] ?? "";
  } catch {
    return "";
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A short human label for a source. Prefer the title segment that names the
 * site ("... | Coinbase", "... - Yahoo Finance"); fall back to the page title,
 * then the domain. A raw URL is never a label.
 */
export function sourceLabel(title: string | null, url: string): string {
  const rawTitle = (title ?? "").trim();
  const clean = /^https?:\/\//i.test(rawTitle)
    ? ""
    : clipWithEllipsis(
        rawTitle.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim(),
        120
      );
  const brand = brandFromUrl(url);
  if (clean.length >= 3 && brand.length >= 3) {
    const segments = clean
      .split(SEPARATOR)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const matches = segments.filter((segment) =>
      letters(segment).includes(letters(brand))
    );
    if (matches.length > 0) {
      const shortest = matches.reduce((a, b) => (a.length <= b.length ? a : b));
      return clipWithEllipsis(shortest.replace(/[[\]]/g, ""), 48);
    }
    // The title is a page description ("... | Live Chart"), not a site name.
    // When it was split into segments and none names the domain, the domain is
    // the cleaner label.
    if (segments.length > 1) return titleCase(brand);
  }
  if (clean.length >= 3) return clipWithEllipsis(clean.replace(/[[\]]/g, ""), 48);
  return titleCase(brand || "Source");
}

/**
 * The Sources block for the pages still cited after verification. Order is
 * first citation; duplicates collapse by page identity; unused search results
 * never appear.
 */
export function sourcesSection(
  cited: string[],
  sources: Array<{ title: string; url: string }>
): string {
  const byPage = new Map<string, { title: string; url: string }>();
  for (const source of sources) byPage.set(canonicalUrl(source.url), source);

  const seen = new Set<string>();
  const links: string[] = [];
  for (const url of cited) {
    const key = canonicalUrl(url);
    if (seen.has(key)) continue;
    const source = byPage.get(key);
    if (source === undefined) continue;
    seen.add(key);
    links.push(`[${sourceLabel(source.title, source.url)}](${source.url})`);
  }
  // One compact line reads better inside a chat bubble than a heading and a
  // list, and the renderer already styles **bold** and [links](url).
  return links.length > 0 ? `\n\n**Sources:** ${links.join(" · ")}` : "";
}
