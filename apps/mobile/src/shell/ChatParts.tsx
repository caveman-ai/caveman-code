// What every chat row shares with the desktop's (apps/web/src/components/StatusMark.tsx, shell/SidebarPeek.tsx,
// shell/InboxItems.tsx): its status mark at the row's end, the card that tells you about a chat before you open it,
// and its menu. On a phone the card is the menu's head: a long press shows what the desktop's hover shows, with the
// row's actions under it, the way iOS pairs a preview with its menu.
import { useState } from "react";
import { Text, View } from "react-native";
import { type Chat, deviceById, deviceLabel, ENGINE_NAME, type Phase } from "../board/model";
import { Icon } from "../components/Icon";
import { DeviceGlyph, PixelAppear, PixelFolder, PixelIcon, StateMark } from "../components/Pixel";
import { EngineLogo } from "../components/ui/EngineLogo";
import type { MenuEntry } from "../components/ui/Menu";
import { MenuSeparator } from "../components/ui/Menu";
import { mono, useTheme } from "../theme";
import { type Inbox, rowAge, snoozePresets, wakeLabel } from "./inbox";

/** A turn's clock in whole minutes and up ("4m", "2h"), nothing for its first minute (StatusMark's Clock). */
export function ran(ms: number): string | null {
  if (ms < 60_000) return null;
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

/** "+42 −3" stays on one line: a wrap never leaves the minus alone under it. */
const keepCounts = (line: string) => line.replace(/(\+\d+) (−\d+)/g, "$1\u00a0$2");

/**
 * A chat's status in words, as the desktop's chatStatus and SidebarPeek's Now name it: the ask is its detail; a
 * working chat's is its clock, then what it is doing ("Working · 4m · Running the tests"). A finished one says no more:
 * its title already names what it made.
 */
export function statusOf(chat: Chat, unread: boolean, clock: string | null = null): { label: string; detail?: string; action: boolean } | null {
  if (chat.phase === "needs") return { label: chat.ask ? "Approve" : "Needs you", detail: keepCounts(chat.line), action: true };
  if (chat.phase === "working") return { label: "Working", detail: [clock, keepCounts(chat.line)].filter(Boolean).join(" · "), action: false };
  // "Finished", not "Done": Done is your word for a chat you are through with (the queue's Done shelf).
  if (chat.phase === "ready" && unread) return { label: "Finished", action: false };
  return null;
}

/**
 * A chat's status where its row ends: an amber dot when it waits on you, the turning ring with its clock while it
 * works, the done mark when it finished and you haven't looked. A change while the row is on screen lands once (the
 * dot dithers in, the done mark plays); a row's first paint rests. `compact`: the glyph alone (a shut folder's).
 */
export function ChatMark({ phase, unread, since, now, compact = false }: { phase: Phase; unread: boolean; since: number; now: number; compact?: boolean }) {
  const { c, t } = useTheme();
  const [first] = useState(phase);
  const landed = phase !== first;
  if (phase === "needs")
    return landed ? <PixelAppear key="needs" name="state-needs-you" ink={c.warning} label="Needs you" /> : <PixelIcon name="state-needs-you" ink={c.warning} label="Needs you" />;
  if (phase === "working") {
    const clock = compact ? null : ran(now - since);
    return (
      <View accessibilityLabel={clock ? `Working, ${clock}` : "Working"} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {clock ? <Text style={[t.micro, { color: c.muted }]}>{clock}</Text> : null}
        <PixelIcon name="state-working" />
      </View>
    );
  }
  if (phase === "ready" && unread) return landed ? <StateMark key="done" name="state-done" label="Finished" /> : <PixelIcon name="state-done" label="Finished" />;
  return null;
}

/** One line of the card: a 20pt icon column, the menu's own, so the card's icons and the rows' below share an edge. */
function Line({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 24 }}>
      <View style={{ width: 20, alignItems: "center" }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>{children}</View>
    </View>
  );
}

/**
 * Where a chat runs, line by line (SidebarPeek's where, PaneHeader's `where`): its project, the computer, its branch
 * and who runs it, the model then the harness. The card ends on these; the title menu opens on them.
 */
