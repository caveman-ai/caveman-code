// One workspace (a project, by name), pushed from Home: its agents grouped by where each stands (shell/rows/
// ChatList.tsx), under a large title that leads with the most urgent state, and its own chat bar, whose chats start
// here. Its ··· holds what the desktop's folder menu holds: Copy path, Open on GitHub, and Remove project, which waits
// until its chats are archived.
import * as Clipboard from "expo-clipboard";
import { useMemo, useState } from "react";
import { Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PixelIcon } from "../components/Pixel";
import { useContentEnd } from "../components/ProgressiveEdge";
import { BrandMark } from "../components/ui/BrandMark";
import type { MenuEntry } from "../components/ui/Menu";
import { WorkspaceLine } from "../home/WorkspaceRows";
import { openRow } from "../nav/ref";
import type { ScreenProps } from "../nav/routes";
import { COMPOSER_ROOM } from "../shell/Composer";
import { useInbox } from "../shell/inbox";
import { NewChatComposer } from "../shell/NewChatComposer";
import { projects } from "../board/places";
import { ChatList } from "../shell/rows/ChatList";
import { ListTitle } from "../shell/rows/ListTop";
import { TopBar } from "../shell/TopBar";
import { countsLine, readyOf, type Row, useList } from "../store/select";
import { useStore } from "../store/store";

export function WorkspaceScreen({ route, navigation }: ScreenProps<"Workspace">) {
  const { id } = route.params;
  const insets = useSafeAreaInsets();
  const rows = useList({ filter: "all", workspace: id });
  const chats = useMemo(() => rows.map((r) => r.chat), [rows]);
  const inbox = useInbox(chats, null);
  const [past, setPast] = useState(false);
  // How far the list has scrolled (the bar's edge comes in once something is under it) and where its last row is (the
  // chat bar's band shows only while rows run under it). The last row rests 24 over the bar at the end.
  const bottom = Math.max(insets.bottom, 10) + COMPOSER_ROOM;
  const foot = useContentEnd(bottom);
  const edgeY = foot.scrollY;
  const place = projects.use().find((p) => p.name === id);
  const n = (phase: Row["phase"]) => rows.filter((r) => r.phase === phase).length;
  const seen = useStore((s) => s.inbox);
  const counts = { needs: n("needs"), ready: readyOf(rows, seen).unseen, working: n("working"), total: rows.length };
  const entries: MenuEntry[] = [
    ...(place?.path ? [{ label: "Copy path", icon: "copy" as const, onPress: () => void Clipboard.setStringAsync(place.path ?? "").catch(() => {}) }] : []),
    ...(place?.github ? [{ label: "Open on GitHub", icon: <BrandMark name="github" size={16} />, onPress: () => void Linking.openURL(`https://github.com/${place.github}`).catch(() => {}) }] : []),
    { type: "separator" },
    {
      label: "Remove project",
      icon: "delete",
      destructive: true,
      disabled: rows.length > 0,
      under: true,
      description: rows.length > 0 ? `Archive its ${rows.length === 1 ? "chat" : `${rows.length} chats`} first` : "Its files stay where they are",
      onPress: () => {},
    },
  ];

  return (
    <View style={{ flex: 1 }}>
      <ChatList
        id={`workspace:${id}`}
        rows={rows}
        inbox={inbox}
        place={false}
        top={(slot) => <ListTitle title={id} line={<WorkspaceLine w={counts} />} action={slot} />}
        empty="No agents here yet"
        emptyLine="What you start below runs in this workspace."
        emptyIcon="repo"
        bottom={bottom}
        onEnd={foot.onEnd}
        onOpen={openRow}
        onScrolled={setPast}
        scrollY={edgeY}
      />
      <TopBar
        onBack={() => navigation.goBack()}
        scrollY={edgeY}
        title={past ? id : undefined}
        subtitle={past ? (countsLine(counts) ?? undefined) : undefined}
        mark={past ? <PixelIcon name="repo" /> : undefined}
        menu={{ entries: entries.filter((e, i) => !(e.type === "separator" && i === 0)) }}
      />
      <NewChatComposer workspace={id} placeholder="What should we build here?" contentEnd={foot.end} />
    </View>
  );
}
