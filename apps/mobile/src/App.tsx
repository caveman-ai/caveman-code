// Caveman Code on a phone: one native stack, the main panel, lying over the sidebar it slides aside to show
// (nav/Navigator.tsx, shell/DrawerLayout.tsx), each screen drawing its own bar and box, and over both what any screen
// can open: the sheets, the moment card and the toast (shell/Overlays.tsx). What it shows comes from the app's store
// (store/), read from disk before the first frame, so it opens where you left it, the sidebar too. This file holds
// only the providers: the appearance Settings can pin, the gesture root and the safe areas, and the shell's shape: the
// phone's, or the sidebar standing beside the panel where two columns fit (the iPhone Duo unfolded, shell/layout.tsx).
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
// The script starts with the app, not with a screen: a chat at work keeps working whatever is open.
import "./board/useBoard";
import { StylePage } from "./components/ui/StylePage";
import { FollowReduceMotion } from "./motion";
import { Navigator } from "./nav/Navigator";
import { ShellContext, SlotsContext, useNewSlots, useShellState } from "./shell/layout";
import { Overlays } from "./shell/Overlays";
import { startSystem } from "./system";
import { type Appearance, AppearanceContext, useTheme } from "./theme";

/** The short side a screen needs before it turns with the hands holding it: the Duo's inner screen (626), not a phone. */
const TURNS = 600;

function Shell() {
  const { c, dark } = useTheme();
  useEffect(() => startSystem(), []);
  const slots = useNewSlots();
  const shell = useShellState(slots);
  // A phone stays upright. A screen that holds two columns either way up turns, and on its side gets the rail.
  const window = useWindowDimensions();
  const turns = Math.min(window.width, window.height) >= TURNS;
  useEffect(() => {
    if (Platform.OS === "web") return;
    void (turns ? ScreenOrientation.unlockAsync() : ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)).catch(() => {});
  }, [turns]);
  return (
    <ShellContext.Provider value={shell}>
      <SlotsContext.Provider value={slots}>
        <View style={{ flex: 1, backgroundColor: shell.split ? c.shell : c.panel }}>
          <StatusBar style={dark ? "light" : "dark"} />
          <Navigator />
          <Overlays />
        </View>
      </SlotsContext.Provider>
    </ShellContext.Provider>
  );
}

/** The web build's /?style shows the shared primitives (ui/StylePage.tsx) instead of the app. */
const STYLE_PAGE = Platform.OS === "web" && typeof location !== "undefined" && new URLSearchParams(location.search).has("style");
/** And /?system, everything the iPhone shows outside the app: the Live Activity, the widgets (system/preview/). */
const SYSTEM_PAGE = Platform.OS === "web" && typeof location !== "undefined" && new URLSearchParams(location.search).has("system");
// Loaded only there: it evaluates the widget layouts' strings as it loads, which the app itself never needs.
const SystemPage: (() => React.JSX.Element) | null = SYSTEM_PAGE ? (require("./system/preview/SystemPage") as typeof import("./system/preview/SystemPage")).SystemPage : null;

// The app reads in the system's own faces (theme.ts), so there is nothing to load before the first frame.
export default function App() {
  const [appearance, setAppearance] = useState<Appearance>("system");
  const context = useMemo(() => ({ appearance, setAppearance }), [appearance]);
  return (
    <AppearanceContext.Provider value={context}>
      {/* Reduce Motion switched on or off while the app runs takes effect at once (motion.ts). */}
      <FollowReduceMotion />
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>{STYLE_PAGE ? <StylePage /> : SystemPage ? <SystemPage /> : <Shell />}</SafeAreaProvider>
      </GestureHandlerRootView>
    </AppearanceContext.Provider>
  );
}
