import type { AccountSummary } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Tag } from "@caveman-app/ui/components/tag";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useRemoteControl } from "../../components/RemoteControl.tsx";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { HOSTED_CLOUD, isHostedCloud } from "../../state/cloud.ts";
import { useAccountRead } from "../../state/account.ts";
import { useRuntimeClient, useRuntimeSelector, useWebWindow } from "../../state/runtime.tsx";
import { planLabel, roleLabel, subscriptionLine } from "./account-model.ts";
import { useUnlinkConfirm } from "../../components/cloud/trust.tsx";
import { CloudConsoleView } from "./CloudConsole.tsx";
import { OnCloudSettings } from "./OnCloud.tsx";
import { SettingRow, SettingsCard, SettingsCardBody } from "./rows.tsx";

/**
 * Settings > Account: the person's Caveman account through the sign-in the
 * runtime keeps (in a browser window with no computer behind it, from Cloud
 * itself): who they are, their organization and its members (read-only),
 * with the Code plan one row away in Settings > Plan, and what Caveman holds
 * for them behind one row. Member admin, SSO and domains live in Caveman
 * Cloud.
 */
export function AccountSettings() {
  const { client, connection } = useRuntimeClient();
  const web = useWebWindow() !== null;
  const read = useAccountRead();
  const settings = useRuntimeSelector((v) => v.settings);
  const remote = useRemoteControl();
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!read) return;
    read().then(setAccount, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [read]);
  const unlink = useUnlinkConfirm((wipe) => remote.signOut(wipe).then(load));

  // Again once a sign-in or sign-out lands (cloud.changed moves the status).
  useEffect(load, [load, connection, remote.status?.account?.email, remote.status?.runtime_id]);

  const cloudUrl = account?.cloud_url ?? settings?.cloud_url ?? HOSTED_CLOUD;
  const credits = account?.credits;
  const sub = credits?.subscription;
  return (
    <div className="flex flex-col gap-8">
      <SettingsCard
        title="Caveman account"
        // A browser window is signed in to be here at all: while Cloud has not answered it says nothing of signing in.
        description={account?.signed_in || (web && account === null) ? undefined : isHostedCloud(cloudUrl) ? "Sign in to see your plan, credits and team here, and to use Caveman credits." : "Sign in to see your organization and team here."}
      >
        {account?.signed_in ? (
          <SettingRow
            label={<span className="block truncate">{account.email}</span>}
            description={[account.organization_name, account.role ? roleLabel(account.role) : undefined].filter(Boolean).join(" · ") || undefined}
          />
        ) : web && account === null ? null : (
          <SignIn remote={remote} />
        )}
        {credits ? (
          <SettingRow to="/settings/plan" label="Plan" description={sub ? subscriptionLine(sub, account?.offer).text : "Plans, credits and free months to give."}>
            {planLabel(credits.plan, account?.offer)}
            {credits.gifts && credits.gifts.open > 0 ? <Tag>{credits.gifts.open === 1 ? "1 free month to give" : `${credits.gifts.open} free months to give`}</Tag> : null}
          </SettingRow>
        ) : null}
        {account?.error || remote.error || error ? (
          <SettingsCardBody className="flex flex-col gap-1 text-[13px]">
            {account?.error ? <p className="text-muted-foreground">{account.error}</p> : null}
            {remote.error ? <p className="text-destructive">{remote.error}</p> : null}
            {error ? <p className="text-destructive">{error}</p> : null}
          </SettingsCardBody>
        ) : null}
      </SettingsCard>

      {account?.signed_in && account.members ? (
        <SettingsCard
          title="Team"
          description="Invites, roles, SSO and domains are managed in Caveman Platform."
          actions={
            <Button variant="outline" onClick={() => openExternal(`${cloudUrl}/team`)}>
              Manage in Caveman Platform
            </Button>
          }
        >
          {account.members.map((m) => (
            <SettingRow key={m.email} label={<span className="block truncate">{m.name ?? m.email}</span>} description={m.name ? m.email : undefined}>
              {m.status === "active" ? null : <Tag>{m.status === "pending" ? "Invited" : m.status}</Tag>}
              <span className="text-[13px] text-muted-foreground">{roleLabel(m.role)}</span>
            </SettingRow>
          ))}
        </SettingsCard>
      ) : null}

      {/* What Caveman holds is read through a computer: a browser window with none does not offer it. */}
      {account?.signed_in && client ? <HeldByCaveman /> : null}

      {/* The Platform console's pages, one click away from the account they belong to. */}
      <CloudConsoleView base={cloudUrl} />

      {account?.signed_in && !web ? (
        <SettingsCard>
          <SettingRow label="Sign out" description="Sign this computer out of Caveman.">
            <Button variant="outline" disabled={remote.busy} onClick={unlink.open}>
              Sign out
            </Button>
          </SettingRow>
        </SettingsCard>
      ) : null}
      {unlink.dialog}
    </div>
  );
}

/**
 * What Caveman holds for the person and who read it: one row, closed until it is asked for. A link to it
 * (/settings/account#held, where the old Held by Caveman page lands) opens it.
 */
function HeldByCaveman() {
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === "#held");
  useEffect(() => {
    if (hash === "#held") setOpen(true);
  }, [hash]);
  return (
    <>
      <SettingsCard>
        <SettingRow label="Held by Caveman" description="What Caveman holds for you, and who read it.">
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </Button>
        </SettingRow>
      </SettingsCard>
      {open ? <OnCloudSettings /> : null}
    </>
  );
}

/** Signed out: the device code to approve while a sign-in runs, else the button that starts one. */
export function SignIn({ remote }: { remote: ReturnType<typeof useRemoteControl> }) {
  const web = useWebWindow() !== null;
  const signin = remote.status?.signin;
  return (
    <>
      {signin ? (
        <SettingRow label={<span className="font-mono text-[20px] tracking-[0.18em]">{signin.user_code}</span>} description="Approve this code in your browser. Only approve a code you see here.">
          <Button variant="outline" onClick={() => openExternal(signin.verification_uri_complete)}>
            Open the sign-in page
          </Button>
        </SettingRow>
      ) : (
        <SettingRow label="Not signed in" description="Your engines run on your own keys and logins.">
          {!web ? (
            <Button disabled={remote.busy} onClick={() => void remote.signIn()}>
              Sign in to Caveman
            </Button>
          ) : null}
        </SettingRow>
      )}
      {remote.status?.signin_error ? <SettingsCardBody className="text-[13px] text-muted-foreground">{remote.status.signin_error}</SettingsCardBody> : null}
    </>
  );
}
