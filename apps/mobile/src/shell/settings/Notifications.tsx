// Settings > Notifications: the desktop's Notifications card (General.tsx, "While Caveman Code is in the
// background") with the same two switches in the same words, and what only a phone has: running chats on the Lock
// Screen and in the Dynamic Island. A notification that asks carries Allow and Deny, so an approval never needs the
// app opened.
import { Toggle } from "../../native/Toggle";
import { Card, Page, SettingRow } from "./kit";
import { useSettings } from "./store";

export function NotificationsSettings({ description }: { description: string }) {
  const [s, save] = useSettings();
  return (
    <Page description={description}>
      <Card>
        <SettingRow label="A session needs you" description="It asks a question or waits for an approval. Allow and Deny are on the notification.">
          <Toggle label="A session needs you" value={s.notify_needs_input} onChange={(notify_needs_input) => save({ notify_needs_input })} />
        </SettingRow>
        <SettingRow label="A session finished" description="Its turn completed or failed.">
          <Toggle label="A session finished" value={s.notify_turn_done} onChange={(notify_turn_done) => save({ notify_turn_done })} />
        </SettingRow>
      </Card>
      <Card title="On this phone">
        <SettingRow label="Live Activity" description="Running chats on the Lock Screen and in the Dynamic Island, until they finish or need you.">
          <Toggle label="Live Activity" value={s.live_activity} onChange={(live_activity) => save({ live_activity })} />
        </SettingRow>
      </Card>
    </Page>
  );
}
