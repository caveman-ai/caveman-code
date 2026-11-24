// What fits in one tool result inline. The Caveman engine keeps a result inline up to 32,768 bytes of its JSON
// (the CallToolResult) and spills the rest to a file the model must read back; a web answer stays under
// MAX_RESULT_BYTES as a JSON string, which leaves room for the envelope. Bytes, not characters: CJK text is three
// bytes a character, a line break two once escaped.
export const MAX_RESULT_BYTES = 28_000;
/** URLs web_fetch takes, keeps and shows: a page's URL appears twice in its answer, so longer ones are refused. */
export const MAX_URL_CHARS = 2_000;

/** `text`'s size as a JSON string, in UTF-8 bytes. */
export const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");

export const fitsInline = (text: string) => jsonBytes(text) <= MAX_RESULT_BYTES;

/** The longest start of `text` that `fits` with `…` after it, cut at a space when one is near; "" when none fits. */
export function cutToFit(text: string, fits: (text: string) => boolean): string {
  if (fits(text)) return text;
  // Never between the halves of a surrogate pair.
  const at = (n: number) => (n > 0 && /[\uD800-\uDBFF]/.test(text[n - 1]!) ? n - 1 : n);
  const piece = (n: number) => `${text.slice(0, at(n)).trimEnd()}…`;
  let low = 0;
  let high = text.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(piece(mid))) low = mid;
    else high = mid - 1;
  }
  if (low === 0) return "";
  const space = text.lastIndexOf(" ", low - 1);
  return space > low * 0.8 ? piece(space) : piece(low);
}
