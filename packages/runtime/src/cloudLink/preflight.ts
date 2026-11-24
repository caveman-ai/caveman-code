// The lid's preflight (agent-continuity.md §7.11, AC-12): what closing the lid would do to a chat on This Mac, said
// before it happens. Pure: the runtime reads the facts once (handlers' cloud.lid.summary, Cloud's holdings cached,
// never a Cloud call per chat). The rules are the lid's own checks (handlers moveCheck), what a chat is before how
// this Mac is set, in their words, so the summary says what the lid then does (sync.lid.integration holds them together).
import type { Result } from "@caveman-app/session-protocol";

import { ENGINE_LABEL, isNativeEngine } from "./moveEngines.ts";

/** session.move.check's preflight.context, as the protocol has it. */
type MoveContext = NonNullable<NonNullable<Result<"session.move.check">["preflight"]>["context"]>;

/** What the lid does to a chat: it continues on a Cloud computer (with gaps), pauses here with a fix, or stays here by its nature. */
export type LidOutcome = "continues" | "continues_with_gaps" | "pauses" | "stays";

/** The chat's own kind, as the lid's checks read it: only a top-level chat moves (handlers followable). */
export type ChatKind = "chat" | "chief" | "setup" | "builder" | "delegated";

/** What one chat's preflight is read from: This Mac's settings and copy state, and Cloud's holdings as last fetched. */
export interface LidFacts {
  readonly engine: string;
  readonly kind: ChatKind;
  /** Signed in to Caveman (Settings, Remote control). */
  readonly signedIn: boolean;
  /** Moves follow sync (S12): on, off, or not answered yet. */
  readonly moves: "on" | "off" | "ask";
  /** Settings, Computers: the lid moves chats (move_to_cloud), and Claude Agent and Codex chats too (move_other_engines). */
  readonly moveToCloud: boolean;
  readonly moveOtherEngines: boolean;
  readonly gitHubRepo: boolean;
  readonly cloudComputers: boolean;
  /**
   * Cloud computers here run Caveman chats (Cloud's `caveman_on_computers`): something carries the person's Caveman
   * credentials to them, their Caveman credits and plan (a short-lived key Cloud mints each computer, computerCredits.ts),
   * or in a lab a key each computer gets. False whenever Cloud does not say so.
   */
  readonly cavemanOnCloud: boolean;
  /**
   * Where those chats pay from the person's credits, whether anything can pay for them now (Cloud's `caveman_paid`: a
   * plan with room, or credits it spends). Undefined when Cloud does not say (a lab, an older Cloud): it runs them.
   */
  readonly cavemanPaid?: boolean | undefined;
  /** A Cloud login for a Claude Agent or Codex chat (moves hasCloudLogin); undefined when Cloud could not be asked. */
  readonly cloudLogin: boolean | undefined;
  /** The chat's copy in Cloud: caught up, owed (the lid's last copy carries it), failing to land, or none yet. */
  readonly copy: "current" | "behind" | "failing" | "none";
  /** Why the copy fails to land, when it does. */
  readonly copyError?: string;
  /** Its uncommitted changes did not fit its last copy (copySegments wip_dropped), and how big they were. */
  readonly wipDropped: boolean;
  readonly wipBytes?: number;
  /** Why they did not: Cloud took no more chunks of its copy (AC-08), which holds as many large files as a chat's may. */
  readonly copyFull?: boolean;
  /** Why they did not: their snapshot failed (what git said); the copy is made again by itself. */
  readonly wipFailed?: string;
  /** A Claude Agent or Codex chat whose own session file no longer travels (too big): it continues from its transcript. */
  readonly nativeOff: boolean;
  /** The secret-shaped files git does not ignore that its copy left on this Mac (decision 24), as its last copy found them. */
  readonly left?: ReadonlyArray<string>;
}

export interface LidPlan {
  readonly outcome: LidOutcome;
  /** Why, in one sentence: what the chat's note says when the lid pauses it. */
  readonly reason: string;
  /** What makes it continue next time; every chat that does not continue has one. */
  readonly fix?: string;
  /**
   * What this chat that continues leaves behind, in short sentences. What every move leaves (servers and terminals
   * stop, files git ignores stay here) is said once where the summary is shown, never per chat.
   */
  readonly gaps: ReadonlyArray<string>;
}

