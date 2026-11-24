import { Button } from "@caveman-app/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Switch } from "@caveman-app/ui/components/switch";
import { useEffect, useId, useState } from "react";
import { SettingRow, SettingsCard } from "../routes/settings/rows.tsx";
import type { AttachedRuntime, CliStatus, PowerState, TelemetryChoice, UpdateChannel, UpdateState } from "../state/desktop.ts";
import { showWhatsNew } from "../whats-new/WhatsNew.tsx";
import { COMPUTER, thisComputer } from "../lib/platform.ts";
import { hasNotch, setNotchOn, useNotchOn } from "../notch/enabled.ts";

const CHANNEL_NAME: Record<UpdateChannel, string> = { stable: "Stable", nightly: "Nightly" };
/** ": message." with its own stop kept, or "." */
const because = (message: string | null | undefined) => (message ? `: ${message}${/[.!?]$/.test(message) ? "" : "."}` : ".");

/** One sentence on where the updater is, from apps/desktop/src/updates/updateMachine.ts's state. */
export const updateLine = (u: UpdateState): string => {
  const next = u.next ?? "an update";
  switch (u.status) {
    case "disabled":
      return u.message ?? "Updates are off in this build.";
    case "error":
      if (u.failed === "download") return `Couldn't download ${next}${because(u.message)} It tries again at the next check.`;
      return `Couldn't check for updates${because(u.message)}`;
    case "checking":
      return `Checking for ${CHANNEL_NAME[u.channel ?? "stable"]} updates…`;
    case "downloading":
      return `Downloading ${next}${typeof u.percent === "number" ? ` (${u.percent}%)` : ""}…`;
    case "ready":
      // A message: why it cannot install now (Windows, while caveman-code's runtime runs in a terminal), or why the
      // last try did not.
      return `${u.next ?? "An update"} is ready. ${u.message ?? "It installs when you quit, or now."}`;
    case "current":
      // Switched back to Stable on a nightly: it stays until a newer Stable is out, never an older one.
      if (u.channel === "stable" && u.buildChannel === "nightly") return "Up to date: this Nightly build stays until a Stable release newer than it is out.";
      return "Up to date.";
    case "idle":
      return "Checks for updates on its own.";
  }
};

function Updates() {
  const updates = window.cavemanDesktop?.updates;
  const channelId = useId();
  const [state, setState] = useState<UpdateState | null>(null);
  const [attached, setAttached] = useState<AttachedRuntime | null>(null);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!updates) return;
    let live = true;
    // The download runs in the main process; follow it while this page is open.
    const read = () => {
      void updates.state().then((next) => live && setState(next));
      void updates.attachedRuntime().then((next) => live && setAttached(next), () => undefined);
    };
    read();
    const timer = setInterval(read, 2_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [updates]);
  if (!updates || !state) return null;
  const busy = state.status === "checking" || state.status === "downloading";
  const notes = state.status === "downloading" || state.status === "ready" ? (state.notes ?? []).filter((note) => note.version === state.next) : [];
  const pick = (channel: UpdateChannel) => {
    if (channel === state.channel) return;
    setSwitching(true);
    void updates
      .setChannel(channel)
      .then((next) => next && setState(next))
      .finally(() => setSwitching(false));
  };
  return (
    <>
      <SettingRow
        label={`Caveman Code ${state.version}`}
        description={
          <>
            <span aria-live="polite">{updateLine(state)}</span>
            {state.notApplied && state.notApplied !== state.next ? ` The update to ${state.notApplied} didn't install.` : null}{" "}
            <button type="button" onClick={showWhatsNew} className="text-foreground underline-offset-2 hover:underline">
              What's new
            </button>
            {notes.length > 0 ? (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4" aria-label={`What's in ${state.next}`}>
                {notes[0]!.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </>
        }
      >
        {state.status === "ready" ? (
          <Button onClick={() => updates.install()}>
            Restart to update
          </Button>
        ) : state.status !== "disabled" ? (
          <Button variant="outline" disabled={busy} onClick={() => void updates.check().then((next) => next && setState(next))}>
            Check for updates
          </Button>
        ) : null}
      </SettingRow>
      {state.channel ? (
        <SettingRow
          id={channelId}
          label="Update channel"
          description="Nightly is a daily build, newest and least tried. Back on Stable, it stays until a newer release."
        >
          <Select value={state.channel} disabled={switching} onValueChange={(value) => pick(value as UpdateChannel)}>
            <SelectTrigger id={channelId} aria-label="Update channel" className="h-8 w-32 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">Stable</SelectItem>
              <SelectItem value="nightly">Nightly</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      ) : null}
      {attached ? (
        <SettingRow
          label="Runtime from caveman-code"
          description={
            attached.skew
              ? `This app is using the runtime caveman-code started in a terminal, which is version ${attached.version}; this app is ${attached.appVersion}, so some things may work differently. Quit caveman-code and this app switches to its own runtime.`
              : `This app is using the runtime caveman-code started in a terminal${attached.version ? ` (version ${attached.version})` : ""}. Quit caveman-code and this app switches to its own runtime.`
          }
        />
      ) : null}
    </>
  );
}

/** Settings and first run: the `caveman-code` command, linked onto PATH only when asked. */
export function CliInstall({ compact = false }: { compact?: boolean }) {
  const cli = window.cavemanDesktop?.cli;
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void cli?.status().then(setStatus);
  }, [cli]);
  if (!cli || !status?.launcher) return null;
  const install = async () => {
    setBusy(true);
    setStatus(await cli.install());
    setBusy(false);
  };
  // Windows: the launcher's folder goes on the user's PATH, which only terminals opened after it read.
  const userPath = status.via === "user-path";
  const line = status.onPath
    ? userPath
      ? `Installed: run caveman-code in a new terminal (${status.link} is on your PATH).`
      : `Installed: run caveman-code in any terminal (${status.link}).`
    : status.conflict
      ? `Something else is at ${status.link}, so it stays. Run ${status.launcher} instead.`
      : userPath
        ? `Start or follow this app's sessions from a terminal. Adds ${status.link} to your PATH; terminals opened after it have the command.`
        : `Start or follow this app's sessions from a terminal. Links ${status.link}; macOS may ask for your password.`;
  if (compact && (status.onPath || status.conflict)) return null;
  return (
    <SettingRow label="Command line: caveman-code" description={status.error ? `Not installed: ${status.error}` : line}>
      {!status.onPath && !status.conflict ? (
        <Button variant="outline" disabled={busy} onClick={() => void install()}>
          {busy ? "Installing…" : "Install"}
        </Button>
      ) : null}
    </SettingRow>
  );
}

