import type { CloudStatus, Params } from "@caveman-app/session-protocol";
import { remoteControlOn } from "@caveman-app/session-protocol/devices";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { Switch } from "@caveman-app/ui/components/switch";
import { useEffect, useId, useState } from "react";
import { openExternal } from "../panels/browser/BrowserBar.tsx";
import { accountLabel, HOSTED_CLOUD, needsSignIn, notRegistered, remoteView, type RemoteView } from "../state/cloud.ts";
import { CLOUD_HOSTED, requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { SettingRow, SettingsCard } from "../routes/settings/rows.tsx";
import { useUnlinkConfirm } from "./cloud/trust.tsx";

/**
 * How the first run signs in through Caveman Cloud's page: `provider` starts that sign-in at once; `email` prefills it.
 */
export type SignInHow = { readonly provider?: "github" | "google"; readonly email?: string; readonly intent?: "signin" | "signup" };

export interface RemoteControl {
  readonly status: CloudStatus | null;
  readonly view: RemoteView;
  readonly busy: boolean;
  readonly error: string | null;
  readonly setOn: (on: boolean) => Promise<void>;
  readonly signIn: (how?: SignInHow) => Promise<void>;
  /** `deleteCloudCopies`: Cloud also deletes what it holds for you (settings, opted-in secrets, server keys, sign-ins). */
  readonly signOut: (deleteCloudCopies?: boolean) => Promise<void>;
}

/**
 * Remote control for the runtime this client is on: cloud.status, kept fresh
 * by cloud.changed, and the actions behind the switch. Sign-in is the
 * runtime's own (Cloud's device flow): this client shows the code and opens
 * Cloud's page through the safe external path (a new tab; the desktop shell
 * hands it to the system browser).
 */
export function useRemoteControl(): RemoteControl {
  const { client, connection } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const off = client.on("cloud.changed", (next) => live && setStatus(next));
    client.call("cloud.status", {}).then(
      (next) => live && setStatus(next),
      () => undefined,
    );
    return () => {
      live = false;
      off();
    };
  }, [client, connection]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const signIn = ({ provider, email, intent }: SignInHow = {}) =>
    run(async () => {
      if (!client) return;
      const started = await client.call("cloud.signin", {
        request_id: requestId(),
        ...(provider ? { provider } : {}),
        ...(email ? { email } : {}),
        ...(intent ? { intent } : {}),
      });
      openExternal(started.verification_uri_complete);
    });
  const setOn = (on: boolean) =>
    run(async () => {
      if (!client) return;
      // Signed in without a registered computer: switching it on asks Caveman to register it again, as Try again does.
      if (on && (needsSignIn(status) || notRegistered(status))) {
        // The runtime keeps Remote control off until the person switches it on again for the account that approved.
        const started = await client.call("cloud.signin", { request_id: requestId() });
        openExternal(started.verification_uri_complete);
        return;
      }
      // Off also cancels a sign-in still waiting for approval.
      await client.call("settings.set", { request_id: requestId(), settings: { remote_control: on } });
      await refresh();
    });
  const signOut = (deleteCloudCopies = true) =>
    run(async () => {
      if (!client) return;
      await client.call("cloud.signout", { request_id: requestId(), delete_cloud_copies: deleteCloudCopies } as Params<"cloud.signout">);
      await refresh();
    });
  // On with sync unless the person set it (S13), as the runtime reads it.
  return { status, view: remoteView(status, remoteControlOn(settings)), busy, error, setOn, signIn, signOut };
}

