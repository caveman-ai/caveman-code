// What chat search reads from a session's journal: each event becomes zero or more passages, small enough that
// the one paragraph a long chat spent on Stripe ranks on its own instead of drowning in the rest of the chat.

import type { SessionEvent } from "@caveman-app/session-protocol";

export type PassageKind = "title" | "user" | "assistant" | "agent" | "plan" | "ask" | "tool" | "files";

export interface Passage {
  /** Within the session: a later passage with the same key replaces it (a plan's update, the files changed so far). */
  readonly key: string;
  readonly kind: PassageKind;
  /** The transcript item it shows in (the web client's ids: item_id, else `type:cursor`); "" for none. */
  readonly item: string;
  /** What a result quotes. Empty: the key's passage goes and nothing replaces it. */
  readonly text: string;
  /** More words to match, never shown: identifier parts, a tool's inputs. */
  readonly aux: string;
  /** Read by meaning too (the on-device embedder); commands and paths match by words only. */
  readonly embed: boolean;
}

/** About the size of a paragraph or two: one topic, a snippet's worth. */
export const CHUNK_CHARS = 900;
/** The snippet markers FTS5 writes; never kept in indexed text. */
const MARKERS = /[\u0001\u0002]/g;

/** Markdown as it reads: no fences, heading, quote or list markers, emphasis, or link targets. */
export function plain(markdown: string): string {
  return markdown
    .replace(MARKERS, "")
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .trim();
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The start of `text`, cut before whitespace to at most `max` characters; a first word longer than that stays whole.
 * Never through a word: a value saved as a secret after it was journaled is scrubbed on the way out only where it is
 * whole, and a cut through it would leave a piece on either side in clear.
 */
export function upTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.slice(0, max + 1).search(/(?<=\S)\s+\S*$/);
  if (last > 0) return text.slice(0, last);
  const next = text.slice(max).search(/\s/);
  return next < 0 ? text : text.slice(0, max + next);
}

/**
 * Pieces of at most `max` characters, cut between paragraphs where it can, else between sentences or lines,
 * else between words (upTo): each piece is one place a result can point at.
 */
export function chunks(text: string, max = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let piece = "";
  const push = () => {
    const done = flat(piece);
    if (done) out.push(done);
    piece = "";
  };
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (piece && piece.length + paragraph.length + 2 > max) push();
    if (paragraph.length <= max) {
      piece = piece ? `${piece}\n\n${paragraph}` : paragraph;
      continue;
    }
    push();
    // One long paragraph: sentences (or lines) packed up to max; a sentence longer than max is cut between words.
    for (const sentence of paragraph.split(/(?<=[.!?])\s+|\n/)) {
      for (let rest = sentence.trimStart(); rest; ) {
        const part = upTo(rest, max);
        rest = rest.slice(part.length).trimStart();
        if (piece && piece.length + part.length + 1 > max) push();
        piece = piece ? `${piece} ${part}` : part;
      }
    }
    push();
  }
  push();
  return out;
}

/** camelCase and PascalCase identifiers in parts ("useStripeCheckout" -> "use stripe checkout"): FTS5 keeps them whole. */
export function identifierParts(text: string): string {
  const parts = new Set<string>();
  for (const word of text.match(/[A-Za-z][A-Za-z0-9]*[a-z0-9][A-Z][A-Za-z0-9]*/g) ?? []) {
    for (const part of word.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) if (part.length > 1) parts.add(part.toLowerCase());
  }
  return [...parts].join(" ");
}

/** A tool's inputs worth matching: what it ran, read, wrote, searched or asked. Never a file's whole new content. */
const TOOL_FIELDS = ["command", "cmd", "file_path", "filePath", "path", "paths", "pattern", "query", "url", "description", "prompt", "subagent_type", "glob"];

function toolInputText(input: unknown): string {
  if (typeof input !== "object" || input === null) return typeof input === "string" ? upTo(input, 2_000) : "";
  const o = input as Record<string, unknown>;
  return TOOL_FIELDS.flatMap((field) => {
    const value = o[field];
    if (typeof value === "string") return [upTo(value, 2_000)];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map((v) => upTo(v, 500));
    return [];
  }).join("\n");
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

const pieces = (keyBase: string, kind: PassageKind, item: string, text: string): Passage[] =>
  chunks(plain(text)).map((piece, i) => ({ key: `${keyBase}#${i}`, kind, item, text: piece, aux: identifierParts(piece), embed: words(piece) >= 3 }));

/** The passages one stored event adds (or replaces) in its session. Most events (deltas, usage, context) add none. */
export function passagesOf(event: SessionEvent): Passage[] {
  const item = event.item_id ?? `${event.type}:${event.cursor}`;
  switch (event.type) {
    case "message.done": {
      // The person's own words, or an answer (and a message another chat's agent wrote, which reads like one).
      const kind = event.payload.role === "user" && event.payload.from === undefined ? "user" : "assistant";
      return pieces(item, kind, item, event.payload.text);
    }
    case "tool.started": {
      const title = upTo(flat(event.payload.title.replace(MARKERS, "")), 600);
      const inputs = flat(toolInputText(event.payload.input).replace(MARKERS, ""));
      if (!title && !inputs) return [];
      return [{ key: item, kind: "tool", item, text: title || upTo(inputs, 600), aux: `${inputs} ${identifierParts(`${title} ${inputs}`)}`.trim(), embed: false }];
    }
    case "diff.changed": {
      // The chat's changed files so far: each diff.changed holds them all, so it replaces the last. Cut between paths, as upTo between words.
      const paths = event.payload.files.map((f) => f.path.replace(MARKERS, ""));
      let text = "";
      for (const path of paths) {
        const more = text ? `${text} · ${path}` : path;
        if (text && more.length > 4_000) break;
        text = more;
      }
      return [{ key: "files", kind: "files", item: "", text, aux: identifierParts(paths.join(" ")), embed: false }];
    }
    case "plan.updated": {
      const text = [...event.payload.steps.map((s) => s.text), event.payload.markdown ?? ""].join("\n");
      const plan = upTo(flat(plain(text)), 2_000);
      return [{ key: item, kind: "plan", item, text: plan, aux: identifierParts(plan), embed: words(plan) >= 3 }];
    }
    case "ask.user": {
      // The questions an agent put to the person (decisions live there); an approval only repeats its tool call.
      if (event.payload.kind !== "question") return [];
      const text = upTo(flat(event.payload.questions.flatMap((q) => [q.prompt, ...q.options.map((o) => o.label)]).join("\n").replace(MARKERS, "")), 2_000);
      return text ? [{ key: item, kind: "ask", item, text, aux: identifierParts(text), embed: words(text) >= 3 }] : [];
    }
    case "subagent.started": {
      const title = flat(event.payload.title.replace(MARKERS, ""));
      return title ? [{ key: `${item}#title`, kind: "agent", item, text: title, aux: identifierParts(title), embed: words(title) >= 2 }] : [];
    }
    case "subagent.done":
      return event.payload.summary ? pieces(`${item}#summary`, "agent", item, event.payload.summary) : [];
    case "grill.finished":
      return pieces(item, "assistant", item, event.payload.summary);
    default:
      return [];
  }
}

/** The chat's title as a passage of its own (key "title", cursor 0): titles change, so the indexer replaces it. */
export const titlePassage = (title: string): Passage => {
  const text = flat(title.replace(MARKERS, ""));
  return { key: "title", kind: "title", item: "", text, aux: identifierParts(text), embed: words(text) >= 1 };
};
