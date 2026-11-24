// chat_wait's memory (docs/ §3 chat_wait): what changed in each chat since this
// process last said, fed by workspace.changed (the notification the sidebar runs on) and a workspace.list on every
// connect. A change is reported once: finished, failed, asking, answered by the person, PR opened.
import type { Workspace } from "@caveman-app/session-protocol";

import { stateOf, type ChatState } from "./render.ts";

export type ChangeKind = "finished" | "failed" | "asking" | "answered" | "pr";

export interface Change {
  readonly kind: ChangeKind;
  readonly chatId: string;
  /** For `pr`: the pull request's number. */
  readonly pr?: number;
}

/** What chat_wait reports a chat entering; `working` and the rest are not changes. */
const REPORTED: Partial<Record<ChatState, ChangeKind>> = {
  finished: "finished",
  failed: "failed",
  can_answer: "asking",
  needs_you: "asking",
};

interface Track {
  /** The state last seen; "sent" after this process acted on it, so whatever comes next is news. */
  state: ChatState | "sent" | undefined;
  /** The open ask last seen (kind and prompt), so a second question is a change of its own. */
  ask: string | undefined;
  pr: number | undefined;
  /** `updated_at` when this process acted: an older view of the chat is from before, not news. */
  actedAt: string | undefined;
  /** This process answered the open ask: its end is not "answered by the person". */
  answeredHere: boolean;
  pending: Array<Change>;
}

const askKey = (w: Workspace) => (w.status === "needs_input" ? `${w.activity?.ask?.kind ?? "?"}:${w.activity?.ask?.prompt ?? ""}` : undefined);

export class Tracker {
  private readonly tracks = new Map<string, Track>();
  private readonly latest = new Map<string, Workspace>();
  private readonly waiters = new Set<() => void>();
  /** The chats this process started, messaged or answered: chat_wait's default set. */
  readonly touched = new Set<string>();

  /** The chat as last seen. */
  get(id: string): Workspace | undefined {
    return this.latest.get(id);
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { state: undefined, ask: undefined, pr: undefined, actedAt: undefined, answeredHere: false, pending: [] };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** A view of a chat, from workspace.changed or a list. */
  observe(w: Workspace): void {
    const t = this.track(w.id);
    this.latest.set(w.id, w);
    const state = stateOf(w);
    const ask = askKey(w);
    const push = (change: Change) => {
      t.pending = t.pending.filter((c) => !(c.kind === change.kind && c.pr === change.pr));
      t.pending.push(change);
    };
    // A view from before this process acted (a notification already on its way) changes nothing.
    const stale = t.state === "sent" && t.actedAt !== undefined && Date.parse(w.updated_at) <= Date.parse(t.actedAt) && state !== "working";
    if (!stale && (state !== t.state || ask !== t.ask)) {
      const before = t.state;
      // An ask that ends with the turn going on was answered; by the person, unless this process answered it.
      if ((before === "can_answer" || before === "needs_you") && state === "working" && !t.answeredHere) push({ kind: "answered", chatId: w.id });
      if (before === "can_answer" || before === "needs_you") t.answeredHere = false;
      // The chat moved on: what it was before is old news.
      if (state === "working") t.pending = t.pending.filter((c) => c.kind === "answered" || c.kind === "pr");
      const kind = REPORTED[state];
      if (kind) push({ kind, chatId: w.id });
      t.state = state;
      t.ask = ask;
      t.actedAt = undefined;
    }
    const pr = w.pull_request?.number;
    if (pr !== undefined && pr !== t.pr) {
      push({ kind: "pr", chatId: w.id, pr });
      t.pr = pr;
    }
    if (t.pending.length) for (const wake of [...this.waiters]) wake();
  }

  /**
   * This process started, messaged or answered the chat: it joins the default set, what was pending for it is moot,
   * and whatever state it shows next is a change (an answer it gave is never "answered by the person").
   */
  acted(id: string, how: "started" | "messaged" | "answered"): void {
    this.touched.add(id);
    const t = this.track(id);
    t.pending = t.pending.filter((c) => c.kind === "pr");
    if (how === "answered") t.answeredHere = true;
    if (how !== "started") {
      t.actedAt = this.latest.get(id)?.updated_at;
      t.state = "sent";
      t.ask = undefined;
    }
  }

  /** Every change not yet reported for these chats, now marked reported. */
  take(ids: ReadonlySet<string>): Array<Change> {
    const out: Array<Change> = [];
    for (const id of ids) {
      const t = this.tracks.get(id);
      if (!t?.pending.length) continue;
      out.push(...t.pending);
      t.pending = [];
    }
    return out;
  }

  /**
   * The changes for these chats: at once if any are unreported, else the next ones (with `settleMs` for changes that
   * come together), or none when `timeoutMs` passes or `signal` aborts.
   */
  wait(ids: ReadonlySet<string>, timeoutMs: number, { settleMs = 150, signal }: { readonly settleMs?: number; readonly signal?: AbortSignal } = {}): Promise<Array<Change>> {
    const now = this.take(ids);
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      let settling: ReturnType<typeof setTimeout> | undefined;
      const finish = (aborted = false) => {
        clearTimeout(timer);
        clearTimeout(settling);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        // A cancelled call reports nothing, so what changed stays news for the next one.
        resolve(aborted ? [] : this.take(ids));
      };
      const abort = () => finish(true);
      const wake = () => {
        if (settling !== undefined) return;
        if (![...ids].some((id) => this.tracks.get(id)?.pending.length)) return;
        // A change the next view takes back (a chat that moved on within the settle) is no news: keep waiting.
        settling = setTimeout(() => {
          settling = undefined;
          if ([...ids].some((id) => this.tracks.get(id)?.pending.length)) finish();
        }, settleMs);
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      this.waiters.add(wake);
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
