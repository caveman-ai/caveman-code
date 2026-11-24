// Settings > Caveman MCP (apps/web/src/routes/settings/CavemanMcp.tsx, caveman-mcp-model.ts): one tap asks your Mac's
// runtime to add `caveman-code mcp` to each agent there (the runtime installs, so a phone can do it too), or the line
// to add by hand where it can't; and every agent that has connected, with what it may do, Disconnect, and Allow again
// on one you cut off. The client names are the outside tools' own. Never any spend. Scripted rows.
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Text, View } from "react-native";
import { Icon } from "../../components/Icon";
import { PixelIcon } from "../../components/Pixel";
import { BrandMark, type BrandName } from "../../components/ui/BrandMark";
import { haptic } from "../../motion";
import { mono, useTheme } from "../../theme";
import { Card, ChoiceRow, choices, Page, RowButton, SettingRow } from "./kit";

type Level = "read" | "supervised" | "full";

/** The three levels, lowest first, each with its one plain line (docs/ §4). */
const LEVELS: readonly { value: Level; label: string; line: string; icon: PixelIconName }[] = [
  { value: "read", label: "Read", line: "Reads your chats and their changes. Changes nothing.", icon: "tool-read" },
  { value: "supervised", label: "Supervised", line: "Starts and steers its own chats. Other commands and every edit wait for you.", icon: "secret" },
  { value: "full", label: "Full access", line: "Lets this agent run commands on your Mac as you.", icon: "unlocked" },
];

type InstallState = "ready" | "installed" | "manual";

/** The command the runtime serves MCP on, as your Mac runs it (connectLines' `command`). */
const BIN = "/Users/ada/.caveman-code/bin/caveman-code";

/** Each client the runtime can install into, in the desktop's order, and where it stands on the Mac. `manual`: the line to add by hand. */
const CLIENTS: readonly { id: string; client: string; brand?: BrandName; state: InstallState; line: string; action?: string; manual?: string }[] = [
  { id: "claude-code", client: "Claude Code", brand: "claude", state: "installed", line: "In your Claude Code user servers." },
  { id: "codex", client: "Codex", brand: "openai", state: "ready", line: "Adds caveman-code to ~/.codex/config.toml." },
  { id: "cursor", client: "Cursor", brand: "cursor", state: "ready", line: "Adds caveman-code to ~/.cursor/mcp.json, for Cursor and cursor-agent." },
  {
    id: "vscode",
    client: "VS Code",
    state: "manual",
    line: "Not found on your Mac.",
    manual: `{"servers": {"caveman-code": {"type": "stdio", "command": ${JSON.stringify(BIN)}, "args": ["mcp"]}}}`,
  },
  { id: "grok", client: "Grok Build", brand: "grok", state: "ready", line: "Adds caveman-code to ~/.grok/config.toml." },
  { id: "grok-bot", client: "Grok Bot", brand: "grok", state: "installed", line: "Grok Bot has connected.", action: "Copy and open" },
];

/** The agents that have connected: who, when, how many chats, and what each may do. */
const CONNECTED: readonly { name: string; brand?: BrandName; line: string; level: Level }[] = [
  { name: "Grok Bot", brand: "grok", line: "Connected now · 3 chats", level: "supervised" },
  { name: "Claude Code", brand: "claude", line: "Last seen 2h ago · 1 chat", level: "read" },
];

export function CavemanMcpSettings({ description }: { description: string }) {
  const { c, t } = useTheme();
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set(CLIENTS.filter((x) => x.state === "installed").map((x) => x.id)));
  const [levels, setLevels] = useState<Record<string, Level>>(Object.fromEntries(CONNECTED.map((a) => [a.name, a.level])));
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (id: string, line: string) => {
    void Clipboard.setStringAsync(line).then(() => {
      haptic.done();
      setCopied(id);
    });
  };
  const allow = (name: string) => setBlocked((now) => new Set([...now].filter((n) => n !== name)));
  return (
    <Page description={description}>
      <Card title="Install" description="One tap adds Caveman Code to the agent on your Mac. You choose what each one may do under Connected agents.">
        {CLIENTS.map((x) => {
          const state: InstallState = installed.has(x.id) ? "installed" : x.state;
          return (
            <SettingRow
              key={x.id}
              icon={x.brand ? <BrandMark name={x.brand} size={16} /> : <PixelIcon name="artifact-code" />}
              label={x.client}
              description={
                x.manual ? (
                  <View style={{ gap: 4 }}>
                    <Text style={t.small}>{x.line}</Text>
                    <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: c.soft }}>
                      {x.manual}
                    </Text>
                  </View>
                ) : state === "installed" && x.state !== "installed" ? (
                  "Installed just now."
                ) : (
                  x.line
                )
              }
              under
            >
              {state === "installed" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Icon name="check" size={14} stroke={2} color={c.muted} />
                  <Text style={t.small}>{x.id === "grok-bot" ? "Connected" : "Installed"}</Text>
                </View>
              ) : state === "ready" ? (
                <RowButton label={x.action ?? "Install"} onPress={() => setInstalled((now) => new Set(now).add(x.id))} accessibilityLabel={`Install Caveman MCP in ${x.client}`} />
              ) : (
                <RowButton
                  label={copied === x.id ? "Copied" : "Copy"}
                  onPress={() => x.manual && copy(x.id, x.manual)}
                  accessibilityLabel={copied === x.id ? `Copied the line for ${x.client}` : `Copy the line for ${x.client}`}
                />
              )}
            </SettingRow>
          );
        })}
      </Card>

      <Card title="Connected agents" description="A new agent starts at Supervised. You choose what each one may do here.">
        {CONNECTED.map((a) => {
          const off = blocked.has(a.name);
          const level = LEVELS.find((l) => l.value === levels[a.name]) ?? LEVELS[1]!;
          const mark = a.brand ? <BrandMark name={a.brand} size={16} /> : <PixelIcon name="tool-mcp" />;
          // Cut off, it shows why and the way back at once; connected, its level is a menu with Disconnect at its foot.
          if (off)
            return (
              <SettingRow
                key={a.name}
                icon={<View style={{ opacity: 0.5 }}>{mark}</View>}
                label={<Text style={[t.row, { color: c.muted }]}>{a.name}</Text>}
                description="Disconnected. It can't start or follow chats."
                under
              >
                <RowButton label="Allow again" onPress={() => allow(a.name)} accessibilityLabel={`Allow ${a.name} again`} />
              </SettingRow>
            );
          return (
            <ChoiceRow
              key={a.name}
              icon={mark}
              label={a.name}
              description={level.value === "full" ? `${a.line}. ${level.line}` : a.line}
              value={level.label}
              accessibilityLabel={`What ${a.name} may do: ${level.label}`}
              width={330}
              entries={[
                { type: "heading", label: `Applies to every ${a.name} on your Mac.` },
                ...choices(
                  LEVELS.map((l) => ({ value: l.value, label: l.label, description: l.line, icon: <PixelIcon name={l.icon} /> })),
                  level.value,
                  (next) => setLevels((now) => ({ ...now, [a.name]: next })),
                ),
                { type: "separator" },
                { label: "Disconnect", icon: "close", destructive: true, onPress: () => setBlocked((now) => new Set(now).add(a.name)) },
              ]}
            />
          );
        })}
      </Card>
    </Page>
  );
}
