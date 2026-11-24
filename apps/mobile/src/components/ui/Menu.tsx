// Every list that drops down, on native phone anatomy over the desktop's vocabulary (packages/ui/src/components/
// menu.tsx, STYLE.md 5): a glass popover rounded 28 around 8pt of padding, so its
// rows sit concentric, that grows out of the button it hangs from over a dimmed, softly blurred screen. Rows are 44pt:
// a 20pt glyph in the description grey that lifts to ink while the row is held, then the label at 17pt; group
// headings small and grey in sentence case; separators inset to the glyphs' edge; a destructive row in red with a red
// wash; one-of rows with a check at the right, many-of rows with an ink checkbox in the glyph slot; a submenu with a
// chevron. On a touch screen keys are never printed, and a submenu (the desktop's flyout) opens in place with its
// parent's name as the way back, since there is no pointer to fly out beside. When the system asks for less
// transparency the glass turns solid (Floating.tsx).
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { type ComponentRef, type ReactNode, useCallback, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut, Keyframe } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ease, enter, haptic } from "../../motion";
import { alpha, overlayShadow, touch, useTheme } from "../../theme";
import { Icon, type IconName } from "../Icon";
import { Squish } from "../Squish";
import { Frost } from "./Floating";

/** The menu's own padding: rows inset this far from its edge, rounding RADIUS - PAD so they sit concentric. */
const PAD = 8;
/** The popover's corner (native ~30). */
const RADIUS = 28;
/** Where a row's glyph starts inside the padding; separators and headings start there too. */
const INSET = 12;

export interface MenuRowItem {
  type?: "row";
  label: string;
  /** Grey words after the label: on the same line (they truncate first), or `under` it where they run long. */
  description?: string;
  under?: boolean;
  /** A chrome glyph by name (it lifts to white while held), or any node: a pixel icon, an engine logo. */
  icon?: IconName | ReactNode;
  /** A setting's current choice, grey before the chevron (the chat's settings: "Permissions  Supervised ›"). */
  value?: string;
  /** One of several: a check at the right of the chosen row. */
  checked?: boolean;
  /** Many of several: an ink checkbox in the icon slot. */
  toggled?: boolean;
  /** Something at the right that isn't a check or a chevron: a count, a tag. */
  trailing?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Its rows open in place of this list, with this row's label as the way back. */
  submenu?: readonly MenuEntry[];
  onPress?: () => void;
  /** Leave the menu open after the press (a many-of toggle). */
  keepOpen?: boolean;
}
export type MenuEntry = MenuRowItem | { type: "heading"; label: string } | { type: "separator" };

/**
 * The surface every menu and popover draws on: glass, rounded 28, lifted by the overlay shadow. In dark a faint wash of
 * ink lifts it a step above the dimmed screen, as native does; in light a wash of white keeps dark words behind it
 * from reading through.
 */
export function MenuSurface({ children, width }: { children: ReactNode; width?: number }) {
  const { c, dark } = useTheme();
  return (
    <View style={{ width, borderRadius: RADIUS, ...overlayShadow(dark) }}>
      <Frost style={{ borderRadius: RADIUS }}>
        <View style={{ borderRadius: RADIUS, padding: PAD, backgroundColor: dark ? alpha(c.text, 0.05) : alpha(c.popover, 0.65) }}>{children}</View>
      </Frost>
    </View>
  );
}

/** A group's heading: "Add", "Plugins and Spaces". */
export function MenuHeading({ label }: { label: string }) {
  const { t } = useTheme();
  return (
    <Text accessibilityRole="header" style={[t.group, { paddingHorizontal: INSET, paddingTop: 8, paddingBottom: 4 }]}>
      {label}
    </Text>
  );
}

/** A rule between groups, inset to the glyphs' edge as native are. */
export function MenuSeparator() {
  const { c } = useTheme();
  return <View style={{ height: 1, marginHorizontal: INSET, marginVertical: 6, backgroundColor: alpha(c.text, 0.1) }} />;
}

/** The many-of box: an outline in the field grey, filled in ink with a check when on. */
function Checkbox({ on }: { on: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: on ? c.text : c.field, backgroundColor: on ? c.text : undefined, alignItems: "center", justifyContent: "center" }}>
      {on ? <Icon name="check" size={14} stroke={2.5} color={c.panel} /> : null}
    </View>
  );
}

/** A menu row's words: 17pt, native. */
const LABEL = { fontSize: 17, lineHeight: 22 } as const;

/** How far a disabled row's marks dim (its glyph, check and chevron). Its words never do: they stay readable. */
const DISABLED_MARK = 0.45;

/**
 * One row, as every menu, picker and sheet draws it. `onPress` absent makes it a plain line (still 44pt, never lit).
 * A submenu or a value gets a chevron; a chosen one-of row a check.
 */
