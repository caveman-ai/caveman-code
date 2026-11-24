import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { cn } from "@caveman-app/ui/lib/cn";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type AccessEntry, type Holding, PAUSED_TEXT, refreshProfile, trustCall, unserved, useProfileStatus } from "../../components/cloud/trust.tsx";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { SettingRow, SettingsCard } from "./rows.tsx";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";

const KIND: Record<Holding["kind"], string> = {
  profile: "Settings and skills",
  repository_secrets: "Repository secrets",
  server_keys: "Server keys",
  connection: "Connector sign-in",
};
const WHAT: Record<Holding["kind"], string> = {
  profile: "Marketplaces, plugins, server definitions, skill text and switches. No values.",
  repository_secrets: `Encrypted values for this repository, set from ${thisComputer}, another computer or Caveman Platform.`,
  server_keys: `Encrypted keys you turned on for your MCP servers, from ${thisComputer} or another one.`,
  connection: "Tokens from a sign-in you made with Caveman.",
};

/** What one holding is, in a line: Cloud's GitHub login is the one connected in the console, not a sign-in made here. */
export const holdingWhat = (h: Pick<Holding, "kind" | "id">) =>
  h.kind === "connection" && h.id === "github" ? "Your GitHub login, connected through Caveman. Removing it deletes the GitHub login Caveman keeps for you." : WHAT[h.kind];

