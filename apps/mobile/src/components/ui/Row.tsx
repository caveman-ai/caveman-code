// A list row and a section heading on the desktop's anatomy (apps/web/src/shell/Sidebar.tsx: NavRow, WorkspaceRow,
// QueueRow, SectionHeader; STYLE.md 4-5). One text edge for every row; a 16pt icon (pixel art in the description grey,
// or a logo) in a 20pt slot; the label at row size; a description in grey on the same line, truncating first; an
// optional second line of meta in the tertiary grey; whatever the row ends on (its state, a count, a chevron) at the
// right. A read chat sits back at 65% ink and regular; unread or open lifts to full ink at 500, never semibold. The
// selected row takes the selected fill; a held row the hover fill. Headings are small, quiet and sentence case.
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { haptic } from "../../motion";
import { alpha, radius, touch, useTheme } from "../../theme";
import { Icon } from "../Icon";

/**
 * What the row sits on decides its fills: the `shell` (the sidebar: --sidebar-accent selected, at 60% while held),
 * a `panel` or card (--accent), or `glass` (the floating sidebar pane: a wash of the text colour, which reads on any
 * glass).
 */
export type Surface = "shell" | "panel" | "glass";

function fills(surface: Surface, c: ReturnType<typeof useTheme>["c"]) {
  if (surface === "glass") return { selected: alpha(c.text, 0.1), held: alpha(c.text, 0.06) };
  if (surface === "shell") return { selected: c.selected, held: alpha(c.selected, 0.6) };
  return { selected: c.raised, held: c.raised };
}

export interface RowProps {
  label: string;
  /** Grey words on the same line, after the label: they truncate before it does. */
  description?: string;
  /** A second line under the label (the queue's project, ask and age): 13pt in the tertiary grey. Text or a node. */
  meta?: ReactNode;
  /** A 16pt glyph: a PixelIcon in the description grey, an EngineLogo, a PixelFolder. */
  icon?: ReactNode;
  /** What the row ends on: a state mark, a Count, a Dot, a chevron. */
  trailing?: ReactNode;
  /** A chevron at the end: the row opens a page. */
  chevron?: boolean;
  selected?: boolean;
  /** `read`: a chat seen since it last changed, at 65% ink. `unread`: full ink at 500. Absent: a nav row, full ink at 400. */
  tone?: "read" | "unread";
  surface?: Surface;
  /** Steps in under a parent (a project's chats hang 22pt in). */
  indent?: number;
  /** Room between the glyph and the words: 10, or 12 on a page's list, whose words share x 48 with every list. */
  gap?: number;
  /** The row's height without a meta line: 44, the smallest a finger can hit. */
  height?: number;
  onPress?: () => void;
  onLongPress?: () => void;
  /** What a screen reader hears when the label isn't all (a status, a count). */
  accessibilityLabel?: string;
}

export function Row({ label, description, meta, icon, trailing, chevron, selected, tone, surface = "panel", indent = 0, gap = 10, height = touch, onPress, onLongPress, accessibilityLabel }: RowProps) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  const fill = fills(surface, c);
  const ink = tone === "read" && !selected ? alpha(c.text, 0.65) : c.text;
  const strong = tone === "unread" || (tone !== undefined && selected);
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel ?? [label, description].filter(Boolean).join(", ")}
      accessibilityState={{ selected }}
      disabled={!onPress && !onLongPress}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onPress?.();
      }}
      onLongPress={onLongPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap,
        minHeight: height,
        paddingVertical: meta ? 7 : 0,
        paddingLeft: 10 + indent,
        paddingRight: 10,
        borderRadius: radius.row,
        backgroundColor: selected ? fill.selected : held ? fill.held : undefined,
      }}
    >
      {icon ? <View style={{ width: 20, alignItems: "center", justifyContent: "center", alignSelf: meta ? "flex-start" : "center", marginTop: meta ? 3 : 0 }}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text numberOfLines={1} style={[t.row, { flexShrink: description ? 0 : 1, maxWidth: "100%", color: ink, fontWeight: strong ? "500" : "400" }]}>
            {label}
          </Text>
          {description ? (
            <Text numberOfLines={1} style={[t.row, { flexShrink: 1, color: c.muted }]}>
              {description}
            </Text>
          ) : null}
        </View>
        {meta ? typeof meta === "string" ? <Text numberOfLines={1} style={t.meta}>{meta}</Text> : meta : null}
      </View>
      {trailing ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>{trailing}</View> : null}
      {chevron ? <Icon name="chevronRight" size={16} color={c.muted} /> : null}
    </Pressable>
  );
}

/**
 * A section's heading (SectionHeader, the sidebar's "Chiefs" and "Projects"): 13pt at 500 in the tertiary grey, its
 * count beside it, then whatever acts on the section at the right (a + for a new one). `open`/`onToggle` make it a
 * shelf that folds, its chevron after the count.
 */
export function Section({ label, count, open, onToggle, children, first = false }: { label: string; count?: number; open?: boolean; onToggle?: () => void; children?: ReactNode; first?: boolean }) {
  const { c, t } = useTheme();
  const head = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text accessibilityRole="header" style={t.section}>
        {label}
      </Text>
      {count !== undefined ? <Text style={[t.meta, { fontWeight: "500" }]}>{count}</Text> : null}
      {onToggle ? (
        <View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
          <Icon name="chevronDown" size={14} color={c.subtle} />
        </View>
      ) : null}
    </View>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 36, paddingLeft: 10, paddingRight: 4, marginTop: first ? 4 : 16 }}>
      {onToggle ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${open ? "shown" : "folded"}`} accessibilityState={{ expanded: open }} onPress={onToggle} hitSlop={8} style={{ flex: 1, minHeight: 36, justifyContent: "center" }}>
          {head}
        </Pressable>
      ) : (
        <View style={{ flex: 1 }}>{head}</View>
      )}
      {children}
    </View>
  );
}
