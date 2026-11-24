// The moment: when a chat has something to look at, a card floats up from the bottom on the menu's surface (the popover
// grey, its edge, the overlay shadow). It gives under your thumb, swipes away, and opens into a sheet laid out like a
// Linear issue: the title, its properties (status, the agent and its model, branch, checks, changes), the change itself
// live, what changed, and the files as the transcript's Changes card lists them, so you can play with it before you
// answer. Its head is every sheet's (shell/Sheet.tsx): a glass X at the top left that puts it away and its state
// centred; the answers stay pinned at its foot, so the decision is in reach however far you read. Its words and marks
// are the desktop's: "Ready for review" under the done mark, the harness logo, the language marks. It rests above the
// composer, never on it.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { type Chat, ENGINE_NAME, totals } from "../board/model";
import { COMPOSER_HEIGHT } from "../shell/Composer";
import { duration, ease, haptic, morph, pop, press, release } from "../motion";
import { Toggle } from "../native/Toggle";
import { alpha, mono, overlayShadow, radius, useTheme } from "../theme";
import { Icon } from "./Icon";
import { PixelIcon } from "./Pixel";
import { RunsPreview } from "./RunsPreview";
import { TurnChanges } from "./transcript/TurnChanges";
import { openGuide } from "../review/lookup";
import { Squish } from "./Squish";
import { ApprovalPair } from "./ui/Choices";
import { EngineLogo } from "./ui/EngineLogo";
import { GlassCircle } from "./ui/Floating";

/** How tall the sheet shrinks to on its way out: it has no card face of its own now, only the open sheet. */
const COMPACT_HEIGHT = 150;
const EDGE = 10;

interface Props {
  chat: Chat | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  onReply: (text: string) => void;
  /** How far above the screen's bottom edge the card rests; never lower than the composer's top, which it must not cover. */
  rest: number;
}

/** A property row of the issue: its name in grey at a fixed width, its value in ink beside it. */
function Property({ label, children }: { label: string; children: React.ReactNode }) {
  const { c, t } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 36 }}>
      <Text style={[t.row, { width: 104, color: c.muted }]}>{label}</Text>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>{children}</View>
    </View>
  );
}

/** Lines added and removed in the diff inks, a true minus, a zero saying nothing. */
function Counts({ add, del }: { add: number; del: number }) {
  const { c, t } = useTheme();
  return (
    <Text style={[t.meta, { fontWeight: "600" }]}>
      {add || !del ? <Text style={{ color: c.added }}>+{add}</Text> : null}
      {add && del ? " " : null}
      {del ? <Text style={{ color: c.removed }}>−{del}</Text> : null}
    </Text>
  );
}

