// The box's controls, as the founder's Cursor shots draw them on our deck:
// circles drawn at 36 and hit at 44, `+` and the mic on a quiet grey fill, and the one round `primary` action at the
// right. The model chip is the desktop picker's trigger at a phone's size: the vendor's mark, the exact model name,
// its effort in grey and a chevron. A mode chip (Plan, Grill me, Goal) sits beside it with its ✕.
//
// Every control here is built like the desktop's reference buttons: it gives under the finger on the press spring and
// settles back without a bounce (components/Squish.tsx), with the same haptic. The round button also carries VoiceOver
// actions, so what a hold offers (queue for after the turn, stop) is never long-press only.
//
// What a finger presses is 44 tall whatever is drawn (DECISIONS.md: 44pt controls): the pressable itself reaches past
// the drawing and gives the extra back in negative margin, so the layout sits at the drawn size, neighbours 8 apart
// meet without overlapping, and the browser's hit box is the phone's.
import { type ReactNode, useEffect, useState } from "react";
import { type AccessibilityActionEvent, Pressable, Text, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { Icon, type IconName } from "../../components/Icon";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { ModeGlyph, PixelIcon } from "../../components/Pixel";
import { effortColor, effortLabel, modelVendor, nameBesideMark, SpeedBolt, VendorMark } from "../../components/ui/EngineLogo";
import { enter, exit, haptic, morph, press, release, useLoop, useReducedMotion } from "../../motion";
import { alpha, sans, useTheme } from "../../theme";
import { BOX, type Primary } from "./state";

/** The least a finger presses. */
export const HIT = 44;
const SLOP = (HIT - BOX.circle) / 2;

/** The quiet grey a circle sits on inside the glass: `+` a step lighter than the mic, as Cursor draws them. */
export function useCircleFill() {
  const { c, dark } = useTheme();
  return { plus: alpha(c.text, dark ? 0.115 : 0.07), mic: alpha(c.text, dark ? 0.085 : 0.055) };
}

export interface CircleAction {
  name: string;
  label: string;
  run: () => void;
}

/**
 * A 36pt circle you press: it sinks on the press spring and comes back, ticks, and says what it does. `actions` are
 * VoiceOver's other things it can do (the hold menu's items); activating it is `onPress`.
 */
export function Circle({ label, onPress, onLongPress, actions, fill, children, disabled = false, selected }: { label: string; onPress: () => void; onLongPress?: () => void; actions?: readonly CircleAction[]; fill?: string; children: ReactNode; disabled?: boolean; selected?: boolean }) {
  const scale = useSharedValue(1);
  const pressed = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "activate") return onPress();
    actions?.find((a) => a.name === e.nativeEvent.actionName)?.run();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      accessibilityActions={actions?.length ? [{ name: "activate" }, ...actions.map((a) => ({ name: a.name, label: a.label }))] : undefined}
      onAccessibilityAction={actions?.length ? onAction : undefined}
      disabled={disabled}
      style={{ width: HIT, height: HIT, margin: -SLOP, alignItems: "center", justifyContent: "center" }}
      onPressIn={() => {
        scale.value = withSpring(0.9, press);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, release);
      }}
      onLongPress={onLongPress}
      delayLongPress={350}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
    >
      <Animated.View style={[{ width: BOX.circle, height: BOX.circle, borderRadius: BOX.circle / 2, alignItems: "center", justifyContent: "center", backgroundColor: fill }, pressed]}>{children}</Animated.View>
    </Pressable>
  );
}

/**
 * `+`: the menu in the keyboard's place (ContextPanel.tsx). While the menu is up its cross turns a quarter to an ✕ that
 * puts it away (the keyboard comes back if it was up). A small count rides on it while something is attached and the
 * box is at rest.
 */
