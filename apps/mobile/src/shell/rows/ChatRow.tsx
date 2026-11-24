// A chat as a row in a list (DECISIONS.md O7, native two-line row): its state mark, the title, how long ago it
// moved at the right, and one line under it of at most three parts. Where the page's title or the group's head already
// names the state (the Working, Ready and Needs you lists, and every headed group), line 2 doesn't say it again and
// uses the slot for what is going on: a working chat's live sentence ("Running the relay suite · 143/200"), fading to
// "No recent update · 12m" when it has gone quiet; a ready chat's +adds −dels; the ask itself. Elsewhere the state word
// leads. Then where it lives, and the device only when it isn't your usual one or is away ("Waiting for Studio"). A
// draft you left in a chat takes line 2 ("Draft · check the backoff jitter…"), so a half-written steer is never lost
// among many agents; the mark still says the state. In the Needs you list a row also shows the command it asks to run,
// in mono, with Deny and Allow under it (ApprovalPair.tsx): an answer holds behind Undo with the row in place, then the
// row folds away (answers.ts). A Ready row ships the same way: its swipe right (and its menu's first entry) says
// "Shipping" on line 2 with Undo where the age was for 4 s, keeping the row's two lines, then the row folds and "Looks
// great, ship it" reaches the chat, as the Chief's Ship it sends it. A long press shows the chat's card and its menu
// (what the desktop's hover shows); a swipe ships, settles, snoozes, pins or archives it, and each of those is a
// VoiceOver action and a menu entry too.
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { type Chat, chiefById, chiefOf, type Phase, toolOf, totals } from "../../board/model";
import * as script from "../../board/script";
import { Icon } from "../../components/Icon";
import { PixelIcon } from "../../components/Pixel";
import { nowClause } from "../../components/transcript/LiveRow";
import { type Anchor, Menu } from "../../components/ui/Menu";
import { askerOf, deviceNote } from "../../home/model";
import { ease, haptic, useReducedMotion } from "../../motion";
import { askOf } from "../../store/select";
import { store, useStore } from "../../store/store";
import { alpha, layout, mono, radius, useTheme, weight } from "../../theme";
import { ARM_MS, DOCK_UNDO_MS } from "../../thread/AskDock";
import { ChatPeek, chatEntries } from "../ChatParts";
import { type Inbox, rowAge, wakeLabel } from "../inbox";
import { archive } from "../ui";
import { rowActions } from "./actions";
import { type Answer, answer, armed, FOLD_MS, undoAnswer, useAnswer } from "./answers";
import { CommandChip } from "../../components/ui/Choices";
import { ApprovalPair, ResolvedLine } from "./ApprovalPair";
import { StateWord } from "./StateWord";
import { SwipeRow } from "./SwipeRow";
import { usePane } from "../layout";

const MENU_WIDTH = 300;
/** Where a row's words start: the 16 pt inset (the one text column every screen shares), the 20 pt mark and its 12 pt gap (Home's rows share it): x 48. */
export const ROW_TEXT_X = layout.inset + 20 + 12;
/** The room a row leaves at its right: the same 16 pt inset as its left. */
const ROW_RIGHT = layout.inset;
/** A working chat that hasn't been heard from this long says so instead of its last sentence (Orca's stale decay). */
const STALE_MS = 10 * 60_000;

/**
 * When a working chat was last heard from: now while its live line is moving (the board's stand-in for the stream
 * advances it every few seconds; the runtime's is its last event), else its last step, message or phase. A parent is
 * heard through its subagents, so one waiting on busy agents isn't stuck.
 */
function heardAt(chat: Chat, chats: readonly Chat[], now: number, depth = 0): number {
  if (chat.phase === "working" && chat.script?.length) return now;
  let at = chat.updatedAt;
  if (depth < 6) for (const kid of chats) if (kid.parent === chat.id) at = Math.max(at, heardAt(kid, chats, now, depth + 1));
  return at;
}

