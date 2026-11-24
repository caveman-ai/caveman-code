// What Review, Automations and Plugins share, as the desktop draws it for each: the pills that pick a tab or a scope
// (plugins/shared.tsx Pills, Browse.tsx's tabs), a quiet heading over a list (automations/Frame.tsx ListGroup,
// review/Queue.tsx's group headers), a bordered list of rows (plugins/shared.tsx HubSection), a fact on one line
// (Frame.tsx RailRow, and a sheet's dl grid), an author's round mark and the "+a −d" of a change (review/parts.tsx
// Avatar and Stat), the bar over what a list opened (Frame.tsx Bar: the way back, then the verbs), a sheet that rises
// over the whole app, and the are-you-sure before what can't be taken back (ConfirmDialog).
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Icon } from "../../components/Icon";
import { Squish } from "../../components/Squish";
import { Button } from "../../components/ui/Button";
import { haptic } from "../../motion";
import { COMPOSER_HEIGHT, COMPOSER_ROOM } from "../../shell/Composer";
import { Sheet } from "../../shell/Sheet";
import { layout, radius, useTheme } from "../../theme";

/** The height a floating card stands over these pages' foot (the moment's card was 150). */
const COMPACT_HEIGHT = 150;

/**
 * The room these pages keep under their last row, past the composer's room that Page already keeps: a card that
 * floats over the foot rests no lower than a composer's top would be (the box and 12 over it) and stands
 * COMPACT_HEIGHT tall. These pages have no composer, so nothing should stay under it.
 */
/** The lists' one left column: heads and glyph boxes start here, at the 16 pt inset every screen shares (words at 48). */
export const LIST_X = layout.inset;

export const CARD_ROOM = COMPOSER_HEIGHT + 12 + COMPACT_HEIGHT - COMPOSER_ROOM;

/** "4m", "3h", "2d": an age as the desktop's rows say it (state/model.ts rowAge). */
export function age(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The clock, read again every `everyMs` so ages stay current. */
export function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** "4m ago", "just now": an age in a sentence (automations/model.ts ago). */
export const ago = (at: number, now = Date.now()) => {
  const a = age(at, now);
  return a === "now" ? "just now" : `${a} ago`;
};

/** "48s", "3m 12s", "1h 04m": how long something took (automations/model.ts duration). */
export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface Pill<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/**
 * Pills, one chosen: a scope switch (`round`, the desktop's rounded-full Pills with a count in the tertiary grey) or a
 * page's tabs (`square`, Browse.tsx's rounded-lg tabs). The chosen one sits on the control grey in full ink; the rest
 * are grey words. A scope row too long for the phone scrolls sideways. `wrap` lays tabs out on lines instead, so none
 * hides off the edge; with a `divider`, its kind of tab starts the second line, the way the desktop's row wraps.
 */
export function Pills<T extends string>({
  items,
  value,
  onChange,
  shape = "round",
  label,
  divider,
  wrap = false,
}: {
  items: readonly Pill<T>[];
  value: T;
  onChange: (value: T) => void;
  shape?: "round" | "square";
  label: string;
  /** Where one kind of tab ends and the next begins: a short rule, or a new line when wrapping. */ divider?: T;
  wrap?: boolean;
}) {
  const { c, t } = useTheme();
  const pills = items.map((item) => {
    const on = item.value === value;
    const pill = (
      <Squish
        key={item.value}
        role="tab"
        selected={on}
        label={item.count !== undefined ? `${item.label}, ${item.count}` : item.label}
        onPress={() => {
          haptic.tick();
          onChange(item.value);
        }}
        depth={0.96}
        hitSlop={4}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 12, borderRadius: shape === "round" ? 18 : radius.row, backgroundColor: on ? c.control : undefined }}
      >
        <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: on ? c.text : c.muted }]}>{item.label}</Text>
        {item.count !== undefined ? <Text style={t.meta}>{item.count}</Text> : null}
      </Squish>
    );
    if (item.value !== divider) return pill;
    // Wrapping, the next kind starts its own line; in one line, a short rule sits between the two.
    return wrap ? (
      [<View key="break" style={{ width: "100%" }} />, pill]
    ) : (
      <View key={item.value} style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ width: 1, height: 16, marginHorizontal: 8, backgroundColor: c.hairline }} />
        {pill}
      </View>
    );
  });
  if (wrap)
    return (
      <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 2, rowGap: 4, paddingHorizontal: 16 }}>
        {pills}
      </View>
    );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 16 }}
    >
      {pills}
    </ScrollView>
  );
}

