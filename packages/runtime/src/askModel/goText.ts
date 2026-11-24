// Go's string semantics on JS strings, as the Go featurizer reads text: lengths and cuts in UTF-8 bytes, runes as
// code points, and the unicode package's character classes and lower-casing (goUnicodeTables.ts). Texts reach here
// well-formed (features applies toWellFormed, as Go's JSON decoding turns a lone surrogate into U+FFFD), so a cut on
// a rune boundary decodes to the same runes in both.
import { DIGIT, LETTER, LOWER, UPPER } from "./goUnicodeTables.ts";

const decodeRanges = (encoded: string): Int32Array => {
  const parts = encoded.split(",");
  const out = new Int32Array(2 * parts.length);
  let prev = 0;
  parts.forEach((part, i) => {
    const [gap, extent] = part.split("+");
    const lo = prev + parseInt(gap!, 36);
    prev = lo + (extent === undefined ? 0 : parseInt(extent, 36));
    out[2 * i] = lo;
    out[2 * i + 1] = prev;
  });
  return out;
};

const decodeRuns = (encoded: string): Int32Array => {
  const parts = encoded.split(",");
  const out = new Int32Array(4 * parts.length);
  let prev = 0;
  parts.forEach((part, i) => {
    const [gap, extent, stride, delta] = part.split(" ").map((x) => parseInt(x, 36));
    const lo = prev + gap!;
    prev = lo + extent!;
    out.set([lo, prev, stride!, delta!], 4 * i);
  });
  return out;
};

const upper = decodeRanges(UPPER);
const letter = decodeRanges(LETTER);
const digit = decodeRanges(DIGIT);
const lower = decodeRuns(LOWER);

/** The index of the last entry (of `width` numbers) whose first number is at most r, or -1. */
const lastAtMost = (table: Int32Array, width: number, r: number): number => {
  let lo = 0;
  let hi = table.length / width - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid * width]! <= r) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
};

const inRanges = (table: Int32Array, r: number): boolean => {
  const i = lastAtMost(table, 2, r);
  return i >= 0 && r <= table[2 * i + 1]!;
};

/** unicode.IsUpper. */
export const isUpper = (r: number): boolean =>
  r < 0x80 ? r >= 0x41 && r <= 0x5a : inRanges(upper, r);

/** unicode.IsLetter. */
export const isLetter = (r: number): boolean =>
  r < 0x80 ? (r >= 0x41 && r <= 0x5a) || (r >= 0x61 && r <= 0x7a) : inRanges(letter, r);

/** unicode.IsDigit. */
export const isDigit = (r: number): boolean =>
  r < 0x80 ? r >= 0x30 && r <= 0x39 : inRanges(digit, r);

/** unicode.IsSpace. */
export const isSpace = (r: number): boolean =>
  r === 0x20 ||
  (r >= 0x09 && r <= 0x0d) ||
  (r >= 0x80 &&
    (r === 0x85 ||
      r === 0xa0 ||
      r === 0x1680 ||
      (r >= 0x2000 && r <= 0x200a) ||
      r === 0x2028 ||
      r === 0x2029 ||
      r === 0x202f ||
      r === 0x205f ||
      r === 0x3000));

/** unicode.ToLower. */
export const lowerRune = (r: number): number => {
  if (r < 0x80) return r >= 0x41 && r <= 0x5a ? r + 32 : r;
  const i = lastAtMost(lower, 4, r);
  if (i < 0) return r;
  const [lo, hi, stride, delta] = [
    lower[4 * i]!,
    lower[4 * i + 1]!,
    lower[4 * i + 2]!,
    lower[4 * i + 3]!,
  ];
  return r <= hi && (r - lo) % stride === 0 ? r + delta : r;
};

const ascii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) return false;
  return true;
};

/** strings.ToLower: unicode.ToLower rune by rune. */
export const toLower = (s: string): string => {
  if (ascii(s)) return s.toLowerCase();
  let out = "";
  for (const ch of s) out += String.fromCodePoint(lowerRune(ch.codePointAt(0)!));
  return out;
};

/** The UTF-8 width of the code point r. */
const width = (r: number): number => (r < 0x80 ? 1 : r < 0x800 ? 2 : r < 0x10000 ? 3 : 4);

