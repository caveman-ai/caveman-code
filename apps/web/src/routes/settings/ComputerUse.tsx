import type { ComputerApp } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Switch } from "@caveman-app/ui/components/switch";
import { PermissionState } from "../../components/ComputerPermission.tsx";
import { missingAny, PERMISSIONS, useComputerAccess } from "../../state/computer-access.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";

const sameApp = (a: ComputerApp, b: ComputerApp) => (a.bundle_id && b.bundle_id ? a.bundle_id === b.bundle_id : a.name === b.name);

/**
 * Settings > App > Computer use: agents using this Mac's apps through the runtime's `desktop` tool. The switch, the
 * two macOS permissions it takes, the apps allowed without asking (an approval's Always allow) and the ones no agent
 * may use. Only a Mac's runtime serves it; anywhere else the page says so.
 */
export function ComputerUseSettings() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const { access, error, retry, guide, guiding, guided, guideError, added, awaitsReopen, reopen } = useComputerAccess(true);

  if (error && !access) {
    return (
      <SettingsCard>
        <SettingRow label="Couldn't check computer use" description={<span className="text-destructive">{error}</span>}>
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        </SettingRow>
      </SettingsCard>
    );
  }
  if (!access) {
    return (
      <SettingsCard>
        <SettingRow label="Loading…" />
      </SettingsCard>
    );
  }
  if (!access.supported) {
    return (
      <SettingsCard>
        <SettingRow label="Computer use runs on a Mac" description={access.reason ?? "Open Caveman Code on a Mac to let agents use its apps."} />
      </SettingsCard>
    );
  }

  const apps = settings?.computer_use_apps ?? [];
  return (
    <>
      <SettingsCard>
        <SettingRow id="computer-use" label="Let agents use apps on this Mac" description="They work in the background and never move your pointer. Each new app asks you first.">
          <Switch id="computer-use" disabled={!settings} checked={settings?.computer_use !== false} onCheckedChange={(on) => void save({ computer_use: on })} />
        </SettingRow>
        {access.version ? (
          <SettingRow label="agent-desktop">
            <span className="text-[12px] tabular-nums text-muted-foreground">{access.version}</span>
          </SettingRow>
        ) : null}
      </SettingsCard>
      <SettingsCard
        title="Permissions"
        actions={
          missingAny(access) ? (
            <div className="flex items-center gap-2">
              {awaitsReopen && reopen ? (
                <Button variant="secondary" onClick={reopen}>
                  Reopen Caveman Code
                </Button>
              ) : guided ? (
                <Button variant="ghost" onClick={added}>
                  I added it
                </Button>
              ) : null}
              <Button variant="secondary" disabled={guiding} onClick={guide}>
                Open System Settings
              </Button>
            </div>
          ) : null
        }
      >
        {PERMISSIONS.map((p) => (
          <SettingRow key={p.key} label={p.label} description={p.description}>
            <PermissionState state={access[p.key]} />
          </SettingRow>
        ))}
        {guideError ? <SettingRow label="System Settings didn't open" description={<span className="text-destructive">{guideError}</span>} /> : null}
        {awaitsReopen ? <SettingRow label="Screen Recording is waiting on a reopen" description="macOS turns it on once Caveman Code reopens. Agents keep using apps meanwhile, without screenshots." /> : null}
      </SettingsCard>
      <SettingsCard title="Always allowed">
        {apps.length === 0 ? (
          <SettingRow label="None yet" description="An app shows here once you choose Always allow for it." />
        ) : (
          apps.map((app) => (
            <SettingRow key={app.bundle_id ?? app.name} label={app.name} {...(app.bundle_id ? { description: app.bundle_id } : {})}>
              <Button variant="ghost" disabled={!settings} aria-label={`Remove ${app.name}`} onClick={() => void save({ computer_use_apps: apps.filter((a) => !sameApp(a, app)) })}>
                Remove
              </Button>
            </SettingRow>
          ))
        )}
      </SettingsCard>
      {access.blocked.length > 0 ? (
        <SettingsCard title="Never available">
          {access.blocked.map((label) => (
            <SettingRow key={label} label={label} />
          ))}
        </SettingsCard>
      ) : null}
    </>
  );
}
