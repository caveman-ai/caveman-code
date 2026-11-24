// What leads a list of agents: its large title (Home's size, so moving from Home to a list keeps one title voice) with
// what narrows it under it; for a device, the device itself and its state; for
// Ready, the Review shelf, the pull requests that wait on your review (DECISIONS.md O8: Review became the Ready tile).
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Chat, Device } from "../../board/model";
import { Icon } from "../../components/Icon";
import { DeviceGlyph, PixelIcon } from "../../components/Pixel";
import { DeviceLine, deviceGlyph } from "../../home/DeviceRows";
import { useMinute } from "../../home/model";
import { haptic } from "../../motion";
import { guideId, openGuide } from "../../review/lookup";
import { queueOf, reviews } from "../../screens/pages/review-model";
import { useDevices } from "../../store/select";
import { layout, useTheme } from "../../theme";
import { BAR_HEIGHT } from "../TopBar";
import { ROW_TEXT_X } from "./ChatRow";

/**
 * The title a pushed list leads with, and the line that says what narrows it. `action` sits at the right of that line,
 * on its baseline (a lone group's Mark all seen or Archive all, then its Undo: ChatList.tsx BulkSlot), so it never
 * takes a line of its own.
 */
export function ListTitle({ title, line, mark, action }: { title: string; line?: ReactNode; mark?: ReactNode; action?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { c, t } = useTheme();
  const said = line ? typeof line === "string" ? <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.muted }]}>{line}</Text> : line : null;
  return (
    <View style={{ paddingTop: insets.top + BAR_HEIGHT + 16, paddingHorizontal: layout.inset, paddingBottom: 12 }}>
      <View accessible accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {mark}
        <Text numberOfLines={1} style={[t.largeTitle, { flexShrink: 1 }]}>
          {title}
        </Text>
      </View>
      {said || action ? (
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4, minHeight: 20 }}>
          <View style={{ flex: 1, minWidth: 0 }}>{said}</View>
          {/* The action's 44 pt target has 8 pt of padding past its words: its words end on the title's edge. */}
          {action ? <View style={{ marginRight: -8 }}>{action}</View> : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A device's own head over its chats: what it is doing. No button: nothing here wakes or reconnects a computer
 * (sending to one of its chats does), so nothing offers to.
 */
export function DeviceHead({ device }: { device: Device }) {
  const { c } = useTheme();
  const now = useMinute();
  const row = useDevices().find((d) => d.device.id === device.id);
  if (!row) return null;
  return (
    <View style={{ marginTop: 12, marginHorizontal: layout.inset, padding: 14, borderRadius: layout.tile.radius, backgroundColor: c.card, borderWidth: 1, borderColor: c.hairline, flexDirection: "row", alignItems: "center", gap: 12 }}>
      <DeviceGlyph device={device} size={32} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <DeviceLine d={row} now={now} />
        <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: c.subtle }}>
          {device.about}
        </Text>
      </View>
    </View>
  );
}

/** Ready's shelf: the pull requests waiting on your review, at most three, then the way into Review. */
export function ReviewShelf({ chats, onOpen }: { chats: readonly Chat[]; onOpen: () => void }) {
  const { c, t } = useTheme();
  const now = useMinute();
  const sent = reviews.use();
  const waiting = queueOf(chats, sent, now).filter((pr) => pr.state === "open" && pr.asksYou && !pr.mine);
  if (!waiting.length) return null;
  return (
    // The page's own rows follow with no head of their own (the title already says Ready and how many): the shelf
    // ends on a rule and a step of room, so its pull requests never read as part of that list.
    // 22 under the rule and the row's own 10 put the first row's words 32 below it.
    <View style={{ marginTop: 20, marginBottom: 22, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: c.hairline, marginHorizontal: layout.inset }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginRight: -8 }}>
        <Text accessibilityRole="header" style={[t.row, { flex: 1, fontSize: 15, lineHeight: 20, color: c.subtle }]}>
          Review <Text style={{ fontVariant: ["tabular-nums"] }}>{waiting.length}</Text>
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Review" onPress={() => (haptic.tap(), onOpen())} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 2, opacity: pressed ? 0.6 : 1 })}>
          <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.muted }]}>Open Review</Text>
          <Icon name="chevronRight" size={14} color={c.muted} />
        </Pressable>
      </View>
      {waiting.slice(0, 3).map((pr, i, shown) => {
        const add = pr.files.reduce((n, f) => n + f.add, 0);
        const del = pr.files.reduce((n, f) => n + f.del, 0);
        const repo = pr.repo.split("/").pop() ?? pr.repo;
        return (
          <Pressable
            key={`${pr.repo}#${pr.number}`}
            accessibilityRole="button"
            accessibilityLabel={`${pr.title}, ${repo} number ${pr.number}, ${add} added, ${del} removed, by ${pr.author}`}
            onPress={() => (haptic.tick(), openGuide(guideId(pr)))}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "flex-start", minHeight: layout.row.double, paddingVertical: 10, marginHorizontal: -layout.inset, paddingHorizontal: layout.inset, backgroundColor: pressed ? c.raised : undefined })}
          >
            <View style={{ width: 20, height: 22, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
              <Icon name={pr.state === "open" ? "pullRequest" : "pullRequestDraft"} size={16} color={c.muted} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text numberOfLines={1} style={[t.row, { fontSize: 17, lineHeight: 22 }]}>
                {pr.title}
              </Text>
              <Text numberOfLines={1} style={[t.row, { fontSize: 14, lineHeight: 19, color: c.muted }]}>
                {repo} #{pr.number}
                {add || del ? " · " : ""}
                {add ? <Text style={{ color: c.added }}>+{add}</Text> : null}
                {add && del ? " " : ""}
                {del ? <Text style={{ color: c.removed }}>−{del}</Text> : null}
                {` · ${pr.author}`}
              </Text>
            </View>
            {i < shown.length - 1 ? <View style={{ position: "absolute", left: ROW_TEXT_X, right: layout.inset, bottom: 0, height: 1, backgroundColor: c.hairline }} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
