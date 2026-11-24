// Empty states, the desktop's two looks (STYLE.md 4, "cleaner empty states"). Copy says what will
// appear and how to get it there, in plain words, sentence case in the system face; an error keeps the shape (the
// title says what failed, the line what to do).
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { enter } from "../../motion";
import { alpha, useTheme } from "../../theme";
import { Mascot, PixelIcon } from "../Pixel";

/**
 * The dithered floor a character stands on (px-dither-50 in the tertiary grey): two rows of alternating cells. `sink`
 * tucks it up under the feet by a cell, as What's new stands the companion on it.
 */
export function Floor({ width, cell, sink = false }: { width: number; cell: number; sink?: boolean }) {
  const { c } = useTheme();
  const cols = Math.floor(width / cell);
  return (
    <Svg width={cols * cell} height={cell * 2} style={sink ? { marginTop: -cell } : undefined}>
      {Array.from({ length: cols * 2 }, (_, i) => {
        const x = i % cols;
        const y = Math.floor(i / cols);
        return (x + y) % 2 === 0 ? <Rect key={i} x={x * cell} y={y * cell} width={cell} height={cell} fill={c.subtle} /> : null;
      })}
    </Svg>
  );
}

/**
 * A whole page or column with nothing in it (EmptyState): the caveman at 2x on his floor, the title 17 at 600, one
 * line in the tertiary grey at most 340 wide, and the one real next step under it (a Button). It fades in; nothing
 * slides.
 */
export function PageEmpty({ title, line, action, size = 48 }: { title: string; line?: ReactNode; action?: ReactNode; size?: 48 | 72 }) {
  const { c, t } = useTheme();
  const cell = size / 24;
  return (
    <Animated.View entering={enter.fade} style={{ alignItems: "center", paddingHorizontal: 24 }}>
      <Mascot size={size} />
      <Floor width={size + 8 * cell * 2} cell={cell} />
      <Text accessibilityRole="header" style={[t.heading, { marginTop: 16, textAlign: "center" }]}>
        {title}
      </Text>
      {line ? <Text style={[t.small, { fontSize: 15, lineHeight: 21, marginTop: 4, maxWidth: 340, textAlign: "center", color: c.subtle }]}>{line}</Text> : null}
      {action ? <View style={{ marginTop: 16, flexDirection: "row", gap: 8 }}>{action}</View> : null}
    </Animated.View>
  );
}

/**
 * A list, card or panel with nothing in it (SurfaceEmpty): an optional 16pt pixel glyph at 55% ink where one fits the
 * subject, the title at 500 and 85% ink, one line in the tertiary grey at most 300 wide, a small secondary button.
 * Centred, 40pt above and below.
 */
export function PanelEmpty({ icon, title, line, action }: { icon?: PixelIconName; title: string; line?: ReactNode; action?: ReactNode }) {
  const { c, t } = useTheme();
  return (
    <Animated.View entering={enter.fade} style={{ alignItems: "center", paddingHorizontal: 24, paddingVertical: 40 }}>
      {icon ? (
        <View style={{ marginBottom: 12 }}>
          <PixelIcon name={icon} ink={alpha(c.text, 0.55)} animate={false} />
        </View>
      ) : null}
      <Text style={[t.label, { color: alpha(c.text, 0.85), textAlign: "center", maxWidth: 300 }]}>{title}</Text>
      {line ? <Text style={[t.meta, { marginTop: 4, textAlign: "center", maxWidth: 300 }]}>{line}</Text> : null}
      {action ? <View style={{ marginTop: 14, flexDirection: "row", gap: 8 }}>{action}</View> : null}
    </Animated.View>
  );
}
