// Settings > Computers: where your chats run, as one flat list, in the desktop's words for the same page. Signed out
// it is one row, "Sign in to Caveman". Signed in: a row per Mac of yours with its chats and whether it is Online,
// Asleep or Offline, and Cloud as one row with its chats, how many of its places run and the share of the month's
// plan its time took ("4 chats · 2 running · 12% of this month's plan"), which opens to a line per project. Under
// the list, for a Mac that is on line and keeps its chats going in Cloud: "When <Mac> sleeps", with only the chats
// that will not carry on ("Pauses · Claude isn't connected"). Nothing here names, sizes, wakes, sleeps, opens or
// connects to a machine: a chat runs on a Mac of yours or in Cloud, and opening it is what reaches it. The one thing a
// Mac asks of you, once, is to allow this phone: its row says so, with the code to check on the Mac.
//
// Nothing scripted is ever drawn here, signed in or out. The list is Caveman's and is read again every few seconds
// while the app is up (live/link.ts).
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { PixelIcon } from "../../components/Pixel";
import { readAgents } from "../../live/agents";
import { readLids, refresh, useComputers, useLink } from "../../live/link";
import { SignInRow } from "../../live/SignIn";
import { mono, useTheme } from "../../theme";
import { Card, CardLine, Page, SettingRow, Status } from "./kit";

const chatsOf = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;
/** How often a Mac is asked again what its person chose for when it sleeps, while the page is open (the desktop's own pace). */
const LID_EVERY_MS = 30_000;
/** A state said in one word sits at the row's end; a longer one ("2 running · 12% of this month's plan", "Paused until Saturday · plan used up") goes under the name, where it has the width. */
const short = (word: string) => word.length <= 12;
const under = (chats: number, word: string) => (word && !short(word) ? `${chatsOf(chats)} · ${word}` : chatsOf(chats));

export function ComputersSettings({ description }: { description: string }) {
  const { c, t } = useTheme();
  const account = useLink((link) => link.account);
  const listed = useLink((link) => link.computers !== null);
  const view = useComputers();
  const [open, setOpen] = useState(false);
  // The Macs that answer this phone now: each is asked what its chats do when it sleeps as it starts to.
  const reached = useLink((link) => Object.keys(link.links).filter((id) => link.links[id]?.phase === "open").join(" "));
  useEffect(() => {
    void refresh();
    // The plan's share of the month, from whichever computer answers.
    readAgents();
  }, []);
  useEffect(() => {
    if (!account) return;
    readLids();
    const timer = setInterval(readLids, LID_EVERY_MS);
    return () => clearInterval(timer);
  }, [account, reached, listed]);
  if (!account)
    return (
      <Page description={description}>
        <Card>
          <SignInRow />
        </Card>
      </Page>
    );
  const empty = listed && view.macs.length === 0 && (view.cloud === null || view.cloud.chats === 0);
  return (
    <Page description={description}>
      <Card>
        {!listed ? <CardLine>Loading…</CardLine> : null}
        {view.macs.map((mac) => (
          <SettingRow
            key={mac.id}
            icon={<PixelIcon name="computer-this-mac" />}
            label={mac.name}
            under={!!mac.allow}
            description={
              mac.allow ? (
                <View style={{ gap: 2 }}>
                  <Text style={t.small}>{mac.allow.words}</Text>
                  {mac.allow.code ? (
                    <Text selectable accessibilityLabel={`Code ${mac.allow.code.split("").join(" ")}`} style={[t.code, { fontFamily: mono, fontSize: 17, lineHeight: 24, letterSpacing: 1, color: c.text }]}>
                      {mac.allow.code}
                    </Text>
                  ) : null}
                </View>
              ) : (
                chatsOf(mac.chats)
              )
            }
          >
            <Status tone={mac.word === "Online" ? "ok" : "idle"}>{mac.word}</Status>
          </SettingRow>
        ))}
        {view.cloud ? (
          <SettingRow
            icon={<PixelIcon name="computer-cloud" />}
            label="Cloud"
            description={under(view.cloud.chats, view.cloud.line)}
            {...(view.cloud.projects.length > 0 ? { onPress: () => setOpen(!open), chevron: true, accessibilityLabel: `Cloud, ${chatsOf(view.cloud.chats)}, ${view.cloud.line}. ${open ? "Hide" : "Show"} its projects` } : null)}
          >
            {view.cloud.line && short(view.cloud.line) ? <Status tone={/running/i.test(view.cloud.line) ? "ok" : "idle"}>{view.cloud.line}</Status> : null}
          </SettingRow>
        ) : null}
        {view.cloud && open
          ? view.cloud.projects.map((p) => (
              <SettingRow key={p.name} icon={<View style={{ width: 16 }} />} label={p.name} description={under(p.chats, p.word)}>
                {short(p.word) ? <Text style={t.small}>{p.word}</Text> : null}
              </SettingRow>
            ))
          : null}
        {empty ? <CardLine>No chats yet. Start one from the box, or on your Mac.</CardLine> : null}
      </Card>
      {view.macs.map((mac) =>
        mac.lid.length > 0 ? (
          <Card key={mac.id} title={`When ${mac.name} sleeps`}>
            {mac.lid.map((line) => (
              <SettingRow key={line.id} label={line.title} description={`${line.what} · ${line.why}`} />
            ))}
          </Card>
        ) : null,
      )}
    </Page>
  );
}
