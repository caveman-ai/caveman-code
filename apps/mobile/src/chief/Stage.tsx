// A call's stage, over the chat, which stays readable behind it ("the full screen gets blurred
// when calling the chief and you cant see the chat anymore"): your words as subtitles just above the call's bar, in
// quotes and a step quieter (as the desktop's call captions yours), on a short fade so they read over the chat; and,
// at the top, whatever the Chief brought up (docs/chief.md, Calls, "Show, don't tell"): the chat's change itself, to
// look at while you talk about it, under the desktop's "Showing" line with its live dot. When you're done with it,
// it goes.
import { LinearGradient } from "expo-linear-gradient";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { type Chat, ENGINE_NAME } from "../board/model";
import { RunsPreview } from "../components/RunsPreview";
import { EngineLogo } from "../components/ui/EngineLogo";
import { enter, exit } from "../motion";
import { alpha, overlayShadow, radius, useTheme } from "../theme";
import { Facts, Files } from "./parts";

interface Props {
  /** Your words so far, or a quiet "Listening". */
  caption: string;
  quiet: boolean;
  showing: Chat | null;
  top: number;
  bottom: number;
}

export function Stage({ caption, quiet, showing, top, bottom }: Props) {
  const { c, t, dark } = useTheme();
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top, bottom, alignItems: "center", paddingHorizontal: 24 }}>
      {caption ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 28, paddingBottom: 10, paddingHorizontal: 28 }}>
          <LinearGradient colors={[alpha(c.panel, 0), alpha(c.panel, 0.92)]} locations={[0, 0.45]} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />
          <Animated.Text
            key={quiet ? "quiet" : "heard"}
            entering={enter.fade}
            exiting={exit.gone}
            accessibilityLiveRegion="polite"
            numberOfLines={3}
            style={quiet ? [t.row, { textAlign: "center", color: c.subtle }] : [t.label, { textAlign: "center", fontSize: 18, lineHeight: 25, color: c.soft }]}
          >
            {quiet ? caption : `“${caption}”`}
          </Animated.Text>
        </View>
      ) : null}
      {showing ? (
        <Animated.View
          key={showing.id}
          entering={enter.float}
          exiting={exit.float}
          style={{ marginTop: 8, alignSelf: "stretch", maxWidth: 440, backgroundColor: c.card, borderRadius: radius.bubble, borderWidth: 1, borderColor: c.edge, padding: 16, gap: 12, ...overlayShadow(dark) }}
        >
          <View style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.success }} />
              <Text style={[t.small, { flex: 1, color: c.text, fontWeight: "600" }]}>Showing</Text>
              <EngineLogo engine={showing.engine} size={14} />
              <Text style={t.small}>{ENGINE_NAME[showing.engine]}</Text>
            </View>
            <Text numberOfLines={2} style={t.heading}>
              {showing.title}
            </Text>
          </View>
          {showing.moment?.preview === "runs" ? <RunsPreview /> : showing.moment ? <Files moment={showing.moment} /> : null}
          {showing.moment ? <Facts moment={showing.moment} /> : null}
        </Animated.View>
      ) : null}
    </View>
  );
}