/** Bytes as whole MiB for people (at least 1). */
export const mib = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

const wipSize = (bytes: number | undefined) => (bytes === undefined ? "more than a move carries" : `${mib(bytes)} MiB, more than a move carries`);
/** Why a move cannot carry a chat's work in progress (F-5): it would land on older files, so it never goes. */
export const wipTooBigReason = (bytes: number | undefined) => `Its uncommitted changes are ${wipSize(bytes)}`;
export const WIP_TOO_BIG_FIX = "Commit and push the large files, or keep it on this Mac.";
/** What the lid's pause and a refused move say: a chat's move never lands on older files than it had (F-5). */
export const wipTooBig = (bytes: number | undefined) => `its uncommitted changes are ${wipSize(bytes)}; commit and push the large files, or keep it on this Mac`;
/**
 * Why, when Cloud took no more chunks of the chat's copy (AC-08): it holds as many large files as a chat's copy may
 * (chunks of work in progress a later turn replaced count until the copy is purged).
 */
export const COPY_FULL_REASON = "Its copy with Caveman holds as many large files as one chat's copy may";
export const COPY_FULL = `its copy with Caveman holds as many large files as one chat's copy may; commit and push the large files, or keep it on this Mac`;

/** Why, when the boundary's snapshot of its work in progress failed (`detail`, what git said). */
export const wipNotCarried = (detail: string) => `Its uncommitted changes didn't go into its copy: ${detail.replace(/\.$/, "")}`;
export const WIP_NOT_CARRIED_FIX = "It tries again by itself, within a minute at most; until a copy carries them, it stays on this Mac.";

/** A Claude Agent or Codex chat with no Cloud login for its engine (handlers LOGIN_FIX opens with this). */
export const noCloudLogin = (engine: "claude-agent" | "codex") => `${ENGINE_LABEL[engine]} needs a login on Cloud computers`;

/**
 * A Caveman chat where Cloud computers cannot run Caveman chats (`cavemanOnCloud`): no Caveman credits or key reach a
 * Cloud computer here, so its first turn there would fail. It stays where it is; Cloud refuses it the same.
 */
export const CAVEMAN_NOT_ON_CLOUD = "Caveman chats don't move to Cloud computers yet: your Caveman credits don't reach them";
export const CAVEMAN_NOT_ON_CLOUD_FIX = "It stays on this Mac and goes on when the Mac is awake: keep the lid open while it works.";
/**
 * A Caveman chat whose person's plan and credits could not pay for its turns on a Cloud computer now (`cavemanPaid`
 * false): it would fail there, so it stays where it is, and Cloud refuses it the same (cave_code_caveman_unpaid). Only
 * whether something pays, never what it costs.
 */
export const CAVEMAN_UNPAID = "Caveman chats on Cloud computers run on your Caveman plan or credits, and neither can pay now";
export const CAVEMAN_UNPAID_FIX = "Choose a plan or add credits (Settings, Plan), or keep the lid open while it works.";

/** A chat that has not copied itself to Cloud to move from (registered to follow), so nothing can continue it there yet. */
export const NOT_COPIED = "It hasn't copied itself to Caveman yet";

export const GAP_TRANSCRIPT = "continues from its transcript";
/** The gap a chat's secret-shaped files make (decision 24): they stay on this Mac, named, a few at most. */
export const gapLeft = (left: ReadonlyArray<string>) =>
  `leaves ${left.length <= 3 ? left.join(", ") : `${left.slice(0, 3).join(", ")} and ${left.length - 3} more`} on this Mac`;

