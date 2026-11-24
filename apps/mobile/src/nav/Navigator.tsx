// The phone's one native stack (react-native-screens through React Navigation 7, ), the
// main panel that slides aside to show the sidebar behind it (shell/DrawerLayout.tsx). Its root is what the sidebar last
// opened: a new chat (Home), a chat or a Chief, its top left the sidebar's button; what you open from there is pushed
// over it, each screen drawing its own bar (shell/TopBar.tsx), so the system's header is off. Back is the stack's: the
// bar's back circle, iOS's edge swipe, Android's back button, the browser's.
//
// It opens on the launch rule's stack (store/launch.ts): a link, else the chat or Chief you left under 30 minutes ago
// as the root (a subagent over its parents), else a new chat. That stack is the navigator's first state, so there is
// no first frame of anything else before the chat. Every move after is written back (`saveRoute`) for the next launch.
// Links while running (caveman://chat/<id>, the web build's /chat/<id>) go through React Navigation's linking, which on
// the web also keeps the address in step with the screen; a chat or a Chief a link names becomes the root, as a jump
// from the sidebar does.
import { bootReady } from "../boot";
import { CommonActions, DarkTheme, DefaultTheme, getActionFromState, getStateFromPath, type LinkingOptions, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { AgentList } from "../screens/AgentList";
import { ChiefRoute } from "../screens/Chief";
import { Home } from "../screens/Home";
import { AutomationsRoute, PluginsRoute, ReviewRoute } from "../screens/Lists";
import { ThreadScreen } from "../screens/ThreadScreen";
import { WorkspaceScreen } from "../screens/Workspace";
import { PullRoute } from "../pulls/PullScreen";
import { GuideRoute } from "../review/GuideScreen";
import { Drawer, setPanelAtRoot } from "../shell/DrawerLayout";
import { setFocused } from "../shell/ui";
import { launchStack, routeFromUrl, saveRoute, stackFor } from "../store/launch";
import { isShareLink } from "../system/share";
import { useTheme } from "../theme";
import { cutStore, focusedRoute, isCut, navigationRef, savedOf, stateOf } from "./ref";
import type { RootStackParamList } from "./routes";

const Stack = createNativeStackNavigator<RootStackParamList>();

/** The root a link to a chat or a Chief makes (a subagent over its parents), as the sidebar would open it. */
function rootOf(state: { routes: readonly { name: string; params?: object }[] } | undefined) {
  const top = state?.routes[state.routes.length - 1];
  const id = (top?.params as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || (top?.name !== "Thread" && top?.name !== "Chief")) return null;
  return stateOf(stackFor(top.name === "Thread" ? { to: "chat", id } : { to: "chief", id }));
}

const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["caveman://"],
  // The share extension opens the app on caveman://expo-sharing: no screen, so you stay where you are and Share to
  // Caveman opens over it (system/share.ts reads what came).
  filter: (url) => !isShareLink(url),
  // A chat or a Chief a link names (a notification while the app runs, an address the browser goes back to) becomes the
  // root, a subagent over its parents; a page (a guide, a list) is pushed over what's showing, or over a new chat.
  getStateFromPath(path, options) {
    const state = getStateFromPath(path, options);
    return rootOf(state) ?? state;
  },
  getActionFromState(state, options) {
    const root = rootOf(state);
    // A link to the screen already on top (the Live Activity of the call you're on) leaves it be: a reset would mount
    // it afresh, and a Chief's screen ends its call as it unmounts. React Navigation resets the root itself when
    // handed nothing, so it gets an action that changes nothing.
    const top = state?.routes[state.routes.length - 1];
    const here = focusedRoute();
    const id = (top?.params as { id?: unknown } | undefined)?.id;
    if (root && here && top?.name === here.name && id === here.id) return CommonActions.setParams({});
    return root ? CommonActions.reset(root) : getActionFromState(state, options);
  },
  config: {
    // A page a link names has a new chat under it, so Back goes somewhere.
    initialRouteName: "Home",
    screens: {
      Home: "",
      Agents: "agents/:filter",
      Workspace: "workspace/:id",
      Thread: "chat/:id",
      Chief: "chief/:id",
      Review: "review",
      Guide: "guide/:id",
      Pull: { path: "pull/:owner/:name/:number", parse: { number: Number } },
      Automations: "automations",
      Plugins: "plugins",
    },
  },
};

