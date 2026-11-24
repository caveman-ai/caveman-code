// The agents on the person's computers and their plan, as Settings reads them: what one of their computers says
// (engine.list for Models & keys, account.get for the plan). A phone runs no agent of its own, so there is nothing to
// list until one of their computers answers: a Mac first (it holds their own sign-ins), else Cloud while it runs.
// Nothing here wakes anything: a Mac that sleeps or a Cloud that sleeps is said so, in one line.
//
// Small on purpose, like seams.ts: Settings reads it, and nothing here loads the connection (link.ts fills it).
import type { EngineDescriptor, Result } from "@caveman-app/session-protocol";

import { createStore, useSelector } from "../store/core";

export interface AgentsState {
  /**
   * "signed-out": nobody is signed in to Caveman on this phone. "loading": asked, no answer yet. "away": no computer
   * of theirs answers now. "ready": `engines` is what `from` lists.
   */
  status: "signed-out" | "loading" | "away" | "ready";
  engines: readonly EngineDescriptor[];
  /** The computer that answered: a Mac's own name, or "Cloud". "" until one has. */
  from: string;
  /** Whether `from` is a Mac (its own sign-ins show as "This Mac only" there) or Cloud. */
  kind: "mac" | "cloud" | null;
  /** While "away": the person's Mac by name and what it is doing, when they have one. */
  mac: { name: string; state: "Asleep" | "Offline" } | null;
  /** The person's plan as that computer reads it (account.get); null until it answered, or where it says none. */
  account: Result<"account.get"> | null;
}

export const agents = createStore<AgentsState, Partial<AgentsState>>(
  { status: "signed-out", engines: [], from: "", kind: null, mac: null, account: null },
  (state, patch) => ({ ...state, ...patch }),
);

/** A slice of what the person's computers say of their agents; re-renders only when it changes. */
export const useAgents = <T>(pick: (state: AgentsState) => T, equal?: (a: T, b: T) => boolean) =>
  useSelector(agents, pick, equal);

/** Reads them again from whichever computer answers: as Settings > Models & keys or Account opens, and while it is open. */
export const readAgents = () => void import("./link").then((link) => link.readAgents());
