// Thread references in the composer (docs/agent-messaging.md, "Composer").
// A picked chat shows as "@Title" in the textarea and is tracked by position,
// so two chats with the same title stay apart. Sent, each one becomes the wire
// link (formatThreadReference); read back, the link is "@Title" again.
// A picked skill is a pill too: "/name" in the textarea, `$name` on the wire,
// which the engine adapters run natively (ClaudeSkillDispatch, Codex's `$`).

import { formatThreadReference, parseThreadReferences } from "@caveman-app/session-protocol/references";
import type { WorkspaceView } from "../state/model.ts";

export interface ThreadRef {
  /** Keys the pill's element, so it animates once: when it lands. */
  readonly id: number;
  readonly workspace_id: string;
  /** A plugin mention instead of a chat: the plugin's id (`name@marketplace`); `workspace_id` is then "". */
  readonly plugin?: string;
  /** A skill instead of a chat: its token, sent as `$token`; `workspace_id` is then "". */
  readonly skill?: string;
  /** Cleaned like the wire label; the textarea shows "@" (a skill: "/") + title over [start, end). */
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

export interface Draft {
  readonly text: string;
  readonly refs: ReadonlyArray<ThreadRef>;
  /** References an edit removed, newest last: undo puts their text back, and they come back with it. */
  readonly gone: ReadonlyArray<ThreadRef>;
  /** A deletion cut into a pill and left part of it: the composer deletes [start, end) too, so no half pill stays. */
  readonly cut?: readonly [number, number];
}

export const EMPTY_DRAFT: Draft = { text: "", refs: [], gone: [] };

let nextId = 1;

/** At most `n` code units, never ending on half of a surrogate pair (a lone surrogate fails the API). */
const cutAt = (s: string, n: number) => s.slice(0, s.length > n && /[\uD800-\uDBFF]/.test(s[n - 1]!) ? n - 1 : n);

/** The label formatThreadReference writes, so the pill reads the same before and after sending. */
const clean = (title: string) => cutAt(title.replace(/[[\]\\\r\n]/g, " ").replace(/\s+/g, " ").trim(), 200) || "thread";

/** What a pill reads in the textarea: "@Title", or "/name" for a skill. */
export const pillText = (r: Pick<ThreadRef, "skill" | "title">) => `${r.skill === undefined ? "@" : "/"}${r.title}`;

/**
 * What to type over [start, end) of `text` to reference a chat, and the
 * reference it becomes once typed: "@Title" with a space after it, and one
 * before it when it would touch a word.
 */
export function refEdit(text: string, start: number, end: number, chat: { workspace_id: string; title: string; plugin?: string; skill?: string }): { insert: string; ref: ThreadRef } {
  const title = chat.skill === undefined ? clean(chat.title) : chat.skill;
  const lead = start > 0 && !/\s/.test(text[start - 1]!) ? " " : "";
  const at = start + lead.length;
  const ref: ThreadRef = {
    id: nextId++,
    workspace_id: chat.workspace_id,
    title,
    start: at,
    end: at + title.length + 1,
    ...(chat.plugin ? { plugin: chat.plugin } : {}),
    ...(chat.skill === undefined ? {} : { skill: chat.skill }),
  };
  return { insert: `${lead}${pillText(ref)} `, ref };
}

/**
 * What a plugin mention sends: a markdown link to `plugin://<id>`, the path Codex uses for a plugin
 * mention. The runtime adds the plugin's capability block for it; the label stays readable as typed.
 */
export const pluginMention = (id: string, label: string) => `[@${label.replace(/[[\]\\]/g, "")}](plugin://${id})`;

/** A reference's wire form: a plugin mention, a skill's `$name`, or a thread link. */
const wire = (r: Pick<ThreadRef, "workspace_id" | "title" | "plugin" | "skill">) =>
  r.plugin ? pluginMention(r.plugin, r.title) : r.skill !== undefined ? `$${r.skill}` : formatThreadReference(r.workspace_id, r.title);

/**
 * The draft after the textarea changed to `next` with the caret at `caret`.
 * The edit is the span between the shared head and tail; the tail never runs
 * past the caret, so typing at a pill's edge is never read as typing inside
 * it. References before the edit stay, ones after it shift, one the edit
 * touched dissolves; when the change only deleted, what is left of that pill
 * is marked `cut` for the composer to delete too. `added` is a reference this
 * very change typed. On an undo or redo (`restoring`), a gone reference whose
 * text is back exactly where it was comes back.
 */
export function changeDraft(d: Draft, next: string, caret: number, added?: ThreadRef, restoring = false): Draft {
  const prev = d.text;
  const max = Math.min(prev.length, next.length);
  let suffix = 0;
  while (suffix < max && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const tail = Math.min(suffix, next.length - caret);
  let head = 0;
  while (head < max - tail && prev[head] === next[head]) head++;
  const prevEnd = prev.length - tail;
  const nextEnd = next.length - tail;
  const delta = next.length - prev.length;

  const refs: ThreadRef[] = [];
  const gone = [...d.gone];
  let [lo, hi] = [head, head];
  for (const r of d.refs) {
    if (r.end <= head) refs.push(r);
    else if (r.start >= prevEnd) refs.push({ ...r, start: r.start + delta, end: r.end + delta });
    else {
      gone.push(r);
      // What is left of it, in `next`: its head before the edit, its tail right after it.
      lo = Math.min(lo, r.start);
      hi = Math.max(hi, head + Math.max(0, r.end - prevEnd));
    }
  }
  if (added) refs.push(added);
  for (let i = gone.length - 1; restoring && i >= 0; i--) {
    const g = gone[i]!;
    const back = g.start < nextEnd && g.end > head && next.slice(g.start, g.end) === pillText(g) && !refs.some((r) => r.start < g.end && g.start < r.end);
    if (back) refs.push(...gone.splice(i, 1));
  }
  refs.sort((a, b) => a.start - b.start);
  const cut = nextEnd === head && lo < hi ? ([lo, hi] as const) : undefined;
  return { text: next, refs, gone: gone.slice(-20), ...(cut ? { cut } : {}) };
}

/**
 * Where a caret at `pos` belongs: never inside a pill. Moving from `from`, it
 * goes on to the pill's far edge; with no direction (a click), the nearer edge.
 */
export function snapCaret(refs: ReadonlyArray<ThreadRef>, pos: number, from: number | null): number {
  const r = refs.find((x) => pos > x.start && pos < x.end);
  if (!r) return pos;
  if (from === null || from === pos) return pos - r.start <= r.end - pos ? r.start : r.end;
  return pos > from ? r.end : r.start;
}

/**
 * What a Backspace (before the caret) or Delete (after it) removes when it
 * meets a pill: the whole pill. A word delete (`word`) reaches a pill across
 * spaces too, and takes them with it.
 */
export function pillDeletion(refs: ReadonlyArray<ThreadRef>, text: string, caret: number, key: "Backspace" | "Delete", word: boolean): readonly [number, number] | undefined {
  const gap = (a: number, b: number) => a === b || (word && /^[ \t]+$/.test(text.slice(a, b)));
  const r = key === "Backspace" ? refs.findLast((x) => x.end <= caret) : refs.find((x) => x.start >= caret);
  if (!r) return undefined;
  if (key === "Backspace") return gap(r.end, caret) ? [r.start, caret] : undefined;
  return gap(caret, r.start) ? [caret, r.end] : undefined;
}

/** What is sent: every reference as its wire link, everything else as typed. */
export function serializeDraft(d: Pick<Draft, "text" | "refs">): string {
  let out = "";
  let at = 0;
  for (const r of d.refs) {
    out += d.text.slice(at, r.start) + wire(r);
    at = r.end;
  }
  return out + d.text.slice(at);
}

/**
 * Text edited as "@Title" (a queued follow-up) back to wire text: each
 * reference whose "@Title" is still there, in order, becomes its link again.
 */
export function relink(text: string, refs: ReadonlyArray<Pick<ThreadRef, "workspace_id" | "title" | "plugin" | "skill">>): string {
  let out = "";
  let at = 0;
  for (const r of refs) {
    const i = text.indexOf(pillText(r), at);
    if (i < 0) continue;
    out += text.slice(at, i) + wire(r);
    at = i + r.title.length + 1;
  }
  return out + text.slice(at);
}

/**
 * References kept with a draft (composer-drafts.ts) back on its text, each with a fresh id: only
 * those whose pill text still sits where they say, in order and apart; the rest are dropped.
 */
export function restoreRefs(text: string, refs: ReadonlyArray<Omit<ThreadRef, "id">>): ThreadRef[] {
  const out: ThreadRef[] = [];
  let at = 0;
  for (const r of refs) {
    if (!Number.isInteger(r.start) || r.start < at || r.end !== r.start + r.title.length + 1 || text.slice(r.start, r.end) !== pillText(r)) continue;
    out.push({ ...r, id: nextId++ });
    at = r.end;
  }
  return out;
}

/** Sent text read back: links become "@Title" references again. */
export function draftFromWire(wire: string): Draft {
  let text = "";
  let at = 0;
  const refs: ThreadRef[] = [];
  for (const r of parseThreadReferences(wire)) {
    text += wire.slice(at, r.start);
    refs.push({ id: nextId++, workspace_id: r.workspace_id, title: r.label, start: text.length, end: text.length + r.label.length + 1 });
    text += `@${r.label}`;
    at = r.end;
  }
  return { text: text + wire.slice(at), refs, gone: [] };
}

/** `text` cut at the spans: plain strings between the spans themselves, in order. */
export function pieces<T extends { readonly start: number; readonly end: number }>(text: string, spans: ReadonlyArray<T>): Array<string | T> {
  const out: Array<string | T> = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(s);
    at = s.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * The "@" menu's Chats: titles holding the query (any case), never `exclude`
 * (the thread being written in) or archived ones; the current project's
 * first, then the most recently active; at most 6.
 */
export function matchChats(workspaces: ReadonlyArray<WorkspaceView>, query: string, exclude: string | undefined, projectId: string | null): WorkspaceView[] {
  const q = query.toLowerCase();
  const here = (w: WorkspaceView) => Number(projectId !== null && w.projectId === projectId);
  return workspaces
    .filter((w) => w.id !== exclude && w.state !== "archived" && w.title.toLowerCase().includes(q))
    .sort((a, b) => here(b) - here(a) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
}
