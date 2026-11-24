// A list of chats as the phone shows every list of agents (a tile's, a Chief's, a workspace's, a device's): grouped by
// where each stands (Pinned, Needs you, Ready, Working, Snoozed, Done; the desktop's queue sections), each group a
// head you can fold, and virtualized, so forty or four hundred rows cost what the screen shows (Legend List).
//
// Rows never move under a thumb (Happy's rule, DECISIONS.md): within a group each keeps the place it first had, a new
// one arrives at the top (asks at the bottom, oldest first, so the one that has waited longest leads), and while a
// finger is on the list nothing re-sorts at all; what changed lands a moment after you let go.
//
// What acts on a whole group (Mark all seen, Archive all) sits at the right of its head, or, when the group is the
// list's only one and has no head, at the right of the list's title line (`top` gets it); once taken, Undo stands in
// that same spot for 4 s (actions.ts useBulk). No line ever holds only the action, and no toast carries its Undo.
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { Icon } from "../../components/Icon";
import { PanelEmpty } from "../../components/ui/Empty";
import { useUsualDevice } from "../../home/model";
import { Quiet } from "../../home/Quiet";
import { haptic } from "../../motion";
import type { Row } from "../../store/select";
import { layout, useTheme, weight } from "../../theme";
import { ARM_MS } from "../../thread/AskDock";
import { type Inbox, type QueueSection } from "../inbox";
import { archiveAll, type Bulk, markAllSeen, undoBulk, useBulk } from "./actions";
import { moved } from "./answers";
import { ChatRow } from "./ChatRow";

const GROUPS: readonly { id: QueueSection; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "needs", label: "Needs you" },
  { id: "finished", label: "Ready" },
  // Ready ones you've looked at: folded at the foot of Ready until they ship or are archived, never Done.
  { id: "seen", label: "Seen" },
  { id: "working", label: "Working" },
  { id: "snoozed", label: "Snoozed" },
  { id: "done", label: "Done" },
];

/** A whole group's action, offered on its rows. */
export type Offer = { run: "seen" | "archive"; rows: readonly Row[] };

type Item =
  | { kind: "top"; key: string }
  | {
      kind: "head";
      key: string;
      group: QueueSection;
      label: string;
      count: number;
      open: boolean;
      /** What acts on the whole group from the head's right: the slot its Undo is held by, and what it offers now. */
      slot?: { where: string; offer: Offer | null };
      /** Not a fold: a group that has just gone (Archive all), kept as a line while its Undo holds. */
      still?: boolean;
    }
  | { kind: "row"; key: string; row: Row; last: boolean; named: boolean }
  | { kind: "empty"; key: string }
  /** `held`: room kept for the rows a whole-group action just took away, while its Undo holds. */
  | { kind: "foot"; key: string; held: number };

/** A two-line row's height, near enough: the room a whole-group action keeps for each row it took. */
const ROW_ESTIMATE = 64;

// Which groups are folded, by list, for as long as the app runs: coming back to a list finds it as you left it.
const folded = new Map<string, Set<QueueSection>>();

const STAGE: Record<Row["phase"], QueueSection> = { needs: "needs", ready: "finished", working: "working", done: "done" };

/**
 * Where a row sits: snoozed and settled chats on their shelves, pinned ones on top, the rest by their status with
 * their subagents' (a parent whose child asks something is in Needs you, not Working).
 */
export function sectionOf(row: Row, inbox: Inbox): QueueSection {
  const raw = inbox.section(row.chat);
  if (raw === "snoozed" || raw === "done" || raw === "pinned" || raw === "seen") return raw;
  return STAGE[row.phase];
}

/** Each row's place, kept for as long as the list is on screen. */
function useStableOrder(rows: readonly Row[], inbox: Inbox): Map<QueueSection, Row[]> {
  const place = useRef(new Map<string, { group: QueueSection; rank: number }>());
  const ends = useRef({ top: 0, bottom: 0 });
  return useMemo(() => {
    const groups = new Map<QueueSection, Row[]>();
    for (const r of rows) {
      const g = sectionOf(r, inbox);
      const list = groups.get(g) ?? [];
      list.push(r);
      groups.set(g, list);
    }
    const first = place.current.size === 0;
    for (const [g, list] of groups) {
      // The first time, asks oldest first and everything else newest first; after that, a row keeps its rank.
      const fresh = list.filter((r) => place.current.get(r.chat.id)?.group !== g);
      fresh.sort((a, b) => (g === "needs" ? inbox.since(a.chat) - inbox.since(b.chat) : inbox.since(b.chat) - inbox.since(a.chat)));
      if (first) fresh.forEach((r, i) => place.current.set(r.chat.id, { group: g, rank: i }));
      else if (g === "needs") for (const r of fresh) place.current.set(r.chat.id, { group: g, rank: ++ends.current.bottom + 1e6 });
      else for (const r of [...fresh].reverse()) place.current.set(r.chat.id, { group: g, rank: --ends.current.top });
      list.sort((a, b) => place.current.get(a.chat.id)!.rank - place.current.get(b.chat.id)!.rank);
    }
    return groups;
  }, [rows, inbox]);
}

