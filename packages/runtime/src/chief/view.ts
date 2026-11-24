// Smart View on the runtime (docs/): what each Chief has put in the person's right sidebar, one
// ChiefView per Chief, kept in the settings store so a relaunch still knows what is open and what the person closed.
// Every open goes through smartView.ts `admit` (the one place the rules live); each change is published whole
// (chief.view.updated) and the app shows it by `placement`. Writes take one lock, so two opens never race the rate.
import { admit, applyAdmission, closeEntry, type Admission, type OpenRequest } from "@caveman-app/session-protocol/smart-view";
import { SmartViewEntry, type ChiefView } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { SessionStore } from "../session-protocol/store.ts";

const key = (chiefId: string) => `chief.view:${chiefId}`;
const decodeEntries = Schema.decodeUnknownOption(Schema.Array(SmartViewEntry));
/** Runs a person's note started or steered into, kept per Chief: an open in one of them may say the person asked. */
const KEEP_NOTE_RUNS = 16;

export interface SmartViewDeps {
  readonly store: Pick<SessionStore["Service"], "kvGet" | "kvSet">;
  /** Settings chief_smart_view, default on. */
  readonly on: Effect.Effect<boolean>;
  readonly now?: () => number;
}

export const makeSmartView = (deps: SmartViewDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const changes = yield* PubSub.unbounded<ChiefView>();
    const now = deps.now ?? Date.now;
    /** When each Chief's unasked opens were admitted, newest last: the rate's memory (a relaunch forgets it, harmlessly). */
    const recent = new Map<string, Array<number>>();
    /** Per Chief, the runs a note from the person went into (Chief.ts deliver), each good for one asked open. */
    const noteRuns = new Map<string, Array<string>>();

    const entriesOf = (chiefId: string) =>
      deps.store.kvGet(key(chiefId)).pipe(
        Effect.map((raw): ReadonlyArray<SmartViewEntry> => {
          if (raw === undefined) return [];
          try {
            // Checked against the schema: a list written by another version is dropped, never trusted as is.
            return Option.getOrElse(decodeEntries(JSON.parse(raw)), () => []);
          } catch {
            return [];
          }
        }),
      );
    const get = (chiefId: string) =>
      Effect.all([deps.on, entriesOf(chiefId)]).pipe(Effect.map(([on, entries]): ChiefView => ({ chief_id: chiefId, on, entries: [...entries] })));
    const put = (chiefId: string, before: ReadonlyArray<SmartViewEntry>, after: ReadonlyArray<SmartViewEntry>) =>
      Effect.gen(function* () {
        if (after !== before) yield* deps.store.kvSet(key(chiefId), JSON.stringify(after));
        const view = yield* get(chiefId);
        if (after !== before) yield* PubSub.publish(changes, view);
        return view;
      });

    /** A note from the person went into this run (started it, or steered into it): one open in it may be asked. */
    const noteRun = (chiefId: string, runId: string) =>
      Effect.sync(() => noteRuns.set(chiefId, [...(noteRuns.get(chiefId) ?? []).filter((r) => r !== runId), runId].slice(-KEEP_NOTE_RUNS)));
    /** Whether `runId` may carry an asked open, and uses it up: once per note, never in a wake or a run of its own. */
    const takeAsk = (chiefId: string, runId: string) => {
      const runs = noteRuns.get(chiefId) ?? [];
      if (!runs.includes(runId)) return false;
      noteRuns.set(chiefId, runs.filter((r) => r !== runId));
      return true;
    };

    /**
     * A Chief's open, as the rules decide it; the decision says what happened, for the Chief. The model's `asked` is a
     * claim: it holds only in a run a note from the person went into, once (`noteRun`); otherwise the open is unasked.
     */
    const open = (chiefId: string, req: OpenRequest, runId: string): Effect.Effect<{ readonly admission: Admission; readonly askedIgnored: boolean }> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const view = yield* get(chiefId);
          const at = now();
          const times = recent.get(chiefId) ?? [];
          const asked = req.asked && view.on && takeAsk(chiefId, runId);
          const admission = admit(view, times, { ...req, asked }, at);
          if (admission.kind === "opened" && !asked) recent.set(chiefId, [...times, at].slice(-8));
          yield* put(chiefId, view.entries, applyAdmission(view.entries, admission));
          return { admission, askedIgnored: req.asked && !asked && view.on };
        }),
      );

    /** Closes one entry: the Chief's own call, or the person closing its tab. Unknown or closed ids change nothing. */
    const close = (chiefId: string, id: string, by: "person" | "chief") =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* entriesOf(chiefId);
          return yield* put(chiefId, before, closeEntry(before, id, by, now()));
        }),
      );

    /** Publishes these Chiefs' lists again: Smart View was turned on or off, and every window shows it. */
    const republish = (chiefIds: ReadonlyArray<string>) => Effect.forEach(chiefIds, (id) => get(id).pipe(Effect.flatMap((view) => PubSub.publish(changes, view))), { discard: true });

    return { get, open, close, noteRun, republish, changes };
  });

export type SmartView = Effect.Success<ReturnType<typeof makeSmartView>>;

/**
 * The Chief's Smart View section, after its own instructions (Chief.ts). Its own constant, so it caches with them and
 * edits to the rest of the Chief's prompt never touch it.
 */
export const SMART_VIEW_INSTRUCTIONS = `Smart View: view_open puts something in the person's sidebar, beside your chat. Use it sparingly, only when seeing it beats reading about it:
- a pull request ready for review: open its guide (kind pr) with the result you write;
- a chat they should look at themselves (one that needs them, or a result easier seen than told);
- a screenshot, clip or page a chat made or pointed to, when it shows the result (web for a running preview).
Never for progress, never twice for the same thing, at most one per result. Set asked only when their latest note asked to see it (it counts only in the turn that note started). The runtime keeps their sidebar theirs: it never moves what they are reading, never reopens what they closed, and holds back a burst; its answer says what happened, so never retry a no. When Smart View is off, say it in words. view_close tidies up what they never looked at (a replaced preview, a superseded PR); anything they have looked at stays until they close it.`;
