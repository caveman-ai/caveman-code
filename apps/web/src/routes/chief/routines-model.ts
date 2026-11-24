// The Routines section at the top of a Chief's List and Board (docs/chief.md "Routines"): the automations with a
// `chief` output that report to it, each joined with its last run as the board keeps it (ChiefBoard.routines). The automation is
// what the Automations page lists (its schedule, on or paused, running); the board says what its last run found.
import type { ChiefProfile, ChiefRoutine } from "@caveman-app/session-protocol";
import {
  ago,
  countsWord,
  fileRef,
  isDraft,
  problemsOf,
  triggerSummary,
  triggersOff,
  type Automation,
} from "../automations/model.ts";

export interface RoutineRow {
  readonly automation: Automation;
  readonly last: ChiefRoutine | undefined;
}

/**
 * The Chief's routines: those whose reports go to it (`routine.chief_id`, which the runtime resolves; a runtime from
 * before Chiefs stood apart from projects sends none, and its Chief's are its one project's), with the Me ones a chat
 * wrote in its worktree (Turn on adds one to the project); a Project draft stays out until it merges. Latest report
 * first, never run last.
 */
export function routineRows(
  automations: ReadonlyArray<Automation>,
  routines: ReadonlyArray<ChiefRoutine>,
  chief: Pick<ChiefProfile, "id" | "project_id"> | null | undefined,
): RoutineRow[] {
  if (!chief) return [];
  const last = new Map(routines.map((r) => [r.automation_id, r] as const));
  const theirs = (a: Automation) =>
    a.routine?.chief_id !== undefined
      ? a.routine.chief_id === chief.id
      : chief.project_id !== undefined && a.project_id === chief.project_id;
  return automations
    .filter(
      (a) => a.routine !== undefined && theirs(a) && (a.worktree === undefined || a.scope === "me"),
    )
    .map((automation) => ({ automation, last: last.get(projectIdOf(automation)) }))
    .sort(
      (a, b) =>
        (b.last?.ran_at ?? "").localeCompare(a.last?.ran_at ?? "") ||
        a.automation.title.localeCompare(b.automation.title),
    );
}

/** Its id in the project, which its runs carry: a draft's runs are its project's automation's. */
function projectIdOf(a: Automation): string {
  const ref = fileRef(a.id);
  return ref === null ? a.id : `file:${a.project_id}:${ref.scope}:${ref.name}`;
}

/** When it runs, in the Automations page's words ("Every 5 minutes, until Sun Nov 22"). */
export const whenWords = (a: Automation): string => triggerSummary(a.trigger);

/**
 * What its last run found, in one line: the first line of its report (a failure says so), and when; none yet. What
 * keeps it from running comes first: an error in its file, or a schedule that does not fire.
 */
export function foundWords(
  row: RoutineRow,
  now: number,
): { readonly text: string; readonly tone: "news" | "quiet" | "failed" | "off" | "none" } {
  const errors = problemsOf(row.automation).errors;
  if (errors > 0)
    return {
      text: `${countsWord({ errors, warnings: 0 })} in its file: Edit to fix it`,
      tone: "failed",
    };
  if (isDraft(row.automation))
    return { text: "A chat wrote it: Turn on adds it to this project", tone: "off" };
  const off = triggersOff(row.automation);
  if (off) return { text: off.reason, tone: "off" };
  const last = row.last;
  if (last === undefined) return { text: "Not run yet", tone: "none" };
  const first =
    last.summary
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  const when = ago(last.ran_at, now);
  if (last.status === "failed") return { text: `${first || "Failed"} · ${when}`, tone: "failed" };
  return {
    text: `${first || (last.decision === "news" ? "Found something" : "Nothing new")} · ${when}`,
    tone: last.decision === "news" ? "news" : "quiet",
  };
}
