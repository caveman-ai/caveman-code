// What an opened automation and an opened agent are built from, so the two pages read as one family (GitHub's run
// pages and native agent pages on a phone, in this app's kit). One column for everything: glyphs in a 20 pt slot at
// x 16, words at x 48, values and ages at the right edge, a hairline between rows from the words' edge, never a card
// around a group. A page slides in over the list it came from, as a pushed screen does, and back out on Back or under
// a finger dragging it right; a run opens and folds in place, the rows under it making room on the snap curve. Its
// verbs stand at the foot, in reach of a thumb, over the page's fade, as the guide's decision does (review/Foot.tsx).
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Keyframe, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../components/Icon";
import { PixelIcon, StateMark } from "../../components/Pixel";
import { BottomEdge } from "../../components/ProgressiveEdge";
import { Shimmer } from "../../components/transcript/Shimmer";
import { BrandMark } from "../../components/ui/BrandMark";
import { effortLabel, EngineLogo, HARNESS_NAME, harnessId } from "../../components/ui/EngineLogo";
import { duration, ease, enter, exit, haptic, layout as rowsMove, release } from "../../motion";
import { alpha, FLOAT_TYPE, layout, mono, useTheme } from "../../theme";
import { BAR_HEIGHT } from "../../shell/TopBar";
import { RUN_WORD, type RunStatus } from "./automations-model";

/** Where every row's words start: past the 16 pt inset, the 20 pt glyph slot and 12 of air. */
export const WORDS_X = layout.inset + 20 + 12;

/** The foot's one height: the guide's decision pair (ui/Choices.tsx PAIR_HEIGHT.standard). */
export const FOOT = 48;

/**
 * A pushed page, slid in from the right over what it came from on the drawer curve, and back out the way it came. It
 * covers the list with the panel's own ground, so the list keeps its place under it.
 */
const pushIn = new Keyframe({
  0: { opacity: 0.6, transform: [{ translateX: 96 }] },
  100: { opacity: 1, transform: [{ translateX: 0 }], easing: ease.drawer },
}).duration(duration.slow);
const pushOut = new Keyframe({
  0: { opacity: 1, transform: [{ translateX: 0 }] },
  100: { opacity: 0, transform: [{ translateX: 120 }], easing: ease.snap },
}).duration(duration.base);

/** How far a drag must carry the page, as a share of the screen, for letting go to go back; a flick goes at any width. */
const BACK_AT = 0.35;
const BACK_FLICK = 600;

/**
 * The page under a finger, as a pushed screen is (components/edge.ts: a swipe right means Back): a drag right carries
 * it off to the list under it, and letting go past a third of the way, or with a flick, goes back; short of that it
 * settles home without a bounce. It takes the drag before the sidebar's pan does, so on a page the list opened a swipe
 * goes back down the stack and never brings the sidebar out over it.
 */
export function Pushed({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  const { c, dark } = useTheme();
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);
  const pan = usePanGesture({
    activeOffsetX: 10,
    failOffsetX: -12,
    failOffsetY: [-14, 14],
    onUpdate: (e) => {
      "worklet";
      x.value = Math.max(0, e.translationX);
    },
    onDeactivate: (e) => {
      "worklet";
      if (x.value > width * BACK_AT || e.velocityX > BACK_FLICK) {
        x.value = withTiming(width, { duration: duration.base, easing: ease.snap }, (done) => {
          if (done) scheduleOnRN(onBack);
        });
      } else x.value = withSpring(0, release);
    },
  });
  const dragged = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  // Its left edge casts onto the list as it leaves, so the page reads as lifted over it.
  const shadow = Platform.OS === "web" ? ({ boxShadow: `0px 0px 24px rgba(0, 0, 0, ${dark ? 0.6 : 0.16})` } as object) : { shadowColor: "#000", shadowOpacity: dark ? 0.6 : 0.16, shadowRadius: 24, shadowOffset: { width: 0, height: 0 } };
  return (
    <Animated.View entering={pushIn} exiting={pushOut} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.panel }, shadow, dragged]}>{children}</Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