const time = (iso: string) => {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/** One access-log row in plain words: who, did what, to which names. */
export function accessLine(e: AccessEntry): string {
  // A chat in Cloud by its title; never the machine under it.
  const who = e.workspace_title
    ? `${e.workspace_title} in Cloud`
    : e.computer_id
      ? "Cloud"
      : e.actor_type === "user"
        ? "You"
        : THIS_COMPUTER;
  const a = e.action;
  const names = e.names.length > 0 ? ` ${e.names.join(", ")}` : "";
  if (/resolve/.test(a)) return `${who} read${names}`;
  if (/lease/.test(a)) return `${who} used the sign-in for${names || " a connector"}`;
  if (/profile/.test(a) && /(get|read|pull)/.test(a)) return `${who} loaded your settings`;
  if (/profile/.test(a)) return `${who} updated your settings`;
  if (/reconnect/.test(a)) return names ? `The sign-in for${names} stopped working` : "A sign-in stopped working";
  if (/delete|remove/.test(a)) return `${who} deleted${names}`;
  if (/connect|start/.test(a)) return `${who} connected${names}`;
  if (/set|put|upload|import/.test(a)) return `${who} stored${names}`;
  return `${who}: ${a}${names}`;
}

/** How skills and plugins sync between your computers, the last changes that came here, and what a sync replaced. */
function SharedRow({ status }: { status: NonNullable<ReturnType<typeof useProfileStatus>> }) {
  const desktop = window.cavemanDesktop;
  const received = status.received_at && status.received ? ` Last brought ${status.received} ${status.received === 1 ? "change" : "changes"} here ${time(status.received_at)}.` : "";
  return status.mode === "two_way" ? (
    <SettingRow
      label="Skills and plugins follow you"
      description={`Skills, plugins and MCP servers sync within a minute. Replaced or removed files are kept 30 days.${received}`}
    >
      {status.trash && desktop?.revealFolder ? (
        <Button variant="secondary" onClick={() => desktop.revealFolder?.(status.trash!)}>
          Show replaced files
        </Button>
      ) : null}
    </SettingRow>
  ) : (
    <SettingRow
      label="Skills and plugins: sent from here only"
      description={`For now ${thisComputer} sends its skills and plugins, replaces none on your other computers and takes none.`}
    />
  );
}

/** Settings > Account, Held by Caveman: everything Caveman holds for you (names only), who read it, and deleting it. */
export function OnCloudSettings() {
  const { client } = useRuntimeClient();
  const status = useProfileStatus();
  const [items, setItems] = useState<ReadonlyArray<Holding> | null>(null);
  const [log, setLog] = useState<ReadonlyArray<AccessEntry> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Why the last removal or sync was refused: kept apart from `problem`, which every read of the list sets again. */
  const [refused, setRefused] = useState<string | null>(null);
  const [old, setOld] = useState(false);
  const [heldFailed, setHeldFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    const [held, read] = await Promise.allSettled([trustCall(client, "cloud.holdings", {}), trustCall(client, "cloud.access_log", { limit: 50 })]);
    if (held.status === "fulfilled") setItems(held.value.items);
    setHeldFailed(held.status === "rejected");
    if (read.status === "fulfilled") setLog(read.value.entries);
    const failed = [held, read].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    setOld(failed !== undefined && unserved(failed.reason));
    setProblem(failed === undefined || unserved(failed.reason) ? null : (failed.reason as { message?: string })?.message ?? String(failed.reason));
  }, [client]);
  useEffect(() => void load(), [load]);

  const remove = async (key: string, params: { all?: boolean; kind?: Holding["kind"]; id?: string }) => {
    if (!client) return;
    setBusy(key);
    setRefused(null);
    try {
      await trustCall(client, "cloud.holdings.remove", { request_id: requestId(), ...params });
      refreshProfile(client);
    } catch (e) {
      setRefused((e as { message?: string })?.message ?? String(e));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const resume = async () => {
    if (!client) return;
    setBusy("sync");
    setRefused(null);
    try {
      await trustCall(client, "cloud.profile.sync", { request_id: requestId() });
      refreshProfile(client);
    } catch (e) {
      setRefused((e as { message?: string })?.message ?? String(e));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const signedOut = status?.state === "off";
  const synced = status?.synced_at ? ` Settings last synced ${time(status.synced_at)}.` : "";
  return (
    <div className="flex flex-col gap-8">
      <SettingsCard
        title="What Caveman holds for you"
        description={`Names and settings sync by themselves, so Cloud starts set up like ${thisComputer}. Secret values stay here unless you turn them on; Cloud keeps those encrypted, and only your own chats in Cloud read them.`}
      >
        {status?.state === "paused" ? (
          <SettingRow label="Settings sync is off" description={PAUSED_TEXT}>
            <Button variant="secondary" disabled={busy !== null} onClick={() => void resume()}>
              {busy === "sync" ? "Syncing…" : "Sync again"}
            </Button>
          </SettingRow>
        ) : null}
        {refused ? <Line alert>{refused}</Line> : null}
        {status?.mode && status.state !== "paused" && status.state !== "off" ? <SharedRow status={status} /> : null}
        {problem ? <Line alert>{problem}</Line> : null}
        {old ? (
          <SettingRow label="Not available" description="This runtime cannot list what Caveman holds yet. Update Caveman Code to see it here." />
        ) : signedOut ? (
          <SettingRow label="Not signed in" description={`${THIS_COMPUTER} is not signed in to Caveman, so Caveman holds nothing from it.`} />
        ) : (
          <>
            {items === null && !problem ? <Line>{heldFailed ? "Caveman did not answer, so this list can't be shown now." : "Loading…"}</Line> : null}
            {items?.length === 0 ? <Line>Nothing. Caveman holds no settings, secrets or sign-ins for you.{synced}</Line> : null}
            {items?.map((h) => (
              <SettingRow
                key={`${h.kind}:${h.id}`}
                label={
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{h.label}</span>
                    <span className="text-[12px] text-muted-foreground">{KIND[h.kind]}</span>
                    {h.updated_at ? <span className="text-[12px] text-[hsl(var(--subtle-foreground))]">{time(h.updated_at)}</span> : null}
                  </span>
                }
                description={
                  <>
                    {holdingWhat(h)}
                    {h.names.length > 0 ? (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {h.names.map((n) => (
                          <li key={n} className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                            {n}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                }
              >
                <Button variant="ghost" disabled={busy !== null} onClick={() => void remove(`${h.kind}:${h.id}`, { kind: h.kind, id: h.id })}>
                  {busy === `${h.kind}:${h.id}` ? "Removing…" : "Remove from Cloud"}
                </Button>
              </SettingRow>
            ))}
            {items !== null && items.length > 0 ? (
              <SettingRow label="Remove everything" description={`Names only here; Caveman never shows a value back. Removing deletes Caveman's copy now.${synced}`}>
                <Button variant="destructive-outline" disabled={busy !== null} onClick={() => setConfirmAll(true)}>
                  Remove everything from Cloud
                </Button>
              </SettingRow>
            ) : null}
          </>
        )}
      </SettingsCard>

      {!old && !signedOut ? (
        <SettingsCard title="Who read it" description="Every time Cloud reads a secret, a server key or a sign-in, or loads your settings. Newest first.">
          {log === null ? <Line>{problem ? "Not available right now." : "Loading…"}</Line> : null}
          {log?.length === 0 ? <Line>Nothing has read anything yet.</Line> : null}
          {log?.map((e, i) => (
            <div key={`${e.at}:${i}`} className="flex items-baseline gap-3 px-5 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1">{accessLine(e)}</span>
              <span className="shrink-0 tabular-nums text-[12px] text-muted-foreground">{time(e.at)}</span>
            </div>
          ))}
        </SettingsCard>
      ) : null}

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Remove everything from Caveman?"
        description="Cloud deletes your synced settings, every secret and server key you turned on, and its connector sign-ins. Settings stop syncing until you turn sync on again. Cloud loses them the next time it starts."
        confirmLabel="Remove everything"
        destructive
        onConfirm={() => void remove("all", { all: true })}
      />
    </div>
  );
}

function Line({ children, alert }: { children: ReactNode; alert?: boolean }) {
  return (
    <p role={alert ? "alert" : undefined} className={cn("px-5 py-3.5 text-[13px]", alert ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}
