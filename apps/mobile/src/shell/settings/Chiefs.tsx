// Settings > Chiefs (apps/web/src/routes/settings/Chief.tsx): each Chief by its character with its model,
// permissions and projects at a glance, a row that opens its screen, where its own settings live; the limits the
// runtime holds them all to in code; and calls: the voice engine's key, the voice, how long it waits on a pause, and
// ringing you back. The capture shortcut is the desktop's.
import { Text } from "react-native";
import { CHIEFS, HOME_CHIEF } from "../../board/model";
import { Sprite } from "../../components/Sprite";
import { Button } from "../../components/ui/Button";
import { Toggle } from "../../native/Toggle";
import { mono, useTheme } from "../../theme";
import { ACCESS } from "../composer/menus";
import { Card, ChoiceRow, choices, Page, RowButton, SettingRow, useSettingsNav } from "./kit";
import { type Patience, useSettings } from "./store";
import { openNewChief } from "../ui";

/** Deepgram's voices (packages/runtime/src/chief/voice/deepgram.ts), each with its one line. */
const VOICES = [
  { value: "flux-cliff-en", label: "Cliff", description: "Deep, calm, a little rasp" },
  { value: "flux-kit-en", label: "Kit", description: "British, friendly, quick" },
  { value: "flux-hannah-en", label: "Hannah", description: "Clear and confident" },
  { value: "flux-miles-en", label: "Miles", description: "Calm and steady" },
  { value: "flux-sienna-en", label: "Sienna", description: "Warm and professional" },
  { value: "flux-colin-en", label: "Colin", description: "British, warm, assured" },
  { value: "flux-brooke-en", label: "Brooke", description: "Fast and bright" },
  { value: "flux-cole-en", label: "Cole", description: "Young and easygoing" },
];

/** How long a call waits on a pause (chief_voice_patience). */
const PATIENCE: readonly { value: Patience; label: string; description: string }[] = [
  { value: "quick", label: "Jump in quickly", description: "It answers as soon as you sound done. For fast talkers in full sentences." },
  { value: "normal", label: "Wait a moment", description: "A short pause, an um, or a trailing and means more is coming." },
  { value: "patient", label: "Wait longer", description: "For slow talkers and thinking out loud: it waits well past a pause." },
];

/** The limits, each a few sensible stops (the desktop's number fields, as a phone picks them). */
const LIMITS = {
  chief_max_concurrent: [0, 1, 2, 3, 4, 6, 8, 12, 20],
  chief_ask_above_chats: [1, 2, 3, 5, 8],
  chief_ask_wait_minutes: [0, 5, 15, 30, 60, 240],
  chief_daily_cap_usd: [0, 5, 10, 20, 50, 100],
  chief_daily_turns: [0, 50, 100, 200, 500, 1000],
} as const;

const minutes = (m: number) => (m === 0 ? "Always wait" : m < 60 ? `${m} min` : `${m / 60} h`);
const dollars = (d: number) => (d === 0 ? "Off" : `$${d}`);
const turns = (n: number) => (n === 0 ? "Off" : `${n}`);