/** Settings, Remote control: follow and steer this computer's sessions from a browser anywhere. */
export function RemoteControlSettings() {
  const { client } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const remote = useRemoteControl();
  const unlink = useUnlinkConfirm(remote.signOut);
  const id = useId();
  const [url, setUrl] = useState<string | null>(null);
  const { status, view } = remote;
  const cloudUrl = status?.cloud_url ?? settings?.cloud_url ?? HOSTED_CLOUD;
  const enrolled = status?.runtime_id !== undefined;
  // CAVEMAN_CLOUD_URL: an IT team chose the Cloud, so it is not changed here.
  const managed = settings?.cloud_url_managed === true;
  const saveUrl = async () => {
    if (!client || url === null) return;
    await client.call("settings.set", { request_id: requestId(), settings: { cloud_url: url.trim() || HOSTED_CLOUD } });
    await refresh();
    setUrl(null);
  };

  // Where the link stands, in words; nothing while it is plainly off, which the switch already says.
  const where = status?.signin
    ? "Waiting for you to approve this computer in your browser. Only approve a code you see here."
    : view.step === "connected"
      ? `Connected${status?.account ? ` as ${accountLabel(status.account)}` : ""}. A new device asks here first.`
      : view.step === "off" && status?.moves === "on"
        ? `${view.detail}${status.account ? `, as ${accountLabel(status.account)}` : ""}. Turn that off in Computers.`
        : view.step === "off" && status?.account
          ? `Signed in as ${accountLabel(status.account)}. Not your account? Sign out below.`
          : view.detail === "Off"
            ? ""
            : view.detail;
  const state = `${where}${CLOUD_HOSTED ? " Turn it off on the computer itself." : ""}`.trim();

  return (
    <>
      <SettingsCard title="Remote control" description="Follow and steer this computer's chats from your other devices.">
        <SettingRow
          id={id}
          label="Allow remote control"
          description={state ? <span aria-live="polite">{state}</span> : undefined}
        >
          <Switch id={id} disabled={!client || remote.busy || CLOUD_HOSTED} checked={view.on} onCheckedChange={(on) => void remote.setOn(on)} />
        </SettingRow>
        {status?.signin ? (
          <SettingRow
            label={<span className="font-mono text-[20px] tracking-[0.18em]">{status.signin.user_code}</span>}
            description={`Approve this code in your browser. It expires at ${new Date(status.signin.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
          >
            <Button asChild variant="outline">
              <a href={status.signin.verification_uri_complete} target="_blank" rel="noopener noreferrer">
                Open the sign-in page
              </a>
            </Button>
          </SettingRow>
        ) : null}
        {!CLOUD_HOSTED && (view.step === "sign_in" || view.step === "sign_in_again") && !status?.signin ? (
          <SettingRow label="Sign in" description="Other devices reach this computer through your Caveman account.">
            <Button disabled={remote.busy} onClick={() => void remote.signIn()}>
              {view.step === "sign_in_again" ? "Sign in again" : "Sign in to Caveman"}
            </Button>
          </SettingRow>
        ) : null}
        {!CLOUD_HOSTED && view.step === "not_registered" ? (
          <SettingRow label="Computer not registered" description="Other devices reach this computer once Caveman registers it. You stay signed in.">
            <Button variant="outline" disabled={remote.busy} onClick={() => void remote.signIn()}>
              Try again
            </Button>
          </SettingRow>
        ) : null}
        {remote.error ? (
          <p role="alert" className="px-5 py-3 text-[12.5px] text-destructive">
            {remote.error}
          </p>
        ) : null}
        {url === null ? (
          <SettingRow
            label="Caveman server"
            description={
              <>
                <span className="block truncate font-mono text-[12px]">{cloudUrl}</span>
                {managed ? <span className="block">Set by your organization.</span> : null}
              </>
            }
          >
            {!enrolled && !CLOUD_HOSTED && !managed ? (
              <Button variant="outline" onClick={() => setUrl(cloudUrl)}>
                Change
              </Button>
            ) : null}
          </SettingRow>
        ) : (
          <SettingRow id={`${id}-url`} label="Caveman server" stacked>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveUrl();
              }}
            >
              <Input id={`${id}-url`} autoFocus value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} className="min-w-0 flex-1 font-mono text-[12.5px]" />
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </form>
          </SettingRow>
        )}
        {enrolled ? (
          <SettingRow
            label="This computer"
            description={
              <>
                Signed in{status?.account ? ` as ${accountLabel(status.account)}` : ""}. Open <span className="font-mono text-[12px] text-foreground">{cloudUrl}/code/</span> on another device.
              </>
            }
          >
            {!CLOUD_HOSTED ? (
              <Button variant="outline" disabled={remote.busy} onClick={unlink.open}>
                Sign out
              </Button>
            ) : null}
          </SettingRow>
        ) : null}
      </SettingsCard>
      {unlink.dialog}
    </>
  );
}
