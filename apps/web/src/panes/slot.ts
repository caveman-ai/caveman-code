// What a pane knows about the split it sits in (PaneHost provides it; the pane header reads it).
import { createContext, useContext } from "react";

export interface PaneSlot {
  /** Panes in the tab. */
  readonly count: number;
  /** The pane fills the tab alone: zoomed by hand, or the window is too small for the split (tree.squeezed). */
  readonly solo: "zoomed" | "squeezed" | null;
}

export const PaneSlotContext = createContext<PaneSlot>({ count: 1, solo: null });
export const usePaneSlot = (): PaneSlot => useContext(PaneSlotContext);
