// The canary harness every secret-containment check shares (.claude/skills/secret-containment): planted secrets of
// every shape the scrubber hides, the scrubber production hands out, and an oracle that says whether a text gives
// any of them away. The oracle is written from 16-SECRETS.md's list of encodings, not from createScrubber's code.
import { createScrubber, type Scrubber, type SecretEntry } from "@caveman-app/session-protocol";

import { chainScrubbers } from "./EgressScrub.ts";

/** Repository secrets (ProjectSecretsLive) of every shape the scrubber hides. */
export const PROJECT: ReadonlyArray<SecretEntry> = [
  { name: "SHORT", value: "Ab3dEf9h" },
  { name: "UNICODE", value: "pässwört-Ünï" },
  { name: "QUOTED", value: `q"u\\o'te9X` },
  { name: "MULTILINE", value: "line-ONE-11\nline-TWO-22" },
  { name: "DATABASE_URL", value: "postgres://app:Pw9x!secret@db.internal/app" },
];
/** The egress layer's token scrubber (EgressScrub.layer): provider keys, leases, the proxy's path token. */
export const TOKENS: ReadonlyArray<SecretEntry> = [
  { name: "PROVIDER_API_KEY", value: "sk-" + "ant-Zq81xWv0" },
];
export const ALL: ReadonlyArray<SecretEntry> = [...PROJECT, ...TOKENS];
export const SECRET = Object.fromEntries(ALL.map((s) => [s.name, s.value])) as Readonly<
  Record<string, string>
>;

/** The shortest value createScrubber hides (isHideable): every secret above is at least this long. */
export const MIN_HIDDEN = 8;

/**
 * What ProjectSecrets.scrubber hands every consumer in production: the store's scrubber chained with the tokens'
 * (EgressScrub.layer). A secret set mid-stream rebuilds it as a new object that still knows every old value. Built
 * once per generation: a scrubber keeps no stream state, and compiling its patterns per replay dominated the run.
 */
const generations = new Map<number, Scrubber>();
export const productionScrubber = (generation = 0): Scrubber => {
  let scrubber = generations.get(generation);
  if (scrubber === undefined) {
    const store =
      generation === 0
        ? PROJECT
        : [...PROJECT, { name: `ROTATED_${generation}`, value: `Rot4ted-value-${generation}` }];
    generations.set(
      generation,
      (scrubber = chainScrubbers(createScrubber(store), createScrubber(TOKENS))),
    );
  }
  return scrubber;
};

export const jsonEscaped = (value: string) => JSON.stringify(value).slice(1, -1);

const urlPassword = (value: string) => {
  try {
    const password = decodeURIComponent(new URL(value).password);
    return password === "" ? undefined : password;
  } catch {
    return undefined;
  }
};

/** The text encodings 16-SECRETS.md promises to hide: raw, CRLF, JSON-escaped once and twice, URL-encoded; a URL's password too. */
export const textForms = (value: string): ReadonlyArray<string> => {
  const out = new Set<string>();
  for (const v of [value, urlPassword(value)]) {
    if (v === undefined) continue;
    for (const base of [v, v.replace(/\r?\n/g, "\r\n")]) {
      out.add(base);
      out.add(jsonEscaped(base));
      out.add(jsonEscaped(jsonEscaped(base)));
    }
    out.add(encodeURIComponent(v));
  }
  return [...out];
};

/** Whether any base64 or base64url run in `text` (line breaks taken out), decoded from any of its four offsets, carries `value`'s bytes. */
const base64Carries = (text: string, value: string) => {
  const bytes = Buffer.from(value, "utf8");
  for (const run of text.replace(/\\r|\\n|\r|\n/g, "").match(/[A-Za-z0-9+/_-]{8,}/g) ?? []) {
    for (let offset = 0; offset < 4; offset++) {
      const piece = run.slice(offset);
      if (
        Buffer.from(piece, "base64").includes(bytes) ||
        Buffer.from(piece, "base64url").includes(bytes)
      )
        return true;
    }
  }
  return false;
};

