// url.ts
//
// Page identity for citation checks. A critic or extractor often writes the
// canonical URL ("https://supabase.com/pricing") while search returned a
// tracked variant ("https://supabase.com/pricing?ref=scrimba.com", "http://
// www.supabase.com/pricing", "....md"). Treating those as different pages
// stripped the citation and left an empty "[]" beside a true value, which is
// worse than either keeping or dropping the claim.
//
// Pure: no network.

/** Host and path only: scheme, query, fragment, www and .md are not identity. */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname
      .replace(/\.md$/, "")
      .replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function samePage(a: string, b: string): boolean {
  return canonicalUrl(a) === canonicalUrl(b);
}
