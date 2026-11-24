// The bar over every screen (native and Grok's phone apps; DECISIONS.md "Thread, exactly", Top bar), its 44pt glass
// circles and capsule floating over the page:
// - `pushed`, over a chat, a Chief, a workspace or a list: a back circle at the left (the stack's Back; an amber dot on
//   it when something waits on you elsewhere), a glass capsule in the middle with who runs it (the engine's vendor
//   mark, the Chief's character, the workspace's glyph) and two lines, the title at 15/600 and where it runs at 12 in
//   grey, and at the right the screen's own button or a ··· circle opening its menu. The capsule opens `onTitle` (a
//   chat's Details), or the menu where there is none; held, it opens `hold` (a chat's: its menu, with the agent's
//   browser and computer over it).
// - `pushed` with `root`, on the main panel's root (a new chat, or a chat or Chief the sidebar opened): the sidebar's
//   button in Back's place (shell/DrawerLayout.tsx), with the same amber dot, since what waits on you is in there.
// - `pushed` with `edge="hard"`, over a subagent's chat (Cursor 5350): no capsule, its title plain and centred, the bar
//   a blurred band with a hairline under it, so you can tell at a glance you're one level down.
// - `home`: your avatar in a glass circle at the left (you and Settings), the screen's glass circles at the right, and
//   no title in the bar: Home draws its own large one under it.
// Beside a sidebar that stands (the iPhone Duo unfolded, shell/layout.tsx), the root's sidebar button tucks the sidebar
// away and brings it back, the dot riding on it only while it's away; and on the Duo's side the screen's own circles
// (and its ···) stand in the rail at the trailing edge, iOS 27's vertical bar, instead of at the bar's right.
// Glass separates the controls from the scrolling page. A light dim and 20 pt blur tail soften its edge only
// once content has scrolled underneath (components/ProgressiveEdge.tsx); no opaque band extends below the title.
import { useIsFocused } from "@react-navigation/native";
import { BlurView } from "expo-blur";
import { type ReactNode, useContext, useState } from "react";
import { Platform, Text, TextInput, useWindowDimensions, View, type ViewStyle } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass } from "../components/Glass";
import { TopEdge } from "../components/ProgressiveEdge";
import { Icon, type IconName } from "../components/Icon";
import { Squish } from "../components/Squish";
import { useReportBarCentre } from "../components/Toast";
import { type Anchor, Menu, type MenuEntry, useAnchor } from "../components/ui/Menu";
import { haptic } from "../motion";
import { alpha, FLOAT_TYPE, layout, useFontScale, useTheme } from "../theme";
import { openSidebar } from "./drawer";
import { RailContext, RailFill, useShell } from "./layout";

export const BAR_HEIGHT = 56;
const BUTTON = layout.float;
const WEB = Platform.OS === "web";

export function GlassButton({ icon, label, onPress, children, dot = false, selected = false }: { icon?: IconName; label: string; onPress: () => void; children?: ReactNode; /** An amber dot at the corner: something waits on you. */ dot?: boolean; /** What it opens is open (the inspector): a wash of ink on the glass says so. */ selected?: boolean }) {
  const { c, dark } = useTheme();
  return (
    <View>
      <Squish label={label} onPress={onPress} depth={0.88} hitSlop={4} selected={selected}>
        <Glass interactive style={{ width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center" }}>
          {selected ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: BUTTON / 2, backgroundColor: alpha(c.text, dark ? 0.2 : 0.12) }} /> : null}
          {icon ? (
            // Over the wash: on the web a positioned layer paints over a bare glyph (components/Glass.tsx).
            <View style={{ zIndex: 1 }}>
              <Icon name={icon} size={22} />
            </View>
          ) : null}
          {children}
        </Glass>
      </Squish>
      {/* The desktop's: 10pt of amber at the button's corner, ringed in what it sits on. */}
      {dot ? <View pointerEvents="none" style={{ position: "absolute", top: 3, right: 3, width: 10, height: 10, borderRadius: 5, backgroundColor: c.warning, borderWidth: 2, borderColor: c.panel }} /> : null}
    </View>
  );
}