/** The lid's plan for one chat: what it is (engine, kind, repository), then this Mac's settings, Cloud's, and its copy. */
export function lidPlan(facts: LidFacts): LidPlan {
  const pauses = (reason: string, fix: string): LidPlan => ({ outcome: "pauses", reason, fix, gaps: [] });
  const stays = (reason: string, fix: string): LidPlan => ({ outcome: "stays", reason, fix, gaps: [] });
  const label = ENGINE_LABEL[facts.engine];
  if (label === undefined) return stays("This engine's chats stay on the computer they started on", "Start the work in a Caveman, Claude Agent or Codex chat to have it continue on Cloud.");
  if (facts.kind !== "chat")
    return stays("This chat stays here: the Chief, setup chats and delegated agents don't move", "Keep this Mac awake while it works, or start the work in a chat of its own.");
  if (!facts.gitHubRepo) return stays("This chat's repository isn't on GitHub, so a Cloud computer can't check it out", "Push the repository to GitHub to have its chats continue on Cloud.");
  if (!facts.signedIn) return pauses("Sign in to Caveman first (Settings, Remote control)", "Sign in to Caveman, then turn on moving chats (Settings, Computers).");
  if (facts.moves === "ask") return pauses("Moving chats to Cloud isn't set up on this Mac yet (Settings, Computers)", "Answer whether chats continue on Cloud (Settings, Computers).");
  if (facts.moves === "off") return pauses("Moving chats to Cloud is off on this Mac (Settings, Computers)", "Turn on moving chats to Cloud (Settings, Computers).");
  if (!facts.moveToCloud) return pauses("Moving chats to Cloud when the lid closes is off on this Mac (Settings, Computers)", "Turn on moving chats when the lid closes (Settings, Computers).");
  if (!facts.cloudComputers) return pauses("This Caveman server runs no Cloud computers", "Ask whoever runs your Caveman server to turn Cloud computers on.");
  if (facts.engine === "caveman" && !facts.cavemanOnCloud) return pauses(CAVEMAN_NOT_ON_CLOUD, CAVEMAN_NOT_ON_CLOUD_FIX);
  if (facts.engine === "caveman" && facts.cavemanPaid === false) return pauses(CAVEMAN_UNPAID, CAVEMAN_UNPAID_FIX);
  if (isNativeEngine(facts.engine)) {
    if (!facts.moveOtherEngines) return pauses(`${label} chats stay on this Mac when the lid closes (Settings, Computers)`, `Turn on moving ${label} chats when the lid closes (Settings, Computers).`);
    if (facts.cloudLogin === false)
      return pauses(noCloudLogin(facts.engine), `Connect your ${facts.engine === "codex" ? "ChatGPT plan or an OpenAI" : "Claude plan or an Anthropic"} API key in Settings > Models & keys.`);
  }
  if (facts.copy === "none") return pauses(NOT_COPIED, "It copies itself as it works; after its next turn it can continue on Cloud.");
  if (facts.copy === "failing") return pauses(`Its copy isn't reaching Caveman${facts.copyError ? `: ${facts.copyError.replace(/\.$/, "")}` : ""}`, "Check this Mac's connection: the copy goes up by itself once Caveman answers.");
  if (facts.wipDropped && facts.wipFailed !== undefined) return pauses(wipNotCarried(facts.wipFailed), WIP_NOT_CARRIED_FIX);
  if (facts.wipDropped) return pauses(facts.copyFull ? COPY_FULL_REASON : wipTooBigReason(facts.wipBytes), WIP_TOO_BIG_FIX);
  const gaps = [...(isNativeEngine(facts.engine) && facts.nativeOff ? [GAP_TRANSCRIPT] : []), ...(facts.left !== undefined && facts.left.length > 0 ? [gapLeft(facts.left)] : [])];
  return { outcome: gaps.length > 0 ? "continues_with_gaps" : "continues", reason: "It continues on a Cloud computer", gaps };
}

/**
 * How a moved chat's conversation goes on where it lands (decision 28, session.move.check's preflight.context): `native`,
 * its engine's own session resumes there (the Caveman engine's journal always does); `handoff`, a new session there is
 * handed the conversation (a budgeted selection of whole items, the rest readable with thread_read). Why a handoff:
 * `no_session`, its engine has no session of it yet; `over_cap`, its session file grew past what a copy carries;
 * `other_account`, another Mac, whose CLI runs on that Mac's own login (S-R2). `to`: a Cloud computer ("cloud", or one
 * named: "computer"), another Mac ("mac"), or back to This Mac from a Cloud computer ("home", where its own session
 * resumes, K15).
 */
export function moveContext(input: { readonly engine: string; readonly to: "cloud" | "computer" | "mac" | "home"; readonly session: boolean; readonly nativeOff: boolean }): MoveContext {
  if (!isNativeEngine(input.engine)) return { mode: "native" };
  if (input.to === "mac") return { mode: "handoff", why: "other_account" };
  if (input.to === "home") return { mode: "native" };
  if (!input.session) return { mode: "handoff", why: "no_session" };
  return input.nativeOff ? { mode: "handoff", why: "over_cap" } : { mode: "native" };
}
