// Settings > Models & keys on a phone: one row per agent with one status in one colour, as one of the person's
// computers lists them (live/agents.ts: a Mac first, else Cloud), then which agent new chats start on. A phone
// connects, reconnects and removes nothing, so no row has a button: where the desktop would offer one, the page says
// once where it is done. While no computer has answered it says one line of what it waits for; signed out on a board
// that is the person's own it is the one sign-in row. Someone who never signed in sees the scripted world's agents in
// the same rows. Every word is in models-model.ts.
import { type ReactNode, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useChoices } from "../../board/catalog";
import { pairedMac } from "../../board/places";
import { EngineLogo } from "../../components/ui/EngineLogo";
import { readAgents, useAgents } from "../../live/agents";
import { SignInRow } from "../../live/SignIn";
import { useTheme } from "../../theme";
import { useMe } from "../me";
import { NEW_CHAT_ENGINES } from "./General";
import { Card, CardLine, ChoiceRow, choices, Page, SettingRow } from "./kit";
import { agentRows, awayLine, CONNECT_ON_MAC, LOADING, pageView, SCRIPTED_AGENTS, type Tone } from "./models-model";
import { setNewChatEngine } from "./store";

/** How often the person's computers are asked again while Models & keys or Account is open. */
const READ_EVERY_MS = 4_000;

/**
 * Asks the person's computers about their agents and plan as a page opens and every four seconds while it is open
 * (a page goes when Settings closes), and gives the time of the last ask, so a status that names a time or counts
 * days is said against now.
 */
export function useAgentsWhileOpen(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const read = () => {
      readAgents();
      setNow(Date.now());
    };
    read();
    const timer = setInterval(read, READ_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function ModelsSettings({ description }: { description: string }) {
  const { t } = useTheme();
  const me = useMe();
  const status = useAgents((s) => s.status);
  const engines = useAgents((s) => s.engines);
  const from = useAgents((s) => s.from);
  const kind = useAgents((s) => s.kind);
  const mac = useAgents((s) => s.mac);
  const now = useAgentsWhileOpen();
  const view = pageView(me, status);
  if (view === "sign-in")
    return (
      <Page description={description}>
        <Card>
          <SignInRow />
        </Card>
      </Page>
    );
  const rows = view === "scripted" ? agentRows(SCRIPTED_AGENTS, { from: pairedMac()?.name ?? "", kind: "mac" }, now) : view === "ready" ? agentRows(engines, { from, kind }, now) : [];
  const waits = view === "loading" ? LOADING : view === "away" ? awayLine(mac) : null;
  return (
    <Page description={description}>
      {waits !== null || rows.length > 0 ? (
        <View style={{ gap: 10 }}>
          <Card>{waits !== null ? <CardLine>{waits}</CardLine> : rows.map((row) => <StatusRow key={row.id} icon={<EngineLogo engine={row.id} size={16} />} name={row.name} status={row.status} tone={row.tone} />)}</Card>
          {/* Said once for every row a phone cannot change, at the page's inset as its first line is. */}
          {rows.some((row) => row.onMac) ? <Text style={[t.small, { paddingHorizontal: 4 }]}>{CONNECT_ON_MAC}</Text> : null}
        </View>
      ) : null}
      <Card>
        <NewChatsStartOn />
      </Card>
    </Page>
  );
}

/**
 * One line of a card: a name at the left and one status at the right, in its one colour. A long name ends in an
 * ellipsis; on a card too narrow for both, the status steps under the name rather than squeeze it.
 */
export function StatusRow({ icon, name, status, tone }: { icon?: ReactNode; name: string; status: string; tone: Tone }) {
  const { c, t } = useTheme();
  const ink = tone === "ok" ? c.success : tone === "warn" ? c.warning : tone === "bad" ? c.destructive : c.muted;
  return (
    <SettingRow
      icon={icon}
      label={
        <View accessible accessibilityLabel={`${name}, ${status}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 12, rowGap: 2 }}>
          <Text numberOfLines={1} style={[t.row, { flexShrink: 1 }]}>
            {name}
          </Text>
          <Text style={[t.small, { flexShrink: 1, color: ink, fontVariant: ["tabular-nums"] }]}>{status}</Text>
        </View>
      }
    />
  );
}

/** Which agent a new chat starts on: the phone's own setting, the picker's Default (board/catalog.ts). */
function NewChatsStartOn() {
  const picks = useChoices();
  const lead = NEW_CHAT_ENGINES.find((e) => e.id === picks.defaultModel.engine);
  return (
    <ChoiceRow
      label="New chats start on"
      description="You can still pick any agent in a chat's model picker."
      value={lead?.label ?? "Nothing set up yet"}
      valueMark={lead ? <EngineLogo engine={lead.id} size={16} /> : undefined}
      entries={choices(
        NEW_CHAT_ENGINES.map((e) => ({ value: e.id, label: e.label, icon: <EngineLogo engine={e.id} size={16} /> })),
        lead?.id ?? null,
        (id) => id && setNewChatEngine(id, picks),
      )}
    />
  );
}
