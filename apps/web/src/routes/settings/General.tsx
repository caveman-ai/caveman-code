import { ACCESS, ACCESS_MODES, DEFAULT_ACCESS, type AccessMode } from "@caveman-app/ui/components/access-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Switch } from "@caveman-app/ui/components/switch";
import { DesktopAppSettings } from "../../components/DesktopAppSettings.tsx";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { modelStart, withDefaultModel, withModelStart } from "../../components/Composer.tsx";
import { NewChatModelPicker, newChatEngines, settingModel } from "./new-chat-model.tsx";
import { CONTROL, InstructionsCard, SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";
import { SnoozeOptionsCard } from "./SnoozeOptions.tsx";

/** Settings > General: how new chats start, what notifies you, how the inbox tidies itself, and this app. */
export function GeneralSettings() {
  const settings = useRuntimeSelector((v) => v.settings);
  const engines = useRuntimeSelector((v) => v.engines);
  const save = useSaveSettings();
  const saveTitles = useSaveSettings({ throws: true });
  return (
    <>
      <SettingsCard title="New chats">
        <SettingRow
          id="default-access"
          label="Permissions"
          description="When agents ask before they act."
        >
          <Select
            disabled={!settings}
            value={settings?.default_access ?? DEFAULT_ACCESS}
            onValueChange={(mode) => void save({ default_access: mode as AccessMode })}
          >
            <SelectTrigger id="default-access" aria-label="Permissions for new chats" className={CONTROL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {ACCESS[mode].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {newChatEngines(engines).map((engine) => {
          const model = settingModel(engine, settings);
          const start = model ? modelStart(settings?.model_defaults, engine.id, model, settings?.engines[engine.id]) : undefined;
          return (
            <SettingRow key={engine.id} label={`${engine.label} model`}>
              <NewChatModelPicker
                engine={engine}
                value={model?.id}
                onChange={(next) => settings && next && void save({ engines: withDefaultModel(settings, engine.id, next) })}
                {...(settings && model && start
                  ? { start: { ...start, onChange: (next) => void save({ model_defaults: withModelStart(settings.model_defaults, engine.id, model, next) }) } }
                  : {})}
                ariaLabel={`Model for new ${engine.label} chats: ${model?.label ?? "none"}`}
              />
            </SettingRow>
          );
        })}
      </SettingsCard>
      <SettingsCard title="Composer">
        <SettingRow id="prompt-suggestions" label="Suggest your next message" description="After each turn, a guess you can take with Tab.">
          <Switch id="prompt-suggestions" disabled={!settings} checked={settings?.prompt_suggestions === true} onCheckedChange={(on) => void save({ prompt_suggestions: on })} />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Notifications">
        <SettingRow id="notify-needs-input" label="When a chat or a Chief needs you" description="A question or an approval, while the app is in the background.">
          <Switch
            id="notify-needs-input"
            disabled={!settings}
            checked={settings?.notifications.needs_input !== false}
            onCheckedChange={(on) => settings && void save({ notifications: { ...settings.notifications, needs_input: on } })}
          />
        </SettingRow>
        <SettingRow id="notify-turn-done" label="When a chat finishes">
          <Switch
            id="notify-turn-done"
            disabled={!settings}
            checked={settings?.notifications.turn_done !== false}
            onCheckedChange={(on) => settings && void save({ notifications: { ...settings.notifications, turn_done: on } })}
          />
        </SettingRow>
        <SettingRow id="notify-chief-messages" label="Messages from Chiefs">
          <Switch
            id="notify-chief-messages"
            disabled={!settings}
            checked={settings?.notifications.chief_messages !== false}
            onCheckedChange={(on) => settings && void save({ notifications: { ...settings.notifications, chief_messages: on } })}
          />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Inbox">
        <SettingRow id="inbox-done-on-merge" label="Done when its pull request merges">
          <Switch id="inbox-done-on-merge" disabled={!settings} checked={settings?.inbox_done_on_merge !== false} onCheckedChange={(on) => void save({ inbox_done_on_merge: on })} />
        </SettingRow>
        <SettingRow id="inbox-done-after" label="Done when nothing is new">
          <DaysSelect id="inbox-done-after" disabled={!settings} value={settings ? (settings.inbox_done_after_days ?? null) : 3} choices={[1, 3, 7, 14]} onChange={(days) => void save({ inbox_done_after_days: days })} />
        </SettingRow>
        <SettingRow id="inbox-keep-prs" label="Keep chats with a pull request" description="Only its merge or close marks them done.">
          <Switch id="inbox-keep-prs" disabled={!settings} checked={settings?.inbox_keep_pull_requests === true} onCheckedChange={(on) => void save({ inbox_keep_pull_requests: on })} />
        </SettingRow>
        <SettingRow id="inbox-archive-after" label="Archive done chats" description="Removes the worktree and keeps uncommitted work for Restore.">
          <DaysSelect id="inbox-archive-after" disabled={!settings} value={settings?.inbox_archive_done_after_days ?? null} choices={[1, 3, 7, 14, 30]} onChange={(days) => void save({ inbox_archive_done_after_days: days })} />
        </SettingRow>
      </SettingsCard>
      <SnoozeOptionsCard />
 {/* upstream thread title instructions (#21882): what every generated chat title follows. */}
      <InstructionsCard
        title="Chat titles"
        description="How to name chats, in plain words."
        label="How chats are named"
        placeholder={"Two to four words, no articles.\nLead with the area: \"Billing: invoice rounding\"."}
        maxLength={2000}
        value={settings?.thread_title_instructions ?? ""}
        disabled={!settings}
        onSave={(thread_title_instructions) => saveTitles({ thread_title_instructions })}
      />
      <SettingsCard title="Git">
        <SettingRow
          id="git-co-author"
          label="Credit Caveman on commits and pull requests"
          description="On the ones agents make, never yours."
        >
          <Switch id="git-co-author" disabled={!settings} checked={settings?.git_co_author !== false} onCheckedChange={(on) => void save({ git_co_author: on })} />
        </SettingRow>
      </SettingsCard>
      <DesktopAppSettings />
    </>
  );
}

/** A number of days, or Never (null). */
function DaysSelect({ id, value, choices, disabled, onChange }: { id: string; value: number | null; choices: ReadonlyArray<number>; disabled: boolean; onChange: (days: number | null) => void }) {
  const options = value === null || choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b);
  return (
    <Select disabled={disabled} value={value === null ? "never" : String(value)} onValueChange={(v) => onChange(v === "never" ? null : Number(v))}>
      <SelectTrigger id={id} className={CONTROL}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="never">Never</SelectItem>
        {options.map((days) => (
          <SelectItem key={days} value={String(days)}>
            After {days} {days === 1 ? "day" : "days"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
