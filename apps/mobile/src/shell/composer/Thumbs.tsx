// What's attached, inside the focused card over its toolbar (Cursor 5355): one thumbnail each, in the order attached,
// the picture itself (a drawn screenshot on the web build), with a ✕ on each to take it off. A tap on a thumbnail sees
// it whole (photos/Viewer.tsx); the box holds the card open meanwhile and gives the keyboard back after.
import { useState } from "react";
import { ScrollView, View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { Squish } from "../../components/Squish";
import { enter, exit, haptic, layout } from "../../motion";
import { forget } from "../../photos/pick";
import { Picture } from "../../photos/Picture";
import { shotRadius } from "../../photos/ShotThumb";
import { PhotoViewer } from "../../photos/Viewer";
import { type Attachment, detach, shotById, useAttached } from "./attached";
import { BOX } from "./state";

export { ShotThumb } from "../../photos/ShotThumb";

/** What a thumbnail is, as VoiceOver says it: "photo 2", "screenshot 1". */
const kindOf = (a: Attachment) => (a.shot || /screenshot/i.test(a.name ?? "") ? "screenshot" : "photo");

/**
 * What's attached to a box. `onOpen` sees one whole; without it the strip opens its own viewer (a box that doesn't
 * need to hold itself open around it).
 */
export function AttachmentStrip({ scope, onOpen }: { scope: string; onOpen?: (index: number) => void }) {
  const list = useAttached(scope);
  const [viewing, setViewing] = useState<number | null>(null);
  if (!list.length) return null;
  const size = BOX.thumbs;
  const radius = shotRadius(size);
  const open = onOpen ?? setViewing;
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }} style={{ height: size, flexGrow: 0 }}>
        {list.map((a, i) => {
          const what = `${kindOf(a)} ${i + 1}`;
          const shot = a.shot ? shotById(a.shot) : undefined;
          return (
            <Animated.View key={a.id} entering={enter.fade} exiting={exit.gone} layout={layout} style={{ width: size, height: size }}>
              <Squish label={shot ? `See ${what}: ${shot.title}` : `See ${what}`} onPress={() => open(i)} depth={0.96}>
                <Picture image={a} width={size} height={size} radius={radius} priority="high" />
              </Squish>
              <View style={{ position: "absolute", top: 3, right: 3 }}>
                <Squish
                  label={`Detach ${what}`}
                  onPress={() => {
                    haptic.tick();
                    detach(scope, a.id);
                    forget(a);
                  }}
                  depth={0.88}
                  hitSlop={12}
                  style={{ width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.62)" }}
                >
                  <Icon name="close" size={11} stroke={2.4} color="#e3e4e6" />
                </Squish>
              </View>
            </Animated.View>
          );
        })}
      </ScrollView>
      {onOpen ? null : <PhotoViewer images={list} index={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
