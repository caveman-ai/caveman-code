// What waits behind the running turn. At rest the next one is the box's own first row (QueueRow): the same glass, so
// one outline and one shadow, with a hairline inset 16 between it and the field and Claude's italic line with ✕ ("+1
// more" when there are several). Its mark sits over `+` and its words over the field's, so the two rows read as one
// object. (It was a tray of its own docked behind the box, whose corners showed as ears and whose shadow doubled the
// box's.) Once the keyboard is up that row steps away so the work stays in view, and the queue folds into a chip in the
// card's toolbar, "2 queued", the dashed ring of "not started yet" before it. Tapped, the chip opens the queue inside the
// card over the field: one 44pt row a message, its words in italic grey (a tap takes them back into the field) and ✕ to
// drop it. The first one sends when the turn ends.
import { ScrollView, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { Squish } from "../../components/Squish";
import { enter, exit } from "../../motion";
import type { Queued } from "../../store/sessions";
import { alpha, FLOAT_TYPE, sans, useTheme } from "../../theme";
import { HIT, ToolChip } from "./Controls";
import { BOX } from "./state";

/** At most this many rows show at once; past them the tray scrolls, the next row peeking. */
const SHOWN = 3;

/** What a queued message says in its row: its words, after the pictures going with it ("2 photos · fix the header"). */
const wordsOf = (q: Queued) => {
  const n = q.images?.length ?? 0;
  const pictures = n > 1 ? `${n} photos` : n ? "A photo" : "";
  return pictures && q.text ? `${pictures} · ${q.text}` : pictures || q.text;
};

/** How tall the opened queue stands in the card. */
export const trayHeight = (count: number) => (count ? Math.min(count, SHOWN) * BOX.queued + (count > SHOWN ? BOX.queued / 2 : 0) : 0);

/** The queue's mark: a dashed ring, "not started yet". */
function Mark() {
  const { c } = useTheme();
  return <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderStyle: "dashed", borderColor: c.muted }} />;
}

/** The toolbar's "2 queued": opens the queue in the card, and folds it again. */
export function QueueChip({ count, open, onPress }: { count: number; open: boolean; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Animated.View entering={enter.fade} exiting={exit.gone}>
      <ToolChip label={`${count} queued for after this turn. ${open ? "Hide them" : "Show them"}`} onPress={onPress} drawn={32} depth={0.94} style={{ gap: 7, paddingLeft: 11, paddingRight: 9, borderRadius: 16, backgroundColor: open ? alpha(c.text, 0.12) : alpha(c.text, 0.06) }}>
        <Mark />
        <Text numberOfLines={1} style={{ fontFamily: sans, fontSize: 15, lineHeight: 20, color: c.soft }}>
          <Text style={{ fontVariant: ["tabular-nums"] }}>{count}</Text> queued
        </Text>
        <Icon name={open ? "chevronDown" : "chevronUp"} size={12} stroke={2} color={c.subtle} />
      </ToolChip>
    </Animated.View>
  );
}

/** The queue opened in the card: a row a message, oldest (next) first. */
export function QueueTray({ queued, onEdit, onRemove }: { queued: readonly Queued[]; onEdit: (q: Queued) => void; onRemove: (q: Queued) => void }) {
  const { c } = useTheme();
  return (
    <ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false} style={{ height: trayHeight(queued.length) }}>
      {queued.map((q, i) => (
        <View key={q.id} style={{ height: BOX.queued, flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 4 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Squish label={`${i === 0 ? "Next" : `Queued ${i + 1}`}: ${wordsOf(q)}. Edit it`} depth={0.98} onPress={() => onEdit(q)} style={{ height: HIT, flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Mark />
              <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: sans, fontSize: 15, lineHeight: 20, fontStyle: "italic", color: c.muted }}>
                {wordsOf(q)}
              </Text>
            </Squish>
          </View>
          <Squish label="Don't send it" depth={0.88} onPress={() => onRemove(q)} style={{ width: HIT, height: HIT, alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={15} color={c.subtle} />
          </Squish>
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * The next queued follow-up as the resting box's first row, BOX.tray tall: the dashed ring over `+`, the words in italic
 * grey over the field's, "+1 more", and ✕ over the round button. A tap takes it back into the box.
 */
export function QueueRow({ queued, onEdit, onRemove }: { queued: readonly Queued[]; onEdit: (q: Queued) => void; onRemove: (q: Queued) => void }) {
  const { c, t } = useTheme();
  const first = queued[0];
  if (!first) return null;
  const more = queued.length - 1;
  return (
    <View style={{ height: BOX.tray, flexDirection: "row", alignItems: "center", paddingLeft: BOX.pad, paddingRight: BOX.pad + BOX.circle / 2 - HIT / 2 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Squish label={`Queued: ${wordsOf(first).replace(/[.!?…]+$/, "")}${more ? `, and ${more} more` : ""}. Take it back into the box`} depth={0.98} hitSlop={4} onPress={() => onEdit(first)} style={{ height: BOX.tray, flexDirection: "row", alignItems: "center", gap: BOX.gap }}>
          <View style={{ width: BOX.circle, alignItems: "center" }}>
            <Mark />
          </View>
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={{ flexShrink: 1, fontFamily: sans, fontSize: 15, lineHeight: 20, fontStyle: "italic", color: c.muted }}>
            {wordsOf(first)}
          </Text>
          {more > 0 ? (
            <Text maxFontSizeMultiplier={FLOAT_TYPE} style={[t.meta, { flexShrink: 0 }]}>
              +{more} more
            </Text>
          ) : null}
        </Squish>
      </View>
      {/* 36 drawn, 44 to hit. */}
      <Squish label="Don't send it" depth={0.88} hitSlop={4} onPress={() => onRemove(first)} style={{ width: HIT, height: BOX.tray, alignItems: "center", justifyContent: "center" }}>
        <Icon name="close" size={16} color={c.muted} />
      </Squish>
    </View>
  );
}
