// A Cloud computer sleeps when it is idle (Caveman Cloud the spec) and wakes for what a workspace on it asked:
// PUT /code/runtime/workspaces/<id>/wake-at (code_workspaces.wake_at). Hosted automation runs ask for their own timers
// (automations/cloudHost.ts). This asks for the computer's schedules: the earliest next run of its scheduled tasks
// (an agent's wake-ups among them) and of its automation files' schedule triggers. Without it, what an agent on a Cloud
// computer scheduled never ran while the computer slept.
//
// Any active Cloud workspace on this computer wakes the whole computer, so one carries the time, the first that takes
// it. Cloud spends a wake time once it is due (wakeDue), so each new earliest is said again, and a time already due
// is not said at all: the runtime that would be woken for it is awake and running it.
import * as Effect from "effect/Effect";

export interface ScheduleWakeDeps {
  /** The earliest next run here (epoch ms) of anything scheduled to run on this computer, or none. */
  readonly next: Effect.Effect<number | undefined>;
  /** Cloud's ids for workspaces on this computer, the one to prefer first. */
  readonly workspaces: Effect.Effect<ReadonlyArray<string>>;
  /** PUT wake-at on one workspace: an ISO time, or null to clear it. */
  readonly put: (workspaceId: string, at: string | null) => Effect.Effect<void, unknown>;
  readonly now?: () => number;
}

/** One pass: says the earliest next run to Cloud when it changed. Keep the returned function and call it on each change. */
export const makeScheduleWake = (deps: ScheduleWakeDeps) => {
  const now = deps.now ?? Date.now;
  /** What Cloud was last told, and on which workspace. */
  let told: { readonly workspace: string; readonly at: string | null } | undefined;
  return Effect.gen(function* () {
    const next = yield* deps.next;
    const at = next === undefined || next <= now() ? null : new Date(next).toISOString();
    if (told !== undefined && told.at === at) return;
    if (told === undefined && at === null) return;
    const candidates = yield* deps.workspaces;
    // The workspace that holds the time keeps it, so a move never leaves a stale time behind on another.
    const order =
      told === undefined
        ? candidates
        : [told.workspace, ...candidates.filter((id) => id !== told!.workspace)];
    for (const workspace of order) {
      const put = yield* deps.put(workspace, at).pipe(Effect.result);
      if (put._tag === "Failure") continue;
      if (told !== undefined && told.workspace !== workspace && told.at !== null)
        yield* deps.put(told.workspace, null).pipe(Effect.ignore);
      told = { workspace, at };
      return;
    }
    if (at !== null)
      yield* Effect.logWarning(
        "schedules: no workspace on this computer took its next wake time; it will not wake for it while asleep",
      );
  });
};