/**
 * A quiet heading over a group of rows ("Active", "Paused", "Needs your review"): 13pt in the tertiary grey, its count
 * beside it, at the rows' text edge. `dot` puts the amber dot before it, where the group waits on you. `onToggle` makes
 * it fold, its chevron at the right edge (always showing: a finger has no hover to reveal it).
 */
export function Heading({
  label,
  count,
  dot,
  open = true,
  onToggle,
  tone = "subtle",
  first,
}: {
  label: string;
  count?: number;
  dot?: boolean;
  open?: boolean;
  onToggle?: () => void;
  tone?: "subtle" | "muted";
  first?: boolean;
}) {
  const { c, t } = useTheme();
  const body = (
    <>
      {dot ? <View accessibilityElementsHidden style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.warning }} /> : null}
      <Text accessibilityRole="header" style={[tone === "muted" ? t.group : t.meta, { flexShrink: 1 }]}>
        {label}
      </Text>
      {count !== undefined ? <Text style={t.meta}>{count}</Text> : null}
      {onToggle ? (
        <View style={{ marginLeft: "auto", transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevronRight" size={14} color={c.subtle} />
        </View>
      ) : null}
    </>
  );
  const style = { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 10, marginTop: first ? 0 : 12 } as const;
  if (!onToggle) return <View style={style}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${count ?? ""} ${open ? "shown" : "folded"}`} accessibilityState={{ expanded: open }} onPress={onToggle} style={style}>
      {body}
    </Pressable>
  );
}

/** A person's round mark: their initial on the control grey (review/parts.tsx Avatar without a picture). */
export function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  const { c, t } = useTheme();
  return (
    <View accessibilityElementsHidden style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.control, alignItems: "center", justifyContent: "center" }}>
      <Text style={[t.micro, { fontSize: Math.round(size * 0.5), lineHeight: size, fontWeight: "600", color: c.muted, textTransform: "uppercase" }]}>{login.slice(0, 1)}</Text>
    </View>
  );
}

const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));

/** "+48 −12" in the added and removed inks, a true minus, a zero saying nothing; nothing when nothing changed. */
export function Stat({ add, del }: { add: number; del: number }) {
  const { c, t } = useTheme();
  if (add === 0 && del === 0) return null;
  return (
    <Text accessibilityLabel={`${add} lines added, ${del} removed`} style={[t.line, { fontVariant: ["tabular-nums"] }]}>
      {add ? <Text style={{ color: c.added }}>+{short(add)}</Text> : null}
      {add && del ? " " : null}
      {del ? <Text style={{ color: c.removed }}>−{short(del)}</Text> : null}
    </Text>
  );
}

/**
 * A bottom sheet over the whole app (shell/Sheet.tsx in a modal layer), so the top bar and the floating card sit under
 * its dim instead of over it. The layer stays up until the sheet has slid away.
 */
export function Overlay({ open, onClose, title, accessory, children }: { open: boolean; onClose: () => void; title?: string; accessory?: ReactNode; children: ReactNode }) {
  const [up, setUp] = useState(open);
  useEffect(() => {
    if (open) return setUp(true);
    const timer = setTimeout(() => setUp(false), 450);
    return () => clearTimeout(timer);
  }, [open]);
  if (!up) return null;
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Sheet open={open} onClose={onClose} title={title} accessory={accessory}>
          {children}
        </Sheet>
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * Are you sure, for what can't be taken back (the desktop's ConfirmDialog, as a phone asks it): a sheet with the
 * question, one line on what happens, the red way forward and the way out under it.
 */
export function Confirm({
  open,
  title,
  line,
  confirm,
  cancel = "Keep it",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  line: string;
  confirm: string;
  cancel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { c, t } = useTheme();
  // The sheet keeps its words while it slides away.
  const last = useRef({ title, line, confirm, cancel });
  if (open) last.current = { title, line, confirm, cancel };
  const words = last.current;
  return (
    <Overlay open={open} onClose={onClose} title={words.title}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 8 }}>
        <Text style={[t.body, { fontSize: 15, lineHeight: 22, color: c.muted, marginBottom: 12 }]}>{words.line}</Text>
        <Button
          label={words.confirm}
          variant="destructive"
          stretch
          onPress={() => {
            haptic.tap();
            onConfirm();
            onClose();
          }}
        />
        <Button label={words.cancel} variant="ghost" stretch onPress={onClose} />
      </View>
    </Overlay>
  );
}