/** The first secret `text` gives away and the form it is in; undefined when none. */
export const leakIn = (text: string): string | undefined => {
  for (const { name, value } of ALL) {
    for (const form of textForms(value))
      if (text.includes(form)) return `${name} as ${JSON.stringify(form)}`;
    if (base64Carries(text, value)) return `${name} in base64`;
  }
  return undefined;
};

/** Where every text form of every secret starts in `text`: a held tail shorter than MIN_HIDDEN after one is a value's start. */
export const valueStarts = (text: string): ReadonlyArray<number> => {
  const starts = new Set<number>();
  for (const { value } of ALL) {
    for (const form of textForms(value))
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) starts.add(at);
  }
  return [...starts];
};

export interface Planted {
  readonly name: string;
  readonly before: string;
  /** What must not come out; "" for a text with nothing to hide, which must come out exactly as it went in. */
  readonly form: string;
  readonly after: string;
  /** A base64 form: its value starts mid-character, so `valueStarts` cannot place it. */
  readonly base64?: true;
  /** `form` is the start of a value the end of the stream cuts off: what followingStream's end must mask. */
  readonly cut?: true;
}
const plant = (
  name: string,
  before: string,
  form: string,
  after: string,
  mark?: "base64" | "cut",
): Planted => ({ name, before, form, after, ...(mark ? { [mark]: true } : {}) });
export const plantedText = (p: Planted) => p.before + p.form + p.after;
const basic = (user: string, value: string) =>
  Buffer.from(`${user}:${value}`, "utf8").toString("base64");
/** A value's base64 cut into lines of `width`, as MIME and PEM print it. */
const wrappedBase64 = (value: string, width: number, lineEnd: string) =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .match(new RegExp(`.{1,${width}}`, "g"))!
    .join(lineEnd);

/** Short texts: every split into four pieces runs. Each starts and ends on text no value begins with. */
export const SHORT_TEXTS: ReadonlyArray<Planted> = [
  plant("the shortest hidden value, raw", "ok:", SECRET.SHORT!, ";"),
  plant("a value after a false start of itself", "ok ", `Ab3d${SECRET.SHORT}`, ";"),
  plant("two values back to back", "ok", `${SECRET.SHORT}Pw9x!secret`, ";"),
  plant("non-ASCII, raw", "ok:", SECRET.UNICODE!, ";"),
  plant("quotes and a backslash, JSON-escaped", "ok:", jsonEscaped(SECRET.QUOTED!), ";"),
  plant("a URL's password alone", "ok:", "Pw9x!secret", ";"),
  plant(
    "inside Basic auth (base64 at an odd byte offset)",
    "ok:",
    basic("u", SECRET.SHORT!),
    ";",
    "base64",
  ),
  plant(
    "wrapped base64 in a JSON string (an escaped CRLF break)",
    "ok:",
    jsonEscaped(wrappedBase64(SECRET.SHORT!, 6, "\r\n")),
    ";",
    "base64",
  ),
  plant(
    "a provider key, hidden by the chained token scrubber",
    "ok:",
    SECRET.PROVIDER_API_KEY!,
    ";",
  ),
  plant("near misses only: nothing to hide", "ok Ab3dEf9 Pw9x!secre", "", ";"),
  plant("a password cut off by the end of the stream", "ok:", "Pw9x!secr", "", "cut"),
  plant("a non-ASCII value cut off by the end of the stream", "ok:", "pässwört-Ü", "", "cut"),
];
/** Longer forms: one piece fewer keeps the run cheap. */
export const LONG_TEXTS: ReadonlyArray<Planted> = [
  plant("non-ASCII, URL-encoded", "ok:", encodeURIComponent(SECRET.UNICODE!), ";"),
  plant(
    "a multi-line value with CRLF line ends (a PTY)",
    "ok:",
    SECRET.MULTILINE!.replace("\n", "\r\n"),
    ";",
  ),
];