export function MenuRow({ item, onPress, chevron }: { item: MenuRowItem; onPress?: () => void; chevron?: boolean }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  // A disabled row's words are the description grey, which still reads (5:1 on the menu in dark, 6.7:1 in light);
  // only its marks dim. Fading the whole row took its words to about 2:1.
  const off = !!item.disabled;
  const ink = off ? c.muted : item.destructive ? c.destructive : c.text;
  const iconInk = item.destructive && !off ? c.destructive : held ? c.text : c.muted;
  const dim = off ? DISABLED_MARK : 1;
  const icon =
    item.toggled !== undefined ? <Checkbox on={item.toggled} /> : typeof item.icon === "string" ? <Icon name={item.icon as IconName} size={20} color={iconInk} /> : (item.icon ?? null);
  const pressable = !!(onPress ?? item.onPress) && !off;
  const wash = item.destructive ? alpha(c.destructive, 0.12) : alpha(c.text, 0.08);
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={[item.label, item.description, item.value].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: item.disabled, checked: item.toggled ?? item.checked, expanded: item.submenu ? false : undefined }}
      disabled={!pressable}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        (onPress ?? item.onPress)?.();
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: touch,
        paddingHorizontal: INSET,
        paddingVertical: item.under && item.description ? 7 : 0,
        borderRadius: RADIUS - PAD,
        backgroundColor: held ? wash : undefined,
        outlineStyle: "none",
      } as object}
    >
      {icon ? <View style={{ width: 20, alignItems: "center", justifyContent: "center", opacity: dim }}>{icon}</View> : null}
      {item.under && item.description ? (
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[t.row, LABEL, { color: ink }]}>
            {item.label}
          </Text>
          <Text numberOfLines={2} style={[t.small, { marginTop: 1 }]}>
            {item.description}
          </Text>
        </View>
      ) : (
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text numberOfLines={1} style={[t.row, LABEL, { flexShrink: 0, maxWidth: "100%", color: ink }]}>
            {item.label}
          </Text>
          {item.description ? (
            <Text numberOfLines={1} style={[t.row, LABEL, { flexShrink: 1, color: c.muted }]}>
              {item.description}
            </Text>
          ) : null}
        </View>
      )}
      {item.trailing && off ? <View style={{ opacity: dim }}>{item.trailing}</View> : (item.trailing ?? null)}
      {item.value ? (
        <Text numberOfLines={1} style={[t.row, LABEL, { color: c.muted, flexShrink: 0 }]}>
          {item.value}
        </Text>
      ) : null}
      {item.checked ? <Icon name="check" size={18} stroke={2} color={off ? alpha(c.text, DISABLED_MARK) : c.text} /> : null}
      {chevron || item.submenu || item.value ? <Icon name="chevronRight" size={16} color={off ? alpha(c.muted, DISABLED_MARK) : c.muted} /> : null}
    </Pressable>
  );
}

/**
 * A list of entries with its submenus: a submenu replaces the list in place, headed by a back row naming its parent.
 * `onDone` runs after a row that closes the menu.
 */
