// The Changes tab's scope: everything the chat changed (fs.diff against the base), or one finished turn, from the
// checkpoint taken as it began to the turn's own (upstream "Latest turn" / "Turn N", DiffPanel.tsx). For a turn the
// runtime leaves out what a pull, rebase or merge in it brought in, so the tab lists what the turn's card lists.

export type TurnCheckpoints = ReadonlyArray<{ readonly id: string; readonly own: boolean }>;

export interface TurnScope {
  /** 1-based, in the order the chat's turns finished. */
  readonly turn: number;
  /**
   * The turn before's checkpoint (the one this turn began at); absent for the chat's first turn, which the runtime
   * then diffs from the checkpoint taken as it began (fs.diff with `to` alone).
   */
  readonly from?: string;
  readonly to: string;
  readonly latest: boolean;
}

/**
 * The fs.diff range for the turn that ended at `checkpoint`; null when this chat can't read it: an unknown id, a
 * fork's copied turn, or a fork's first own turn (it started from the source chat's checkpoint).
 */
export function turnScope(checkpoints: TurnCheckpoints, checkpoint: string): TurnScope | null {
  const at = checkpoints.findIndex((c) => c.id === checkpoint);
  if (at < 0 || !checkpoints[at]!.own) return null;
  const before = checkpoints[at - 1];
  if (before && !before.own) return null;
  return { turn: at + 1, ...(before ? { from: before.id } : {}), to: checkpoint, latest: at === checkpoints.length - 1 };
}

/** The turns the scope menu offers, newest first. */
export function turnScopes(checkpoints: TurnCheckpoints): ReadonlyArray<TurnScope> {
  return checkpoints.flatMap((c) => turnScope(checkpoints, c.id) ?? []).reverse();
}

export const scopeLabel = (scope: TurnScope | null): string => (scope === null ? "All changes" : scope.latest ? "Latest turn" : `Turn ${scope.turn}`);