/** A screen's circles side by side in its bar, one over another in the rail. */
export function BarGroup({ children }: { children: ReactNode }) {
  const rail = useContext(RailContext);
  return <View style={{ flexDirection: rail ? "column" : "row", alignItems: "center", gap: rail ? 12 : layout.floatGap }}>{children}</View>;
}

/** The title's menu (PaneHeader's): what it holds, and where the chat runs at its head. */
export interface TitleMenu {
  entries: readonly MenuEntry[];
  /** Over the rows; given the way to close the menu when something in it can be pressed. */
  header?: ReactNode | ((close: () => void) => ReactNode);
}

interface Common {
  /** The screen's own buttons at the right, in glass. */
  right?: ReactNode;
  /** What hangs under the bar and stays with it, and how tall it is. */
  below?: ReactNode;
  belowHeight?: number;
  /** How far the page has scrolled: the edge's tail under the bar comes in once something is under it. */
  scrollY?: SharedValue<number>;
}

export interface PushedBar extends Common {
  variant?: "pushed";
  /** The stack's Back; unused on the root, where the sidebar's button takes its place. */
  onBack?: () => void;
  /** The main panel's root: the sidebar's button at the left instead of Back. */
  root?: boolean;
  /** What waits on you elsewhere: an amber dot on the back circle says so. */
  waiting?: number;
  title?: string;
  /** A second line in the capsule, small and grey: where a chat runs ("caveman-code · Studio"), a Chief's counts. */
  subtitle?: string;
  /** Before the title: who runs it (an engine's mark, a Chief's character, a workspace's glyph). */
  mark?: ReactNode;
  /** Kept for screens that still pass it: the status now lives over the box, in the chat's floating row. */
  status?: "needs" | "working" | null;
  /** The ··· circle opens this menu (and the capsule, when it has no `onTitle`). */
  menu?: TitleMenu;
  /** The capsule's own action: a chat's Details. */
  onTitle?: () => void;
  /** A long press on the capsule opens this menu, hung under it (a chat's: its menu, the agent's screens over it). */
  hold?: TitleMenu & { label: string };
  /** `hard`: a subagent's bar, its title plain and centred over a blurred band with a hairline. */
  edge?: "fade" | "hard";
  /** Kept for screens that still pass it: every edge is the same (components/ProgressiveEdge.tsx). */
  fade?: number;
  /** The title as a field, for Rename; `onRename` gets the new name, or null when it is left as it was. */
  editing?: boolean;
  onRename?: (title: string | null) => void;
}

export interface HomeBar extends Common {
  variant: "home";
  /** Your avatar's circle: you, your plan, Settings. */
  avatar: ReactNode;
  onProfile: () => void;
  profileLabel?: string;
  fade?: number;
}

/** The title being renamed, in its capsule's place (PaneHeader's rename field). */
function TitleField({ value, onDone }: { value: string; onDone: (title: string | null) => void }) {
  const { c, t } = useTheme();
  const [text, setText] = useState(value);
  const finish = () => onDone(text.trim() && text.trim() !== value ? text.trim() : null);
  return (
    <TextInput
      autoFocus
      value={text}
      onChangeText={setText}
      selectTextOnFocus
      accessibilityLabel="Chat name"
      returnKeyType="done"
      onSubmitEditing={finish}
      onBlur={finish}
      style={[t.body, { alignSelf: "stretch", height: BUTTON, paddingHorizontal: 14, textAlign: "center", borderRadius: BUTTON / 2, borderWidth: 1, borderColor: alpha(c.target, 0.6), backgroundColor: c.panel }, { outlineStyle: "none" } as object]}
    />
  );
}

/** How wide the title's menu is: native 250, at a finger's size. */
const MENU_WIDTH = 260;