/** The web build's address names a screen other than Home, a chat or a Chief. */
function pageLink(): boolean {
  if (Platform.OS !== "web" || typeof location === "undefined") return false;
  return /^\/(agents|workspace|review|guide|pull|automations|plugins)(\/|$)/.test(location.pathname);
}

/**
 * The screen on top, told to the shell (the toast, the moment card) and kept for the next launch; and whether the
 * panel shows its root, where a drag right opens the sidebar.
 */
function noteFocus() {
  const route = focusedRoute();
  setFocused(route);
  if (route) saveRoute(savedOf(route));
  setPanelAtRoot((navigationRef.getRootState()?.index ?? 0) === 0);
}

export function Navigator() {
  const { c, dark } = useTheme();
  // Read once, before the first frame: the web build's address is the link; a phone's comes from Linking below. An
  // address naming a list or a page (/agents/ready, /review) is left to the linking below, so it opens there rather
  // than on the chat you left.
  const [initial] = useState(() => {
    const state = pageLink() ? undefined : stateOf(launchStack());
    setPanelAtRoot((state?.index ?? 0) === 0);
    return state;
  });
  // Each screen's slide is read again whenever a new root stops arriving without one (nav/ref.ts `showRoots`).
  useSyncExternalStore(cutStore.subscribe, cutStore.version);

  // A phone opened by a link (a notification, caveman://chat/<id>) opens there, as the root. The address only
  // arrives asynchronously, so the stack the launch rule chose without it is replaced when it names a chat or Chief
  // that's here.
  useEffect(() => {
    if (Platform.OS === "web") return;
    let live = true;
    void Linking.getInitialURL().then((url) => {
      if (!live || !url || !routeFromUrl(url) || !navigationRef.isReady()) return;
      navigationRef.resetRoot(stateOf(launchStack(url)));
    });
    return () => {
      live = false;
    };
  }, []);

  // The navigator's surfaces are the deck's, so nothing flashes white between screens.
  const theme = useMemo<Theme>(() => {
    const base = dark ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, primary: c.primary, background: c.panel, card: c.panel, text: c.text, border: c.hairline, notification: c.warning } };
  }, [c, dark]);

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={theme}
      initialState={initial}
      linking={linking}
      onReady={() => {
        noteFocus();
        // A launch on a chat keeps its cover until the chat's latest turn has landed (screens/Thread.tsx); anywhere
        // else the cover goes once the first frame is up.
        if (focusedRoute()?.name !== "Thread") requestAnimationFrame(() => requestAnimationFrame(bootReady));
      }}
      onStateChange={noteFocus}
      documentTitle={{ formatter: () => "Caveman Code" }}
    >
      {/* The stack is the main panel; the sidebar lies behind it. */}
      <Drawer>
        <Stack.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            // A swipe from the left edge always goes back: iOS's own back swipe has it (from anywhere on iOS 26, from
            // the edge before), and every swipe of ours in the content lets a touch that starts in Back's strip go
            // (components/edge.ts), so a row's actions or a card's Allow never take it first. Left at iOS's own reach
            // rather than widened: a full-screen swipe before iOS 26 would race the rows' and cards' swipes in the
            // middle. On the root there is nothing to go back to, and the same swipe brings the sidebar out instead
            // (shell/DrawerLayout.tsx).
            gestureEnabled: true,
            contentStyle: { backgroundColor: c.panel },
            // A new root swaps in place under the panel as it slides back (nav/ref.ts `showRoots`); every push slides.
            animation: isCut(route.key) ? "none" : "default",
            // Swiping back takes the keyboard with the screen it belonged to (iOS); a screen covered by a push puts its
            // own away (shell/Composer.tsx).
            keyboardHandlingEnabled: true,
          })}
        >
          <Stack.Screen name="Home" component={Home} />
          <Stack.Screen name="Agents" component={AgentList} />
          <Stack.Screen name="Workspace" component={WorkspaceScreen} />
          <Stack.Screen name="Thread" component={ThreadScreen} />
          <Stack.Screen name="Chief" component={ChiefRoute} />
          <Stack.Screen name="Review" component={ReviewRoute} />
          <Stack.Screen name="Guide" component={GuideRoute} />
          <Stack.Screen name="Pull" component={PullRoute} />
          <Stack.Screen name="Automations" component={AutomationsRoute} />
          <Stack.Screen name="Plugins" component={PluginsRoute} />
        </Stack.Navigator>
      </Drawer>
    </NavigationContainer>
  );
}
