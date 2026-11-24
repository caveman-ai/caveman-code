// The Needs you list as summary cards (SummaryCard.tsx, its `row` size), one per ask, the longest-waiting first: each
// says who asks, what it did so far and what it needs, and is answered where it is. An answer takes its card away at
// once, the cards under it closing up (its Undo is the shell's toast, src/asks/decide.ts), and Undo puts it back where
// it was; a new ask arrives at the foot, so nothing moves under a thumb. Tapping a card's body opens its chat, landing
// on the subagent that asks when one does. A card's own "Tell it something else…" field scrolls up clear of the
// keyboard.
//
// Signed in, the full list (`pulls`) holds the person's pull requests under the asks (pulls/PullRows.tsx): those that
// wait on their review, then their own open ones, read from Cloud each time the list is opened or pulled down. The
// list is empty only when neither asks nor pull requests are in it.
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Platform, RefreshControl, ScrollView, type ScrollViewInstance, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import Animated, { type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { PanelEmpty } from "../components/ui/Empty";
import { Quiet } from "../home/Quiet";
import { exit, layout as glide } from "../motion";
import { refreshPullList, usePerson, usePullList } from "../pulls/live";
import { PullRows } from "../pulls/PullRows";
import { BAR_HEIGHT } from "../shell/TopBar";
import { askerOf, needOf, type Row } from "../store/select";
import { useStore } from "../store/store";
import { layout } from "../theme";
import { act } from "./decide";
import { SummaryCard } from "./SummaryCard";

export function NeedsList({
  rows,
  top,
  showChief = true,
  empty,
  emptyLine,
  emptyIcon = "state-needs-input",
  pulls = false,
  bottom,
  onOpen,
  onScrolled,
  scrollY,
  onEnd,
}: {
  /** The rows that need you (a parent lit by its subagent's ask among them). */
  rows: readonly Row[];
  /** What leads the list: its title. */
  top: ReactNode;
  /** Lead each card with its Chief's face; a Chief's own list leaves it out. */
  showChief?: boolean;
  empty: string;
  emptyLine?: string;
  emptyIcon?: Exclude<PixelIconName, "engine-caveman">;
  /** Under the asks, the pull requests of whoever is signed in. Off for a list narrowed to a Chief, a project or a computer. */
  pulls?: boolean;
  /** Room under the last card, for the chat bar. */
  bottom: number;
  onOpen: (id: string) => void;
  onScrolled?: (past: boolean) => void;
  scrollY?: SharedValue<number>;
  /** Where the last card ends, for the chat bar's band (ProgressiveEdge useContentEnd). */
  onEnd?: (y: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const chats = useStore((s) => s.board.chats);
  const asks = useMemo(
    () =>
      rows
        .flatMap((row) => {
          const asker = askerOf(row.chat, chats);
          const need = needOf(asker);
          return need ? [{ row, asker, need }] : [];
        })
        .sort((a, b) => a.need.at - b.need.at),
    [rows, chats],
  );
  const person = usePerson();
  const waiting = usePullList(pulls);
  const [refreshing, setRefreshing] = useState(false);
  const scroller = useRef<ScrollViewInstance>(null);
  const at = useRef(new Map<string, number>());
  const cardsAt = useRef(0);
  const past = useRef(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    if (scrollY) scrollY.value = y;
    const now = y > 36;
    if (now !== past.current) {
      past.current = now;
      onScrolled?.(now);
    }
  };
  // A card's field took focus: the card goes up under the bar, so the keyboard never covers what you're writing.
  const lift = (id: string) => {
    const card = at.current.get(id);
    if (card === undefined) return;
    const y = cardsAt.current + card;
    setTimeout(() => scroller.current?.scrollTo({ y: Math.max(0, y - insets.top - BAR_HEIGHT - 8), animated: true }), Platform.OS === "ios" ? 250 : 0);
  };

  return (
    <ScrollView
      ref={scroller}
      style={{ flex: 1 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      {...(Platform.OS === "web" ? null : { keyboardDismissMode: "interactive" as const, automaticallyAdjustKeyboardInsets: true })}
      // Pulling the list down reads the pull requests again (a phone's own gesture; the web build has none).
      {...(Platform.OS === "web" || !pulls || person === null
        ? null
        : {
            refreshControl: (
              <RefreshControl
                refreshing={refreshing}
                progressViewOffset={insets.top + BAR_HEIGHT}
                onRefresh={() => {
                  setRefreshing(true);
                  void refreshPullList(person).finally(() => setRefreshing(false));
                }}
              />
            ),
          })}
    >
      {top}
      {asks.length ? (
        <View onLayout={(e) => (cardsAt.current = e.nativeEvent.layout.y)} style={{ paddingHorizontal: layout.inset, gap: 12, paddingTop: 4 }}>
          {asks.map(({ row, asker, need }) => (
            <Animated.View
              key={`${asker.id}:${need.at}`}
              layout={glide}
              exiting={exit.gone}
              onLayout={(e) => at.current.set(asker.id, e.nativeEvent.layout.y)}
            >
              <SummaryCard
                asker={asker}
                row={row.chat}
                need={need}
                variant="row"
                showChief={showChief}
                onReply={(reply) => void act(asker.id, reply)}
                onOpen={() => onOpen(row.chat.id)}
                onFieldFocus={() => lift(asker.id)}
              />
            </Animated.View>
          ))}
        </View>
      ) : waiting.kind !== "none" ? null : (
        // Empty, its glyph is grey like a quiet tile's: no amber when nothing waits on you.
        <View style={{ paddingTop: 48 + 40 }}>
          <View style={{ alignItems: "center", marginBottom: 12 - 40 }}>
            <Quiet name={emptyIcon} size={16} />
          </View>
          <PanelEmpty title={empty} line={emptyLine} />
        </View>
      )}
      <PullRows view={waiting} first={asks.length === 0} />
      <View onLayout={(e) => onEnd?.(e.nativeEvent.layout.y)} style={{ height: bottom }} />
    </ScrollView>
  );
}
