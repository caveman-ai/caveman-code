// A guide as a screen reads it, and how to open one. The guide and its diff come from review/source.ts; this adds what
// changes while you look (the writer at work, the guide it lands) and the way in. Every way into a review (a chat's
// Changes pill, a Chief's Ready card, Review's rows, the Ready list's shelf and its cards) opens the same pushed
// screen, by the chat's id or the pull request's name.
import { StackActions } from "@react-navigation/native";
import { useMemo } from "react";
import { navigationRef } from "../nav/ref";
import type { Pr } from "../screens/pages/review-model";
import { type Review, reviewOf } from "./source";
import { marksKey } from "./state";
import { useDrafts, useWriting } from "./write";

export { findPr, guideId, type Review, reviewOf } from "./source";

/** The review of a pull request as it stands: its guide (written, or being written) and its diff. */
export function useReview(pr: Pr): Review {
  const key = marksKey(pr);
  const draft = useDrafts()[key] ?? null;
  const running = !!useWriting()[key];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` and `pr.state` stand for `pr`, a new object each render.
  return useMemo(() => reviewOf(pr, draft, running), [key, pr.state, draft, running]);
}

/** Opens a pull request's guide over whatever is showing; the one already on top stays. */
export function openGuide(id: string) {
  if (!navigationRef.isReady()) return;
  const here = navigationRef.getCurrentRoute();
  if (here?.name === "Guide" && (here.params as { id?: string } | undefined)?.id === id) return;
  navigationRef.dispatch(StackActions.push("Guide", { id }));
}
