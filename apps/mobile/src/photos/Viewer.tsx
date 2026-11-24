// A picture seen whole: what a thumbnail in the box or a picture in a message opens. Black, the picture fitted to the
// screen, ✕ at the top left as every sheet has it, and "2 of 4" over a message's pictures, which page sideways. A swipe
// down (or up) takes it away, the picture following the finger and the black thinning as it goes; let go short of
// that and it settles back. With Reduce Motion it comes and goes without the slide (Reanimated jumps every animation to
// its end), and VoiceOver's escape closes it.
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { FlatList, Modal, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, GestureHandlerRootView, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { duration, ease, release, useReducedMotion } from "../motion";
import { shotById } from "../shell/composer/attached";
import { glass, layout, useTheme } from "../theme";
import { fitted, Picture, type Pictured } from "./Picture";

/** The viewer is dark whatever the app is: the deck's dark ink on black. */
const INK = "#e3e4e6";
/** How far a drag goes, or how fast, before letting go takes the picture away. */
const AWAY = 110;
const FLING = 900;

/** `index` is the picture it opens on; null, it's closed. */
export function PhotoViewer({ images, index, onClose }: { images: readonly Pictured[]; index: number | null; onClose: () => void }) {
  const open = index !== null && images.length > 0;
  return (
    <Modal transparent visible={open} animationType="none" onRequestClose={onClose} statusBarTranslucent supportedOrientations={["portrait", "landscape"]}>
      {open ? (
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Stage images={images} start={Math.min(index, images.length - 1)} onClose={onClose} />
        </GestureHandlerRootView>
      ) : null}
    </Modal>
  );
}

/** What VoiceOver says a picture is. */
export function pictureLabel(image: Pictured, i: number, n: number) {
  const shot = image.shot ? shotById(image.shot) : undefined;
  const what = shot ? `Screenshot: ${shot.title}` : "Photo";
  return n > 1 ? `${what}, ${i + 1} of ${n}` : what;
}

function Stage({ images, start, onClose }: { images: readonly Pictured[]; start: number; onClose: () => void }) {
  const { t } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const still = useReducedMotion();
  const n = images.length;
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);
  const [at, setAt] = useState(start);
  const atRef = useRef(start);
  const closing = useRef(false);

  useEffect(() => {
    shown.value = withTiming(1, { duration: duration.base, easing: ease.snap });
  }, [shown]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    shown.value = withTiming(0, { duration: duration.fast, easing: ease.snap }, (done) => {
      if (done) scheduleOnRN(onClose);
    });
  };

  const pan = usePanGesture({
    activeOffsetY: [-12, 12],
    failOffsetX: [-16, 16],
    onUpdate: (e) => {
      "worklet";
      drag.value = e.translationY;
    },
    onDeactivate: (e) => {
      "worklet";
      if (Math.abs(e.translationY) > AWAY || Math.abs(e.velocityY) > FLING) {
        const down = e.translationY + e.velocityY * 0.1 >= 0;
        drag.value = withTiming((down ? 1 : -1) * height, { duration: duration.base, easing: ease.snap });
        shown.value = withTiming(0, { duration: duration.base, easing: ease.snap }, (done) => {
          if (done) scheduleOnRN(onClose);
        });
        return;
      }
      drag.value = withSpring(0, release);
    },
  });

  const backdrop = useAnimatedStyle(() => ({ opacity: shown.value * (1 - Math.min(1, Math.abs(drag.value) / (height * 0.55))) }));
  const picture = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: drag.value }, { scale: still ? 1 : 1 - Math.min(0.12, Math.abs(drag.value) / (height * 2)) }],
  }));
  const chrome = useAnimatedStyle(() => ({ opacity: shown.value * (1 - Math.min(1, Math.abs(drag.value) / 80)) }));

  // The picture fits the screen inside its safe edges.
  const box = { width, height: height - insets.top - insets.bottom };
  return (
    <View style={{ flex: 1 }} accessibilityViewIsModal onAccessibilityEscape={close}>
      {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar's style is a string, the text's colour. */}
      <StatusBar style="light" />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "#000000" }, backdrop]} />
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ flex: 1 }, picture]}>
          <FlatList
            horizontal
            pagingEnabled
            data={images}
            keyExtractor={(image, i) => `${i}:${image.shot ?? image.uri}`}
            initialScrollIndex={start}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            scrollEnabled={n > 1}
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={32}
            onScroll={(e) => {
              const i = Math.max(0, Math.min(n - 1, Math.round(e.nativeEvent.contentOffset.x / width)));
              if (i === atRef.current) return;
              atRef.current = i;
              setAt(i);
            }}
            renderItem={({ item, index: i }) => {
              const size = item.width && item.height ? fitted(item, box) : item.shot ? fitted(item, box) : box;
              return (
                <View style={{ width, height, paddingTop: insets.top, paddingBottom: insets.bottom, alignItems: "center", justifyContent: "center" }}>
                  <Picture image={item} width={size.width} height={size.height} radius={item.shot ? 16 : 0} fit="contain" bare label={pictureLabel(item, i, n)} priority="high" />
                </View>
              );
            }}
          />
        </Animated.View>
      </GestureDetector>
      <Animated.View pointerEvents="box-none" style={[{ position: "absolute", top: insets.top + 8, left: layout.inset, right: layout.inset, height: layout.float, flexDirection: "row", alignItems: "center" }, chrome]}>
        {n > 1 ? (
          <Text accessibilityLiveRegion="polite" style={[t.label, { position: "absolute", left: 0, right: 0, textAlign: "center", color: INK, fontVariant: ["tabular-nums"] }]}>
            {at + 1} of {n}
          </Text>
        ) : null}
        <Squish label="Close" onPress={close} depth={0.88} hitSlop={4}>
          <View style={{ width: layout.float, height: layout.float, borderRadius: layout.float / 2, backgroundColor: glass.float.fill.dark, borderWidth: StyleSheet.hairlineWidth, borderColor: glass.float.edge.dark, alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={20} color={INK} />
          </View>
        </Squish>
      </Animated.View>
    </View>
  );
}