export function MenuList({ entries, onDone }: { entries: readonly MenuEntry[]; onDone?: () => void }) {
  const { c, t } = useTheme();
  const [trail, setTrail] = useState<readonly MenuRowItem[]>([]);
  const open = trail[trail.length - 1];
  const shown = open?.submenu ?? entries;
  return (
    <Animated.View key={trail.length} entering={trail.length ? enter.fade : undefined}>
      {open ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Back from ${open.label}`}
            onPress={() => {
              haptic.tick();
              setTrail(trail.slice(0, -1));
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch, paddingHorizontal: INSET - 2 }}
          >
            <Icon name="chevronLeft" size={18} color={c.muted} />
            <Text numberOfLines={1} style={[t.row, LABEL, { fontWeight: "500", flexShrink: 1 }]}>
              {open.label}
            </Text>
          </Pressable>
          <MenuSeparator />
        </>
      ) : null}
      {shown.map((entry, i) => {
        if (entry.type === "heading") return <MenuHeading key={`h-${entry.label}`} label={entry.label} />;
        if (entry.type === "separator") return <MenuSeparator key={`s-${i}`} />;
        return (
          <MenuRow
            key={entry.label}
            item={entry}
            onPress={
              entry.submenu
                ? () => setTrail([...trail, entry])
                : entry.onPress
                  ? () => {
                      entry.onPress?.();
                      if (!entry.keepOpen) onDone?.();
                    }
                  : undefined
            }
          />
        );
      })}
    </Animated.View>
  );
}

/** Where a menu hangs from: its trigger's box on the screen. */
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A ref for a trigger and a way to read where it is, for `Menu`'s anchor. */
export function useAnchor() {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const measure = useCallback(
    () =>
      new Promise<Anchor | null>((resolve) => {
        if (!ref.current) return resolve(null);
        ref.current.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
      }),
    [],
  );
  return { ref, measure };
}

/** About how tall a list of entries stands, before it is laid out: rows 44 (58 with a line under), headings 30, rules 13. */
function estimate(entries: readonly MenuEntry[]) {
  return entries.reduce((h, e) => h + (e.type === "separator" ? 13 : e.type === "heading" ? 30 : (e as MenuRowItem).under && (e as MenuRowItem).description ? 58 : 44), 2 * PAD + 2);
}

// It grows out of its button like iOS 26's menus. Liquid Glass renders wrong under opacity, so there it only grows;
// the frosted glass elsewhere grows and fades in with it.
const liquid = isLiquidGlassAvailable();
const grow = new Keyframe({
  0: { opacity: liquid ? 1 : 0, transform: [{ scale: 0.6 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: ease.snap },
}).duration(260);
const shrink = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: liquid ? 1 : 0, transform: [{ scale: liquid ? 0.4 : 0.9 }], easing: ease.snap },
}).duration(160);

/** What a menu hangs over: the screen dimmed and softly blurred, so the glass reads as the one thing in front. */
function Backdrop({ onClose }: { onClose: () => void }) {
  const { c, dark } = useTheme();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={StyleSheet.absoluteFill}>
      {Platform.OS !== "android" ? <BlurView intensity={dark ? 14 : 10} tint={dark ? "dark" : "light"} style={StyleSheet.absoluteFill} /> : null}
      <Pressable accessibilityLabel="Close the menu" style={[StyleSheet.absoluteFill, { backgroundColor: alpha(c.scrim, dark ? 0.32 : 0.14) }, { outlineStyle: "none" } as object]} onPress={onClose} />
    </Animated.View>
  );
}

/**
 * The menu as a popover, hung from its trigger: under it where its head and rows fit, over it otherwise (the
 * composer's menus open upward), aligned to the trigger's `align` edge, kept 12pt inside the screen. It grows out of
 * that corner over a dimmed screen and closes on a tap outside. Without an anchor it rises from the bottom like a
 * sheet's menu. A `header` (a chat's card) counts toward the room it needs, and the rows scroll under it when they
 * don't all fit. native is 250 wide.
 */
export function Menu({ open, onClose, anchor, align = "start", width = 250, entries, header }: { open: boolean; onClose: () => void; anchor?: Anchor | null; align?: "start" | "end"; width?: number; entries: readonly MenuEntry[]; header?: ReactNode }) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [headH, setHeadH] = useState(0);
  const room = 12;
  const w = Math.min(width, screenW - room * 2);
  const maxH = screenH - insets.top - insets.bottom - room * 4;
  const below = anchor ? screenH - (anchor.y + anchor.height) : 0;
  const above = anchor ? anchor.y : 0;
  // What the menu takes beyond its rows: the gap to its trigger, the surface's padding and its edge.
  const chrome = 6 + 2 * PAD + 2;
  const up = anchor ? headH + estimate(entries) > below - insets.bottom - room - 6 && above > below : true;
  const left = anchor ? Math.max(room, Math.min(screenW - w - room, align === "end" ? anchor.x + anchor.width - w : anchor.x)) : (screenW - w) / 2;
  const vertical = anchor ? (up ? { bottom: screenH - anchor.y + 6 } : { top: anchor.y + anchor.height + 6 }) : { bottom: insets.bottom + room };
  const origin = `${align === "end" ? "right" : "left"} ${up ? "bottom" : "top"}`;
  const scrollH = Math.max(88, Math.min(maxH, (up ? above - insets.top : below - insets.bottom) - room - chrome) - headH);
  return (
    <Modal transparent visible={open} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {open ? <Backdrop onClose={onClose} /> : null}
      {open ? (
        // A plain view holds the place and the animated one inside it only scales and fades: on the web a keyframe
        // entrance freezes the position it starts at, which would pin the menu's top while a submenu grows upward.
        <View pointerEvents="box-none" style={{ position: "absolute", left, width: w, ...vertical }}>
          <Animated.View entering={grow} exiting={shrink} style={{ transformOrigin: origin }}>
            <MenuSurface>
              <View onLayout={(e) => setHeadH(e.nativeEvent.layout.height)}>{header}</View>
              {/* The scroller spans the padding too, so a held row's wash reaches the padding's edge. */}
              <ScrollView style={{ marginHorizontal: -PAD, maxHeight: scrollH }} contentContainerStyle={{ paddingHorizontal: PAD }} bounces={false} showsVerticalScrollIndicator={false}>
                <MenuList entries={entries} onDone={onClose} />
              </ScrollView>
            </MenuSurface>
          </Animated.View>
        </View>
      ) : null}
    </Modal>
  );
}

/**
 * A trigger with its menu: give it what it shows (`children`, something 44pt) and the entries. It measures itself on
 * a press, so the menu hangs from wherever it is. It gives under the finger by scale, never by fading, so a Glass
 * button inside it stays glass.
 */
export function MenuButton({ label, entries, align = "end", width, children, header }: { label: string; entries: readonly MenuEntry[]; align?: "start" | "end"; width?: number; children: ReactNode; header?: ReactNode }) {
  const { ref, measure } = useAnchor();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <View ref={ref} collapsable={false}>
        <Squish
          label={label}
          depth={0.9}
          hitSlop={4}
          onPress={async () => {
            setAnchor(await measure());
            setOpen(true);
          }}
        >
          {children}
        </Squish>
      </View>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} align={align} width={width} entries={entries} header={header} />
    </>
  );
}
