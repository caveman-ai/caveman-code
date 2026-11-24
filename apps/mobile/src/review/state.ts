// What a reviewer has done with a guide on this phone: the stops read and the files viewed, kept by pull request and
// the head they were read at (the desktop's `caveman.review.read.{prKey}@{head}`), so a push that moves the head
// starts the marks over; your replies on threads, the threads you resolved, and what you asked the agent and its
// answers. All of it is kept on disk (store/persist.ts), as the desktop keeps its marks per device, so a relaunch
// opens a guide where you left it.
import { keep, type Kept } from "../screens/pages/keep";
import { read as readDisk, write as writeDisk } from "../store/persist";
import type { PrThread } from "./model";

type Marks = Readonly<Record<string, readonly number[]>>;
type Viewed = Readonly<Record<string, readonly string[]>>;
type Replies = Readonly<Record<string, readonly { body: string; at: number }[]>>;

/** A question asked from a guide and the agent's answer, null while it reads the code. */
export interface Asked {
  id: string;
  question: string;
  /** Where it was asked from, said as the agent hears it ("chapter 2 of the guide, …", "apns.ts:51"). */
  where?: string;
  /** The chapter it was asked from, which keeps it under that chapter. */
  stop: number | null;
  answer: string | null;
  at: number;
}

interface Disk {
  read: Marks;
  viewed: Viewed;
  replies: Replies;
  resolved: Readonly<Record<string, boolean>>;
  asked: Readonly<Record<string, readonly Asked[]>>;
  started: Readonly<Record<string, readonly PrThread[]>>;
}

const KEY = "cc/v1/review";
const disk: Partial<Disk> = readDisk<Partial<Disk>>(KEY, (data) => (data && typeof data === "object" && !Array.isArray(data) ? (data as Partial<Disk>) : null)) ?? {};

/** A record kept while the app runs and written to disk with the others whenever it changes. */
function kept<T>(start: () => T): Kept<T> {
  const k = keep(start);
  return {
    get: k.get,
    use: k.use,
    set(next) {
      k.set(next);
      writeDisk(KEY, () => ({ read: read.get(), viewed: viewed.get(), replies: replies.get(), resolved: resolved.get(), asked: asked.get(), started: started.get() }));
    },
  };
}

const read = kept<Marks>(() => disk.read ?? {});
const viewed = kept<Viewed>(() => disk.viewed ?? {});
const replies = kept<Replies>(() => disk.replies ?? {});
const resolved = kept<Readonly<Record<string, boolean>>>(() => disk.resolved ?? {});
// An answer still being read when the app quit never lands; it comes back as asked, without one.
export const asked = kept<Readonly<Record<string, readonly Asked[]>>>(() => disk.asked ?? {});
const started = kept<Readonly<Record<string, readonly PrThread[]>>>(() => disk.started ?? {});

export const marksKey = (pr: { repo: string; number: number; head: string }) => `${pr.repo}#${pr.number}@${pr.head}`;

const NONE: readonly never[] = [];

// One set per list, made once, so a screen reading the same marks again gets the same set and its memos hold.
const sets = new WeakMap<readonly unknown[], ReadonlySet<unknown>>();
function setOf<T>(list: readonly T[]): ReadonlySet<T> {
  let set = sets.get(list) as ReadonlySet<T> | undefined;
  if (!set) sets.set(list, (set = new Set(list)));
  return set;
}

/** The stops read, by index. */
export const useRead = (key: string): ReadonlySet<number> => setOf(read.use()[key] ?? NONE);

export function setRead(key: string, stop: number, on: boolean) {
  read.set((was) => {
    const next = new Set(was[key] ?? []);
    if (on) next.add(stop);
    else next.delete(stop);
    return { ...was, [key]: [...next].sort((a, b) => a - b) };
  });
}

/** What was viewed in Files, by part ("src/a.ts#0", the part its first hunk opens). */
export const useViewed = (key: string): ReadonlySet<string> => setOf(viewed.use()[key] ?? NONE);

export function setViewed(key: string, ids: readonly string[], on: boolean) {
  viewed.set((was) => {
    const next = new Set(was[key] ?? []);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return { ...was, [key]: [...next] };
  });
}

/** Your replies on review threads, by thread, oldest first: they land under the thread as the host would show them. */
export const useReplies = () => replies.use();

export function reply(thread: string, body: string) {
  replies.set((was) => ({ ...was, [thread]: [...(was[thread] ?? []), { body, at: Date.now() }] }));
}

/** The threads you resolved or opened again on this phone, by id, over what the host said. */
export const useResolved = () => resolved.use();

export function resolve(thread: string, on: boolean) {
  resolved.set((was) => ({ ...was, [thread]: on }));
}

/** What you asked about a pull request and what came back, oldest first. */
export const useAsked = (pr: string): readonly Asked[] => asked.use()[pr] ?? NONE;

/** The threads you started on a pull request's lines from this phone, as the host would list them. */
export const useStarted = (pr: string): readonly PrThread[] => started.use()[pr] ?? NONE;

export function startThread(pr: string, thread: PrThread) {
  started.set((was) => ({ ...was, [pr]: [...(was[pr] ?? []), thread] }));
}
