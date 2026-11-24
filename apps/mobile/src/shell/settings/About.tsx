// Settings > About: the version your Mac runs and whether it is current (the desktop's app card in General, with its
// Check for updates), and What's new, the release notes the desktop shows after an update (releases/<version>.md), the
// parts a phone uses, laid out as the desktop's What's new lays them: your companion with its club raised on a patch
// of dithered floor, the version and date, the title, then numbered sections between hairlines.
import { useCompanion } from "@caveman-app/ui/mascot/cast";
import type { CastCharacter } from "@caveman-app/ui/mascot/poses";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { resetDemo } from "../../board/script";
import { pairedMac } from "../../board/places";
import { Sprite } from "../../components/Sprite";
import { Floor } from "../../components/ui/Empty";
import { mono, useTheme } from "../../theme";
import { Card, Page, RowButton, SettingRow, useCardGreys } from "./kit";

/** releases/0.1.0.md, without what only the desktop has (tabs and splits, its own updates). */
const RELEASE = {
  version: "0.1.0",
  date: "Oct 25, 2026",
  title: "Caveman Code is here",
  intro: "The first release of Caveman Code for Mac: every coding agent you use in one window, with a Chief that runs your chats for you.",
  sections: [
    {
      heading: "A Chief runs your chats",
      body: "Tell the Chief what you want done. It starts the chats, answers their questions, reports back, and goes ahead on its own when you don't answer in time. Set how long it waits in Settings > Chiefs. Run several Chiefs, each with its own projects and rules, from the sidebar.",
    },
    {
      heading: "Every agent in one window",
      body: "Chat with Caveman, Claude Agent (your own claude and its login), Codex, Cursor, OpenCode and more from one place. Pick the agent and the model for each chat.",
    },
    { heading: "Review pull requests", body: "The Review queue lists pull requests by repository, with a short guide and the diff for each. Ask about one and a chat starts on the pull request." },
    { heading: "Automations", body: "Write an automation once and run it by hand, on a schedule or on an event." },
  ],
};

/** The companion's size: the desktop's scale 3 on its 24-cell body. */
const MASCOT = 72;

export function AboutSettings({ description }: { description: string }) {
  const { t } = useTheme();
  const greys = useCardGreys();
  const [checking, setChecking] = useState(false);
  const mac = pairedMac();
  // The check asks your Mac; scripted, it finds what it found last time.
  useEffect(() => {
    if (!checking) return;
    const timer = setTimeout(() => setChecking(false), 1200);
    return () => clearTimeout(timer);
  }, [checking]);
  return (
    <Page description={description}>
      <Card>
        {/* The version is your Mac's: the phone asks it, so a Mac that sleeps checks once it's back. */}
        <SettingRow label={`Caveman Code ${RELEASE.version}`} description={checking ? "Checking for updates…" : !mac ? "Up to date." : mac.status === "online" ? `Up to date on ${mac.name}.` : `${mac.name} is ${mac.status === "asleep" ? "asleep" : "offline"}. It checks once it's back.`} under>
          <RowButton label="Check for updates" disabled={checking || (!!mac && mac.status !== "online")} onPress={() => setChecking(true)} />
        </SettingRow>
      </Card>
      {/* The prototype keeps its scripted world on the phone (store/persist.ts); this plays it from the top. */}
      <Card title="Demo">
        <SettingRow label="Start the morning again" description="Forgets the chats, drafts and marks this phone kept, and plays the scripted morning from the top." under>
          <RowButton label="Start again" onPress={resetDemo} />
        </SettingRow>
      </Card>
      <Card title="What's new">
        <ReleaseHeader />
        <View style={{ gap: 0, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 }}>
          <Text style={[t.small, { fontSize: 15, lineHeight: 22 }]}>{RELEASE.intro}</Text>
          <View style={{ marginTop: 16 }}>
            {RELEASE.sections.map((s, i) => (
              <View key={s.heading} style={{ flexDirection: "row", paddingVertical: 16, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: greys.line, paddingTop: i === 0 ? 0 : 16 }}>
                <Text aria-hidden style={[t.line, { width: 32, paddingTop: 2 }]}>
                  {String(i + 1).padStart(2, "0")}
                </Text>
                <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                  <Text accessibilityRole="header" style={t.label}>
                    {s.heading}
                  </Text>
                  <Text style={[t.small, { fontSize: 14, lineHeight: 22 }]}>{s.body}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </Card>
    </Page>
  );
}

/** The release's header: the companion on its floor, "v0.1.0 · Oct 25, 2026" and the title, over a hairline. */
function ReleaseHeader() {
  const { c, t } = useTheme();
  const greys = useCardGreys();
  const { character, tone } = useCompanion();
  // A character drawn on the desktop alone has no body here yet; the caveman stands in.
  const who = (character.startsWith("custom:") ? "caveman" : character) as CastCharacter;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 16, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: greys.line }}>
      <View style={{ alignItems: "center" }}>
        <Sprite character={who} tone={tone} pose="done" size={MASCOT} />
        <Floor width={MASCOT + 16} cell={MASCOT / 24} sink />
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: 4, gap: 4 }}>
        <Text style={t.small}>
          <Text style={{ fontFamily: mono, color: c.text }}>v{RELEASE.version}</Text>
          {`  ·  ${RELEASE.date}`}
        </Text>
        <Text accessibilityRole="header" style={t.title}>
          {RELEASE.title}
        </Text>
      </View>
    </View>
  );
}
