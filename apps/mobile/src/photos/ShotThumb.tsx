// A screenshot drawn rather than loaded: the web build has no photo library, so its `+` strip shows the prototype's
// screenshots (attached.ts SHOTS), each drawn from what it was of (a list, a chat, a diff, a settings page) in the
// deck's own greys, small enough that it reads as a picture of a screen. Wherever a real picture would show (the strip,
// the grid, the box, a sent message, the viewer), a drawn one shows this.
import { View } from "react-native";
import type { Shot } from "../shell/composer/attached";
import { alpha, useTheme } from "../theme";

/**
 * A screen in miniature. Everything is laid out on a 92-wide grid and scaled to `width`. `radius` overrides the corner
 * it rounds to at that size (0 inside a clipped grid, which rounds the group instead).
 */
export function ShotThumb({ shot, width, height, radius }: { shot: Shot; width: number; height: number; radius?: number }) {
  const { c } = useTheme();
  const k = width / 92;
  const ink = shot.dark ? "#e3e4e6" : "#1f1f21";
  const bg = shot.dark ? "#121213" : "#ffffff";
  const line = (w: number, o = 0.22, h = 3) => <View style={{ width: w * k, height: h * k, borderRadius: 1.5 * k, backgroundColor: alpha(ink, o) }} />;
  let body;
  if (shot.look === "list") {
    body = (
      <View style={{ gap: 9 * k }}>
        {line(38, 0.6, 5)}
        {[52, 44, 58, 40, 50].map((w, i) => (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 5 * k }}>
            <View style={{ width: 5 * k, height: 5 * k, borderRadius: 3 * k, backgroundColor: i === 1 ? "#f09c2d" : i === 3 ? "#3fcf7b" : alpha(ink, 0.3) }} />
            <View style={{ gap: 3 * k }}>
              {line(w, 0.42)}
              {line(w * 0.6, 0.18, 2)}
            </View>
          </View>
        ))}
      </View>
    );
  } else if (shot.look === "chat") {
    body = (
      <View style={{ gap: 6 * k }}>
        <View style={{ alignSelf: "flex-end", width: 46 * k, height: 12 * k, borderRadius: 6 * k, backgroundColor: alpha(ink, 0.14) }} />
        {line(70)}
        {line(64)}
        {line(52)}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 * k, marginTop: 2 * k }}>
          <View style={{ width: 4 * k, height: 4 * k, borderRadius: 2 * k, backgroundColor: alpha(ink, 0.4) }} />
          <View style={{ width: 34 * k, height: 3 * k, borderRadius: 1.5 * k, backgroundColor: alpha("#7eabf3", 0.7) }} />
        </View>
        {line(60)}
        {line(44)}
      </View>
    );
  } else if (shot.look === "diff") {
    body = (
      <View style={{ gap: 3 * k }}>
        {line(40, 0.55, 4)}
        <View style={{ height: 4 * k }} />
        {[0, 0, -1, -1, 1, 1, 1, 0, 0, 1].map((d, i) => (
          <View key={i} style={{ height: 6 * k, borderRadius: 1 * k, paddingLeft: 3 * k, justifyContent: "center", backgroundColor: d > 0 ? alpha("#3fcf7b", 0.14) : d < 0 ? alpha("#e36369", 0.14) : undefined }}>
            {line([44, 60, 38, 52, 66, 48, 30, 56, 40, 62][i]!, d ? 0.34 : 0.2, 2)}
          </View>
        ))}
      </View>
    );
  } else {
    body = (
      <View style={{ gap: 7 * k }}>
        {line(34, 0.6, 5)}
        {[3, 2].map((rows, g) => (
          <View key={g} style={{ borderRadius: 5 * k, backgroundColor: alpha(ink, 0.05), paddingHorizontal: 5 * k, paddingVertical: 4 * k, gap: 5 * k }}>
            {Array.from({ length: rows }, (_, i) => (
              <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                {line(30 + i * 8, 0.38)}
                <View style={{ width: 10 * k, height: 6 * k, borderRadius: 3 * k, backgroundColor: i === 0 ? "#3fcf7b" : alpha(ink, 0.18) }} />
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Screenshot: ${shot.title}`}
      style={{ width, height, borderRadius: radius ?? shotRadius(width), overflow: "hidden", backgroundColor: bg, borderWidth: 1, borderColor: shot.dark ? c.edge : alpha("#000000", 0.08), paddingHorizontal: 8 * k, paddingTop: 10 * k }}
    >
      {body}
    </View>
  );
}

/** The corner a thumbnail rounds to at its width: 12 at the strip's size and up, a little less as it gets smaller. */
export const shotRadius = (width: number) => Math.round(12 * Math.min(1, (width / 92) * 1.2));