/** A subagent's bar: a blurred band to the bar's foot and a hairline, nothing fading past it (Cursor 5350). */
function HardEdge({ height }: { height: number }) {
  const insets = useSafeAreaInsets();
  const { c, dark } = useTheme();
  const style: ViewStyle = { position: "absolute", top: 0, left: 0, right: 0, height: insets.top + height };
  return (
    <View pointerEvents="none" style={[style, { borderBottomWidth: 1, borderBottomColor: dark ? c.edge : c.hairline, overflow: "hidden" }]}>
      {WEB ? (
        <View style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: alpha(c.panel, 0.78), backdropFilter: "blur(18px) saturate(160%)", WebkitBackdropFilter: "blur(18px) saturate(160%)" } as ViewStyle]} />
      ) : (
        <>
          <BlurView intensity={dark ? 50 : 60} tint={dark ? "dark" : "light"} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: alpha(c.panel, 0.72) }} />
        </>
      )}
    </View>
  );
}

export function TopBar(props: PushedBar | HomeBar) {
  const insets = useSafeAreaInsets();
  const { belowHeight = 0, below } = props;
  const hard = props.variant !== "home" && props.edge === "hard";
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
      {hard ? <HardEdge height={BAR_HEIGHT + 8 + belowHeight} /> : <TopEdge bottom={insets.top + BAR_HEIGHT + belowHeight} scrollY={props.scrollY} />}
      <View pointerEvents="box-none" style={{ marginTop: insets.top, height: BAR_HEIGHT, flexDirection: "row", alignItems: "center", paddingHorizontal: layout.inset, gap: 10 }}>
        {props.variant === "home" ? <HomeRow {...props} /> : <PushedRow {...props} />}
      </View>
      {below}
    </View>
  );
}

