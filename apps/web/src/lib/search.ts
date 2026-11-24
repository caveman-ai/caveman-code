/** Matches every word of the query somewhere in the text, in any order. */
export function matches(query: string, text: string): boolean {
  const t = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w));
}
