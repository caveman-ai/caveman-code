/**
 * Diagnostics and the small, dependency-free helpers every rule uses:
 * suggestions, the hidden-character scan, rendering, and the file digest.
 *
 * @module diagnostics
 */
import { RULES, type RuleCode } from "./rules.ts";

/** A file by its repo-relative path. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface Diagnostic {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly severity: "error" | "warning";
  /** Stable, from `RULES`. */
  readonly code: string;
  /** One sentence that says what to do. */
  readonly message: string;
}

export interface Position {
  readonly line: number;
  readonly column: number;
}

export const diagnostic = (path: string, at: Position, code: RuleCode, message: string): Diagnostic => ({
  path,
  line: at.line,
  column: at.column,
  severity: RULES[code].severity,
  code,
  message,
});

export const hasErrors = (diagnostics: ReadonlyArray<Diagnostic>): boolean => diagnostics.some((d) => d.severity === "error");

/** Edit distance where swapping two neighbours counts once ("modle" is one edit from "model"); three rows at a time. */
function editDistance(a: string, b: string): number {
  let before = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, before[j - 2]! + 1);
    }
    [before, previous, row] = [previous, row, before];
  }
  return previous[b.length]!;
}

/** Names are at most 64 characters; a longer word is no typo of one, and comparing it costs its length squared. */
const LONGEST_TYPO = 64;

/** The closest candidate, if it is close enough to be a typo. */
export function closest(word: string, candidates: Iterable<string>): string | undefined {
  if (word.length > LONGEST_TYPO) return undefined;
  let best: string | undefined;
  let bestDistance = Infinity;
  const lower = word.toLowerCase();
  // Nothing further from the word than this is returned, and a length this far off is at least as far.
  const furthest = Math.max(1, Math.floor(word.length / 3));
  for (const candidate of candidates) {
    const other = candidate.toLowerCase();
    if (Math.abs(other.length - lower.length) > furthest) continue;
    const distance = editDistance(lower, other);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= Math.max(1, Math.floor(Math.min(word.length, best.length) / 3)) ? best : undefined;
}

/** ` Did you mean "x"?`, or nothing. */
export const didYouMean = (word: string, candidates: Iterable<string>): string => {
  const match = closest(word, candidates);
  return match === undefined ? "" : ` Did you mean "${match}"?`;
};

export const quoteList = (values: ReadonlyArray<string>, last = "or"): string =>
  values.length <= 1 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} ${last} ${values[values.length - 1]}`;

const FORMAT_NAMES: Readonly<Record<number, string>> = {
  0x00ad: "soft hyphen",
  0x200b: "zero-width space",
  0x200c: "zero-width non-joiner",
  0x200d: "zero-width joiner",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x202a: "left-to-right embedding",
  0x202b: "right-to-left embedding",
  0x202c: "pop directional formatting",
  0x202d: "left-to-right override",
  0x202e: "right-to-left override",
  0x2060: "word joiner",
  0x2066: "left-to-right isolate",
  0x2067: "right-to-left isolate",
  0x2068: "first strong isolate",
  0x2069: "pop directional isolate",
  0xfeff: "zero-width no-break space",
};

/**
 * Security rule 8: invisible Unicode format characters (category Cf: bidi
 * controls, zero-width characters, tag characters) can hide instructions
 * from the person reviewing a file. One error per line. A byte-order mark at
 * the very start of a file is harmless and allowed.
 */
export function hiddenCharacters(path: string, text: string, lineOffset = 0): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = i === 0 ? lines[i]!.replace(/^﻿/, "") : lines[i]!;
    const shift = line.length === lines[i]!.length ? 0 : 1;
    const found = [...line.matchAll(/\p{Cf}/gu)];
    const first = found[0];
    if (first === undefined) continue;
    const code = first[0].codePointAt(0)!;
    const name = FORMAT_NAMES[code] ?? (code >= 0xe0000 && code <= 0xe007f ? "tag character" : "invisible format character");
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    const more = found.length > 1 ? ` and ${found.length - 1} more on this line` : "";
    out.push(
      diagnostic(path, { line: i + 1 + lineOffset, column: [...line.slice(0, first.index)].length + 1 + shift }, "hidden-character",
        `Hidden character U+${hex} (${name})${more}: it can hide text from whoever reviews this file. Delete it.`),
    );
  }
  return out;
}

const bySource = (a: Diagnostic, b: Diagnostic) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;

/** `path:line:col  message`, one per line, sorted, with a count at the end. Empty when there is nothing to say. */
export function renderDiagnostics(diagnostics: ReadonlyArray<Diagnostic>): string {
  if (diagnostics.length === 0) return "";
  const sorted = [...diagnostics].sort(bySource);
  const where = sorted.map((d) => `${d.path}:${d.line}:${d.column}`);
  // Not Math.max(...): a call takes about 100,000 arguments, and a big file can have more problems.
  const width = where.reduce((most, w) => Math.max(most, w.length), -Infinity);
  const lines = sorted.map((d, i) => `${where[i]!.padEnd(width)}  ${d.severity === "warning" ? "warning: " : ""}${d.message}`);
  const errors = sorted.filter((d) => d.severity === "error").length;
  const warnings = sorted.length - errors;
  const count = [errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "", warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
  return `${lines.join("\n")}\n\n${count}`;
}

// sha256 in plain TypeScript: the digest must be sync and run in the browser too.
const K = Uint32Array.from(
  "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2"
    .split(" ")
    .map((h) => parseInt(h, 16)),
);

/** Hex sha256 of the text's UTF-8 bytes. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0]! += a;
    h[1]! += b;
    h[2]! += c;
    h[3]! += d;
    h[4]! += e;
    h[5]! += f;
    h[6]! += g;
    h[7]! += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
