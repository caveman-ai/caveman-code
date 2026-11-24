// The app's chrome icons on an iPhone: SF Symbols, the system's own glyphs, as Cursor, Grok and Claude draw theirs
//. Every name the app uses maps to a symbol; a name without
// one falls back to the desktop's Hugeicons glyph (HugeIcon.tsx), so nothing ever draws blank. A pull request has no SF
// symbol of its own (arrow.triangle.pull read as two arrows; "the ios native pr icon looks pretty
// bad"), so it is the desktop's git glyph, as everywhere else. Identity (states, engines,
// tools, Chiefs) stays pixel art.
//
// Weight follows the stroke the caller asked for: the line set's 1.75 reads as SF's medium at these sizes, a 2 (a check
// that confirms a choice) as semibold. A symbol sits in a square frame of `size`, like the line glyph it replaces, so
// callers' layouts don't move.
import { SymbolView, type SymbolViewProps, type SymbolWeight } from "expo-symbols";
import { useTheme } from "../theme";
import { HugeIcon, type IconName } from "./HugeIcon";

export type { IconName };

/** An SF Symbol's name, checked against the system's catalogue by expo-symbols' own types. */
type SFSymbol = Extract<SymbolViewProps["name"], string>;

/** The symbol for each name, and its filled form where `filled` asks for one. */
const SYMBOLS: Partial<Record<IconName, SFSymbol | { line: SFSymbol; fill: SFSymbol }>> = {
  add: "plus",
  alert: "exclamationmark.triangle",
  archive: "archivebox",
  arrowDown: "arrow.down",
  arrowBack: "arrow.left",
  attachFile: "doc",
  back: "chevron.left",
  branch: "arrow.triangle.branch",
  call: { line: "phone", fill: "phone.fill" },
  callEnd: "phone.down.fill",
  hangUp: "phone.down.fill",
  camera: "camera",
  check: "checkmark",
  checklist: "checklist",
  chevronDown: "chevron.down",
  chevronLeft: "chevron.left",
  chevronRight: "chevron.right",
  chevronUp: "chevron.up",
  clock: "clock",
  close: "xmark",
  code: "chevron.left.forwardslash.chevron.right",
  comment: "bubble.left",
  compose: "square.and.pencil",
  connect: "square.grid.2x2",
  copy: "doc.on.doc",
  delete: "trash",
  diff: "plus.forwardslash.minus",
  filter: "line.3.horizontal.decrease",
  folder: { line: "folder", fill: "folder.fill" },
  fork: "arrow.triangle.branch",
  grip: "line.3.horizontal",
  home: "house",
  hourglass: { line: "hourglass", fill: "hourglass.bottomhalf.filled" },
  info: "info.circle",
  laptop: "laptopcomputer",
  link: "arrow.up.right.square",
  lock: "lock",
  menu: "line.3.horizontal",
  merge: "arrow.triangle.merge",
  mic: { line: "mic", fill: "mic.fill" },
  micOff: "mic.slash",
  more: "ellipsis",
  open: "arrow.up.right",
  parent: "arrow.up",
  pause: "pause.fill",
  photos: "photo",
  pin: { line: "pin", fill: "pin.fill" },
  play: "play.fill",
  plug: "powerplug",
  rename: "pencil",
  restore: "tray.and.arrow.up",
  retry: "arrow.clockwise",
  scan: "viewfinder",
  search: "magnifyingglass",
  send: "arrow.up",
  settings: "gearshape",
  share: "square.and.arrow.up",
  sliders: "slider.horizontal.3",
  snooze: "alarm",
  speak: "speaker.wave.2",
  speed: { line: "bolt", fill: "bolt.fill" },
  star: { line: "star", fill: "star.fill" },
  stop: "stop.fill",
  terminal: "terminal",
  thumbsDown: { line: "hand.thumbsdown", fill: "hand.thumbsdown.fill" },
  thumbsUp: { line: "hand.thumbsup", fill: "hand.thumbsup.fill" },
  undo: "arrow.uturn.backward",
  unpin: "pin.slash",
  view: "eye",
  voice: "waveform",
  web: "globe",
  markDone: "checkmark.circle",
  markRead: "envelope.open",
  markUnread: "envelope.badge",
  sidebarClose: "sidebar.left",
  sidebarOpen: "sidebar.left",
  panel: "sidebar.right",
  panelClose: "sidebar.right",
  sidebar: "line.3.horizontal",
  wake: "smallcircle.filled.circle",
  wakeNow: "alarm",
};

function weightOf(stroke: number): SymbolWeight {
  if (stroke >= 2) return "semibold";
  if (stroke >= 1.5) return "medium";
  return "regular";
}

/** One chrome glyph. `filled` draws the symbol's filled form when it has one (a starred model, the bolt while on). */
export function Icon({ name, size = 20, color, stroke = 1.75, filled = false }: { name: IconName; size?: number; color?: string; stroke?: number; filled?: boolean }) {
  const { c } = useTheme();
  const ink = color ?? c.text;
  const symbol = SYMBOLS[name];
  if (!symbol) return <HugeIcon name={name} size={size} color={ink} stroke={stroke} filled={filled} />;
  const resolved = typeof symbol === "string" ? symbol : filled ? symbol.fill : symbol.line;
  return (
    <SymbolView
      name={resolved}
      size={size}
      tintColor={ink}
      weight={weightOf(stroke)}
      type="monochrome"
      fallback={<HugeIcon name={name} size={size} color={ink} stroke={stroke} filled={filled} />}
      style={{ width: size, height: size }}
    />
  );
}