/** How far a page scrolls before the bar takes its title (Page.tsx ListPage's PAST, past the large title). */
export const TITLE_PAST = 64;

/**
 * The head of an opened page: what it belongs to in one quiet line (its project, with GitHub's mark), its name at
 * the large title's size, what it does in grey, then whatever states it (a status line, a runner).
 */
export function PageHead({ project, title, line, children }: { project?: string; title: string; line?: string; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { c, t } = useTheme();
  return (
    <View style={{ paddingTop: insets.top + BAR_HEIGHT + 12, paddingHorizontal: layout.inset }}>
      {project ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <BrandMark name="github" size={13} />
          <Text numberOfLines={1} style={[t.small, { color: c.subtle, flexShrink: 1 }]}>
            {project}
          </Text>
        </View>
      ) : null}
      <Text accessibilityRole="header" style={t.largeTitle}>
        {title}
      </Text>
      {line ? <Text style={[t.body, { fontSize: 15, lineHeight: 22, marginTop: 4, color: c.muted }]}>{line}</Text> : null}
      {children}
    </View>
  );
}

/** A group's head ("Runs 3", "Setup"): the sidebar's section type, 32 over it and 4 under. */
export function SectionHead({ label, count, first = false }: { label: string; count?: number; first?: boolean }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, marginTop: first ? 24 : 32, paddingHorizontal: layout.inset }}>
      <Text accessibilityRole="header" style={t.section}>
        {label}
      </Text>
      {count !== undefined ? <Text style={[t.meta, { fontWeight: "500" }]}>{count}</Text> : null}
    </View>
  );
}

/** The rule between two rows, from the words' edge to the page's. */
export function Rule() {
  const { c } = useTheme();
  return <View style={{ height: 1, marginLeft: WORDS_X, marginRight: layout.inset, backgroundColor: c.hairline }} />;
}

/** A row's press: it lights the hover fill while held, never scales (a row is too wide to give). */
function RowPress({ label, onPress, expanded, children }: { label: string; onPress?: () => void; expanded?: boolean; children: ReactNode }) {
  const { c } = useTheme();
  const [held, setHeld] = useState(false);
  if (!onPress) return <View accessible accessibilityLabel={label}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      style={{ backgroundColor: held ? c.raised : undefined }}
    >
      {children}
    </Pressable>
  );
}

/**
 * One fact, as a phone's settings row says it: its mark, what it is in ink, its value in grey at the right; a chevron
 * when it opens something. `path` sets the value in mono. A long value gives way before the label does.
 */
export function FactRow({ icon, label, value, path = false, onPress, accessibilityLabel }: { icon: ReactNode; label: string; value?: ReactNode; path?: boolean; onPress?: () => void; accessibilityLabel?: string }) {
  const { c, t } = useTheme();
  const said = accessibilityLabel ?? (typeof value === "string" ? `${label}, ${value}` : label);
  return (
    <RowPress label={said} onPress={onPress}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingHorizontal: layout.inset }}>
        <View style={{ width: 20, alignItems: "center", justifyContent: "center" }}>{icon}</View>
        <Text numberOfLines={1} style={[t.row, { flexShrink: 0, maxWidth: "55%" }]}>
          {label}
        </Text>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
          {typeof value === "string" ? (
            <Text numberOfLines={1} style={path ? [t.code, { fontSize: 13, color: c.muted, flexShrink: 1 }] : [t.row, { fontSize: 15, color: c.muted, flexShrink: 1, textAlign: "right" }]}>
              {value}
            </Text>
          ) : (
            value
          )}
        </View>
        {onPress ? <Icon name="chevronRight" size={14} color={c.subtle} /> : null}
      </View>
    </RowPress>
  );
}

/**
 * A run's state as its mark: the working ring while it runs; the done check or the failed mark once it has ended. A run
 * that ends while you watch lands (the check draws itself in), since `landed` remounts it; a run read from history is
 * still.
 */
