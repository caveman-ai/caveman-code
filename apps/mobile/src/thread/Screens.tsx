// The agent's browser and computer from a chat (the desktop's InUseButton, FloatingScreen and side-panel tabs),
// three ways in:
// - the floating row: a glass pill that says Browser or Computer for each screen the agent opened, the one it is
//   using now first with the blue live dot pulsing, the ones it used and left after it in grey, still a tap away;
// - a long press on the chat's title: the screen it uses (or last used) live and small, over a row for each screen and
//   then the chat's own menu, the way iOS pairs a preview with its menu (a tap on the title still opens Details);
// - the sheet either opens: the screen live with the agent's cursor, and who has it. Take over stops the agent and
//   hands the screen to your finger; Hand back, or closing the sheet, gives it back. A screen nobody is using is yours
//   at a touch. A Mac's computer (the app the agent used, through agent-desktop) is the exception: it takes no input
//   from here, so Take over pauses the agent and brings the app forward on that Mac, for its own mouse.
// Everything here reads the screens through a LiveSource (live/protocol.ts); the script's stand in for the runtime's.
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { type Chat, deviceById, ENGINE_NAME } from "../board/model";
import { DeviceGlyph, PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { LiveDot } from "../components/ui/Badge";
import type { MenuEntry } from "../components/ui/Menu";
import { MenuSeparator } from "../components/ui/Menu";
import { LiveScreen } from "../live/LiveScreen";
import type { Screen } from "../live/protocol";
import { canStream, inUse, sourceFor, takesInput } from "../live/scripted";
import { useLive } from "../live/useLive";
import { Sheet } from "../shell/Sheet";
import { alpha, useTheme } from "../theme";

export const SCREEN_NAME: Record<Screen, string> = { browser: "Browser", computer: "Computer" };

/** A screen's glyph: the browser's, or the computer the chat runs on. */
export function ScreenGlyph({ chat, screen, ink }: { chat: Chat; screen: Screen; ink?: string }) {
  return screen === "browser" ? <PixelIcon name="tool-browser" ink={ink} /> : <DeviceGlyph device={deviceById(chat.device)} ink={ink} />;
}

/** A page's address as the views name it: host and path. */
function pageHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/** Where a screen is, in a few words: the page's address; on a Mac the app the agent used; else the computer's name. */
function whereOf(chat: Chat, screen: Screen): string {
  const state = sourceFor(chat.id, screen).state;
  if (state && "url" in state) return pageHost(state.url);
  if (state && "app" in state && state.app) return state.app.name;
  return deviceById(chat.device).name;
}

/** The long press's preview: the screen the agent is on, or the last one it opened, live and small; a tap opens it. */
function ScreenPeek({ chat, onOpen }: { chat: Chat; onOpen: (screen: Screen) => void }) {
  const { c } = useTheme();
  const lead = (["browser", "computer"] as const).filter((s) => canStream(chat, s)).sort((a, b) => Number(inUse(chat, b)) - Number(inUse(chat, a)))[0];
  const source = lead ? sourceFor(chat.id, lead) : null;
  const live = useLive(source, !!source);
  const [width, setWidth] = useState(0);
  if (!lead || !source) return null;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Squish label={`Open the ${lead}, ${whereOf(chat, lead)}`} onPress={() => onOpen(lead)} depth={0.98}>
        <View style={{ borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: c.hairline }}>
          {width ? <LiveScreen source={source} live={live} width={width - 2} engine={ENGINE_NAME[chat.engine]} label={`The agent's ${lead}`} /> : null}
        </View>
      </Squish>
      <MenuSeparator />
    </View>
  );
}