export function PlusButton({ label, count = 0, open = false, onPress }: { label: string; count?: number; open?: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const fill = useCircleFill();
  const still = useReducedMotion();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = still ? (open ? 1 : 0) : withSpring(open ? 1 : 0, morph);
  }, [open, still, turn]);
  const turned = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 45}deg` }] }));
  return (
    <Circle label={open ? "Put the menu away" : count ? `${label}. ${count} attached` : label} onPress={onPress} fill={open ? alpha(c.text, 0.16) : fill.plus} selected={open}>
      <Animated.View style={turned}>
        <Icon name="add" size={18} stroke={1.9} color={open ? c.text : c.muted} />
      </Animated.View>
      {count ? (
        <Animated.View entering={enter.fade} exiting={exit.gone} style={{ position: "absolute", top: -3, right: -3, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, backgroundColor: c.primary, alignItems: "center", justifyContent: "center" }}>
          <Text style={[t.micro, { fontSize: 10, lineHeight: 12, color: c.onPrimary }]}>{count}</Text>
        </Animated.View>
      ) : null}
    </Circle>
  );
}

/** The mic: dictation into the field. */
export function MicButton({ onPress }: { onPress: () => void }) {
  const { c } = useTheme();
  const fill = useCircleFill();
  return (
    <Circle label="Dictate" onPress={onPress} fill={fill.mic}>
      <Icon name="mic" size={19} color={c.muted} />
    </Circle>
  );
}

const GLYPH: Record<Exclude<Primary, "none" | "stop">, IconName> = { voice: "voice", call: "call", send: "send", steer: "send", settling: "send" };

/**
 * The one round action, in `primary` with `onPrimary` ink (never bone, never pure white): voice chat, a call, send,
 * steer, stop, or the beat after a send. The glyph crossfades as it changes, so the circle itself never pops.
 */
export function PrimaryButton({ primary, label, onPress, onLongPress, actions }: { primary: Exclude<Primary, "none">; label: string; onPress: () => void; onLongPress?: () => void; actions?: readonly CircleAction[] }) {
  const { c } = useTheme();
  const settling = primary === "settling";
  return (
    <Circle label={label} onPress={onPress} onLongPress={onLongPress} actions={actions} fill={c.primary} disabled={settling}>
      <Animated.View key={primary === "steer" ? "send" : primary} entering={enter.fade} exiting={exit.gone} style={{ position: "absolute" }}>
        {/* The beat after a send dims the arrow on a plain view: a fading entrance owns the animated one's opacity. */}
        <View style={{ opacity: settling ? 0.45 : 1 }}>
          {primary === "stop" ? <View style={{ width: 11, height: 11, borderRadius: 2.5, backgroundColor: c.onPrimary }} /> : <Icon name={GLYPH[primary]} size={primary === "send" || primary === "steer" || settling ? 18 : 19} color={c.onPrimary} stroke={primary === "voice" ? 2 : 2.25} />}
        </View>
      </Animated.View>
    </Circle>
  );
}

/**
 * A chip on the toolbar: drawn `drawn` tall (36, or 32 for a mode), pressed at 44. It gives under the finger and, as a
 * row does, lights the hover surface while held when it has no fill of its own.
 */
export function ToolChip({ label, onPress, drawn = BOX.circle, depth = 0.95, highlight = false, shrinks = false, style, children }: { label: string; onPress: () => void; drawn?: number; depth?: number; highlight?: boolean; /** Gives way on a crowded toolbar. */ shrinks?: boolean; style?: object; children: ReactNode }) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const [held, setHeld] = useState(false);
  const pressed = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ height: HIT, marginVertical: -(HIT - drawn) / 2, justifyContent: "center", flexShrink: shrinks ? 1 : 0, minWidth: 0 }}
      onPressIn={() => {
        scale.value = withSpring(depth, press);
        if (highlight) setHeld(true);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, release);
        if (highlight) setHeld(false);
      }}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
    >
      <Animated.View style={[{ height: drawn, flexDirection: "row", alignItems: "center", minWidth: 0 }, style, held ? { backgroundColor: c.raised } : null, pressed]}>{children}</Animated.View>
    </Pressable>
  );
}

/**
 * The model this chat runs on, as the desktop picker's trigger: the vendor's mark, its exact name at 15/500, the effort
 * in grey, the bolt while a faster speed is on, then a chevron. It gives way first on a crowded toolbar, and `compact`
 * (while dictating, or beside a chat's queue chip) draws only the mark and the chevron; VoiceOver still hears it all.
 */
export function ModelChip({ engine, model, label, effort, fast, accessibilityLabel, compact = false, onPress }: { engine: string; model: string; label?: string; effort?: string; fast?: "fast" | "fastest"; accessibilityLabel?: string; compact?: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const name = label ?? model;
  const vendor = modelVendor(engine, model);
  const said = `${accessibilityLabel ?? `${name}${effort ? `, ${effortLabel(effort)} effort` : ""}`}. Change the model`;
  return (
    <ToolChip label={said} onPress={onPress} highlight shrinks style={{ gap: 6, paddingHorizontal: 8, borderRadius: BOX.circle / 2 }}>
      {/* A place that runs no agent has no mark to wear: its words stand alone, however tight the bar. */}
      {engine ? <VendorMark engine={engine} model={model} size={15} /> : null}
      {compact && engine ? null : (
        <>
          <Text numberOfLines={1} style={{ fontFamily: sans, fontSize: 15, lineHeight: 20, fontWeight: "500", color: c.text, flexShrink: 1 }}>
            {nameBesideMark(name, vendor)}
          </Text>
          {effort ? <Text style={{ fontFamily: sans, fontSize: 15, lineHeight: 20, color: effortColor(effort, c) ?? c.subtle }}>{effortLabel(effort)}</Text> : null}
          {fast ? <SpeedBolt on double={fast === "fastest"} size={14} /> : null}
        </>
      )}
      <Icon name="chevronDown" size={13} stroke={2} color={c.subtle} />
    </ToolChip>
  );
}

/** A mode the box is in (Plan, Grill me, Goal): its pixel glyph and word on the raised grey with a ✕ that leaves it. */
export function ModeChip({ icon, label, onClear }: { icon: PixelIconName; label: string; onClear: () => void }) {
  const { c } = useTheme();
  return (
    <Animated.View entering={enter.fade} exiting={exit.gone}>
      <ToolChip label={`${label} on. Turn off`} onPress={onClear} drawn={32} depth={0.94} style={{ gap: 6, paddingLeft: 10, paddingRight: 8, borderRadius: 16, backgroundColor: alpha(c.text, 0.08) }}>
        <ModeGlyph name={icon} ink={c.text} />
        <Text numberOfLines={1} style={{ fontFamily: sans, fontSize: 15, lineHeight: 20, fontWeight: "500", color: c.text }}>
          {label}
        </Text>
        <Icon name="close" size={12} stroke={2.2} color={c.subtle} />
      </ToolChip>
    </Animated.View>
  );
}

/** How strongly each of the five bars answers the voice: the middle ones loudest. */
const GAIN = [0.9, 1.5, 2.1, 1.6, 1];
/** The same for the microphone's real level, which runs higher than the acted-out one: a voice fills the middle bar. */
const MIC_GAIN = GAIN.map((g) => g * 0.75);

function Bar({ i, clock, loud, gain, floor, ink, height }: { i: number; clock: SharedValue<number>; loud: SharedValue<number>; gain: number; floor: number; ink: string; height: number }) {
  const style = useAnimatedStyle(() => {
    // Whole turns of the loop's clock, so the wobble never jumps when it wraps.
    const wobble = 0.7 + 0.3 * Math.sin(clock.value * Math.PI * 2 * 3 + i * 1.9);
    return { transform: [{ scaleY: floor + Math.min(1, loud.value * gain * wobble) * (1 - floor) }] };
  });
  return <Animated.View style={[{ width: 3.5, height, borderRadius: 1.75, backgroundColor: ink }, style]} />;
}

/**
 * Five level bars in ink (never amber: DECISIONS.md "Voice level bars are ink"): they swell with the words coming in and
 * settle between them. `floor` is how tall they stand when quiet: voice chat rests as five dots (Cursor 5345), a
 * dictation pill as five short bars, since it is recording either way (5346). Under Reduce Motion they hold still.
 *
 * `level` is the microphone's real level, 0 to 1, when one comes in (system/audio.ts `useMicLevel`, a shared value the
 * bars read on the UI thread, or a number): the bars follow it, each with its own wobble. Without one (the web, no
 * microphone) they act it out from `loud`, as the prototype always has.
 */
export function Levels({ live, loud: level, level: mic, ink, height = 12, floor = 0.3 }: { live: boolean; loud: boolean; level?: SharedValue<number> | number; ink?: string; height?: number; floor?: number }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  const clock = useLoop(1800, live && !still);
  const loud = useSharedValue(0);
  const given = useSharedValue(typeof mic === "number" ? mic : 0);
  useEffect(() => {
    loud.value = still ? 0.1 : withSpring(level ? 0.6 : live ? 0.1 : 0, morph);
  }, [level, live, loud, still]);
  useEffect(() => {
    if (typeof mic === "number") given.value = withTiming(Math.min(1, Math.max(0, mic)), { duration: 90 });
  }, [mic, given]);
  const real = mic === undefined || still ? null : typeof mic === "number" ? given : mic;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
      {GAIN.map((g, i) => (
        <Bar key={i} i={i} clock={clock} loud={real ?? loud} gain={real ? MIC_GAIN[i]! : g} floor={floor} ink={ink ?? c.soft} height={height} />
      ))}
    </View>
  );
}
