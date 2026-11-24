// One of the agent's screens, live, at the width it is given: the desktop's LiveView (apps/web/src/panels/live/
// LiveView.tsx) at a finger's size. The frame is drawn at its own size and scaled to fit: a runtime's frame is an
// image, the script's a drawing (live/views.tsx). The agent's cursor follows its `*.pointer` events: a dark arrow with
// a light edge, so it reads on light pages and dark ones, the engine's name beside it, and a ring where it clicks. It
// sits outside the scaled frame, so it keeps its size however small the frame is drawn, and dims while you hold the
// screen. A touch is a pointer down and up at that spot in frame pixels (`*.input`); `touch` says whether one reaches
// the screen, and `take` gets it first when you don't hold it yet.
import { useEffect, useRef } from "react";
import { Image, Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { duration, ease, useReducedMotion } from "../motion";
import { alpha, useTheme } from "../theme";
import type { LiveSource } from "./protocol";
import type { Live } from "./useLive";
import { DRAWINGS } from "./views";

/** A screen's shape before its first frame: 16:10, a viewport's and a desktop's. */
const ASPECT = 10 / 16;

interface Props {
  source: LiveSource;
  live: Live;
  /** How wide it is drawn; its height follows the frame's shape. */
  width: number;
  /** Who the agent is, on its cursor. */
  engine: string;
  /** Touches reach the screen; without, it only shows it. */
  touch?: boolean;
  /** Take the screen before a touch lands, when this view doesn't hold it; resolves whether it does now. */
  take?: () => Promise<boolean>;
  label: string;
}

export function LiveScreen({ source, live, width, engine, touch = false, take, label }: Props) {
  const { c, t } = useTheme();
  const still = useReducedMotion();
  const { frame } = live;
  const size = frame ?? (live.state && "width" in live.state ? live.state : null);
  const scale = size ? width / size.width : 1;
  const height = size ? size.height * scale : width * ASPECT;

  // The agent's cursor, in frame pixels: where its last pointer event was, and a ring that grows from a click.
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const seen = useSharedValue(0);
  const ping = useSharedValue(1);
  useEffect(
    () =>
      source.onPointer((p) => {
        const far = Math.hypot(p.x - x.value, p.y - y.value);
        const move = { duration: still || !seen.value ? 0 : Math.min(600, Math.max(150, far * 0.9)), easing: ease.swift };
        x.value = withTiming(p.x, move);
        y.value = withTiming(p.y, move);
        seen.value = 1;
        if (p.phase === "click" && !still) {
          ping.value = 0;
          ping.value = withTiming(1, { duration: duration.scene, easing: ease.snap });
        }
      }),
    [source, still, x, y, seen, ping],
  );
  // Shown while someone drives: bright while the agent does, faint under your finger.
  const shown = live.controller === "agent" ? 1 : live.controller === "user" ? 0.18 : 0;
  const cursor = useAnimatedStyle(
    () => ({ opacity: withTiming(seen.value ? shown : 0, { duration: duration.fast }), transform: [{ translateX: x.value * scale }, { translateY: y.value * scale }] }),
    [shown, scale],
  );
  const ring = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - ping.value), transform: [{ scale: 0.4 + 2 * ping.value }] }));

  // A touch, in frame pixels: down as the finger lands (once the screen is held: taking it first if need be), up where
  // it leaves, however long it stayed, in that order.
  const held = useRef<Promise<boolean>>(Promise.resolve(false));
  const toFrame = (e: { nativeEvent: { locationX: number; locationY: number } }) => ({ x: e.nativeEvent.locationX / scale, y: e.nativeEvent.locationY / scale });
  const pointer = (action: "down" | "up", at: { x: number; y: number }) => source.input({ type: "pointer", action, x: at.x, y: at.y, button: "left", modifiers: 0 });

  const Drawn = frame && "drawn" in frame ? DRAWINGS[frame.drawn] : null;
  return (
    <View accessible={!touch} accessibilityRole={touch ? undefined : "image"} accessibilityLabel={touch ? undefined : label} style={{ width, height, overflow: "hidden", backgroundColor: c.raised }}>
      {frame && size ? (
        // Drawn at the frame's size, scaled about its centre to fill the box.
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: (width - size.width) / 2, top: (height - size.height) / 2, width: size.width, height: size.height, transform: [{ scale }] }}
        >
          {Drawn && "drawn" in frame ? <Drawn page={frame.page} /> : "data" in frame ? <Image source={{ uri: `data:${frame.mime_type};base64,${frame.data}` }} style={{ width: size.width, height: size.height }} /> : null}
        </View>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={t.small}>{live.status === "unavailable" ? "No picture from this computer" : live.status === "error" ? "The screen stopped streaming" : "Connecting…"}</Text>
        </View>
      )}
      {touch ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPressIn={(e) => {
          const at = toFrame(e);
          held.current = (live.holding ? Promise.resolve(true) : take ? take() : Promise.resolve(false)).then((ok) => {
            if (ok) pointer("down", at);
            return ok;
          });
        }}
        onPressOut={(e) => {
          const at = toFrame(e);
          void held.current.then((ok) => ok && pointer("up", at));
        }}
        style={{ position: "absolute", left: 0, top: 0, width, height }}
      />
      ) : null}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: 0, width: 160, height: 36 }, cursor]}>
        <Animated.View style={[{ position: "absolute", left: -8, top: -8, width: 16, height: 16, borderRadius: 8, backgroundColor: c.target }, ring]} />
        <Svg width={18} height={18} viewBox="0 0 18 18" style={{ position: "absolute", left: -3, top: -3 }}>
          <Path d="M3 2 L3 15.5 L6.6 12.2 L9 17 L11.2 16 L8.9 11.2 L13.8 11 Z" fill="#111113" stroke="#ffffff" strokeWidth={1.4} strokeLinejoin="round" />
        </Svg>
        <View style={{ position: "absolute", left: 12, top: 15, height: 16, paddingHorizontal: 6, borderRadius: 8, justifyContent: "center", backgroundColor: c.panel, borderWidth: 1, borderColor: alpha(c.text, 0.2) }}>
          <Text numberOfLines={1} style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: c.text }}>
            {engine}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}
