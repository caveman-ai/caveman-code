// The sidebar's fold of the agents a chat started (Sidebar.tsx Builders): shut by default behind its count line
// ("2 working · 1 needs you"), so a chat's agents never take over the sidebar. It opens when the person opens it, or by
// itself when one of its agents becomes the open chat, so the open chat's row shows. Past five live ones not even that
// opens it (job 4: thirty agents never take over the sidebar).

/** More live agents than this keep the fold shut until the person opens it, even with one of them on screen. */
export const MANY_LIVE = 5;

export interface FoldFacts {
  /** The person's own open or shut, held until they leave the lead and its agents; null when they made none. */
  readonly choice: boolean | null;
  readonly live: number;
  /** One of its agents is the open chat. */
  readonly viewingChild: boolean;
}

export const manyLive = (live: number): boolean => live > MANY_LIVE;

/** Whether one of its agents on screen opens the fold: not past five live, where nothing opens it but the person. */
export const opensForChild = (live: number, viewingChild: boolean): boolean =>
  viewingChild && !manyLive(live);

/**
 * Whether the fold stands open. The person's choice holds until they leave the lead and its agents; an agent coming on
 * screen sets it open (Sidebar.tsx Builders), so stepping back to the lead keeps the fold open.
 */
export function foldOpen({ choice, live, viewingChild }: FoldFacts): boolean {
  return choice ?? opensForChild(live, viewingChild);
}

/** The count line of a fold with many live agents: "12 agents · 9 working · 2 need you". */
export function manyLine(total: number, working: number, waiting: number): ReadonlyArray<string> {
  return [
    `${total} agents`,
    ...(working > 0 ? [`${working} working`] : []),
    ...(waiting > 0 ? [`${waiting} ${waiting === 1 ? "needs" : "need"} you`] : []),
  ];
}
