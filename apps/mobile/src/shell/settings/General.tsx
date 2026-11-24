// Settings > General (apps/web/src/routes/settings/General.tsx): how new chats start (their permissions, and each
// engine's model at the effort and speed it starts on), when a chat goes to the inbox's Done shelf by itself and when
// it is archived, and Caveman's credit on commits. The desktop's Notifications card has its own section here.
//
// A model row opens the app's model picker on that engine's models alone, as the desktop's NewChatModelPicker opens
// the composer's: a pick is the model new chats there start on, and its slider and bolt set where that model starts.
// What it writes is the picker's own part of Settings (board/catalog.ts), so New chat and the picker read the same.
//
// The whole page is the scripted world's (settings/sections.ts `scriptedOnly`): nothing it sets is sent to a computer
// yet, so a board that is the person's own does not list it. There, which agents and models a chat can start on is
// each computer's to say (the model picker lists them, live/engines.ts).
import { Text } from "react-native";
import { boardEngine, CATALOG, startOf, useChoices } from "../../board/catalog";
import type { Effort } from "../../board/model";
import { PixelIcon } from "../../components/Pixel";
import { ModelName } from "../../components/ui/EngineLogo";
import { Toggle } from "../../native/Toggle";
import { mono, useTheme } from "../../theme";
import { type Access, ACCESS } from "../composer/menus";
import { triggerOf } from "../Sheets";
import { Card, ChoiceRow, choices, Page, SettingRow, useSettingsNav } from "./kit";
import { newChatModel, useSettings } from "./store";

/** The engines a new chat can start on from this phone, each with a model to pick (newChatEngines). */
export const NEW_CHAT_ENGINES = CATALOG.filter((e) => boardEngine(e.id) !== undefined && e.models.length > 0);

const DAYS = (days: readonly number[]) => [{ value: null, label: "Never" }, ...days.map((d) => ({ value: d, label: `After ${d} ${d === 1 ? "day" : "days"}` }))];
const daysLabel = (days: number | null) => (days === null ? "Never" : `After ${days} ${days === 1 ? "day" : "days"}`);

export function GeneralSettings({ description }: { description: string }) {
  const { c, t } = useTheme();
  const [s, save] = useSettings();
  const picks = useChoices();
  const nav = useSettingsNav();
  return (
    <Page description={description}>
      <Card title="New chats" description="What a new chat starts with, each model at its effort and speed. A project can set its own.">
        <ChoiceRow
          label="Permissions"
          description="When an agent needs your approval to act. New chats start with this; a chat changes its own in the composer."
          value={ACCESS[s.default_access].label}
          accessibilityLabel={`Permissions for new chats, ${ACCESS[s.default_access].label}`}
          width={330}
          entries={choices(
            (Object.keys(ACCESS) as Access[]).map((mode) => ({ value: mode, label: ACCESS[mode].label, description: ACCESS[mode].line, icon: <PixelIcon name={ACCESS[mode].icon} /> })),
            s.default_access,
            (default_access) => save({ default_access }),
          )}
        />
        {NEW_CHAT_ENGINES.map((engine) => {
          const entry = newChatModel(engine.id, s.engine_models, picks);
          const board = boardEngine(engine.id);
          if (!entry || !board) return null;
          const start = startOf(entry, picks.starts);
          const { accessibilityLabel: said, ...trigger } = triggerOf({ engine: board, model: entry.model.label, effort: (start.effort ?? "medium") as Effort, speed: start.speed });
          return (
            <SettingRow
              key={engine.id}
              label={`${engine.label} model`}
              description={<ModelName {...trigger} size="small" />}
              chevron
              onPress={() => nav.pickModel(engine.id)}
              accessibilityLabel={`Model for new ${engine.label} chats. ${said}`}
            />
          );
        })}
      </Card>

      <Card title="Inbox" description="The Done shelf: when a chat goes there by itself, and when it is archived.">
        <SettingRow label="Done when its pull request merges" description="A closed pull request always marks its chat done. A pinned chat never is.">
          <Toggle label="Done when its pull request merges" value={s.inbox_done_on_merge} onChange={(inbox_done_on_merge) => save({ inbox_done_on_merge })} />
        </SettingRow>
        <ChoiceRow
          label="Done after a quiet spell"
          description="Days with nothing new. A chat that asks something or works never is."
          value={daysLabel(s.inbox_done_after_days)}
          width={220}
          entries={choices(DAYS([1, 3, 7, 14]), s.inbox_done_after_days, (inbox_done_after_days) => save({ inbox_done_after_days }))}
        />
        <SettingRow label="Keep chats with a pull request" description="The quiet spell never marks them done; their merge or close still does.">
          <Toggle label="Keep chats with a pull request" value={s.inbox_keep_pull_requests} onChange={(inbox_keep_pull_requests) => save({ inbox_keep_pull_requests })} />
        </SettingRow>
        <ChoiceRow
          label="Archive done chats"
          description="Its worktree goes, uncommitted work is kept on the branch, and Restore brings it back."
          value={daysLabel(s.inbox_archive_done_after_days)}
          width={220}
          entries={choices(DAYS([1, 3, 7, 14, 30]), s.inbox_archive_done_after_days, (inbox_archive_done_after_days) => save({ inbox_archive_done_after_days }))}
        />
      </Card>

      <Card title="Git">
        <SettingRow
          label="Credit Caveman on commits and pull requests"
          description={
            <Text style={t.small}>
              Commits engines make get <Text style={{ fontFamily: mono, fontSize: 12, color: c.soft }}>Co-Authored-By: Caveman</Text>, and pull requests get "Made with Caveman Code". Commits you make
              yourself stay as they are.
            </Text>
          }
        >
          <Toggle label="Credit Caveman on commits and pull requests" value={s.git_co_author} onChange={(git_co_author) => save({ git_co_author })} />
        </SettingRow>
      </Card>
    </Page>
  );
}