export function RunMark({ status }: { status: RunStatus }) {
  const was = useRef(status);
  const landed = was.current === "running" && status !== "running";
  useEffect(() => {
    was.current = status;
  }, [status]);
  if (status === "succeeded" && landed) return <StateMark key="landed" name="state-done" label="Worked" />;
  const name = status === "running" ? "state-working" : status === "succeeded" ? "state-done" : status === "failed" ? "state-failed" : status === "cancelled" ? "state-sleeping" : "state-queued";
  return <PixelIcon name={name} label={status === "succeeded" ? "Worked" : status} />;
}

/** The disclosure's chevron: right while folded, down while open, a quarter turn on the snap curve. */
function Disclosure({ open }: { open: boolean }) {
  const { c } = useTheme();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = withTiming(open ? 1 : 0, { duration: duration.base, easing: ease.snap });
  }, [open, turn]);
  const turned = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 90}deg` }] }));
  return (
    <Animated.View style={turned}>
      <Icon name="chevronRight" size={13} color={c.subtle} />
    </Animated.View>
  );
}

/**
 * A run, as a CI list names it: its mark, what it did (or what went wrong) in ink, and under it what started it, how
 * long it took and on which model; its age at the right. `open` shows `children` under it, its body, at the words'
 * edge. Running, its line shimmers.
 */
export function RunRow({
  status,
  title,
  meta,
  at,
  open,
  onPress,
  disclose = true,
  children,
}: {
  status: RunStatus;
  title: string;
  meta: ReactNode;
  /** Its age, as the rows say it ("3h"). */
  at: string;
  open?: boolean;
  onPress?: () => void;
  /** A chevron that turns as it opens; off for a row that opens another page (it shows the plain chevron). */
  disclose?: boolean;
  children?: ReactNode;
}) {
  const { c, t } = useTheme();
  const running = status === "running";
  const line = [t.row, { color: c.text }];
  return (
    <Animated.View layout={rowsMove}>
      <RowPress label={[RUN_WORD[status], title, typeof meta === "string" ? meta : null, at].filter(Boolean).join(", ")} onPress={onPress} expanded={disclose ? open : undefined}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 11, paddingHorizontal: layout.inset }}>
          <View style={{ width: 20, height: 22, alignItems: "center", justifyContent: "center" }}>
            <RunMark status={status} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            {running ? <Shimmer text={title} style={line} /> : <Text numberOfLines={open ? 3 : 1} style={line}>{title}</Text>}
            {typeof meta === "string" ? (
              <Text numberOfLines={1} style={t.small}>
                {meta}
              </Text>
            ) : (
              meta
            )}
          </View>
          <View style={{ height: 22, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={t.meta}>{at}</Text>
            {onPress ? disclose ? <Disclosure open={!!open} /> : <Icon name="chevronRight" size={13} color={c.subtle} /> : null}
          </View>
        </View>
      </RowPress>
      {open && children ? (
        <Animated.View entering={enter.fade} exiting={exit.gone} style={{ paddingLeft: WORDS_X, paddingRight: layout.inset, paddingBottom: 18, gap: 14 }}>
          {children}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/**
 * The page's verbs at its foot, in reach of a thumb: a 48 pt circle for the quiet one (Pause) and the wide pill for the
 * way forward (Run now, Publish), over the page's fade, as the guide's decision stands. `state` takes the pill's place
 * while something is under way ("Publishing v2").
 */
export function Foot({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 10);
  return (
    <>
      <BottomEdge floor={bottom + FOOT} />
      <Animated.View entering={enter.fade} exiting={exit.gone} pointerEvents="box-none" style={{ position: "absolute", left: layout.inset, right: layout.inset, bottom, flexDirection: "row", alignItems: "center", gap: 8 }}>
        {children}
      </Animated.View>
    </>
  );
}

/** The foot's quiet verb: a 48 pt circle on the control grey, its glyph in ink. */
export function FootCircle({ icon, label, onPress }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}>
      {({ pressed }) => (
        <View style={{ width: FOOT, height: FOOT, borderRadius: FOOT / 2, alignItems: "center", justifyContent: "center", backgroundColor: c.control, transform: [{ scale: pressed ? 0.94 : 1 }] }}>
          <Icon name={icon} size={20} color={c.text} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * The foot's wide verb (ui/Choices.tsx PairButton): `primary` is the one white action of the page; otherwise the
 * control grey, as a quiet way that still reads as a button (Resume).
 */
export function FootPill({ label, icon, onPress, primary = true, flex = true }: { label: string; icon?: ReactNode; onPress: () => void; primary?: boolean; flex?: boolean }) {
  const { c, t } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={flex ? { flex: 1 } : undefined}>
      {({ pressed }) => (
        <View
          style={{
            height: FOOT,
            borderRadius: FOOT / 2,
            paddingHorizontal: 20,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            backgroundColor: primary ? c.primary : c.control,
            transform: [{ scale: pressed ? 0.98 : 1 }],
          }}
        >
          {icon}
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.button, { fontSize: 17, lineHeight: 22, color: primary ? c.onPrimary : c.text }]}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** What is under way at the foot, in the pill's place: its mark and its words on the control grey (review/Foot.tsx). */
export function FootState({ mark, words }: { mark: ReactNode; words: string }) {
  const { c, t } = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={{ flex: 1, height: FOOT, borderRadius: FOOT / 2, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, backgroundColor: c.control }}>
      {mark}
      <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.row, { flex: 1 }]}>
        {words}
      </Text>
    </View>
  );
}

/**
 * A status's dot: 8 pt in its colour, or a ring when it is at rest (paused, here only), centred in the 16 pt the runner's
 * logo takes over it, so both lines' words start on one edge.
 */
export function StatusDot({ color, hollow = false }: { color: string; hollow?: boolean }) {
  return (
    <View accessibilityElementsHidden style={{ width: 16, alignItems: "center" }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hollow ? undefined : color, borderWidth: hollow ? 1.5 : 0, borderColor: color }} />
    </View>
  );
}

/**
 * Who runs it, under its name (RunnerBadge, a step up): the engine's logo in its own colours, the engine's name in ink,
 * the model and its effort in grey. "Claude Agent", never "Claude Code".
 */
export function RunnerLine({ engine, model, effort }: { engine: string; model: string; effort?: string }) {
  const { c, t } = useTheme();
  const name = HARNESS_NAME[harnessId(engine)] ?? engine;
  const rest = [model, effort ? effortLabel(effort) : null].filter(Boolean).join(" · ");
  return (
    <View accessible accessibilityLabel={`Runs on ${name}, ${rest}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 }}>
      <EngineLogo engine={engine} size={16} />
      <Text numberOfLines={1} style={[t.row, { fontSize: 15, flexShrink: 1 }]}>
        <Text style={{ fontWeight: "500" }}>{name}</Text>
        <Text style={{ color: c.muted }}> · {rest}</Text>
      </Text>
    </View>
  );
}

/** Where its file lives, last on the page and quiet: the whole path in mono, which the menu's Copy path copies. */
export function FilePath({ path }: { path: string }) {
  const { c, t } = useTheme();
  return (
    <View accessible accessibilityLabel={`Its file, ${path}`} style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 28, paddingHorizontal: layout.inset }}>
      <View style={{ width: 20, alignItems: "center" }}>
        <PixelIcon name="artifact-file" ink={c.subtle} />
      </View>
      <Text selectable numberOfLines={1} style={[t.code, { fontSize: 12, color: c.subtle, flexShrink: 1 }]}>
        {path}
      </Text>
    </View>
  );
}

/** Output a step printed: mono on the faint ink wash, the way a chat shows a command's output. */
export function Output({ text }: { text: string }) {
  const { c } = useTheme();
  return (
    <View style={{ borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: alpha(c.text, 0.045) }}>
      <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: c.muted }}>
        {text}
      </Text>
    </View>
  );
}
