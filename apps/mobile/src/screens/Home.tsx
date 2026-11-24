// Home is a new chat ("fuck the homepage we are going to make homepage just a new chat. get rid
// of the agent managing from the homepage its new chat"). The main panel's root: the sidebar's button at its top left
// (an amber dot on it while something waits on you, which the sidebar lists), your Chief and a greeting in your name in
// the middle (home/Welcome.tsx), and the box at its foot: where the chat will run and on which model, its + menu taking the keyboard's place, voice beside it. The
// keyboard rises on the first tap, never on its own. Sending makes the new chat the panel's root, so its top left is
// still the sidebar's button. What Home used to hold (the tiles, the agents, the Chiefs, the workspaces and devices)
// lives in the sidebar behind the panel (shell/DrawerLayout.tsx, sidebar/).
import { View } from "react-native";
import { type ScreenProps, useIsRoot } from "../nav/routes";
import { Welcome } from "../home/Welcome";
import { NewChatComposer } from "../shell/NewChatComposer";
import { TopBar } from "../shell/TopBar";
import { askQueue } from "../store/select";
import { useStore } from "../store/store";

export function Home({ navigation }: ScreenProps<"Home">) {
  const root = useIsRoot();
  // Everything that waits on you, anywhere: the dot on the sidebar's button.
  const waiting = useStore((s) => askQueue(s).length);
  return (
    <View style={{ flex: 1 }}>
      <TopBar root={root} onBack={() => navigation.goBack()} waiting={waiting} />
      <Welcome />
      <NewChatComposer placeholder="Describe a task" />
    </View>
  );
}