/** len(s): its UTF-8 bytes. */
export const byteLength = (s: string): number =>
  ascii(s) ? s.length : Buffer.byteLength(s, "utf8");

/** utf8.RuneCountInString. */
export const runeCount = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) n++;
  }
  return n;
};

/** The first n bytes of s, cut back to a rune boundary. */
export const headBytes = (s: string, n: number): string => {
  if (s.length <= n && byteLength(s) <= n) return s;
  let bytes = 0;
  for (let i = 0; i < s.length;) {
    const r = s.codePointAt(i)!;
    bytes += width(r);
    if (bytes > n) return s.slice(0, i);
    i += r > 0xffff ? 2 : 1;
  }
  return s;
};

/** The last n bytes of s, cut forward to a rune boundary. */
export const tailBytes = (s: string, n: number): string => {
  if (s.length <= n && byteLength(s) <= n) return s;
  let bytes = 0;
  for (let i = s.length; i > 0;) {
    const low = s.charCodeAt(i - 1);
    const step = low >= 0xdc00 && low <= 0xdfff && i >= 2 ? 2 : 1;
    bytes += width(s.codePointAt(i - step)!);
    if (bytes > n) return s.slice(i);
    i -= step;
  }
  return s;
};

/** The first n runes of s. */
export const headRunes = (s: string, n: number): string => {
  let i = 0;
  for (; n > 0 && i < s.length; n--) i += s.codePointAt(i)! > 0xffff ? 2 : 1;
  return s.slice(0, i);
};

/** The last n runes of s. */
export const lastRunes = (s: string, n: number): string => {
  let i = s.length;
  for (; n > 0 && i > 0; n--) {
    const low = s.charCodeAt(i - 1);
    i -= low >= 0xdc00 && low <= 0xdfff && i >= 2 ? 2 : 1;
  }
  return s.slice(i);
};

/** The UTF-8 bytes of s. */
export const utf8 = (s: string): Uint8Array => Buffer.from(s, "utf8");

const spaceBefore = (s: string, end: number): number => {
  const low = s.charCodeAt(end - 1);
  const step = low >= 0xdc00 && low <= 0xdfff && end >= 2 ? 2 : 1;
  return isSpace(s.codePointAt(end - step)!) ? step : 0;
};

/** strings.TrimRightFunc(s, unicode.IsSpace). */
export const trimRightSpace = (s: string): string => {
  let end = s.length;
  for (let step: number; end > 0 && (step = spaceBefore(s, end)) > 0;) end -= step;
  return s.slice(0, end);
};

/** strings.TrimSpace. */
export const trimSpace = (s: string): string => {
  const right = trimRightSpace(s);
  let start = 0;
  while (start < right.length) {
    const r = right.codePointAt(start)!;
    if (!isSpace(r)) break;
    start += r > 0xffff ? 2 : 1;
  }
  return right.slice(start);
};

/** strings.Fields. */
export const fields = (s: string): Array<string> => {
  const out: Array<string> = [];
  let start = -1;
  for (let i = 0; i < s.length;) {
    const r = s.codePointAt(i)!;
    if (isSpace(r)) {
      if (start >= 0) out.push(s.slice(start, i));
      start = -1;
    } else if (start < 0) start = i;
    i += r > 0xffff ? 2 : 1;
  }
  if (start >= 0) out.push(s.slice(start));
  return out;
};

/** The number of words strings.Fields finds, without the slice. */
export const wordCount = (s: string): number => {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < s.length;) {
    const r = s.codePointAt(i)!;
    const space = isSpace(r);
    if (!space && !inWord) words++;
    inWord = !space;
    i += r > 0xffff ? 2 : 1;
  }
  return words;
};

/** strings.TrimFunc(s, func(r) bool { return !unicode.IsLetter(r) }). */
export const trimNonLetters = (s: string): string => {
  const runes = Array.from(s);
  let start = 0;
  let end = runes.length;
  while (start < end && !isLetter(runes[start]!.codePointAt(0)!)) start++;
  while (end > start && !isLetter(runes[end - 1]!.codePointAt(0)!)) end--;
  return runes.slice(start, end).join("");
};

/** strings.Count of a non-empty substring. */
export const countOf = (s: string, sub: string): number => {
  let n = 0;
  for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + sub.length)) n++;
  return n;
};