export function ChiefsSettings({ description }: { description: string }) {
  const { c, t } = useTheme();
  const [s, save] = useSettings();
  const nav = useSettingsNav();
  const limit = <K extends keyof typeof LIMITS>(key: K, label: (n: number) => string) =>
    choices(
      LIMITS[key].map((n) => ({ value: n as number, label: label(n) })),
      s[key],
      (n) => save({ [key]: n }),
    );
  return (
    <Page description={description}>
      <Card
        title="Chiefs"
        description="Each has its own character, model, permissions, projects and soul."
        action={<Button label="New Chief" size="small" onPress={() => openNewChief()} />}
      >
        {CHIEFS.map((chief) => {
          const open = nav.openChief;
          const home = chief.id === HOME_CHIEF;
          return (
            <SettingRow
              key={chief.id}
              icon={<Sprite character={chief.character} tone={chief.tone} size={32} animate={false} />}
              label={chief.name}
              description={`Auto, its chats on ${ACCESS[s.default_access].label} like new chats, in ${chief.projects ? (chief.projects.length === 1 ? chief.projects[0] : `${chief.projects.length} projects`) : "every project"}`}
              value={open && home ? "Home" : undefined}
              chevron={!!open}
              under={false}
              onPress={open ? () => open(chief.id) : undefined}
              accessibilityLabel={`${chief.name}${home ? ", Home" : ""}. Open its screen`}
            >
              {!open && home ? <Text style={[t.row, { color: c.muted }]}>Home</Text> : null}
            </SettingRow>
          );
        })}
      </Card>

      <Card title="Limits" description="The runtime holds all your Chiefs to these together. Past them, a note waits in the Queue and says why.">
        <ChoiceRow label="Chats at once" description="How many chats your Chiefs keep running between them." value={turns(s.chief_max_concurrent)} width={200} entries={limit("chief_max_concurrent", turns)} />
        <ChoiceRow label="Ask first above" description="A note that needs more chats than this comes back as Suggested chats for you to start." value={String(s.chief_ask_above_chats)} width={200} entries={limit("chief_ask_above_chats", String)} />
        <ChoiceRow
          label="Go ahead after"
          description="When you don't answer a Chief's question this long, it goes ahead with the answer it recommended. Approvals and secrets always wait."
          value={minutes(s.chief_ask_wait_minutes)}
          width={200}
          entries={limit("chief_ask_wait_minutes", minutes)}
        />
        <ChoiceRow label="Daily cap" description="What your Chiefs and the chats they started may spend in a day, measured." value={dollars(s.chief_daily_cap_usd)} width={200} entries={limit("chief_daily_cap_usd", dollars)} />
        <ChoiceRow label="Turns a day" description="It holds where spend is not measured, as on a Claude plan." value={turns(s.chief_daily_turns)} width={200} entries={limit("chief_daily_turns", turns)} />
      </Card>

      <Card
        title="Calls"
        description="Call any Chief from its screen and just talk: it hands what you ask to that Chief and walks you through the work when it's ready. Your voice goes to Deepgram, which keeps none of it; the transcript stays in the Chief's chat."
      >
        <SettingRow label="Deepgram" description="It hears you, talks back and knows when you're done talking. It runs on your Caveman credits; a key of your own goes first." under>
          {s.chief_voice_key ? (
            <>
              <Text style={{ fontFamily: mono, fontSize: 13, color: c.muted }}>{s.chief_voice_key}</Text>
              <RowButton label="Remove" variant="ghost" onPress={() => save({ chief_voice_key: null })} accessibilityLabel="Remove the Deepgram key" />
            </>
          ) : (
            <RowButton label="Add a key" onPress={() => save({ chief_voice_key: "…4f2a" })} />
          )}
        </SettingRow>
        <ChoiceRow
          label="Voice"
          description={VOICES.find((v) => v.value === s.chief_voice_name)?.description ?? "How your Chiefs sound on a call."}
          value={VOICES.find((v) => v.value === s.chief_voice_name)?.label ?? "Cliff"}
          width={280}
          entries={choices(VOICES, s.chief_voice_name, (chief_voice_name) => save({ chief_voice_name }))}
        />
        <ChoiceRow
          label="When you pause"
          description={PATIENCE.find((p) => p.value === s.chief_voice_patience)?.description}
          value={PATIENCE.find((p) => p.value === s.chief_voice_patience)?.label}
          width={320}
          entries={choices(PATIENCE, s.chief_voice_patience, (chief_voice_patience) => save({ chief_voice_patience }))}
        />
        <SettingRow label="Ring me back" description="When work you asked for on a call is ready, or stuck, the Chief you asked rings to walk you through it.">
          <Toggle label="Ring me back" value={s.chief_voice_ring_back} onChange={(chief_voice_ring_back) => save({ chief_voice_ring_back })} />
        </SettingRow>
      </Card>
    </Page>
  );
}
