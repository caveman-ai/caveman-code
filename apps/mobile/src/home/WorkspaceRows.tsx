// A workspace's second line (DECISIONS.md "Home, exactly" 5, the rows for workspaces wherever they appear: Search, a
// workspace's page): it leads with the most urgent state ("● 2 need you · 11 agents"). The state's colour is a 6 pt
// dot before it, never the words: amber words stay on the bar's capsule and the Chief rows, so the same three asks
// aren't said in amber ten times down a page.
import { Text, View } from "react-native";
import type { WorkspaceRow } from "../store/select";
import { useTheme } from "../theme";

const agents = (n: number) => (n ? `${n} ${n === 1 ? "agent" : "agents"}` : "No agents yet");

/** The 6 pt dot that carries a state's colour where the words beside it stay grey. */
export function StateDot({ color }: { color: string }) {
  return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />;
}

/** "● 2 need you · 11 agents": the most urgent state first, its colour in the dot, then how many agents run there. */
export function WorkspaceLine({ w }: { w: Pick<WorkspaceRow, "needs" | "ready" | "working" | "total"> }) {
  const { c, t } = useTheme();
  const lead = w.needs
    ? { word: `${w.needs} ${w.needs === 1 ? "needs" : "need"} you`, color: c.warning }
    : w.ready
      ? { word: `${w.ready} ready`, color: c.success }
      : w.working
        ? { word: `${w.working} working`, color: null }
        : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
      {lead?.color ? <StateDot color={lead.color} /> : null}
      <Text numberOfLines={1} style={[t.row, { flexShrink: 1, fontSize: 14, lineHeight: 18, color: c.muted }]}>
        {lead ? `${lead.word} · ` : ""}
        {agents(w.total)}
      </Text>
    </View>
  );
}
