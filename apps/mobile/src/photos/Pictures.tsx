// The pictures over your words in a message (Transcript.tsx YouBubble), right-aligned as the bubble is. One shows large,
// at its own proportions inside 240 by 320, its corners the bubble family's 16. Two stand side by side, three as one
// tall and two stacked, four as a square of four; more show four, the last one dimmed under "+3" for the three past it. The group rounds as
// one, with hairline gaps between, so it reads as one thing you sent. Each one opens the viewer on it.
import { StyleSheet, Text, View } from "react-native";
import type { SentImage } from "../board/model";
import { Squish } from "../components/Squish";
import { alpha, sans, useTheme } from "../theme";
import { fitted, Picture } from "./Picture";
import { pictureLabel } from "./Viewer";

/** A lone picture fits inside this box; a group is this wide. */
const MAX_W = 240;
const MAX_H = 320;
/** A lone picture is never narrower or shorter than this: a panorama or a long screenshot is cropped to it instead. */
const MIN_W = 120;
const MIN_H = 90;
const CORNER = 16;
const GAP = 2;

/** `room`: the widest the pictures may be (80% of the row, as the bubble). */
export function Pictures({ images, room, onOpen }: { images: readonly SentImage[]; room: number; onOpen: (index: number) => void }) {
  const { c } = useTheme();
  const n = images.length;
  const W = Math.max(MIN_W, Math.min(MAX_W, room > 0 ? room : MAX_W));
  if (!n) return null;

  if (n === 1) {
    const image = images[0]!;
    const fit = fitted(image, { width: W, height: MAX_H });
    return (
      <Squish label={pictureLabel(image, 0, 1)} depth={0.98} onPress={() => onOpen(0)}>
        <Picture image={image} width={Math.max(MIN_W, fit.width)} height={Math.max(MIN_H, fit.height)} radius={CORNER} />
      </Squish>
    );
  }

  const cell = Math.floor((W - GAP) / 2);
  const whole = cell * 2 + GAP;
  const tile = (i: number, width: number, height: number) => {
    // The fourth, dimmed, says how many more there are past it.
    const more = i === 3 && n > 4 ? n - 4 : 0;
    const image = images[i]!;
    return (
      <Squish key={i} label={more ? `${pictureLabel(image, i, n)}, and ${more} more` : pictureLabel(image, i, n)} depth={0.98} onPress={() => onOpen(i)}>
        <Picture image={image} width={width} height={height} radius={0} />
        {more ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: alpha(c.scrim, 0.48), alignItems: "center", justifyContent: "center" }]}>
            <Text style={{ fontFamily: sans, fontSize: 20, lineHeight: 26, fontWeight: "600", color: "#e3e4e6", fontVariant: ["tabular-nums"] }}>+{more}</Text>
          </View>
        ) : null}
      </Squish>
    );
  };

  let body;
  if (n === 2) {
    const tall = Math.round(cell * (4 / 3));
    body = (
      <View style={{ flexDirection: "row", gap: GAP }}>
        {tile(0, cell, tall)}
        {tile(1, cell, tall)}
      </View>
    );
  } else if (n === 3) {
    body = (
      <View style={{ flexDirection: "row", gap: GAP }}>
        {tile(0, cell, whole)}
        <View style={{ gap: GAP }}>
          {tile(1, cell, cell)}
          {tile(2, cell, cell)}
        </View>
      </View>
    );
  } else {
    body = (
      <View style={{ gap: GAP }}>
        <View style={{ flexDirection: "row", gap: GAP }}>
          {tile(0, cell, cell)}
          {tile(1, cell, cell)}
        </View>
        <View style={{ flexDirection: "row", gap: GAP }}>
          {tile(2, cell, cell)}
          {tile(3, cell, cell)}
        </View>
      </View>
    );
  }
  return <View style={{ width: whole, borderRadius: CORNER, overflow: "hidden" }}>{body}</View>;
}