export function MomentSheet({ chat, open, onOpenChange, onDismiss, onReply, rest: asked }: Props) {
  const { height: screen } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { c, t, dark } = useTheme();
  const full = screen - insets.top - 8;
  const rest = Math.max(asked, Math.max(insets.bottom, 10) + COMPOSER_HEIGHT + 12);
  // The box can grow under it (a queue rides on it): the card moves up with it on the swift curve rather than jumping.
  const restAt = useSharedValue(rest);
  useEffect(() => {
    restAt.value = withTiming(rest, { duration: duration.base, easing: ease.swift });
  }, [rest, restAt]);
  // Scrolled, the sheet's head sits on a hairline, so what passes under it is cut by an edge (PaneHeader's border-b).
  const [scrolled, setScrolled] = useState(false);
  const [shown, setShown] = useState<Chat | null>(chat);
  const rise = useSharedValue(0);
  const openness = useSharedValue(0);
  const drag = useSharedValue(0);
  const squeeze = useSharedValue(1);
  const [previewDark, setPreviewDark] = useState(true);
  const darkness = useSharedValue(1);

  const momentKey = chat ? `${chat.id}:${chat.moment?.headline}` : null;
  useEffect(() => {
    if (chat) {
      setShown(chat);
      drag.value = 0;
      rise.value = withSpring(1, pop);
      haptic.thud();
    } else {
      rise.value = withSpring(0, morph, (finished) => {
        if (finished) scheduleOnRN(setShown, null);
      });
    }
    // Keyed on the moment, not the chat object: a chat's live line changes every few seconds and must not re-pop it.
  }, [momentKey]);

  useEffect(() => {
    openness.value = withSpring(open && chat ? 1 : 0, morph);
    drag.value = withSpring(0, release);
  }, [open, chat, openness, drag]);

  const dismiss = () => {
    haptic.soft();
    onDismiss();
  };
  const collapse = () => {
    haptic.soft();
    onOpenChange(false);
  };


  const sheetPan = usePanGesture({
    activeOffsetY: [-6, 6],
    onUpdate: (e) => {
      "worklet";
      drag.value = Math.max(0, e.translationY);
    },
    onDeactivate: (e) => {
      "worklet";
      if (e.translationY > 110 || e.velocityY > 900) scheduleOnRN(collapse);
      drag.value = withSpring(0, release);
    },
  });

  const frame = useAnimatedStyle(() => {
    const p = openness.value;
    const away = (1 - rise.value) * (COMPACT_HEIGHT + restAt.value + 40);
    return {
      left: interpolate(p, [0, 1], [EDGE, 0]),
      right: interpolate(p, [0, 1], [EDGE, 0]),
      bottom: interpolate(p, [0, 1], [restAt.value, 0]),
      height: interpolate(p, [0, 1], [COMPACT_HEIGHT, full]),
      // A card's corners grow into a sheet's: the system's large top corners, square where it meets the screen's foot.
      borderTopLeftRadius: interpolate(p, [0, 1], [radius.card, radius.sheet]),
      borderTopRightRadius: interpolate(p, [0, 1], [radius.card, radius.sheet]),
      borderBottomLeftRadius: interpolate(p, [0, 1], [radius.card, 0]),
      borderBottomRightRadius: interpolate(p, [0, 1], [radius.card, 0]),
      backgroundColor: c.popover,
      borderColor: c.edge,
      transform: [{ translateY: away + drag.value }, { scale: squeeze.value * interpolate(rise.value, [0, 1], [0.92, 1]) }],
    };
  });
  const sheetFace = useAnimatedStyle(() => ({
    opacity: interpolate(openness.value, [0.35, 1], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(openness.value, [0, 1], [24, 0]) }],
  }));
  const backdrop = useAnimatedStyle(() => ({ opacity: openness.value * (dark ? 0.7 : 0.3) * rise.value }));

  if (!shown?.moment) return null;
  const moment = shown.moment;
  const sum = totals(moment.files);
  const tweak = moment.preview === "runs" ? "Make it darker" : "Change something";

  return (
    <>
      <Animated.View aria-hidden={!open} pointerEvents={open ? "auto" : "none"} style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000" }, backdrop]}>
        <Pressable accessibilityLabel="Close" style={{ flex: 1 }} onPress={collapse} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal={open}
        style={[{ position: "absolute", overflow: "hidden", borderWidth: 1, ...overlayShadow(dark) }, frame]}
      >
        <Animated.View aria-hidden={!open} pointerEvents={open ? "auto" : "none"} style={[{ position: "absolute", top: 0, left: 0, right: 0, height: full, backgroundColor: c.popover }, sheetFace]}>
          <GestureDetector gesture={sheetPan}>
            <View style={{ paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: scrolled ? c.hairline : "transparent" }}>
              <View style={{ position: "absolute", top: 6, alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: dark ? "#4a4a4d" : alpha(c.text, 0.18) }} />
              <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
                <View style={{ flex: 1, flexBasis: 0, alignItems: "flex-start" }}>
                  <GlassCircle icon="close" label="Put it away" onPress={collapse} />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <PixelIcon name="state-done" />
                  <Text accessibilityRole="header" style={[t.heading, { lineHeight: 22 }]}>
                    Ready for review
                  </Text>
                </View>
                <View style={{ flex: 1, flexBasis: 0 }} />
              </View>
              <View style={{ paddingHorizontal: 20, gap: 2 }}>
                <Text style={t.title}>{shown.title}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text numberOfLines={1} style={t.small}>
                    {shown.repo}
                  </Text>
                  <Icon name="chevronRight" size={12} color={c.subtle} />
                  <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 12.5, color: c.muted, flexShrink: 1 }}>
                    {moment.branch}
                  </Text>
                </View>
              </View>
            </View>
          </GestureDetector>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, gap: 24 }}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={32}
            onScroll={(e) => {
              const now = e.nativeEvent.contentOffset.y > 0;
              if (now !== scrolled) setScrolled(now);
            }}
          >
            <View>
              {/* Who ran it, named once as the chat's header names it: the harness, then its model in grey. */}
              <Property label="Agent">
                <EngineLogo engine={shown.engine} />
                <Text numberOfLines={1} style={[t.row, { flexShrink: 1 }]}>
                  {ENGINE_NAME[shown.engine]} <Text style={{ color: c.muted }}>{shown.model}</Text>
                </Text>
              </Property>
              <Property label="Branch">
                <Icon name="branch" size={16} color={c.muted} />
                <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 14, color: c.text, flexShrink: 1 }}>
                  {moment.branch}
                </Text>
              </Property>
              <Property label="Checks">
                <PixelIcon name="state-done" />
                <Text style={t.row}>{moment.checks}</Text>
              </Property>
              <Property label="Changes">
                <Text style={t.row}>
                  {moment.files.length} {moment.files.length === 1 ? "file" : "files"}
                </Text>
                <Counts add={sum.add} del={sum.del} />
              </Property>
            </View>

            {moment.preview ? (
              <View style={{ gap: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={t.group}>Preview</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={t.small}>Dark</Text>
                    <Toggle
                      label="Dark theme"
                      value={previewDark}
                      onChange={(value) => {
                        haptic.tick();
                        setPreviewDark(value);
                        darkness.value = withTiming(value ? 1 : 0, { duration: 420 });
                      }}
                    />
                  </View>
                </View>
                <RunsPreview dark={darkness} />
              </View>
            ) : null}

            <View style={{ gap: 6 }}>
              <Text style={t.group}>What changed</Text>
              {moment.changes.map((change) => (
                <View key={change} style={{ flexDirection: "row", gap: 6 }}>
                  <Text style={[t.body, { width: 18, textAlign: "center", color: c.subtle }]}>•</Text>
                  <Text style={[t.body, { flex: 1 }]}>{change}</Text>
                </View>
              ))}
            </View>

            {/* Its Review opens the change's guide (review/GuideScreen.tsx), the phone's one place to review it. */}
            <TurnChanges
              files={moment.files}
              onReview={() => {
                collapse();
                openGuide(shown.id);
              }}
            />
          </ScrollView>
          {/* The decision, pinned: the one pair every Ready card ends in (Later | Ship it at 48 pt, as the Chief's), and
              the tweak under it as a 44 pt row, the way "Tell it what to do instead" sits under Deny | Allow. */}
          <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 12) - 12, gap: 8, borderTopWidth: 1, borderTopColor: c.hairline }}>
            <ApprovalPair allow="Ship it" deny="Later" armKey={shown.id} onAllow={() => onReply("Looks great, ship it")} onDeny={() => onReply("Later")} />
            <Squish label={tweak} depth={0.98} onPress={() => onReply(tweak)} style={{ height: 44, flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: 1, borderTopColor: c.hairline, marginHorizontal: -16, paddingHorizontal: 18 }}>
              <Icon name="rename" size={18} color={c.muted} />
              <Text style={[t.body, { fontSize: 15, color: c.muted }]}>{tweak}</Text>
            </Squish>
          </View>
        </Animated.View>
      </Animated.View>
    </>
  );
}
