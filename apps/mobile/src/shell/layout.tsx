// How the app lays itself out on the screen it has. A phone, and the iPhone Duo folded, get the phone's shell: the
// main panel lying over the sidebar it slides aside to show (DrawerLayout.tsx). A screen with room for two columns, the
// Duo unfolded (890 by 626 on its side, 626 by 890 upright), keeps the sidebar standing beside the panel instead, as
// the desktop does. The space decides, never the device's name, so a Duo running two apps in Split View, each in a
// narrow window, gets the phone's shell. upstream phone app sets its columns the same way (apps/mobile/src/lib/
// layout.ts, which reads the Duo's own geometry through a native module); these numbers are ours.
//
// On its side the Duo runs iOS 27's vertical bar: the status bar sits in the trailing top corner and an app's bar
// buttons stand in a column down that edge. The shell keeps that column, the rail, and the screen's own buttons stand
// there instead of at its bar's right. A third column, the inspector (a chat's details), opens beside the panel;
// where all three don't fit, it takes the sidebar's place, and the two trade places on one curve so the panel between
// them keeps its width and nothing in it reflows.
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { setDocked, setInspector, useDrawer } from "./drawer";
import { deriveLayout, GAP, type Layout, PHONE } from "./split";

export { deriveLayout, GAP, type Layout, RAIL_TOP, SHEET_MAX } from "./split";

export interface Shell extends Layout {
  /** Split only: the sidebar is standing beside the panel. */
  sidebar: boolean;
  /** Tucks the sidebar away for a wider panel, or brings it back (taking its place back from the inspector). */
  setSidebar: (shown: boolean) => void;
  /** The inspector is showing: asked for, on a screen that has one. */
  inspector: boolean;
  setInspector: (open: boolean) => void;
  /** Where the panel stands in the window, for what is drawn over it from outside (the toast, a sheet). */
  panel: { left: number; right: number; top: number; bottom: number };
  /** The screen's column: the panel less the inspector. */
  pane: { width: number; height: number };
}

const noop = () => {};
export const ShellContext = createContext<Shell>({
  ...PHONE,
  sidebar: false,
  setSidebar: noop,
  inspector: false,
  setInspector: noop,
  panel: { left: 0, right: 0, top: 0, bottom: 0 },
  pane: { width: 0, height: 0 },
});
export const useShell = () => useContext(ShellContext);

/** The shell, worked out once at the top from the window and its real insets (inside the panel they read zero). */
export function useShellState(slots: Slots): Shell {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = deriveLayout(window.width, window.height, insets);
  const docked = useDrawer((s) => s.docked);
  const asked = useDrawer((s) => s.inspector);
  const filled = useSlotFilled(slots.inspector);
  return useMemo(() => {
    const { split, side, rail, three } = layout;
    const inspector = split && asked && filled;
    const sidebar = split && docked && (three || !inspector);
    const top = insets.top + GAP;
    const bottom = Math.max(insets.bottom, GAP);
    const right = rail || Math.max(insets.right, GAP);
    const left = split ? insets.left + (sidebar ? side : GAP) : 0;
    const room = side - GAP;
    return {
      ...layout,
      sidebar,
      inspector,
      setSidebar: (shown) => {
        setDocked(shown);
        if (shown && !three) setInspector(false);
      },
      setInspector,
      panel: split ? { left, right, top, bottom } : { left: 0, right: 0, top: 0, bottom: 0 },
      pane: split
        ? {
            width: window.width - left - right - (inspector ? room : 0),
            height: window.height - top - bottom,
          }
        : { width: window.width, height: window.height },
    };
  }, [
    layout.split,
    layout.side,
    layout.rail,
    layout.three,
    docked,
    asked,
    filled,
    window.width,
    window.height,
    insets.top,
    insets.bottom,
    insets.left,
    insets.right,
  ]);
}

/** The column a screen is drawn in: the window on a phone, its own column in the panel beside the sidebar. */
export const PaneContext = createContext<{ width: number; height: number } | null>(null);
export function usePane() {
  const window = useWindowDimensions();
  const pane = useContext(PaneContext);
  return pane ? { ...window, width: pane.width, height: pane.height } : window;
}

/** True inside the rail: a row of glass circles (BarGroup) stands as a column there. */
export const RailContext = createContext(false);

// ---------------------------------------------------------------- slots

/** What a screen shows in the inspector: its name for the head, and the body. */
export interface InspectorContent {
  title: string;
  body: ReactNode;
}

/** One thing the shell draws, set from wherever a screen is drawn; only what reads it redraws when it changes. */
function slot<T>() {
  let value: T | null = null;
  const hearers = new Set<() => void>();
  return {
    set(next: T | null | undefined) {
      value = next ?? null;
      for (const hear of [...hearers]) hear();
    },
    get: () => value,
    subscribe(hear: () => void) {
      hearers.add(hear);
      return () => void hearers.delete(hear);
    },
  };
}
type Slot<T> = ReturnType<typeof slot<T>>;

/** The rail's circles and the inspector, which a screen fills and the shell draws beside the panel. */
export interface Slots {
  rail: Slot<ReactNode>;
  inspector: Slot<InspectorContent>;
}
export function useNewSlots(): Slots {
  const [slots] = useState<Slots>(() => ({
    rail: slot<ReactNode>(),
    inspector: slot<InspectorContent>(),
  }));
  return slots;
}
export const SlotsContext = createContext<Slots | null>(null);

/** What a slot holds, for the shell that draws it. */
export function useSlot<T>(s: Slot<T>) {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}
/** Only whether a slot holds anything: what holds the screens must not redraw them each time one fills it. */
function useSlotFilled<T>(s: Slot<T>) {
  const filled = () => s.get() !== null;
  return useSyncExternalStore(s.subscribe, filled, filled);
}

/**
 * Holds `value` in a slot while `active`. Only the screen on top fills it. A screen covered by a push leaves what it put
 * there until the one over it fills the slot itself, so a chat's details stay beside the guide pushed over it; it
 * empties the slot when it goes, and only while the slot still holds what it put there.
 */
function useFill<T>(pick: (slots: Slots) => Slot<T>, value: T | null, active: boolean) {
  const slots = useContext(SlotsContext);
  const mine = useRef<T | null>(null);
  const letGo = () => {
    if (!slots || mine.current === null) return;
    if (pick(slots).get() === mine.current) pick(slots).set(null);
    mine.current = null;
  };
  useLayoutEffect(() => {
    if (!slots || !active) return;
    mine.current = value;
    pick(slots).set(value);
  });
  useLayoutEffect(() => letGo, [slots]);
}

/** Stands a screen's own circles in the rail. It draws nothing where it sits. */
export function RailFill({ children, active = true }: { children: ReactNode; active?: boolean }) {
  useFill((s) => s.rail, children ?? null, active);
  return null;
}

/** Puts a screen's inspector in the shell's third column. It draws nothing where it sits. */
export function InspectorFill({
  title,
  children,
  active = true,
}: {
  title: string;
  children: ReactNode;
  active?: boolean;
}) {
  useFill((s) => s.inspector, { title, body: children }, active);
  return null;
}