/** The mark a row leads with: the same pixel family as Home's tiles. */
function RowMark({ phase, unread, snoozed }: { phase: Phase; unread: boolean; snoozed: boolean }) {
  const { c } = useTheme();
  if (snoozed) return <Icon name="snooze" size={16} color={c.subtle} />;
  if (phase === "needs") return <PixelIcon name="state-needs-you" ink={c.warning} />;
  if (phase === "working") return <PixelIcon name="state-working" />;
  // Ready and not yet looked at: the green check. Seen, it rests as a hollow dot until you settle it.
  if (phase === "ready") return unread ? <PixelIcon name="state-done" /> : <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: c.success }} />;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: alpha(c.text, 0.18) }} />;
}

/** One part of line 2. `lead` is a word in full ink before it ("Draft"). */
/** A part of line 2. `state`: it is the state word, drawn by the one StateWord (its colour and weight everywhere). */
type Part = { text: string; color?: string; lead?: string; diff?: { add: number; del: number }; state?: Phase };

/** The second line's parts, in order, at most three; the first is the one that gives way when the line is short. */
function partsOf(
  chat: Chat,
  phase: Phase,
  inbox: Inbox,
  usual: string,
  c: ReturnType<typeof useTheme>["c"],
  o: { ask: boolean; place: boolean; named: boolean; draft: string; now: number },
): Part[] {
  const note = deviceNote(chat, usual);
  const snoozed = inbox.snoozedUntil(chat);
  const where: Part[] = o.place ? [{ text: chat.repo }] : [];
  const device: Part[] = note && !note.waiting ? [{ text: note.device.name }] : [];
  if (snoozed !== null) return [{ text: `Snoozed, wakes in ${wakeLabel(snoozed, inbox.now)}`, color: c.soft }, ...where];
  // What you were writing to it leads; the mark keeps saying where it stands.
  if (o.draft) return [{ lead: "Draft", text: o.draft }];
  if (phase === "needs") {
    // The one question every screen asks it with (store/select.ts askOf); a subagent's says which one, in grey.
    const ask = askOf(chat, store.get().board.chats);
    const by: Part[] = ask.by ? [{ text: ask.by, color: c.subtle }] : [];
    // In the Needs you list every row asks, so each leads with its question and says whose board it is on.
    if (o.ask) {
      const chief = chiefOf(chat);
      return [{ text: ask.question, color: c.soft }, ...by, { text: chief ? chiefById(chief).name : "Your chat" }].slice(0, 3);
    }
    // A subagent asking says which one in place of where it lives, so the question keeps its room.
    if (o.named) return [{ text: ask.question, color: c.soft }, ...(by.length ? by : where)].slice(0, 3);
    return ([{ text: "Needs you", state: "needs" }, { text: ask.question }, ...by] as Part[]).slice(0, 3);
  }
  if (phase === "working") {
    if (note?.waiting) return [{ text: `Waiting for ${note.device.name}`, state: "working" }, ...where];
    if (!o.named) return [{ text: "Working", state: "working" }, ...where, ...device];
    // What it is doing and where: the sentence gives way first, and the device (it is on), not the place, goes.
    const heard = heardAt(chat, store.get().board.chats, o.now);
    if (o.now - heard > STALE_MS) return [{ text: `No recent update · ${rowAge(heard, o.now)}`, color: c.subtle }, ...where];
    return [{ text: chat.line ? nowClause(chat.line, toolOf(chat.line)) : "Working", color: c.soft }, ...where];
  }
  if (phase === "ready") {
    const sum = chat.moment ? totals(chat.moment.files) : null;
    const diff: Part[] = sum && (sum.add || sum.del) ? [{ text: "", diff: sum }] : [];
    if (o.named && diff.length + where.length) return [...diff, ...where];
    return [{ text: "Ready", state: "ready" }, ...diff, ...where];
  }
  // A merged chat says so; anything else that is over is Done (unless its head says that already).
  const merged = /^Merged\b/.test(chat.line);
  if (o.named && !merged && where.length + device.length) return [...where, ...device];
  return [{ text: merged ? chat.line : "Done", state: "done" }, ...where, ...device];
}

/** About how wide a character of line 2 (14 pt) is, a little over the average so a guess never runs long. */
const CH = 7.4;

/** Line 2's parts as wide as they'd draw, near enough, with the " · " between them. */
function widthOf(parts: readonly Part[]): number {
  const one = (p: Part) => (p.diff ? `+${p.diff.add} −${p.diff.del}`.length : (p.lead ? p.lead.length + 3 : 0) + p.text.length) * CH;
  return parts.reduce((n, p, i) => n + one(p) + (i ? 3 * CH : 0), 0);
}

