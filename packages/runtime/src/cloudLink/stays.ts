// Whether a chat can run somewhere else than where it is, as its summary tells Caveman Cloud and Cloud tells every
// device (CONTRACT §11): `movable`, and when it is not, `stays: { code }`. A code, never a sentence: each client words
// the codes it knows, so a phone and a browser say the same thing without asking the chat's Mac, and no device draws a
// control Cloud would refuse.
//
// The codes are the ones the lid's plan gives each reason (preflight.ts), with two for what a chat works in (a folder,
// several repositories), which the move's own check refuses before it reads anything else. Cloud keeps any code of
// STAYS_CODE_FORM, so a new reason needs no Cloud release; it adds its own for what only it knows (CLOUD_STAYS).
// What a runtime says opens nothing: Cloud's checks decide a move.

/** A code as Cloud takes one (its place_facts.go staysCodeForm). */
export const STAYS_CODE_FORM = /^[a-z][a-z0-9_]{0,39}$/;

/** Every code a runtime sends, and what it stands for. */
export const STAYS = {
  /** Its agent's chats stay where they started (not Caveman, Claude Agent or Codex). */
  agent: "agent",
  /** It works in a folder itself, with no branch of its own to carry. */
  folder: "folder",
  /** It works in several repositories, which no move carries yet. */
  several_repositories: "several_repositories",
  /** The Chief, setup chats and delegated agents (a chat's agents in chats of their own among them) stay where they are. */
  kind: "kind",
  /** Its project is not on GitHub. */
  not_on_github: "not_on_github",
  /** Its Mac is not signed in to Caveman. */
  not_signed_in: "not_signed_in",
  /** Its person has not chosen what the Mac's chats do when it sleeps, so nothing is saved to Caveman. */
  not_chosen: "not_chosen",
  /** Its person chose that chats pause: nothing is saved to Caveman. */
  lid_off: "lid_off",
  /** This Caveman runs no Cloud. */
  cloud_off: "cloud_off",
  /** Caveman chats cannot run in Cloud here. */
  caveman_not_on_cloud: "caveman_not_on_cloud",
  /** The plan is used up and there are no credits. */
  unpaid: "unpaid",
  /** No plan or key is connected for its agent in Cloud. */
  no_plan: "no_plan",
  /** Not saved to Caveman yet. */
  not_saved: "not_saved",
  /** Its last save is not reaching Caveman. */
  save_failing: "save_failing",
  /** Its uncommitted changes were not saved. */
  changes_not_saved: "changes_not_saved",
  /** Its uncommitted changes are too big to move. */
  too_big: "too_big",
  /** It has too many large uncommitted files to move. */
  too_many_files: "too_many_files",
  /** It stays, and nothing here says why in a word Cloud's list knows. */
  other: "other",
} as const;
export type StaysCode = (typeof STAYS)[keyof typeof STAYS];

/**
 * The codes Cloud gives by itself, on a chat (`stays.code`) or on a queued message that waits because its chat cannot
 * move (`waiting.code`): what only Cloud's rows know.
 */
export const CLOUD_STAYS = {
  /** Cloud could not confirm the chat's person may read its repository. */
  repo_unverified: "repo_unverified",
  /** Every Cloud computer the person may run is awake and working. */
  cloud_full: "cloud_full",
} as const;

/** What a summary says of where its chat can run. */
export type ChatPlace =
  | { readonly movable: true }
  | { readonly movable: false; readonly stays: { readonly code: string } };

/** What `placeOf` reads: the chat's own nature, and on a Mac what the lid's plan says with the lid's own two switches on. */
export interface PlaceFacts {
  /** Caveman, Claude Agent or Codex: the agents whose chats move. */
  readonly agentMoves: boolean;
  /** It runs in its project's folder itself. */
  readonly folder: boolean;
  /** It works in more than one repository. */
  readonly several: boolean;
  /** A top-level chat: not the Chief, a setup chat, a builder or a delegated agent. */
  readonly topLevel: boolean;
  /**
   * On a Mac: the lid's plan for the chat (lidPlan), read as "could it run in Cloud at all": with the lid's own
   * settings (move when the lid closes, Claude Agent and Codex chats too) taken as on, since a person's own move
   * goes whatever they are. `code`: the reason's code, where the plan gives one. Absent on a Cloud computer, whose
   * chats go back to a Mac on that Mac's word.
   */
  readonly plan?:
    | {
        readonly outcome: "continues" | "continues_with_gaps" | "pauses" | "stays";
        readonly code?: string | undefined;
      }
    | undefined;
}

const stays = (code: string): ChatPlace => ({ movable: false, stays: { code } });

/**
 * Whether the chat can run somewhere else, and the code of why not. The order is the move's own (handlers
 * moveRefusal): its agent, what it works in, its kind, then everything the plan reads.
 */
export function placeOf(facts: PlaceFacts): ChatPlace {
  if (!facts.agentMoves) return stays(STAYS.agent);
  if (facts.folder) return stays(STAYS.folder);
  if (facts.several) return stays(STAYS.several_repositories);
  if (!facts.topLevel) return stays(STAYS.kind);
  const plan = facts.plan;
  if (plan === undefined || plan.outcome === "continues" || plan.outcome === "continues_with_gaps")
    return { movable: true };
  return stays(
    plan.code !== undefined && STAYS_CODE_FORM.test(plan.code) ? plan.code : STAYS.other,
  );
}