/**
 * Settings > General and the first onboarding screen: what is sent, and the switch.
 * `onShown` runs once the line is on screen; the desktop sends nothing before the
 * onboarding screen's call (apps/desktop/src/telemetry.ts).
 */
export function TelemetrySetting({ onShown }: { onShown?: () => void }) {
  const telemetry = window.cavemanDesktop?.telemetry;
  const id = useId();
  const [choice, setChoice] = useState<TelemetryChoice | null>(null);
  useEffect(() => {
    void telemetry?.choice().then(setChoice);
  }, [telemetry]);
  const shown = choice !== null;
  useEffect(() => {
    if (shown) onShown?.();
  }, [shown, onShown]);
  // This line names turn stats and crash reports: on screen with telemetry on, turns count and crash reports may go from
  // now (an install from before them). A development build's line says nothing is sent, so it names nothing.
  const naming = choice !== null && choice.enabled && !choice.envOff && !choice.dryRun && (choice.turnsDisclosed === false || choice.reportsDisclosed === false);
  useEffect(() => {
    if (naming) telemetry?.disclosed?.();
  }, [naming, telemetry]);
  if (!telemetry || !choice) return null;
  return (
    <SettingRow
      id={id}
      label="Usage stats"
      description={
        choice.envOff
          ? "Off: DO_NOT_TRACK or CAVEMAN_TELEMETRY is set on this computer."
          : choice.dryRun
            ? "This is a development or test build: nothing is sent, whatever the switch says."
            : "Which first-run steps you reached, and how each turn went: its engine, model and effort, how long it took, its token and tool counts, and whether it failed or was undone. While you use Caveman's own Cloud, crash reports too: where the app failed, as the error and its stack or a native crash dump, with secrets, emails and your home folder taken out, sent to Sentry, our crash service. With the app version, OS, processor type and an anonymous install id. Never prompts, replies or code."
      }
    >
      <Switch id={id} disabled={choice.envOff} checked={choice.enabled && !choice.envOff} onCheckedChange={(on) => void telemetry.set(on).then((next) => next && setChoice(next))} />
    </SettingRow>
  );
}

/** Idle sleep waits while chats work on this Mac, when turned on. */
function KeepAwakeSetting() {
  const power = window.cavemanDesktop?.power;
  const id = useId();
  const [state, setState] = useState<PowerState | null>(null);
  useEffect(() => {
    void power?.get().then(setState);
  }, [power]);
  if (!power || !state) return null;
  return (
    <SettingRow
      id={id}
      label={`Keep ${thisComputer} awake while chats work`}
      description={`So idle sleep doesn't freeze a long run. The display still sleeps, and so does a closed ${COMPUTER}.${state.holding ? " Keeping it awake now." : ""}`}
    >
      <Switch id={id} checked={state.keepAwake} onCheckedChange={(on) => void power.set(on).then((next) => next && setState(next))} />
    </SettingRow>
  );
}

/** The notch at the top of the screen (notch/NotchFeed.tsx), a Mac's: its right-click menu hides it, this brings it back. */
function NotchSetting() {
  const on = useNotchOn();
  const id = useId();
  if (!hasNotch()) return null;
  return (
    <SettingRow id={id} label="Notch at the top of the screen" description="Marks your chats at work, over every app, and opens when one needs you.">
      <Switch id={id} checked={on} onCheckedChange={setNotchOn} />
    </SettingRow>
  );
}

/** Settings > General, desktop only: version, updates and their channel, the command line tool, sleep, the notch, crash and onboarding counts. */
export function DesktopAppSettings() {
  if (!window.cavemanDesktop?.updates) return null;
  return (
    <SettingsCard title="This app" description="Version, updates and their channel, the command line tool, sleep, the notch, and crash reports.">
      <Updates />
      <CliInstall />
      <KeepAwakeSetting />
      <NotchSetting />
      <TelemetrySetting />
    </SettingsCard>
  );
}