/**
 * Line 2 fitted to `room`: the tail gives way first, a part at a time (where it lives, then which subagent), so the
 * part that says what is going on is said whole; only when it alone is too long is it cut, at a space, so a number, a
 * path or a package name is never cut through ("Running vitest transcript · 20/29" never ends "· 2…").
 */
function fitted(parts: readonly Part[], room: number): Part[] {
  const out = parts.slice();
  while (out.length > 1 && widthOf(out) > room) out.pop();
  const first = out[0];
  if (first && !first.diff && !first.state && widthOf(out) > room) {
    const max = Math.max(8, Math.floor(room / CH) - (first.lead ? first.lead.length + 3 : 0) - 1);
    const cut = first.text.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s·,;:—–-]+$/, "");
    if (cut.length > 0 && cut.length < first.text.length) out[0] = { ...first, text: `${cut}…` };
  }
  return out;
}

/** "+42 −3", each side in its diff ink; a zero side is left out. */
function Diff({ add, del }: { add: number; del: number }) {
  const { c } = useTheme();
  return (
    <>
      {add ? <Text style={{ color: c.added }}>+{add}</Text> : null}
      {add && del ? " " : null}
      {del ? <Text style={{ color: c.removed }}>−{del}</Text> : null}
    </>
  );
}

function PartText({ p }: { p: Part }) {
  const { c } = useTheme();
  if (p.diff) return <Diff add={p.diff.add} del={p.diff.del} />;
  if (p.state) return <StateWord phase={p.state} word={p.text} />;
  return (
    <Text style={p.color ? { color: p.color } : undefined}>
      {p.lead ? <Text style={{ color: c.text }}>{p.lead} · </Text> : null}
      {p.text}
    </Text>
  );
}

/** Room the title and line 2 leave at the right for a ship's Undo. */
const UNDO_ROOM = 48;

/**
 * A ship's Undo, where the row's age was: a 44 pt text button in ink, centred on the row's two lines. Deaf for ARM_MS,
 * so the end of the swipe that shipped it never takes it back.
 */