/** The screens' part of a long press on a chat's title: a row for each, the lead one live at the head. */
export function screenMenu(chat: Chat, onOpen: (screen: Screen) => void): { header: (close: () => void) => ReactNode; entries: MenuEntry[] } {
  const device = deviceById(chat.device);
  const row = (screen: Screen, why: string): MenuEntry => {
    const can = canStream(chat, screen);
    return {
      label: SCREEN_NAME[screen],
      description: can ? whereOf(chat, screen) : why,
      under: true,
      icon: <ScreenGlyph chat={chat} screen={screen} />,
      trailing: inUse(chat, screen) ? <LiveDot /> : undefined,
      disabled: !can,
      onPress: () => onOpen(screen),
    };
  };
  return {
    header: (close) => (
      <ScreenPeek
        chat={chat}
        onOpen={(screen) => {
          close();
          onOpen(screen);
        }}
      />
    ),
    entries: [
      row("browser", "No page open yet"),
      // A Cloud computer's desktop starts when it is first used; on a Mac it is the app the agent uses, once it uses one.
      row("computer", device.kind === "cloud" ? `${device.name}: no desktop yet` : `${device.name}: no app used yet`),
    ],
  };
}

/** A chat's own menu with its screens added over it: the long press never takes the chat's actions away. */
export function withScreens(screens: ReturnType<typeof screenMenu>, menu: readonly MenuEntry[]) {
  return { header: screens.header, entries: [...screens.entries, { type: "separator" as const }, ...menu] };
}

/** One of the agent's screens, live on a medium sheet over the chat. */
export function ScreenSheet({ chat, screen, onClose }: { chat: Chat | undefined; screen: Screen | null; onClose: () => void }) {
  const { c, t } = useTheme();
  // The screen stays drawn while the sheet goes down.
  const [shown, setShown] = useState(screen);
  if (screen && screen !== shown) setShown(screen);
  const source = chat && shown ? sourceFor(chat.id, shown) : null;
  const open = !!screen && !!chat && !!shown && canStream(chat, shown);
  const live = useLive(source, open);
  const [width, setWidth] = useState(0);
  if (!chat || !shown || !source) return null;

  const engine = ENGINE_NAME[chat.engine];
  const agent = live.controller === "agent";
  // A Mac's computer is driven at that Mac: Take over pauses the agent and brings its app forward there.
  const touches = takesInput(chat, shown);
  const device = deviceById(chat.device);
  const app = live.state && "app" in live.state ? live.state.app?.name : undefined;
  const [lead, detail] = live.holding
    ? touches
      ? // What a person does here, the agent's account can read: the browser's profile, the desktop's keyboard.
        ["You're in control", shown === "browser" ? "Sign-ins here are the agent's too" : "The agent can see what you type"]
      : ["You're in control", `${engine} waits. ${app ?? "The app"} is in front on ${device.name}`]
    : agent
      ? [`${engine} is using ${shown === "computer" && app ? app : `the ${shown}`}`, chat.line]
      : live.controller === "user"
        ? ["In control somewhere else", touches ? "Take over to use it here" : `On ${device.name}`]
        : ["Not in use", touches ? `Tap the ${shown === "browser" ? "page" : "screen"} to use it yourself` : `Use ${app ?? "it"} on ${device.name}`];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      detent="medium"
      // Which screen, and where it is: the page's own title is in the picture (the desktop's float: "Agent browser · host").
      title={SCREEN_NAME[shown]}
      subtitle={whereOf(chat, shown)}
      action={live.holding || agent || live.controller === "user" ? { label: live.holding ? "Hand back" : "Take over", onPress: () => void live.control(live.holding ? "agent" : "user") } : undefined}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, gap: 12 }}>
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: live.holding ? c.target : c.hairline }}>
          {width ? (
            <LiveScreen
              source={source}
              live={live}
              width={width - 2}
              engine={engine}
              // Your finger reaches the screen once you hold it, or straight away when nobody is using it; never a Mac's.
              touch={touches && (live.holding || live.controller === "none")}
              take={() => live.control("user")}
              label={`The agent's ${shown}, ${whereOf(chat, shown)}`}
            />
          ) : null}
        </View>
        <View accessible accessibilityLabel={`${lead}. ${detail}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 }}>
          {agent ? <LiveDot /> : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: live.holding ? c.target : alpha(c.muted, 0.5) }} />}
          <Text numberOfLines={1} style={[t.small, { flex: 1, fontSize: 14, lineHeight: 19 }]}>
            <Text style={{ color: c.text, fontWeight: "500" }}>{lead}</Text>
            {detail ? ` · ${detail}` : null}
          </Text>
        </View>
      </View>
    </Sheet>
  );
}
