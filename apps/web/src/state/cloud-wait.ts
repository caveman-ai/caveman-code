// A chat on its way to Cloud from a browser window: one the person started there (state/cloud.ts PendingStart), or one
// that moved there (PendingFollow). The window waits for its place to run, then goes there by itself. This is the wait
// the Cloud-hosted client's front door used to be; now it is one line in the app ("Waking Cloud… 8s", with Cancel).
// A start is a send, so its place is asked for again while it does not come up; a window that only looks wakes nothing.
import type { CloudComputerRow } from "@caveman-app/session-protocol";
import {
  awaitedStart,
  chosenRuntime,
  clearPendingFollow,
  confirmPendingStart,
  discardPendingStart,
  isLaptop,
  pendingFollow,
  seenLabel,
  startsByItself,
  type CloudRuntime,
  type PendingStart,
  type RuntimesAnswer,
} from "./cloud.ts";

export interface CloudWaitView {
  /** A chat the person started in Cloud waits for its place: since when (ms), for the line's seconds. */
  readonly waiting: { readonly computerId: string; readonly since: number } | null;
  /** A start that came in a link, its place running: it waits for the person's Start before this window goes there. */
  readonly linked: { readonly start: PendingStart; readonly runtime: CloudRuntime } | null;
  /** The place did not come up: Cloud's own reason, shown only to someone who asks. It is asked for again meanwhile. */
  readonly failed: string | null;
}

const IDLE: CloudWaitView = { waiting: null, linked: null, failed: null };

/** While a chat waits for its place, Cloud is read this often. */
export const WAIT_EVERY_MS = 3_000;
/** A place that did not come up is asked for again at most this often. */
export const ASK_AGAIN_MS = 30_000;

export const CLOUD_WAKING = "Waking Cloud";
export const CLOUD_FAILED_LINE = "Cloud couldn't start. Trying again.";

/** The runtime of `computerId` once it answers: what a chat on its way to Cloud waits for. */
export function readyRuntime(
  runtimes: ReadonlyArray<CloudRuntime>,
  computerId: string,
  now = Date.now(),
): CloudRuntime | undefined {
  return runtimes.find(
    (r) =>
      r.computer_id === computerId && !isLaptop(r) && seenLabel(r.last_seen_at, now) === "Online",
  );
}

/** Why a computer on its way is not up, in Cloud's own words; null while it is only on its way. */
export function notStarting(
  row: Pick<CloudComputerRow, "observed_state" | "observed_reason"> | undefined,
): string | null {
  if (row?.observed_state !== "failed") return null;
  return (row.observed_reason ?? "").trim() || "Cloud gave no reason.";
}

type Session = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface CloudWaitDeps {
  readonly session: Session;
  readonly local: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Cloud's list of the runtimes this person may reach (state/cloud.ts listRuntimes). */
  readonly runtimes: () => Promise<RuntimesAnswer>;
  /** Cloud's rows for the person's own computers, for one that failed to start; absent: never read. */
  readonly computers?: () => Promise<{ readonly computers: ReadonlyArray<CloudComputerRow> }>;
  /** Asks Cloud to run a computer (state/cloud.ts setComputer): a started chat's place that did not come up. */
  readonly run?: (computerId: string) => Promise<unknown>;
  /** Puts this window on a runtime (state/cloud.ts chooseRuntime). */
  readonly choose: (runtime: CloudRuntime) => void;
  readonly now?: () => number;
  readonly everyMs?: number;
}

const SINCE_KEY = "caveman.cloud.wait";

export class CloudWait {
  private view: CloudWaitView = IDLE;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private looking = false;
  private askedAt = Number.NEGATIVE_INFINITY;
  private readonly deps: CloudWaitDeps;

  constructor(deps: CloudWaitDeps) {
    this.deps = deps;
  }

  get = (): CloudWaitView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.look();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  /** Something changed what this window waits for (a start held, a runtime chosen or let go): look now. */
  kick = (): void => {
    if (!this.running) return;
    clearTimeout(this.timer);
    void this.look();
  };

  /** The person pressed Start on a link's chat: it runs on its place, where this window goes now. */
  confirm(): void {
    const linked = this.view.linked;
    if (!linked) return;
    confirmPendingStart(this.deps.session);
    this.set(IDLE);
    this.deps.choose(linked.runtime);
  }

