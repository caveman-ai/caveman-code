// What the phone holds of the person's pull requests, read from Cloud's Review routes on their own sign-in
// (live/cloud.ts, CONTRACT §12): the list the Needs you screen draws, and each pull request that was opened, with its
// discussion and, once a file is opened, its patches. Nothing here polls: the list is read when its screen asks, a
// pull request when it is opened and again after every change, so GitHub's word on it is what shows.
//
// A read that fails for a moment (no network, Cloud busy) is tried again by itself before anything is said. A change
// is sent once: an approval, a comment or a merge that may have reached GitHub is never sent twice, so one that fails
// says why and leaves what the person typed with them (the screen keeps it). Cloud and where the toast goes are
// handed in, so this runs the same in the app and in Node's tests.
import type { PrDetail, PrDiscussionItem } from "@caveman-app/session-protocol";

import type { PhoneCloud, PullDiff } from "../live/cloud";
import { createStore, type Store } from "../store/core";
import { canMerge, connectUrl, type Listed, type ListState, mergeMethod, pullKey } from "./model";
import { type Change, DONE, notConnected, passes, refusedWords, unreadWords } from "./words";

/** One line about what could not be read or done, with where GitHub connects when that is what is missing. */
export interface Said {
  readonly words: string;
  readonly connect?: string;
}

/** One pull request as the phone holds it. */
export interface PullState {
  readonly detail: PrDetail | null;
  /** Its comments, reviews and line threads, oldest first; null until read. */
  readonly discussion: ReadonlyArray<PrDiscussionItem> | null;
  /** Its files' patches; null until a file was opened. */
  readonly diff: PullDiff | null;
  readonly reading: boolean;
  readonly readingDiff: boolean;
  /** Why it could not be read, while there is nothing of it to show. */
  readonly problem: Said | null;
  readonly discussionProblem: string | null;
  readonly diffProblem: string | null;
  /** A change on its way to GitHub, and since when. */
  readonly busy: { readonly change: Change; readonly since: number } | null;
  /** Why the last change was refused, until the next one is sent. */
  readonly refused: (Said & { readonly change: Change }) | null;
}

export const NO_PULL: PullState = {
  detail: null,
  discussion: null,
  diff: null,
  reading: false,
  readingDiff: false,
  problem: null,
  discussionProblem: null,
  diffProblem: null,
  busy: null,
  refused: null,
};

export interface PullsState extends ListState {
  /** Whose these are, by their account's email: another sign-in starts from nothing. */
  readonly person: string | null;
  readonly pulls: Readonly<Record<string, PullState>>;
}

const fresh = (person: string | null): PullsState => ({
  person,
  list: null,
  reading: false,
  problem: null,
  pulls: {},
});

type Cloud = Pick<
  PhoneCloud,
  | "url"
  | "reviews"
  | "pull"
  | "pullDiff"
  | "pullDiscussion"
  | "reviewPull"
  | "commentOnPull"
  | "mergePull"
>;

export interface PullsDeps {
  readonly cloud: () => Promise<Cloud>;
  /** What happened, for the app's toast ("Approved", "Merged"). */
  readonly say: (text: string) => void;
  readonly now?: () => number;
  /** How long a read waits before each further try; none for a test that wants the first answer. */
  readonly retryMs?: ReadonlyArray<number>;
}

export interface Pulls {
  readonly store: Store<PullsState, (state: PullsState) => PullsState>;
  /** Reads the open pull requests GitHub shows `person`. What was read before stays until the answer is in. */
  readList(person: string): Promise<void>;
  /** Reads a pull request and its discussion: as its screen opens, and again whenever asked. */
  open(person: string, repo: string, number: number): Promise<void>;
  /** Reads its files' patches, once per head: the first time a file is opened. */
  readDiff(repo: string, number: number): Promise<void>;
  /** Each change answers whether GitHub has it. Refused, its reason is in the pull request's `refused`. */
  approve(repo: string, number: number): Promise<boolean>;
  requestChanges(repo: string, number: number, body: string): Promise<boolean>;
  comment(repo: string, number: number, body: string): Promise<boolean>;
  merge(repo: string, number: number): Promise<boolean>;
}