function ShipUndo({ given, title }: { given: Answer; title: string }) {
  const { c, t } = useTheme();
  useEffect(() => AccessibilityInfo.announceForAccessibility(`Shipping ${title}. Undo is next to it.`), [title]);
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, bottom: 0, right: layout.inset - 8, justifyContent: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Undo: ship ${title}`}
        onPress={() => {
          if (Date.now() - given.at < ARM_MS) return;
          haptic.tap();
          undoAnswer(given.id);
        }}
        style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 8, justifyContent: "center", opacity: pressed ? 0.6 : 1 })}
      >
        <Text style={[t.row, { fontSize: 15, lineHeight: 20, fontWeight: weight.semibold, color: c.text }]}>Undo</Text>
      </Pressable>
    </View>
  );
}

/** Whether a held answer has reached its fold: Undo's window is over, or it has landed. */
function useFolding(given: { at: number; landed: boolean } | undefined): boolean {
  const [folding, setFolding] = useState(false);
  useEffect(() => {
    if (!given) {
      setFolding(false);
      return;
    }
    const wait = given.landed ? 0 : given.at + DOCK_UNDO_MS - Date.now();
    if (wait <= 0) {
      setFolding(true);
      return;
    }
    setFolding(false);
    const timer = setTimeout(() => setFolding(true), wait);
    return () => clearTimeout(timer);
  }, [given]);
  return folding;
}

export function ChatRow({
  chat,
  phase,
  inbox,
  onPress,
  usual,
  ask = false,
  place = true,
  named = false,
  last = false,
}: {
  chat: Chat;
  /** Its status with its subagents' (select.ts phaseOf). */
  phase: Phase;
  inbox: Inbox;
  onPress: () => void;
  /** The device most chats run on: the row names its device only when it is another one. */
  usual: string;
  /** The Needs you list: the command in mono, with Deny and Allow under it. */
  ask?: boolean;
  /** Say where it lives; a workspace's own list doesn't, every row would say the same. */
  place?: boolean;
  /** The page's title or the group's head already names the state: line 2 says what is going on instead. */
  named?: boolean;
  /** The last row of its group draws no hairline. */
  last?: boolean;
}) {
  const { c, t } = useTheme();
  const still = useReducedMotion();
  const view = useRef<ComponentRef<typeof View>>(null);
  const [menu, setMenu] = useState<Anchor | null | false>(false);
  const draft = useStore((s) => s.sessions[chat.id]?.draft ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const unread = inbox.unread(chat);
  const snoozed = inbox.snoozedUntil(chat) !== null;
  const title = inbox.title(chat);
  // The inbox's clock moves each minute; a row drawn between its ticks reads the time it is drawn at, so its age and
  // its "No recent update · 11m" always agree.
  const now = Math.max(inbox.now, Date.now());
  const asker = phase === "needs" ? askerOf(chat, store.get().board.chats) : null;
  // An ask's age is how long it has waited on you (its subagent's, when one asks), the time every Needs you list and
  // the Queue sort by, so the ages down a list always read longest first.
  const age = rowAge(asker?.need?.at ?? inbox.since(chat), now);
  const command = ask && asker?.ask ? asker.ask : null;
  // An ask's answer is held by its asker; a ship by the ready chat itself.
  const given = useAnswer(command ? asker?.id : phase === "ready" ? chat.id : null);
  const shipping = given?.kind === "ship" && !given.landed ? given : undefined;
  const folding = useFolding(given);
  // While it ships, line 2 says so and keeps what it ships (its +adds −dels, where it lives); the swipes rest.
  const sum = shipping && chat.moment ? totals(chat.moment.files) : null;
  const { width: screenW } = usePane();
  const all: Part[] = shipping
    ? [{ text: "Shipping", color: c.text }, ...(sum && (sum.add || sum.del) ? [{ text: "", diff: sum }] : []), ...(place ? [{ text: chat.repo }] : [])]
    : partsOf(chat, phase, inbox, usual, c, { ask, place, named, draft, now });
  // The Needs you list says an ask whole over two lines; elsewhere line 2 is one line, fitted to its room.
  const parts = command ? all : fitted(all, screenW - ROW_TEXT_X - ROW_RIGHT - (shipping ? UNDO_ROOM : 0));
  const actions = shipping ? { leading: [], trailing: [] } : rowActions(chat, phase, inbox, c);
  // Ship it leads a Ready row's menu too, so it is never a swipe alone.
  const shipIt = actions.leading.find((a) => a.key === "ship");

  // The fold: from the row's height to nothing, ease-out with no overshoot; a cut under Reduce Motion.
  const height = useSharedValue(0);
  const fade = useSharedValue(1);
  useEffect(() => {
    if (!folding) {
      fade.value = 1;
      return;
    }
    height.value = still ? 0 : withTiming(0, { duration: FOLD_MS, easing: ease.drawer });
    fade.value = still ? 0 : withTiming(0, { duration: FOLD_MS * 0.6 });
  }, [folding, still, height, fade]);
  const foldStyle = useAnimatedStyle(() => ({ height: height.value, opacity: fade.value }));

  const open = () => {
    haptic.thud();
    if (!view.current) return setMenu(null);
    view.current.measureInWindow((x, y, width, height) => setMenu({ x, y, width, height }));
  };
  const said = [
    title,
    ...parts.map((p) => (p.diff ? `${p.diff.add} added, ${p.diff.del} removed` : p.lead ? `${p.lead}, ${p.text}` : p.text)),
    command ? `command ${command}` : null,
    age === "now" ? "just now" : `${age} ago`,
  ]
    .filter(Boolean)
    .join(", ");
  const line2 = [t.row, { fontSize: 14, lineHeight: 19, color: c.muted }];

  return (
    // Its height is known before a fold starts, so the fold starts from where the row stands.
    <Animated.View
      onLayout={(e) => {
        if (!folding) height.value = e.nativeEvent.layout.height;
      }}
      style={folding ? [{ overflow: "hidden" }, foldStyle] : undefined}
    >
      <View ref={view} collapsable={false}>
        <SwipeRow leading={actions.leading} trailing={actions.trailing}>
          {(tappable) => (
            <View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={said}
                accessibilityHint="Opens the chat"
                onPress={() => {
                  if (!tappable()) return;
                  haptic.tick();
                  onPress();
                }}
                onLongPress={() => tappable() && open()}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "flex-start",
                  minHeight: layout.row.double,
                  paddingLeft: layout.inset,
                  paddingRight: layout.inset,
                  paddingTop: 10,
                  paddingBottom: 10,
                  backgroundColor: pressed || menu !== false ? c.raised : c.panel,
                })}
              >
                <View style={{ width: 20, height: 22, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <RowMark phase={phase} unread={unread} snoozed={snoozed} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2, paddingRight: shipping ? UNDO_ROOM : 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
                    <Text numberOfLines={1} style={[t.row, { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: "400", color: c.text }]}>
                      {title}
                    </Text>
                    {shipping ? null : <Text style={[t.meta, { fontSize: 13 }]}>{age}</Text>}
                  </View>
                  {/* An ask in the Needs you list is said whole, over two lines if it needs them: it is what Allow
                      answers. Elsewhere the first part gives way first, so the workspace after it always shows. */}
                  {command ? (
                    <Text numberOfLines={2} style={line2}>
                      {parts.map((p, i) => (
                        <Text key={i}>
                          {i ? "\u00a0· " : null}
                          <PartText p={p} />
                        </Text>
                      ))}
                    </Text>
                  ) : (
                  <View style={{ flexDirection: "row", minWidth: 0 }}>
                    {parts[0] ? (
                      <Text numberOfLines={1} style={[line2, { flexShrink: 1 }]}>
                        <PartText p={parts[0]} />
                      </Text>
                    ) : null}
                    {parts.length > 1 ? (
                      <Text numberOfLines={1} style={[line2, { flexShrink: 0, maxWidth: "60%" }]}>
                        {parts.slice(1).map((p, i) => (
                          <Text key={i}>
                            {/* A no-break space: the web drops a leading plain one at the start of its own text block. */}
                            {"\u00a0· "}
                            <PartText p={p} />
                          </Text>
                        ))}
                      </Text>
                    ) : null}
                  </View>
                  )}
                  {/* Allow is never offered without what it lets run, whole: the one command chip. */}
                  {command ? (
                    <View style={{ marginTop: 8 }}>
                      <CommandChip command={command} />
                    </View>
                  ) : null}
                </View>
              </Pressable>
              {/* The answer sits beside the row, not inside it: a button never holds another button. Answered, the
                  pair becomes what it is doing with Undo where Allow was, at the same height, so nothing moves. */}
              {command && asker ? (
                <View style={{ paddingLeft: ROW_TEXT_X, paddingRight: layout.inset, paddingTop: 2, paddingBottom: 14, backgroundColor: c.panel }}>
                  {given ? (
                    <ResolvedLine yes={given.yes} command={given.command} onUndo={() => undoAnswer(given.id)} />
                  ) : (
                    <ApprovalPair command={command} armed={armed} onDeny={() => answer(asker.id, false, command)} onAllow={() => answer(asker.id, true, command)} />
                  )}
                </View>
              ) : null}
              {/* Beside the row, never inside it, as the answer's pair is. */}
              {shipping ? <ShipUndo given={shipping} title={title} /> : null}
              {last ? null : <View pointerEvents="none" style={{ position: "absolute", left: ROW_TEXT_X, right: layout.inset, bottom: 0, height: 1, backgroundColor: c.hairline }} />}
            </View>
          )}
        </SwipeRow>
      </View>
      {/* Mounted only while it is up: a long list keeps no closed menu per row. */}
      {menu !== false ? (
        <Menu
          open
          onClose={() => setMenu(false)}
          anchor={menu}
          width={Math.min(MENU_WIDTH, menu ? menu.width : MENU_WIDTH)}
          entries={[
            ...(shipIt ? [{ label: shipIt.label, icon: shipIt.icon, onPress: shipIt.onPress }, { type: "separator" as const }] : []),
            ...chatEntries(chat, inbox, { pin: (pinned) => script.pin(chat.id, pinned), archive: () => archive(chat.id) }),
          ]}
          header={<ChatPeek chat={chat} inbox={inbox} />}
        />
      ) : null}
    </Animated.View>
  );
}