  /** The person gave up a start (Cancel on the wait, Discard on a link's card). Answers what it would have sent, to keep. */
  discard(): PendingStart | null {
    const start = awaitedStart(this.deps.session);
    discardPendingStart(this.deps.session, this.deps.local);
    this.deps.session.removeItem(SINCE_KEY);
    this.set(IDLE);
    return start;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private set(next: CloudWaitView): void {
    const was = this.view;
    if (
      was.waiting?.computerId === next.waiting?.computerId &&
      was.waiting?.since === next.waiting?.since &&
      was.linked?.runtime.id === next.linked?.runtime.id &&
      was.failed === next.failed
    )
      return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }

  /** Since when this window has waited for `computerId`, kept for a reload. */
  private since(computerId: string): number {
    try {
      const kept = JSON.parse(this.deps.session.getItem(SINCE_KEY) ?? "null") as {
        computer_id?: unknown;
        since?: unknown;
      } | null;
      if (kept?.computer_id === computerId && typeof kept.since === "number") return kept.since;
    } catch {
      // Unreadable: the wait counts from now.
    }
    const since = this.now();
    this.deps.session.setItem(SINCE_KEY, JSON.stringify({ computer_id: computerId, since }));
    return since;
  }

  private async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      await this.once();
    } catch {
      // Cloud could not say: asked again at the next look.
    } finally {
      this.looking = false;
    }
    if (!this.running) return;
    clearTimeout(this.timer);
    if (this.view.waiting !== null || pendingFollow(this.deps.session) !== null)
      this.timer = setTimeout(() => void this.look(), this.deps.everyMs ?? WAIT_EVERY_MS);
  }

  private async once(): Promise<void> {
    const { session, local } = this.deps;
    const start = awaitedStart(session);
    const follow = pendingFollow(session);
    const here = chosenRuntime(local)?.computer_id;
    // On its computer already: the start runs there (shell/PendingCloudStart), the moved chat is open.
    const awaited =
      start && start.computer_id !== here
        ? start.computer_id
        : !start && follow && follow.computer_id !== here
          ? follow.computer_id
          : null;
    if (!start && follow && follow.computer_id === here) clearPendingFollow(session);
    if (awaited === null) {
      session.removeItem(SINCE_KEY);
      return this.set(IDLE);
    }
    // A moved chat shows where it is in its own pane; only a start says it waits.
    const waiting = start ? { computerId: awaited, since: this.since(awaited) } : null;
    if (waiting && this.view.waiting?.computerId !== awaited)
      this.set({ waiting, linked: null, failed: null });
    const answer = await this.deps.runtimes();
    if (!answer.signedIn) return;
    const ready = readyRuntime(answer.runtimes, awaited, this.now());
    // Read again: the person may have cancelled while Cloud answered.
    const still = awaitedStart(session);
    if (
      (start && still?.computer_id !== awaited) ||
      (!start && pendingFollow(session)?.computer_id !== awaited)
    )
      return this.set(IDLE);
    if (!ready) {
      const failed = start ? await this.whyNot(awaited) : null;
      return this.set({ waiting, linked: null, failed });
    }
    // Anyone can send a link: its chat starts, and this window goes to its computer, only on the person's Start.
    if (start && !startsByItself(start))
      return this.set({ waiting: null, linked: { start, runtime: ready }, failed: null });
    if (!start) clearPendingFollow(session);
    session.removeItem(SINCE_KEY);
    this.set(IDLE);
    this.deps.choose(ready);
  }

  /** Why the place is not up, when Cloud says it failed; it is asked for again, at most every ASK_AGAIN_MS. */
  private async whyNot(computerId: string): Promise<string | null> {
    if (!this.deps.computers) return null;
    const rows = await this.deps.computers().catch(() => null);
    const why = notStarting(rows?.computers.find((c) => c.id === computerId));
    if (why !== null && this.deps.run && this.now() - this.askedAt >= ASK_AGAIN_MS) {
      this.askedAt = this.now();
      void this.deps.run(computerId).catch(() => undefined);
    }
    return why;
  }
}