/** The value as it was while a finger is on the list; the new one a moment after it lifts. */
function useHeld<T>(value: T): { value: T; hold: () => void; let: () => void } {
  const [, tick] = useState(0);
  const held = useRef(false);
  const shown = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!held.current) shown.current = value;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return {
    value: shown.current,
    hold: () => {
      if (timer.current) clearTimeout(timer.current);
      held.current = true;
    },
    let: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        held.current = false;
        tick((n) => n + 1);
      }, 450);
    },
  };
}

/** What a group offers on all its rows at once: Ready marks them seen, Done archives them. */
function offerOf(group: QueueSection, rows: readonly Row[], inbox: Inbox): Offer | null {
  if (group === "finished" && rows.some((r) => inbox.unread(r.chat))) return { run: "seen", rows };
  if (group === "done" && rows.some((r) => r.chat.phase !== "working")) return { run: "archive", rows };
  return null;
}

/** A group's head: its name and size, folding on a tap; at the right, what acts on the whole group. */
function Head({ item, inbox, onToggle }: { item: Extract<Item, { kind: "head" }>; inbox: Inbox; onToggle: () => void }) {
  const { c, t } = useTheme();
  const words = (
    <>
      <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.subtle }]}>{item.label}</Text>
      <Text style={[t.meta, { fontSize: 15, lineHeight: 20, color: c.subtle }]}>{item.count}</Text>
    </>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 20, paddingLeft: layout.inset, paddingRight: layout.inset - 4 }}>
      {item.still ? (
        <View accessible accessibilityLabel={`${item.label} ${item.count}`} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 }}>
          {words}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.label}, ${item.count}`}
          accessibilityState={{ expanded: item.open }}
          accessibilityHint={item.open ? "Folds the group" : "Shows the group"}
          onPress={() => {
            haptic.tick();
            onToggle();
          }}
          style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          {words}
          <View style={{ transform: [{ rotate: item.open ? "0deg" : "-90deg" }] }}>
            <Icon name="chevronDown" size={14} color={c.subtle} />
          </View>
        </Pressable>
      )}
      {/* Dead room between the fold and the action: 12 pt at least, so a tap meant for one never lands on the other. */}
      <View style={{ flex: 1, minWidth: 12 }} />
      {item.slot ? <BulkSlot where={item.slot.where} offer={item.open ? item.slot.offer : null} inbox={inbox} /> : null}
    </View>
  );
}

const OFFER_LABEL = { seen: "Mark all seen", archive: "Archive all" } as const;

/**
 * A whole group's action, at the right of its head or of the list's title line: "Mark all seen" or "Archive all" at
 * 15/500 in the description grey. Once taken, Undo (15/600, ink) stands in the same spot for 4 s, and the rows have
 * already gone where they go (folded under Seen, or archived). Either is a 44 pt target laid over its 20 pt line, so
 * the line keeps its height when one becomes the other; 8 pt of its padding lies past the words at the right.
 */
export function BulkSlot({ where, offer, inbox }: { where: string; offer: Offer | null; inbox: Inbox }) {
  const { c, t } = useTheme();
  const held = useBulk(where);
  if (held) return <BulkUndo held={held} />;
  if (!offer) return null;
  const label = OFFER_LABEL[offer.run];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        haptic.tap();
        const chats = offer.rows.map((r) => r.chat);
        if (offer.run === "archive") archiveAll(chats, where);
        else markAllSeen(chats, inbox, where);
      }}
      style={({ pressed }) => ({ minHeight: 44, marginVertical: -12, paddingHorizontal: 8, justifyContent: "center", opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={[t.row, { fontSize: 15, lineHeight: 20, fontWeight: weight.medium, color: c.muted }]}>{label}</Text>
    </Pressable>
  );
}

/** Undo where the action was. Deaf for ARM_MS, so the second tap of a double tap never takes the first back. */
function BulkUndo({ held }: { held: Bulk }) {
  const { c, t } = useTheme();
  const words = held.kind === "seen" ? `Marked ${held.count} seen` : `Archived ${held.count} ${held.count === 1 ? "chat" : "chats"}`;
  // VoiceOver hears what happened and that it can still be taken back.
  useEffect(() => AccessibilityInfo.announceForAccessibility(`${words}. Undo is where it was.`), [words]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Undo: ${words}`}
      onPress={() => {
        if (Date.now() - held.at < ARM_MS) return;
        haptic.tap();
        undoBulk(held.where);
      }}
      style={({ pressed }) => ({ minHeight: 44, marginVertical: -12, paddingHorizontal: 8, justifyContent: "center", opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={[t.row, { fontSize: 15, lineHeight: 20, fontWeight: weight.semibold, color: c.text }]}>Undo</Text>
    </Pressable>
  );
}

export function ChatList({
  id,
  rows,
  inbox,
  top,
  empty,
  emptyLine,
  emptyIcon,
  ask = false,
  heads: always = false,
  named = false,
  place = true,
  device,
  bottom,
  onOpen,
  onScrolled,
  scrollY,
  onEnd,
}: {
  /** Which list this is, so its folded groups are remembered. */
  id: string;
  rows: readonly Row[];
  inbox: Inbox;
  /**
   * What leads the list: its title, a device's head, Review's shelf. Given a function, it gets the slot for the right
   * of the title's line: a lone group's Mark all seen or Archive all (its Undo once taken), or null.
   */
  top: ReactNode | ((slot: ReactNode) => ReactNode);
  empty: string;
  emptyLine?: string;
  emptyIcon?: Exclude<PixelIconName, "engine-caveman">;
  /** The Needs you list: rows show their command with Deny and Allow. */
  ask?: boolean;
  /** Head every group, even a lone one. */
  heads?: boolean;
  /** The list's title names its rows' state (the Working, Ready and Needs you lists): rows don't say it again. */
  named?: boolean;
  /** Rows say where they live (not in a workspace's own list). */
  place?: boolean;
  /** A device's own list: its rows never name it. */
  device?: string;
  /** Room under the last row, for the chat bar. */
  bottom: number;
  onOpen: (id: string) => void;
  /** Whether the list has scrolled past its title (the bar shows the title then). */
  onScrolled?: (past: boolean) => void;
  /** How far it has scrolled, for the bar's edge (components/ProgressiveEdge.tsx). */
  scrollY?: SharedValue<number>;
  /** Told where the last row ends in the list (its foot's top), so the chat bar's band knows (ProgressiveEdge useContentEnd). */
  onEnd?: (y: number) => void;
}) {
  const usualAcross = useUsualDevice();
  const usual = device ?? usualAcross;
  const placed = useStableOrder(rows, inbox);
  // What the data does waits for the finger to lift; what you do (folding a group) shows at once.
  const held = useHeld(placed);
  const groups = held.value;
  const [shut, setShut] = useState<Set<QueueSection>>(() => {
    const was = folded.get(id);
    if (was) return was;
    // The past folds by default where there is a present to read first.
    const start = new Set<QueueSection>(["seen"]);
    if ((groups.get("done")?.length ?? 0) > 0 && [...groups.keys()].some((g) => g !== "done")) start.add("done");
    return start;
  });
  useEffect(() => void folded.set(id, shut), [id, shut]);
  // Where each whole-group action keeps its Undo: the title's line (a lone group), Ready's head, Done's head.
  const at = { title: `${id}:title`, seen: `${id}:head:seen`, archive: `${id}:head:archive` };
  const titleHeld = useBulk(at.title);
  const seenHeld = useBulk(at.seen);
  const archiveHeld = useBulk(at.archive);

  const { items, lone } = useMemo(() => {
    const out: Item[] = [{ kind: "top", key: "top" }];
    const present = GROUPS.filter((g) => groups.get(g.id)?.length);
    // One group needs no head: the list's own title already names it. Seen always has one, as it folds, and it
    // doesn't count toward the others' (the Ready page with some seen has no "Ready" head over its unseen rows).
    const heads = always || present.filter((g) => g.id !== "seen").length > 1;
    const finishedHeaded = heads && present.some((g) => g.id === "finished");
    let lone: Offer | null = null;
    for (const g of present) {
      const list = groups.get(g.id)!;
      const headed = heads || g.id === "seen";
      const open = !headed || !shut.has(g.id);
      // A head that names a state names its rows' (Pinned and Snoozed don't; a row there still says where it stands).
      const said = named || (headed && g.id !== "pinned" && g.id !== "snoozed");
      const offer = offerOf(g.id, list, inbox);
      // A group with no head offers its action on the title's line instead.
      if (!headed && offer) lone = offer;
      // Mark all seen's Undo stays on Ready's head; once Ready has emptied into Seen, on Seen's, which took its place.
      const slot =
        g.id === "finished" ? { where: at.seen, offer } : g.id === "seen" && !finishedHeaded && seenHeld ? { where: at.seen, offer: null } : g.id === "done" ? { where: at.archive, offer } : undefined;
      if (headed) out.push({ kind: "head", key: `head-${g.id}`, group: g.id, label: g.label, count: list.length, open, slot });
      if (open) list.forEach((row, i) => out.push({ kind: "row", key: row.chat.id, row, last: i === list.length - 1, named: said }));
    }
    // Archive all emptied Done: its head stays as a line saying so, with Undo where Archive all was, while Undo holds.
    if (archiveHeld && !groups.get("done")?.length)
      out.push({ kind: "head", key: "head-done", group: "done", label: "Archived", count: archiveHeld.count, open: false, still: true, slot: { where: at.archive, offer: null } });
    if (!present.length) out.push({ kind: "empty", key: "empty" });
    // While an Undo holds, the list keeps the height the rows it took had, so a list scrolled to its end isn't pulled
    // down under the thumb and the Undo stays where the button was; the room goes with the Undo.
    const took = (titleHeld?.count ?? 0) + (seenHeld?.count ?? 0) + (archiveHeld?.count ?? 0);
    out.push({ kind: "foot", key: "foot", held: took * ROW_ESTIMATE });
    return { items: out, lone };
    // The held actions are read so the top and the heads redraw when an Undo comes and goes.
  }, [groups, shut, always, named, inbox, at.title, at.seen, at.archive, titleHeld, seenHeld, archiveHeld]);
  // The title line's slot: a lone group's action, or its Undo while that holds.
  const slot = titleHeld || lone ? <BulkSlot where={at.title} offer={lone} inbox={inbox} /> : null;
  // Rows came, went or moved: whatever is under the thumb may be another row now, so answers wait a beat. Only the
  // list's shape counts; a row's words changing moves nothing.
  const shape = items.map((i) => i.key).join("\n");
  useEffect(() => moved(), [shape]);
  const past = useRef(false);
  // Where the foot starts: the end of the last real row, however the rows above it grow, fold or go.
  const list = useRef<LegendListRef>(null);
  const toldEnd = useRef(onEnd);
  toldEnd.current = onEnd;
  useEffect(() => {
    const state = list.current?.getState();
    if (!state) return;
    const at = state.positionByKey("foot");
    if (at !== undefined) toldEnd.current?.(at);
    return state.listenToPosition("foot", (y) => toldEnd.current?.(y));
  }, []);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (scrollY) scrollY.value = e.nativeEvent.contentOffset.y;
    const now = e.nativeEvent.contentOffset.y > 36;
    if (now !== past.current) {
      past.current = now;
      onScrolled?.(now);
    }
  };

  return (
    <View style={{ flex: 1 }} onTouchStart={held.hold} onTouchEnd={held.let} onTouchCancel={held.let}>
      <LegendList<Item>
        data={items}
        style={{ flex: 1 }}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        estimatedItemSize={64}
        recycleItems={false}
        extraData={inbox}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        ref={list}
        // The web's list hands unknown props to its div, which has no keyboard to manage.
        {...(Platform.OS === "web" ? null : { keyboardDismissMode: "interactive" as const, keyboardShouldPersistTaps: "handled" as const })}
        renderItem={({ item }) => {
          if (item.kind === "top") return <>{typeof top === "function" ? top(slot) : top}</>;
          if (item.kind === "foot") return <View style={{ height: bottom + item.held }} />;
          // Empty, its glyph is grey like a quiet tile's: an empty Needs you shows no amber, an empty Ready no green.
          // It stands where PanelEmpty puts its own, 12 over the title (PanelEmpty's 40 of padding, less 28).
          if (item.kind === "empty")
            return (
              <View style={{ paddingTop: 48 + 40 }}>
                <View style={{ alignItems: "center", marginBottom: 12 - 40 }}>
                  <Quiet name={emptyIcon ?? "inbox"} size={16} />
                </View>
                <PanelEmpty title={empty} line={emptyLine} />
              </View>
            );
          if (item.kind === "head")
            return (
              <Head
                item={item}
                inbox={inbox}
                onToggle={() =>
                  setShut((was) => {
                    const next = new Set(was);
                    if (next.has(item.group)) next.delete(item.group);
                    else next.add(item.group);
                    return next;
                  })
                }
              />
            );
          return <ChatRow chat={item.row.chat} phase={item.row.phase} inbox={inbox} usual={usual} ask={ask} place={place} named={item.named} last={item.last} onPress={() => onOpen(item.row.chat.id)} />;
        }}
      />
    </View>
  );
}
