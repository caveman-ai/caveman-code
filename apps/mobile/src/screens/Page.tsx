// A screen's scrolling body: clear of the top bar above and the composer below, both of which float over it.
//
// ListPage is the one pushed page every list and place wears (the lists, a workspace, a device, Review, Automations):
// a 44 pt back circle and the page's own circles at the right (Search, by default), a large title at 32/600 with an
// optional 15 grey line under it, and the page under the bar's edge. Scrolled past its title, the bar's capsule takes
// the title, as on /agents/all.
import { forwardRef, type ReactNode, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, type ScrollViewInstance, type ScrollViewProps, View } from "react-native";
import { type SharedValue, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COMPOSER_ROOM } from "../shell/Composer";
import { ListTitle } from "../shell/rows/ListTop";
import { BAR_HEIGHT, TopBar } from "../shell/TopBar";
import { useIsRoot } from "../nav/routes";
import { askQueue } from "../store/select";
import { useStore } from "../store/store";

export const Page = forwardRef<ScrollViewInstance, ScrollViewProps & { children: ReactNode; below?: number; /** How far it has scrolled, for the bar's edge. */ scrollY?: SharedValue<number> }>(function Page({ children, below = 0, contentContainerStyle, scrollY, onScroll, ...rest }, ref) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      ref={ref}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={(e) => {
        if (scrollY) scrollY.value = e.nativeEvent.contentOffset.y;
        onScroll?.(e);
      }}
      contentContainerStyle={[{ paddingTop: insets.top + BAR_HEIGHT + 8, paddingBottom: Math.max(insets.bottom, 10) + COMPOSER_ROOM + below + 16 }, contentContainerStyle]}
      {...rest}
    >
      {children}
    </ScrollView>
  );
});

/** How far a page scrolls before the bar takes its title (ChatList's, so every list hands over at the same point). */
const PAST = 36;

/**
 * A pushed page on the list shell. `right` holds the bar's right circles; `top` hangs under the title (a segmented
 * control, a search field); the children are the page's rows, at the lists' insets.
 */
export function ListPage({ title, line, onBack, right, top, children, below = 0 }: { title: string; line?: string; onBack: () => void; right?: ReactNode; top?: ReactNode; children: ReactNode; below?: number }) {
  const root = useIsRoot();
  const waiting = useStore((s) => (root ? askQueue(s).length : 0));
  const insets = useSafeAreaInsets();
  const edgeY = useSharedValue(0);
  const [past, setPast] = useState(false);
  const was = useRef(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const now = e.nativeEvent.contentOffset.y > PAST;
    if (now !== was.current) {
      was.current = now;
      setPast(now);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <Page below={below} scrollY={edgeY} onScroll={onScroll} contentContainerStyle={{ paddingTop: 0, paddingBottom: Math.max(insets.bottom, 10) + 32 + below }}>
        <ListTitle title={title} line={line} />
        {top}
        {children}
      </Page>
      {/* Opened from the sidebar it is the panel's root: the sidebar's button where Back would be (nav/ref.ts showPlace). */}
      <TopBar root={root} waiting={waiting} onBack={onBack} scrollY={edgeY} title={past ? title : undefined} subtitle={past ? line : undefined} right={right} />
    </View>
  );
}