export function createPulls(deps: PullsDeps): Pulls {
  const store = createStore<PullsState, (state: PullsState) => PullsState>(
    fresh(null),
    (state, change) => change(state),
  );
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? [800, 2500];
  const set = (patch: Partial<PullsState>) => store.dispatch((state) => ({ ...state, ...patch }));
  const pullOf = (key: string): PullState => store.get().pulls[key] ?? NO_PULL;
  const patch = (key: string, next: Partial<PullState>) =>
    store.dispatch((state) => ({
      ...state,
      pulls: { ...state.pulls, [key]: { ...(state.pulls[key] ?? NO_PULL), ...next } },
    }));
  /** Another person signed in: nothing of the last one's is left to show. */
  const own = (person: string) => {
    if (store.get().person !== person) store.replace(fresh(person));
  };

  /** A read, tried again by itself while what failed passes by itself. */
  const read = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let tries = 0; ; tries++) {
      try {
        return await run();
      } catch (error) {
        const wait = retryMs[tries];
        if (wait === undefined || !passes(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  /** Where GitHub connects, as the refusal that asks for it says (its `details.connect_url`). */
  const connectOf = (error: unknown, cloudUrl: string): string =>
    connectUrl(
      (error as { details?: { connect_url?: unknown } } | null)?.details?.connect_url,
      cloudUrl,
    );
  const said = (words: string, error: unknown, cloudUrl: string | undefined): Said => ({
    words,
    ...(notConnected(error) && cloudUrl ? { connect: connectOf(error, cloudUrl) } : {}),
  });

  let listing: { readonly person: string; readonly done: Promise<void> } | null = null;
  const readList = (person: string): Promise<void> => {
    own(person);
    if (listing?.person === person) return listing.done;
    set({ reading: true });
    const done = (async () => {
      let from: Cloud | undefined;
      try {
        from = await deps.cloud();
        const cloud = from;
        const answer = await read(() => cloud.reviews());
        if (store.get().person !== person) return;
        const list: Listed | null = answer
          ? {
              prs: answer.prs,
              errors: answer.errors,
              connect:
                answer.github === "not_connected"
                  ? connectUrl(answer.connect_url, cloud.url)
                  : null,
            }
          : null;
        set({ list, reading: false, problem: null });
      } catch (error) {
        if (store.get().person !== person) return;
        // No link for any repository can come as a refusal too: the same one thing to do.
        if (notConnected(error) && from)
          return set({
            list: { prs: [], errors: [], connect: connectOf(error, from.url) },
            reading: false,
            problem: null,
          });
        // What was read before stays on screen; with nothing to show, the list says why.
        set({ reading: false, problem: unreadWords(error, "list") });
      }
    })().finally(() => {
      if (listing?.done === done) listing = null;
    });
    listing = { person, done };
    return done;
  };

  const opening = new Map<string, Promise<void>>();
  const open = (person: string, repo: string, number: number): Promise<void> => {
    own(person);
    const key = pullKey(repo, number);
    const under = opening.get(key);
    if (under) return under;
    patch(key, { reading: true });
    const done = (async () => {
      let from: Cloud | undefined;
      try {
        from = await deps.cloud();
      } catch (error) {
        if (store.get().person === person)
          patch(key, {
            reading: false,
            problem: pullOf(key).detail ? null : said(unreadWords(error, "pull"), error, undefined),
          });
        return;
      }
      const cloud = from;
      const [detail, discussion] = await Promise.allSettled([
        read(() => cloud.pull(repo, number)),
        read(() => cloud.pullDiscussion(repo, number)),
      ]);
      if (store.get().person !== person) return;
      const was = pullOf(key);
      if (detail.status === "rejected") {
        // What was read before stays; with nothing to show, the screen says why.
        patch(key, {
          reading: false,
          problem: was.detail
            ? null
            : said(unreadWords(detail.reason, "pull"), detail.reason, cloud.url),
        });
        return;
      }
      // Its head moved: the patches read before are another commit's.
      const moved = was.diff !== null && was.detail?.head_sha !== detail.value.head_sha;
      patch(key, {
        detail: detail.value,
        reading: false,
        problem: null,
        ...(discussion.status === "fulfilled"
          ? { discussion: discussion.value, discussionProblem: null }
          : {
              discussionProblem: was.discussion
                ? null
                : unreadWords(discussion.reason, "discussion"),
            }),
        ...(moved ? { diff: null, diffProblem: null } : {}),
      });
    })().finally(() => opening.delete(key));
    opening.set(key, done);
    return done;
  };

  const readDiff = async (repo: string, number: number): Promise<void> => {
    const key = pullKey(repo, number);
    const person = store.get().person;
    if (pullOf(key).diff || pullOf(key).readingDiff) return;
    patch(key, { readingDiff: true, diffProblem: null });
    try {
      const from = await deps.cloud();
      const diff = await read(() => from.pullDiff(repo, number));
      if (store.get().person === person) patch(key, { diff, readingDiff: false });
    } catch (error) {
      if (store.get().person === person)
        patch(key, { readingDiff: false, diffProblem: unreadWords(error, "patch") });
    }
  };

  /**
   * One change, sent once. While it is on its way the pull request is busy, so nothing else can be sent beside it;
   * once GitHub has it the pull request is read again, and only then does the toast say what happened.
   */
  const change = async (
    repo: string,
    number: number,
    what: Change,
    send: (cloud: Cloud) => Promise<void>,
    after?: (detail: PrDetail) => PrDetail,
  ): Promise<boolean> => {
    const key = pullKey(repo, number);
    const person = store.get().person;
    if (person === null || pullOf(key).busy) return false;
    patch(key, { busy: { change: what, since: now() }, refused: null });
    let from: Cloud | undefined;
    try {
      from = await deps.cloud();
      await send(from);
    } catch (error) {
      if (store.get().person === person)
        patch(key, {
          busy: null,
          refused: { change: what, ...said(refusedWords(error, what), error, from?.url) },
        });
      return false;
    }
    if (store.get().person !== person) return true;
    // What is known at once, should the read after it fail: a merged pull request offers no merge.
    const held = pullOf(key).detail;
    if (after && held) patch(key, { detail: after(held) });
    // A read already under way began before the change: it is let finish, and the pull request is read after it.
    await opening.get(key);
    await open(person, repo, number);
    if (store.get().person === person) patch(key, { busy: null });
    deps.say(DONE[what]);
    return true;
  };

  return {
    store,
    readList,
    open,
    readDiff,
    approve: (repo, number) =>
      change(repo, number, "approve", (cloud) =>
        cloud.reviewPull(repo, number, { verdict: "approve" }),
      ),
    requestChanges: async (repo, number, body) => {
      const words = body.trim();
      // GitHub takes no request for changes without what should change.
      return words === ""
        ? false
        : change(repo, number, "changes", (cloud) =>
            cloud.reviewPull(repo, number, { verdict: "request_changes", body: words }),
          );
    },
    comment: async (repo, number, body) => {
      const words = body.trim();
      return words === ""
        ? false
        : change(repo, number, "comment", (cloud) =>
            cloud.commentOnPull(repo, number, { body: words }),
          );
    },
    merge: async (repo, number) => {
      const detail = pullOf(pullKey(repo, number)).detail;
      if (!detail || !canMerge(detail)) return false;
      // With the head it was read at, GitHub refuses a merge of commits the person has not seen.
      const merge = {
        method: mergeMethod(detail),
        ...(detail.head_sha ? { head_sha: detail.head_sha } : {}),
      };
      return change(
        repo,
        number,
        "merge",
        (cloud) => cloud.mergePull(repo, number, merge),
        (was) => ({ ...was, state: "merged", can: { ...was.can, merge: false, review: false } }),
      );
    },
  };
}
