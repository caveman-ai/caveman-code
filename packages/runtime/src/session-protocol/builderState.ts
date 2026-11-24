// What a person reads of the agents a chat started in chats of their own (Workspace.builder, a generated message's
// `shown`, their one result), from what builders.ts keeps: an agent's row, its merge and its engine's pause. Words
// from the one vocabulary: "agents", "plan", "GitHub"; never "builders", a computer's name, a ref, a worktree or a
// workspace id.
import type { BuilderState, BuildersResult } from "@caveman-app/session-protocol";

/** The plan that runs out under an engine, as a person names it. */
export const planName = (engine: string) =>
  engine === "claude-agent"
    ? "Claude plan"
    : engine === "codex"
      ? "ChatGPT plan"
      : engine === "caveman"
        ? "Caveman plan"
        : `${engine} plan`;

/** At most three files, then how many more. */
export const fewFiles = (files: ReadonlyArray<string>) =>
  files.length <= 3
    ? files.join(", ")
    : `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`;

/** Why a builder is left out, after "Left out: ". */
export const BRANCH_MISSING = "its branch did not arrive";
export const NOT_FINISHED = "it did not finish";
export const conflictsIn = (files: ReadonlyArray<string>) =>
  files.length === 0 ? "conflicts with the others' work" : `conflicts in ${fewFiles(files)}`;
/** A builder whose work is not in, by what its merge row says: conflicting files, or a branch that never came. */
export const leftOutWhy = (
  merge: { readonly sha: string | null; readonly files: ReadonlyArray<string> } | undefined,
) =>
  merge !== undefined && (merge.files.length > 0 || merge.sha !== null)
    ? conflictsIn(merge.files)
    : BRANCH_MISSING;

/**
 * The first sentence of the chat's note when nothing connected runs its agent ("Claude isn't connected for Cloud.",
 * modelConnections.ts noConnectionNote), as it stands in an engine's error. builderState.test.ts holds the two
 * together: a note reworded there and not here fails it.
 */
const NOT_CONNECTED =
  /(?:(?:Claude|ChatGPT) isn't connected|Your [^.]+? key isn't connected|This model has no key connected)(?: for Cloud)?\./;

/** Why a builder failed, in one sentence of ours, from how its last turn ended. */
export const failedWhy = (ended: {
  readonly status: string;
  readonly error?: string | undefined;
  readonly failure?: { readonly class: string } | undefined;
}) => {
  if (ended.status === "interrupted") return "It was stopped.";
  // The chat's own words when nothing connected runs its agent.
  const ours = NOT_CONNECTED.exec(ended.error ?? "")?.[0];
  if (ours !== undefined) return ours;
  switch (ended.failure?.class) {
    case "transport_error":
      return "It lost touch with its agent.";
    case "permission_error":
      return "Its agent was not allowed to go on.";
    case "usage_limit":
      return "Its plan is used up.";
    default:
      return "Its agent stopped with an error.";
  }
};

/** What became of one builder, for its row. */
export const builderStateOf = (
  row: { readonly state: string; readonly engine: string },
  merge:
    | { readonly state: string; readonly sha: string | null; readonly files: ReadonlyArray<string> }
    | undefined,
  pause: { readonly resets_at: string | null } | undefined,
  why: string | undefined,
): BuilderState => {
  switch (row.state) {
    case "paused":
      return {
        state: "paused",
        plan: planName(row.engine),
        ...(pause?.resets_at ? { until: pause.resets_at } : {}),
      };
    case "failed":
      return { state: "failed", why: why ?? "Its agent stopped with an error." };
    case "completed":
      return merge?.state === "merged"
        ? { state: "merged" }
        : merge?.state === "left_out"
          ? { state: "left_out", why: leftOutWhy(merge) }
          : { state: "done" };
    default:
      // Starting, at work, or sent back to fix a conflict.
      return { state: "working" };
  }
};

/** The line a lead's chat shows for a builder's result. */
export const resultShown = (title: string, status: string) =>
  `${title} ${status === "completed" ? "finished" : status === "interrupted" ? "stopped" : "failed"}`;
/** The line a builder's chat shows when its lead sends it back to fix a conflict. */
export const conflictShown = (files: ReadonlyArray<string>) =>
  files.length === 0
    ? "Fix conflicts with the others' work"
    : `Fix conflicts in ${fewFiles(files)}`;
/** The line a paused builder's chat shows when its plan has reset. */
export const RESUME_SHOWN = "Carry on";
/** The line a builder's chat shows for its lead's message: the first line of it. */
export const leadMailShown = (body: string) => {
  const line = body.trim().split("\n")[0]!.trim();
  return `From your lead: ${line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line}`;
};

/** The builders' one result as its row reads: "28 of 30 merged · 2 left out · PR #128". */
export const resultRow = (result: BuildersResult) =>
  [
    `${result.merged} of ${result.total} merged`,
    ...(result.left_out.length === 0 ? [] : [`${result.left_out.length} left out`]),
    result.pull_requests.length === 0
      ? "no pull request"
      : `PR ${result.pull_requests.map((pr) => `#${pr.number}`).join(", ")}`,
  ].join(" · ");

/** Why no pull request carries the builders' work. */
export const NOTHING_MERGED = "No agent's work merged, so there is no pull request.";
export const PULL_REQUEST_REFUSED = "GitHub didn't open the pull request.";

/** A pull request by its address: its number, and its repository ("owner/name") when the address names one. */
export const pullRequestOf = (url: string, number?: number) => {
  const found = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  const n = number ?? (found ? Number(found[2]) : Number(/\/(\d+)\/?$/.exec(url)?.[1] ?? 0));
  return { number: n, url, ...(found ? { repo: found[1]! } : {}) };
};
