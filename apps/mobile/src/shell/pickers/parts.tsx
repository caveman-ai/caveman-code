// Small parts every sheet shares: a group's quiet heading, the title row's Done, where a repository was found, and a
// list that fades at an edge with more beyond it.
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, type Ref, useRef, useState } from "react";
import { type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, type ScrollViewInstance, type ScrollViewProps, type StyleProp, Text, View, type ViewStyle } from "react-native";
import type { Source } from "../../board/places";
import { Tag } from "../../components/ui/Badge";
import { BrandMark } from "../../components/ui/BrandMark";
import { Button } from "../../components/ui/Button";
import { alpha, useTheme } from "../../theme";
import { SheetLabel, useSheet } from "../Sheet";

/** A group's heading in a sheet: the sheet's own section head (Sheet.tsx SheetLabel), 15pt grey in sentence case. */
export function Label({ children, first = false }: { children: string; first?: boolean }) {
  return <SheetLabel first={first}>{children}</SheetLabel>;
}

/** A sheet's way out at the right of its title: the small secondary button. */
export function Done({ onPress }: { onPress: () => void }) {
  return <Button label="Done" size="small" onPress={onPress} />;
}

/** Where a repository turned up (board/places.ts). */
export type { Source };

/** What `Found` draws, in words for a screen reader: "Claude and Codex sessions here, only on GitHub, used 2d ago". */
export function foundWords(sources: readonly Source[], clone: boolean, age?: string): string | undefined {
  const engines = [sources.includes("claude") && "Claude", sources.includes("codex") && "Codex"].filter(Boolean).join(" and ");
  const words = [engines && `${engines} sessions here`, clone && "only on GitHub", age && `used ${age} ago`].filter(Boolean);
  return words.length ? words.join(", ") : undefined;
}

/**
 * Where a repository was found, at its row's right (ProjectPicker.tsx CandidateMeta): the Claude spark and the OpenAI
 * mark for the engines whose sessions ran there, a "Clone" tag where it is only on GitHub, then how lately it was used.
 */
export function Found({ sources, clone, age }: { sources: readonly Source[]; clone: boolean; age?: string }) {
  const { c, t } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {sources.includes("claude") ? <BrandMark name="claude" size={14} /> : null}
      {sources.includes("codex") ? <BrandMark name="openai" size={14} color={c.muted} /> : null}
      {clone ? <Tag label="Clone" /> : null}
      {age ? <Text style={[t.meta, { minWidth: 26, textAlign: "right" }]}>{age}</Text> : null}
    </View>
  );
}

/**
 * A scrolling list that fades out at whichever edge has more beyond it (menu.tsx fadeEdges), so a list cut by its height
 * says there is more without a scroll bar. The desktop fades 20 and 24px over 32px rows; these are a finger's 44pt
 * rows, so the fades are 24 and 32. The fade is the grey it sits on drawn over the rows. `style` sizes it (a height, or a cap); the list fills it.
 */
export function FadeScroll({ style, scrollRef, children, onScroll, ...rest }: Omit<ScrollViewProps, "style"> & { style?: StyleProp<ViewStyle>; scrollRef?: Ref<ScrollViewInstance>; children: ReactNode }) {
  const { c } = useTheme();
  // It fades to whatever it sits on: the sheet's fill, or the popover grey in a menu.
  const ground = useSheet()?.fill ?? c.popover;
  const size = useRef({ y: 0, height: 0, content: 0 });
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = (next: Partial<typeof size.current>) => {
    const s = Object.assign(size.current, next);
    const top = s.y > 1;
    const bottom = s.y + s.height < s.content - 1;
    if (top !== edges.top || bottom !== edges.bottom) setEdges({ top, bottom });
  };
  return (
    <View style={style}>
      <ScrollView
        ref={scrollRef}
        {...rest}
        style={{ flexGrow: 1, flexShrink: 1 }}
        scrollEventThrottle={16}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
          measure({ y: e.nativeEvent.contentOffset.y });
          onScroll?.(e);
        }}
        onLayout={(e: LayoutChangeEvent) => measure({ height: e.nativeEvent.layout.height })}
        onContentSizeChange={(_, content) => measure({ content })}
      >
        {children}
      </ScrollView>
      {edges.top ? <LinearGradient pointerEvents="none" colors={[ground, alpha(ground, 0)]} style={{ position: "absolute", top: 0, left: 0, right: 0, height: 24 }} /> : null}
      {edges.bottom ? <LinearGradient pointerEvents="none" colors={[alpha(ground, 0), ground]} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 32 }} /> : null}
    </View>
  );
}
