// Talking instead of typing. Voice chat grows out of the box in place, one glass piece (Cursor 5345): the chat bar's
// contents give way to two lines, what's happening ("Listening…" from the first frame, then the words coming in, or
// "Answering…", or Muted) over what this is ("Voice chat · marketing"), five ink level bars, mute, voice settings and a
// red hang-up, and hang-up gives the chat bar back. VoiceOver names the bar "Voice chat in marketing". The session is the
// app's, not the box's (voice.ts), so it carries on into the chat a spoken ask starts. A Chief's call is the same row,
// the call's clock in place of the label and no settings (Chief.tsx owns the call; the box only draws it). The level
// bars follow the microphone while it is live (system/audio.ts), in soft ink, and fall quiet while the other side talks.
//
// Mute is a quiet circle that fills with ink while muted, its glyph struck through; hang-up is the deck's red at low
// strength under a red glyph, the one place red sits on a fill at rest, as a phone's call screen draws it.
import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { enter, exit, haptic } from "../../motion";
import { useMicLevel } from "../../system/audio";
import { alpha, sans, useTheme } from "../../theme";
import { Circle, Levels, useCircleFill } from "./Controls";
import { BOX } from "./state";

function Mute({ muted, onPress }: { muted: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const fill = useCircleFill();
  return (
    <Circle label={muted ? "Unmute" : "Mute"} selected={muted} onPress={onPress} fill={muted ? c.text : fill.mic}>
      <Icon name={muted ? "micOff" : "mic"} size={18} color={muted ? c.panel : c.muted} />
    </Circle>
  );
}

/** The classic hang-up: the handset lying on its back, without the arrow Hugeicons draws under it. */

function HangUp({ label, onPress }: { label: string; onPress: () => void }) {
  const { c, dark } = useTheme();
  return (
    <Circle
      label={label}
      onPress={() => {
        haptic.thud();
        onPress();
      }}
      fill={alpha(c.destructive, dark ? 0.24 : 0.14)}
    >
      <View style={{ transform: [{ translateY: 4 }] }}>
        <Icon name="hangUp" size={22} stroke={1.9} color={dark ? "#ed6c84" : c.destructive} />
      </View>
    </Circle>
  );
}

const WEB = Platform.OS === "web";
/** The first line's words cross over this fast: "Listening…" into what's heard, or "Answering…". */
const cross = { in: FadeIn.duration(150), out: FadeOut.duration(150) };

/**
 * What the row says. The first line is what's happening, there from the first frame and crossing over in 150 ms when it
 * changes kind (the words coming in are italic, the latest kept in view); it is a polite live region, so a screen
 * reader hears them land. The second, when there is one, says what this is. `name` makes the two one element for
 * VoiceOver ("Voice chat in marketing", its value what's happening); the web names the row's group instead.
 */
function Caption({ kind, text, under, name }: { /** What the first line says: a label, or the words coming in ("live"). */ kind: string; text: string; under?: string; name?: string }) {
  const { c } = useTheme();
  const [first, setFirst] = useState(true);
  useEffect(() => setFirst(false), []);
  const live = kind === "live";
  return (
    <View accessible={!!name} accessibilityLabel={name} accessibilityValue={name ? { text } : undefined} style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
      <View accessibilityLiveRegion="polite" style={{ height: 20 }}>
        <Animated.Text
          key={kind}
          entering={first ? undefined : cross.in}
          exiting={cross.out}
          numberOfLines={1}
          ellipsizeMode={live ? "head" : "tail"}
          style={{ position: "absolute", top: 0, left: 0, right: 0, fontFamily: sans, fontSize: 15, lineHeight: 20, color: live ? c.soft : c.muted, fontStyle: live ? "italic" : "normal", fontVariant: ["tabular-nums"] }}
        >
          {text}
        </Animated.Text>
      </View>
      {under ? (
        <Text numberOfLines={1} style={{ fontFamily: sans, fontSize: 13, lineHeight: 17, color: c.muted }}>
          {under}
        </Text>
      ) : null}
    </View>
  );
}

/** Voice chat, drawn in the box it grew from. `where` is who listens: the workspace a new chat would start in, or the chat's. */
export function VoiceRow({ where, heard, muted, answering, onMute, onSettings, onEnd }: { where?: string; heard: string; muted: boolean; answering: boolean; onMute: () => void; onSettings: () => void; onEnd: () => void }) {
  const fill = useCircleFill();
  const { c } = useTheme();
  const mic = useMicLevel();
  const live = !muted && !!heard;
  const kind = muted ? "muted" : live ? "live" : answering ? "answering" : "listening";
  const text = muted ? "Muted" : heard || (answering ? "Answering…" : "Listening…");
  const name = where ? `Voice chat in ${where}` : "Voice chat";
  return (
    <Animated.View
      entering={enter.fade}
      exiting={exit.gone}
      {...(WEB ? { role: "group" as const, "aria-label": name } : null)}
      style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: BOX.gap, paddingLeft: 18, paddingRight: BOX.pad }}
    >
      <Caption kind={kind} text={text} under={where ? `Voice chat · ${where}` : "Voice chat"} name={WEB ? undefined : name} />
      {muted ? null : <Levels live loud={live || answering} level={mic} ink={live || answering || mic ? c.soft : c.subtle} floor={0.34} />}
      <View style={{ width: 4 }} />
      <Mute muted={muted} onPress={onMute} />
      <Circle label="Voice settings" onPress={onSettings} fill={fill.mic}>
        <Icon name="settings" size={18} color={c.muted} />
      </Circle>
      <HangUp label="End voice chat" onPress={onEnd} />
    </Animated.View>
  );
}

/** A Chief's call, drawn in its box: the call's words and clock, the level, mute and hang-up. */
export function CallRow({ label, muted, onMute, onEnd }: { label: string; muted: boolean; onMute: () => void; onEnd: () => void }) {
  const { c } = useTheme();
  const mic = useMicLevel();
  return (
    <Animated.View entering={enter.fade} exiting={exit.gone} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: BOX.gap, paddingLeft: 18, paddingRight: BOX.pad }}>
      <Caption kind={muted ? "muted" : "call"} text={muted ? `${label} · Muted` : label} />
      {muted ? null : <Levels live loud={false} level={mic} ink={mic ? c.soft : c.subtle} floor={0.34} />}
      <View style={{ width: 4 }} />
      <Mute muted={muted} onPress={onMute} />
      <HangUp label="End the call" onPress={onEnd} />
    </Animated.View>
  );
}
