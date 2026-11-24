// What the person can do to a piece of work from the Work tab's list, in one place for its hover buttons, its
// right-click menu and its keys (work.tsx): finish it (Mark done, Drop), move its pull request on (Merge, Re-run CI) or
// open what it made (its pull request, its chat). Pure, so the list and its tests read one answer.
import type { WorkspaceView } from "../../state/model.ts";
import { baseFixed, type Work } from "./work-model.ts";

export type WorkAction = "merge" | "rerun" | "openPr" | "openChat" | "done" | "drop";

/** Each action's name and key, in the order the row and its menu show them. Merge asks first, always (work.tsx MergeConfirm). */
export const WORK_ACTIONS: ReadonlyArray<{
  readonly id: WorkAction;
  readonly label: string;
  readonly key: string;
  readonly keyLabel: string;
}> = [
  { id: "merge", label: "Merge…", key: "m", keyLabel: "M" },
  { id: "rerun", label: "Re-run CI", key: "r", keyLabel: "R" },
  { id: "openPr", label: "Open pull request", key: "p", keyLabel: "P" },
  { id: "openChat", label: "Open chat", key: "o", keyLabel: "O" },
  { id: "done", label: "Mark done", key: "d", keyLabel: "D" },
  { id: "drop", label: "Drop", key: "Backspace", keyLabel: "⌫" },
];

/** The actions that can be done to it now. Merge only when its pull request is open and ready (green, or red only as its base). */
export function workActions(
  work: Pick<Work, "group" | "pr" | "chats" | "item">,
): ReadonlyArray<WorkAction> {
  const pr = work.pr;
  const open = pr !== undefined && (pr.state === "open" || pr.state === "draft");
  const finished = work.group === "done";
  const can: Record<WorkAction, boolean> = {
    merge: open && pr.state === "open" && work.group === "ready",
    rerun: open && pr.checks === "failing",
    openPr: pr !== undefined,
    openChat: work.chats.length > 0,
    done: !finished,
    drop: !finished,
  };
  return WORK_ACTIONS.filter((a) => can[a.id]).map((a) => a.id);
}

/** The action a key does, if any. Only bare keys: a key with ⌘, Ctrl or Alt belongs to the app. */
export function actionOfKey(
  key: string,
  mods: { readonly meta: boolean; readonly ctrl: boolean; readonly alt: boolean },
): WorkAction | undefined {
  if (mods.meta || mods.ctrl || mods.alt) return undefined;
  const k = key === "Delete" ? "Backspace" : key.length === 1 ? key.toLowerCase() : key;
  return WORK_ACTIONS.find((a) => a.key === k)?.id;
}

/** The chat a piece of work opens: one waiting on the person first, then one running, then its newest. */
export function chatToOpen(chats: ReadonlyArray<WorkspaceView>): WorkspaceView | undefined {
  return (
    chats.find((c) => c.state === "needs_input" || c.state === "failed") ??
    chats.find((c) => c.state === "working") ??
    chats.at(-1)
  );
}

/** The project a piece of work's pull request belongs to: its chat's, else the item's first. */
export function workProject(work: Pick<Work, "chats" | "item">): string | undefined {
  return (
    work.chats.find((c) => c.pullRequest && c.projectId)?.projectId ??
    work.chats.find((c) => c.projectId)?.projectId ??
    work.item.project_ids[0]
  );
}

/**
 * The work whose pull request failed only on its base's failures, and whose base is green again: one click re-runs
 * them all (each brings the base's fix in, since a plain re-run replays the old merge commit).
 */
export function blockedByFixedBase(works: ReadonlyArray<Work>): ReadonlyArray<Work> {
  return works.filter(
    (w) =>
      w.group !== "done" &&
      w.pr !== undefined &&
      (w.pr.state === "open" || w.pr.state === "draft") &&
      baseFixed(w.pr),
  );
}
