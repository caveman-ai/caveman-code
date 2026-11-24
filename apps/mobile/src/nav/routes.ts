// The phone's screens, one native stack (upstream phone app, Stack.tsx), the main panel in front of the sidebar
// (shell/DrawerLayout.tsx). Its root is what the sidebar opened: a new chat (Home), a chat or a Chief, with the sidebar's
// button at its top left (`useIsRoot`); what you open from there is pushed over it, so Back goes where you came from,
// and a subagent's chat is pushed over its parent's so Back returns to the parent. Sheets are not routes: they are
// drawn over the stack by the shell (shell/Overlays.tsx).
//
// A screen reads its own params and navigation from its props (`ScreenProps<"Thread">`) or `useNav()`. Code outside a
// screen (the toast's Open, Settings' Chiefs) goes through nav/ref.ts.
import { useNavigation, useNavigationState, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp, NativeStackScreenProps } from "@react-navigation/native-stack";
import type { ListFilter } from "../store/select";

export type RootStackParamList = {
  /** A new chat: an empty panel and the box at its foot. */
  Home: undefined;
  /** A list of agents: a tile's (needs, working, ready, all), narrowed to a Chief, a workspace or a device. */
  Agents: { filter: ListFilter; chief?: string; workspace?: string; device?: string };
  /** One workspace (a project, by name) and its agents. */
  Workspace: { id: string };
  /** One chat. */
  Thread: { id: string };
  /** A Chief's screen. `call`, a moment in ms, starts a call as it opens (its menu's Call). */
  Chief: { id: string; call?: number };
  Review: undefined;
  /** A pull request's guide, read as its agent wrote it: by the chat that made it, or "repo-number" (review/lookup.ts). */
  Guide: { id: string };
  /** A pull request of a signed-in person's, read from Cloud (pulls/PullScreen.tsx): its repository on GitHub as owner and name, and its number. */
  Pull: { owner: string; name: string; number: number };
  Automations: undefined;
  Plugins: undefined;
};

export type RouteName = keyof RootStackParamList;

/** A screen's props: `route.params` and `navigation`. */
export type ScreenProps<T extends RouteName> = NativeStackScreenProps<RootStackParamList, T>;
export type Nav = NativeStackNavigationProp<RootStackParamList>;

/** The stack's navigation, typed, from anywhere inside a screen. */
export const useNav = () => useNavigation<Nav>();

/** Whether this screen is the stack's root, the main panel's own: its top left is the sidebar's button, not Back. */
export function useIsRoot(): boolean {
  const key = useRoute().key;
  return useNavigationState((s) => s.routes[0]?.key === key);
}

declare global {
  namespace ReactNavigation {
    // biome-ignore lint/suspicious/noEmptyInterface: React Navigation's way to type `useNavigation` app-wide.
    interface RootParamList extends RootStackParamList {}
  }
}
