import { useEffect, type RefObject } from "react";
import { DISCLOSURE_MS } from "@caveman-app/ui/ai/disclosure";
import type { HeldFold, Row } from "./rows.ts";
import { hasOpenWork } from "./work-disclosures.ts";

/** Manual choices survive completion, including a run opened inside the turn. */
export function idleFolds(rows: ReadonlyArray<Row>, held: ReadonlyArray<HeldFold>, choices: ReadonlyMap<string, boolean>): ReadonlyArray<HeldFold> {
  const folds = new Map(rows.filter((row) => row.kind === "fold").map((row) => [row.id, row]));
  return held.filter((fold) => {
    const row = folds.get(fold.id);
    return choices.get(fold.id) === undefined && row !== undefined && !row.rows.some((child) => hasOpenWork(child, choices));
  });
}

/**
 * A turn the reader watched folds the moment it ends ("auto collapse ... once the agent has
 * finished responding"): its steps close in place (`onClose`, the disclosure's motion), then the fold takes their
 * place (`onFold`), so the turn reads as the message, its "Worked for" line and the answer. Text the reader is
 * selecting in it, or a keyboard's focus on one of its steps, holds it open until that goes.
 */
export function useSettledWork({ box, folds, enabled, onClose, onFold }: {
  box: RefObject<HTMLDivElement | null>;
  folds: ReadonlyArray<HeldFold>;
  enabled: boolean;
  onClose: (ids: ReadonlyArray<string>) => void;
  onFold: (ids: ReadonlyArray<string>, first: HTMLElement, above: boolean, last: HTMLElement) => void;
}) {
  useEffect(() => {
    const root = box.current;
    if (!enabled || !root || !folds.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let look: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      const selection = window.getSelection();
      if (selection?.toString() && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))) return;
      if (root.querySelector("[data-step-row] :focus-visible")) return;
      document.removeEventListener("selectionchange", settle);
      document.removeEventListener("focusout", later);
      onClose(folds.map((fold) => fold.id));
      timer = setTimeout(() => {
        for (const fold of folds) {
          const row = (id: string | undefined) => (id === undefined ? null : root.querySelector<HTMLElement>(`:scope > [data-row="${CSS.escape(id)}"]`));
          const first = row(fold.rows[0]);
          const last = row(fold.rows.at(-1));
          if (first && last) onFold([fold.id, ...fold.rows], first, false, last);
        }
      }, DISCLOSURE_MS);
    };
    // Focus leaving lands on its new element after focusout: look again then.
    const later = () => {
      clearTimeout(look);
      look = setTimeout(settle);
    };
    document.addEventListener("selectionchange", settle);
    document.addEventListener("focusout", later);
    settle();
    return () => {
      clearTimeout(timer);
      clearTimeout(look);
      document.removeEventListener("selectionchange", settle);
      document.removeEventListener("focusout", later);
    };
  }, [box, folds, enabled, onClose, onFold]);
}
