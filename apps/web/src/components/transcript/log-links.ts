// What in a step's log (a command's output, a thought) can be clicked: web addresses ("Local:
// http://localhost:5173/") and files ("src/retry.test.ts:12:5", "/tmp/report.html", a stack frame's
// "(file:///…/a.js:3:1)"). Files follow the answer's chips (fileRefs.ts codeRef): inside the chat's folder, or an
// HTML page anywhere. A log names folders and bare words all the time, so here a file also needs an extension
// (or a line), and a folder is never a link.
import { codeRef, type FileRef } from "../../panels/files/fileRefs.ts";

export type LogPiece = string | { readonly text: string; readonly url: string } | { readonly text: string; readonly file: FileRef };

/**
 * An address (up to a space, quote or angle bracket), or a run of characters a path can be made of: quotes,
 * brackets, commas, `=` and `|` end it ("--out=dist/report.html", "(src/a.ts:3)").
 */
const TOKEN = /https?:\/\/[^\s"'`<>]+|[^\s"'`()[\]{}<>,;|=]+/gi;
const ADDRESS = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
/** Sentence punctuation after a path, not part of it ("see src/a.ts.", "in src/a.ts:"). */
const TRAILING = /[.:!?]+$/;
/** A file names itself: a name with an extension, maybe a line and column. */
const NAMED = /[^/\\]\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?$/;

/** `text` cut into plain runs and the addresses and files in it, in order. */
export function logLinks(text: string, root: string | null | undefined): LogPiece[] {
  const out: LogPiece[] = [];
  let plain = 0;
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const address = /^https?:\/\//i.test(raw);
    // Cheap first: an address, or something with a dot in it.
    if (!address && !raw.includes(".")) continue;
    const token = address ? trimAddress(raw) : raw.replace(TRAILING, "");
    const piece = address ? (ADDRESS.test(token) ? { text: token, url: token } : null) : file(token, root);
    if (!piece) continue;
    if (match.index > plain) out.push(text.slice(plain, match.index));
    out.push(piece);
    plain = match.index + token.length;
  }
  if (plain < text.length) out.push(text.slice(plain));
  return out.length ? out : [text];
}

/** An address without the sentence around it: trailing punctuation, and a closing bracket it never opened ("(see http://x/a)"). */
function trimAddress(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s.at(-1);
    if (last === undefined) return s;
    const opener = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (".,:;!?'\"".includes(last) || (opener && s.split(opener).length <= s.split(last).length - 1)) s = s.slice(0, -1);
    else return s;
  }
}

function file(token: string, root: string | null | undefined): LogPiece | null {
  const path = /^file:\/\//i.test(token) ? safeDecode(token.replace(/^file:\/\/(localhost)?/i, "")) : token;
  if (!NAMED.test(path)) return null;
  const ref = codeRef(path, root);
  return ref && !ref.directory ? { text: token, file: ref } : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