export function ChatWhere({ chat, inbox }: { chat: Chat; inbox: Inbox }) {
  const { c, t } = useTheme();
  const snoozed = inbox.snoozedUntil(chat);
  const device = deviceById(chat.device);
  const text = [t.small, { color: c.soft, flexShrink: 1 }];
  return (
    <View style={{ gap: 2 }}>
      <Line icon={<PixelFolder open={false} />}>
        <Text numberOfLines={1} style={text}>
          {chat.repo}
        </Text>
      </Line>
      <Line icon={<DeviceGlyph device={device} />}>
        <Text numberOfLines={1} style={text}>
          {deviceLabel(device)}
        </Text>
      </Line>
      {chat.moment ? (
        <Line icon={<Icon name="branch" size={14} color={c.muted} />}>
          <Text numberOfLines={1} style={[text, { fontFamily: mono, fontSize: 12 }]}>
            {chat.moment.branch}
          </Text>
        </Line>
      ) : null}
      <Line icon={<EngineLogo engine={chat.engine} size={chat.engine === "caveman" ? 16 : 14} />}>
        <Text numberOfLines={1} style={text}>
          {chat.model}
          <Text style={{ color: c.muted }}> · {ENGINE_NAME[chat.engine]}</Text>
        </Text>
      </Line>
      {snoozed !== null ? (
        <Line icon={<Icon name="snooze" size={14} color={c.muted} />}>
          <Text numberOfLines={1} style={text}>
            Snoozed, wakes in {wakeLabel(snoozed, inbox.now)}
          </Text>
        </Line>
      ) : null}
    </View>
  );
}

/**
 * The card a chat shows before you open it (SidebarPeek's ChatPeek): its title in full and how long ago it moved; what
 * it waits on or is doing, in amber when it is on you; then where it runs. Lines with nothing to say are left out. A
 * rule bleeds under it to the menu's edge.
 */
export function ChatPeek({ chat, inbox }: { chat: Chat; inbox: Inbox }) {
  const { c, t } = useTheme();
  const unread = inbox.unread(chat);
  const status = statusOf(chat, unread, ran(inbox.now - inbox.since(chat)));
  const age = rowAge(inbox.since(chat), inbox.now);
  return (
    <View accessible accessibilityLabel={[inbox.title(chat), status?.label, status?.detail].filter(Boolean).join(", ")}>
      <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <Text numberOfLines={2} style={[t.label, { flex: 1 }]}>
            {inbox.title(chat)}
          </Text>
          <Text style={[t.meta, { lineHeight: 20 }]}>{age === "now" ? "now" : `${age} ago`}</Text>
        </View>
        {status ? (
          <Line icon={<ChatMark phase={chat.phase} unread={unread} since={inbox.since(chat)} now={inbox.now} compact />}>
            <Text numberOfLines={status.action ? 3 : 2} style={[t.small, { flex: 1, color: c.soft }]}>
              <Text style={{ fontWeight: "500", color: status.action ? c.warning : c.text }}>{status.label}</Text>
              {status.detail ? ` · ${status.detail}` : ""}
            </Text>
          </Line>
        ) : null}
        <View style={{ marginTop: 2 }}>
          <ChatWhere chat={chat} inbox={inbox} />
        </View>
      </View>
      <MenuSeparator />
    </View>
  );
}

/**
 * A chat's menu (WorkspaceRow's ⋯ and InboxItems): Rename, then Pin, Mark done, Snooze (its times in place, or Wake
 * now while it sleeps; never while it asks you something), Mark unread, and Archive (not while it works).
 * `rename` absent: the queue's menu, which has none.
 */
export function chatEntries(chat: Chat, inbox: Inbox, act: { pin: (pinned: boolean) => void; archive: () => void; rename?: () => void }): MenuEntry[] {
  const done = inbox.isDone(chat);
  const unread = inbox.unread(chat);
  const snoozed = inbox.snoozedUntil(chat) !== null;
  return [
    ...(act.rename ? [{ label: "Rename", icon: "rename" as const, onPress: act.rename }, { type: "separator" as const }] : []),
    { label: chat.pinned ? "Unpin" : "Pin", icon: chat.pinned ? "unpin" : "pin", onPress: () => act.pin(!chat.pinned) },
    // A chat that asks you something can't be settled until you answer it (the runtime refuses).
    { label: done ? "Not done" : "Mark done", icon: done ? "undo" : "markDone", disabled: chat.phase === "needs", onPress: () => (done ? inbox.reopen(chat.id) : inbox.markDone(chat)) },
    snoozed
      ? { label: "Wake now", icon: "wake", onPress: () => inbox.wake(chat.id) }
      : {
          label: "Snooze",
          icon: "snooze",
 // A chat that asks you something can't be put off (the runtime refuses, upstream canSnooze).
          disabled: chat.phase === "needs",
          submenu: snoozePresets(new Date()).map((p) => ({ label: p.label, trailing: <When text={p.when} />, onPress: () => inbox.snooze(chat, p.until) })),
        },
    { label: unread ? "Mark read" : "Mark unread", icon: unread ? "markRead" : "markUnread", onPress: () => (unread ? inbox.markRead(chat) : inbox.markUnread(chat.id)) },
    { type: "separator" },
    { label: "Archive", icon: "archive", disabled: chat.phase === "working", onPress: act.archive },
  ];
}

/** When a snooze ends, grey at the row's end. */
function When({ text }: { text: string }) {
  const { t, c } = useTheme();
  return <Text style={[t.row, { color: c.muted }]}>{text}</Text>;
}