function HomeRow({ avatar, onProfile, profileLabel = "You and Settings", right }: HomeBar) {
  const shell = useShell();
  const focused = useIsFocused();
  if (shell.rail) right = <RailFill active={focused}>{right}</RailFill>;
  return (
    <>
      <Squish label={profileLabel} onPress={onProfile} depth={0.88} hitSlop={4}>
        <Glass interactive style={{ width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {avatar}
        </Glass>
      </Squish>
      <View pointerEvents="none" style={{ flex: 1 }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: layout.floatGap }}>{right}</View>
    </>
  );
}

function PushedRow({ onBack, root = false, waiting = 0, title, subtitle, mark, menu, onTitle, hold, right, edge = "fade", editing = false, onRename }: PushedBar) {
  const { c, t } = useTheme();
  // A bar with nothing in its centre lends the row to news (components/Toast.tsx).
  useReportBarCentre(!title && !editing, (right ? 1 : 0) + (menu ? 1 : 0));
  const { width: screen } = useWindowDimensions();
  const shell = useShell();
  const focused = useIsFocused();
  const fontScale = useFontScale();
  // At the largest text sizes the capsule keeps one line: the title (its type held at FLOAT_TYPE).
  const twoLines = !!subtitle && fontScale <= 1.35;
  const capsule = useAnchor();
  const more = useAnchor();
  const [open, setOpen] = useState<{ anchor: Anchor | null; align: "start" | "end"; held?: boolean } | null>(null);

  const openFrom = async (from: "capsule" | "more" | "hold") => {
    if (from === "hold") haptic.thud();
    const at = await (from === "more" ? more : capsule).measure();
    if (from === "more") return setOpen({ anchor: at, align: "end" });
    // Centred under the capsule: the menu hangs from its start edge, so the anchor is the menu's own width.
    const w = Math.min(MENU_WIDTH, screen - 24);
    setOpen({ anchor: at ? { x: at.x + at.width / 2 - w / 2, y: at.y, width: w, height: at.height } : null, align: "start", held: from === "hold" });
  };
  // What's open: the long press's menu, or the title's.
  const shown = open?.held && hold ? hold : menu;
  const close = () => setOpen(null);

  const said = [title, subtitle].filter(Boolean).join(", ");
  const press = onTitle ?? (menu ? () => void openFrom("capsule") : undefined);
  const inside = title ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, maxWidth: "100%" }}>
      {mark}
      <View style={{ flexShrink: 1, minWidth: 0 }} accessibilityShowsLargeContentViewer accessibilityLargeContentTitle={said}>
        <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.label, { fontSize: 15, lineHeight: twoLines ? 18 : 20, fontWeight: "600" }]}>
          {title}
        </Text>
        {twoLines ? (
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.small, { fontSize: 12, lineHeight: 15, color: c.muted }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  ) : null;
  const pill = { height: BUTTON, borderRadius: BUTTON / 2, paddingLeft: mark ? 14 : 18, paddingRight: 18, justifyContent: "center" as const, maxWidth: "100%" as const };

  // The screen's own circles: at the bar's right, or standing in the rail on the Duo's side. Beside a sidebar the ···
  // stands with them, since the capsule opens the inspector there.
  const moreCircle = menu ? (
    <View ref={more.ref} collapsable={false}>
      <GlassButton icon="more" label="More" onPress={() => void openFrom("more")} />
    </View>
  ) : null;
  const circles =
    shell.split && right && moreCircle ? (
      <BarGroup>
        {right}
        {moreCircle}
      </BarGroup>
    ) : (
      (right ?? moreCircle)
    );

  let middle: ReactNode = null;
  if (editing && title && onRename) middle = <TitleField value={title} onDone={onRename} />;
  else if (title && edge === "hard") {
    // A subagent's title, plain: one level down, it isn't a place to open.
    middle = (
      <Text accessibilityRole="header" maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.heading, { fontSize: 17, lineHeight: 22, fontWeight: "600", textAlign: "center" }]}>
        {title}
      </Text>
    );
  } else if (inside && press) {
    middle = (
      <View ref={capsule.ref} collapsable={false} style={{ maxWidth: "100%" }}>
        <Squish
          label={onTitle ? `${said}. Details` : said}
          onPress={press}
          onLongPress={hold ? () => void openFrom("hold") : undefined}
          longLabel={hold?.label}
          depth={0.96}
          selected={open?.align === "start"}
        >
          <Glass interactive style={pill}>
            {inside}
          </Glass>
        </Squish>
      </View>
    );
  } else if (inside) {
    middle = (
      <Glass style={pill}>
        <View accessible accessibilityRole="header" accessibilityLabel={said}>
          {inside}
        </View>
      </Glass>
    );
  }

  return (
    <>
      {root && shell.split ? (
        // Beside the panel the sidebar shows what waits on you itself; the dot comes back only while it's tucked away.
        <GlassButton
          icon={shell.sidebar ? "sidebarClose" : "sidebarOpen"}
          label={shell.sidebar ? "Hide the sidebar" : waiting ? `Show the sidebar, ${waiting} need${waiting === 1 ? "s" : ""} you` : "Show the sidebar"}
          onPress={() => shell.setSidebar(!shell.sidebar)}
          dot={!shell.sidebar && waiting > 0}
        />
      ) : root ? (
        <GlassButton icon="sidebar" label={waiting ? `Sidebar, ${waiting} need${waiting === 1 ? "s" : ""} you` : "Sidebar"} onPress={openSidebar} dot={waiting > 0} />
      ) : (
        <GlassButton label={waiting ? `Back, ${waiting} need${waiting === 1 ? "s" : ""} you elsewhere` : "Back"} onPress={() => onBack?.()} dot={waiting > 0}>
          <Icon name="chevronLeft" size={24} />
        </GlassButton>
      )}
      <View pointerEvents="box-none" style={{ flex: 1, alignItems: "center", minWidth: 0 }}>
        {middle}
      </View>
      <View style={{ minWidth: BUTTON, alignItems: "flex-end" }}>{shell.rail ? null : circles}</View>
      {shell.rail ? <RailFill active={focused}>{circles}</RailFill> : null}
      {shown ? (
        <Menu
          open={open !== null}
          onClose={close}
          anchor={open?.anchor}
          align={open?.align ?? "start"}
          width={MENU_WIDTH}
          entries={shown.entries}
          header={typeof shown.header === "function" ? shown.header(close) : shown.header}
        />
      ) : null}
    </>
  );
}
