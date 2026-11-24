// The pure rules of Review on a phone that is signed in: which pull requests the Needs you list holds and in which
// group (the web's queue model, apps/web/src/routes/review/model.ts groupQueue), what the list draws in each state,
// which changes a pull request's foot offers, and where GitHub connects. No React, no wire calls.
import type { PrDetail, PrSummary } from "@caveman-app/session-protocol";

import { couldNotRead, type MergeMethod } from "./words";

/** One pull request, by its repository (owner/name, whatever its case) and number. */
export const pullKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

export type QueueGroupId = "needs_you" | "guides_ready" | "yours" | "drafts" | "others" | "closed";

/** The group a pull request is in, first match wins, as the web's queue has it: asked of you, a guide to read, yours, drafts, the rest. */
export function groupOf(pr: PrSummary): QueueGroupId {
  if (pr.state === "merged" || pr.state === "closed") return "closed";
  if (pr.state === "draft") return "drafts";
  if (pr.review_requested && !pr.mine) return "needs_you";
  if (pr.guide_ready) return "guides_ready";
  return pr.mine ? "yours" : "others";
}

export interface PullGroup {
  readonly id: "needs_you" | "yours";
  readonly prs: ReadonlyArray<PrSummary>;
}

/**
 * What the Needs you list holds: the pull requests that wait on the person's review, then their own open ones (so one
 * that can merge is in reach), each in the order Cloud sent them (newest update first). Drafts and everyone else's
 * open pull requests are not listed; an empty group is left out.
 */
export function waitingGroups(prs: ReadonlyArray<PrSummary>): PullGroup[] {
  const of = (id: PullGroup["id"]): PullGroup => ({
    id,
    prs: prs.filter((pr) => groupOf(pr) === id),
  });
  return [of("needs_you"), of("yours")].filter((group) => group.prs.length > 0);
}

/** The list as Cloud last answered it (live/cloud.ts ReviewList), with where GitHub connects worked out. */
export interface Listed {
  readonly prs: ReadonlyArray<PrSummary>;
  readonly errors: ReadonlyArray<{ readonly repo?: string; readonly message: string }>;
  /** Where GitHub connects, when Cloud keeps no link of the person's; null while it keeps one. */
  readonly connect: string | null;
}

export interface ListState {
  /** Null: not read yet, or this Caveman serves no Review to a phone. */
  readonly list: Listed | null;
  readonly reading: boolean;
  /** Why the first read failed, while there is nothing older to show. */
  readonly problem: string | null;
}

/** What the Needs you list draws of pull requests: nothing, the one wait, the one thing to do, or the rows. */
export type ListView =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "connect"; readonly url: string }
  | { readonly kind: "problem"; readonly words: string }
  | {
      readonly kind: "rows";
      readonly groups: ReadonlyArray<PullGroup>;
      /** The repositories Cloud could not read. */ readonly note: string | null;
    };

export const NO_PULLS: ListView = { kind: "none" };

export function listView(state: ListState): ListView {
  const { list } = state;
  if (!list)
    return state.reading
      ? { kind: "loading" }
      : state.problem
        ? { kind: "problem", words: state.problem }
        : NO_PULLS;
  if (list.connect !== null) return { kind: "connect", url: list.connect };
  const groups = waitingGroups(list.prs);
  const note = couldNotRead(list.errors);
  return groups.length === 0 && note === null ? NO_PULLS : { kind: "rows", groups, note };
}

/** How many pull requests wait on the person's review: what a count beside "Needs you" adds. */
export const waitingOnReview = (prs: ReadonlyArray<PrSummary>): number =>
  prs.filter((pr) => groupOf(pr) === "needs_you").length;

/** The method a merge from the phone uses: the first the repository allows (squash where it names none, as the web). */
export const mergeMethod = (pr: Pick<PrDetail, "can">): MergeMethod =>
  pr.can.merge_methods[0] ?? "squash";

/** Whether Merge can work: the person may, the pull request is open, and GitHub names nothing in its way. */
export const canMerge = (pr: Pick<PrDetail, "can" | "state" | "mergeable">): boolean =>
  pr.can.merge &&
  pr.state === "open" &&
  pr.mergeable !== "conflicting" &&
  pr.mergeable !== "blocked";

/** What a pull request's foot offers. A change Cloud would refuse is left out, never drawn disabled. */
export interface Foot {
  readonly approve: boolean;
  readonly changes: boolean;
  readonly comment: boolean;
  /** The method Merge uses; null where it cannot merge. */
  readonly merge: MergeMethod | null;
  /** A chat about it can start in Cloud. */
  readonly ask: boolean;
}

/** `cloud`: a chat can start in Cloud from this phone. Asking is for a pull request still open: a merged one's branch is often gone. */
export function footOf(pr: Pick<PrDetail, "can" | "state" | "mergeable">, cloud: boolean): Foot {
  return {
    approve: pr.can.review,
    changes: pr.can.review,
    comment: pr.can.comment,
    merge: canMerge(pr) ? mergeMethod(pr) : null,
    ask: cloud && (pr.state === "open" || pr.state === "draft"),
  };
}

/** Cloud's own page that connects GitHub for the signed-in person (the web's GITHUB_CONNECT_PATH). */
export const GITHUB_CONNECT_PATH = "/cave-agent/code";

/**
 * Where "Connect GitHub" opens: the address Cloud sent, absolute or relative to Cloud itself; Cloud's own page where
 * it sent none or one a browser should not be handed (anything but https, or Cloud's own origin).
 */
export function connectUrl(sent: unknown, cloud: string): string {
  const own = new URL(GITHUB_CONNECT_PATH, cloud).href;
  if (typeof sent !== "string" || sent.trim() === "") return own;
  try {
    const url = new URL(sent.trim(), cloud);
    return url.protocol === "https:" || url.origin === new URL(cloud).origin ? url.href : own;
  } catch {
    return own;
  }
}

/** The project a repository's chats start in: named by the repository's own name, as every computer names it. */
export const projectNameOf = (repo: string): string => repo.split("/").pop() || repo;
