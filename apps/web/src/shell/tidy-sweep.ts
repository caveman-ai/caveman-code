// Tidy's sweep, apart from React (Tidy.tsx draws it): a press archives the old chats one after another, and Undo puts
// every one back as it was. Its state is this module's, as the rows' marks are: the sidebar mounts afresh when it
// docks, tucks away or opens on a phone, and a sweep still archiving, and its Undo bar, carry on across that.

import type { Workspace } from "@caveman-app/session-protocol";
import type { WorkspaceView } from "../state/model.ts";

/** What a sweep asks of the runtime it archives on; its Undo goes back to that same one. */
export interface TidyPort {
  readonly archive: (id: string) => Promise<unknown>;
  /** workspace.restore; `keepDone` (keep_done) brings a done chat back done from when it was. */
  readonly restore: (id: string, keepDone: boolean) => Promise<Workspace>;
  /** Marks a chat done now: a runtime from before keep_done reopens every chat it restores. */
  readonly markDone: (id: string) => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
  readonly announce: (text: string) => void;
}

/** A row Tidy points at: set back while its button is hovered, fading out once it is pressed. */
export type TidyMark = "preview" | "leaving";

interface Sweep {
  readonly port: TidyPort;
  readonly ids: ReadonlyArray<string>;
  /** Those that were on the Done shelf: Undo brings them back done, as they were. */
  readonly done: ReadonlySet<string>;
  readonly archived: string[];
  running: boolean;
  undone: boolean;
}

export interface TidyNotice {
  readonly sweep: Sweep;
  readonly text: string;
  /** Why some stayed, or could not come back: the runtime's own words. */
  readonly why: string | null;
  readonly undo: "offered" | "running" | "over";
}

/** A row's fade, then the list closes (STYLE.md section 8: `fast`). */
export const LEAVE_MS = 150;

const marks = new Map<string, TidyMark>();
// Chats being archived: out of the sidebar's lists before the runtime answers.
let gone: ReadonlySet<string> = new Set();
let notice: TidyNotice | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const subscribeTidy = (listener: () => void) => (
  listeners.add(listener),
  () => void listeners.delete(listener)
);
export const tidyMark = (id: string): TidyMark | undefined => marks.get(id);
export const tidyGone = (): ReadonlySet<string> => gone;
/** What Tidy just did, with its Undo, for the sidebar's foot (Tidy.tsx TidyNotice). */
export const tidyNotice = (): TidyNotice | null => notice;
/** Archiving or restoring now: no second press until it is over, so its Undo is never replaced under it. */
export const tidyBusy = (n: TidyNotice | null = notice): boolean =>
  n !== null && (n.sweep.running || n.undo === "running");

export function markTidy(ids: ReadonlyArray<string>, to: TidyMark | null) {
  for (const id of ids) to ? marks.set(id, to) : marks.delete(id);
  emit();
}

function hide(ids: ReadonlyArray<string>, hidden: boolean) {
  const next = new Set(gone);
  for (const id of ids) hidden ? next.add(id) : next.delete(id);
  gone = next;
  emit();
}

function setNotice(next: (n: TidyNotice | null) => TidyNotice | null) {
  notice = next(notice);
  emit();
}

const chats = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Archives `old` (inbox-state.ts tidyable's answer) on `port`'s runtime, one after another. */
export async function runTidy(
  port: TidyPort,
  old: ReadonlyArray<Pick<WorkspaceView, "id" | "inbox">>,
): Promise<void> {
  const ids = old.map((w) => w.id);
  if (ids.length === 0 || tidyBusy()) return;
  const sweep: Sweep = {
    port,
    ids,
    done: new Set(old.filter((w) => w.inbox?.doneAt).map((w) => w.id)),
    archived: [],
    running: true,
    undone: false,
  };
  setNotice(() => ({ sweep, text: `Archived ${chats(ids.length)}`, why: null, undo: "offered" }));
  markTidy(ids, "leaving");
  await new Promise((done) => setTimeout(done, LEAVE_MS));
  hide(ids, true);
  markTidy(ids, null);
  let why: string | null = null;
  // One after another: each archive moves a worktree out of the same repository.
  for (const id of ids) {
    if (sweep.undone) break;
    try {
      await port.archive(id);
      sweep.archived.push(id);
    } catch (e) {
      why ??= message(e);
    }
  }
  await port.refresh().catch(() => undefined);
  hide(ids, false);
  sweep.running = false;
  if (sweep.undone) return restore(sweep);
  const stayed = ids.length - sweep.archived.length;
  const text =
    stayed === 0
      ? `Archived ${chats(ids.length)}`
      : sweep.archived.length === 0
        ? `${chats(stayed)} could not be archived`
        : `Archived ${chats(sweep.archived.length)}, ${stayed} stayed`;
  port.announce(why ? `${text}: ${why}` : `${text}.`);
  setNotice((n) =>
    n?.sweep === sweep
      ? { sweep, text, why, undo: sweep.archived.length > 0 ? "offered" : "over" }
      : n,
  );
}

/** Undo: every chat the sweep archived comes back as it was; one still archiving stops at the next chat first. */
export function undoTidy() {
  if (!notice || notice.undo !== "offered") return;
  const { sweep } = notice;
  sweep.undone = true;
  setNotice((n) => (n?.sweep === sweep ? { ...n, text: "Restoring…", undo: "running" } : n));
  if (!sweep.running) void restore(sweep);
}

/** The bar goes; not while it archives or restores: it is what keeps a second press out, and where its Undo is. */
export function dismissTidy() {
  setNotice((n) => (tidyBusy(n) ? n : null));
}

async function restore(sweep: Sweep) {
  const { port } = sweep;
  let why: string | null = null;
  let back = 0;
  // Back, but no longer on the Done shelf: a runtime from before keep_done reopened it, and marking it done failed.
  let reopened = 0;
  let reopenedWhy: string | null = null;
  for (const id of sweep.archived) {
    const done = sweep.done.has(id);
    let restored: Workspace;
    try {
      restored = await port.restore(id, done);
    } catch (e) {
      why ??= message(e);
      continue;
    }
    back += 1;
    if (done && !restored.inbox?.done_at) {
      await port.markDone(id).catch((e: unknown) => {
        reopened += 1;
        reopenedWhy ??= message(e);
      });
    }
  }
  await port.refresh().catch(() => undefined);
  const stuck = sweep.archived.length - back;
  port.announce(
    stuck > 0
      ? `${chats(stuck)} could not be restored: ${why}`
      : reopened > 0
        ? `Restored ${chats(back)}; ${reopened} left the Done shelf: ${reopenedWhy}`
        : `Restored ${chats(back)}.`,
  );
  setNotice((n) =>
    n?.sweep !== sweep
      ? n
      : stuck === 0
        ? null
        : { sweep, text: `${chats(stuck)} stayed archived`, why, undo: "over" },
  );
}
