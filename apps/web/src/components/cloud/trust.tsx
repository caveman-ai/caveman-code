// What Caveman Cloud holds for you, and the switches that decide it (founder
// 2026-10-17, TRUST + SECURITY). Settings sync by themselves and carry no
// values; secret values leave This Mac only for a repository or server you
// turned on, and turning it off deletes Cloud's copy; connector sign-ins are
// made with Cloud and kept there. Every surface here says that plainly.
//
// The cloud.* trust methods are served by the runtime (names in
// packages/session-protocol/src/protocol.ts). A runtime that does not serve
// them shows none of this.
import type { Repo } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Checkbox } from "@caveman-app/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Switch } from "@caveman-app/ui/components/switch";
import { Tag } from "@caveman-app/ui/components/tag";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { openSoon } from "../../panels/browser/BrowserBar.tsx";
import { requestId, useRuntimeClient, useRuntime } from "../../state/runtime.tsx";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";

type Client = NonNullable<ReturnType<typeof useRuntime>["client"]>;

export interface ProfileItem {
  readonly kind: "marketplace" | "plugin" | "server" | "skill";
  readonly id: string;
  readonly cloud: "runs" | "needs_runtime" | "mac_only" | "skipped";
  readonly reason?: string;
  readonly available?: boolean;
  /** A home skill on This Mac: its SKILL.md's real path, as skill.list names it. */
  readonly path?: string;
}
export interface ProfileStatus {
  /** off: not signed in to Cloud; pending: signed in, never synced; paused: you removed it from Cloud. */
  readonly state: "off" | "pending" | "ok" | "error" | "paused";
  /** two_way: skills and plugins go both ways between your computers; push_only: Caveman cannot take shared changes yet, so this Mac only sends. */
  readonly mode?: "two_way" | "push_only";
  /** Where what a sync replaced or removed here is kept (30 days). */
  readonly trash?: string;
  /** The last sync that brought another computer's changes here, and how many. */
  readonly received_at?: string;
  readonly received?: number;
  readonly synced_at?: string;
  readonly error?: string;
  readonly items: ReadonlyArray<ProfileItem>;
  /** On a Cloud computer whose MCP servers run beside your agents' commands (not as their own user): those commands can read server keys. */
  readonly server_keys_shared?: boolean;
}
export interface Holding {
  readonly kind: "profile" | "repository_secrets" | "server_keys" | "connection";
  readonly id: string;
  readonly label: string;
  readonly names: ReadonlyArray<string>;
  readonly updated_at?: string;
}
export interface AccessEntry {
  readonly at: string;
  readonly action: string;
  readonly names: ReadonlyArray<string>;
  readonly computer_id?: string;
  readonly workspace_id?: string;
  readonly workspace_title?: string;
  readonly actor_type?: string;
  readonly actor_id?: string;
}

interface TrustMethods {
  "cloud.profile.status": [Record<string, never>, ProfileStatus];
  "cloud.profile.sync": [{ request_id: string }, ProfileStatus];
  "cloud.secrets.set_available": [{ request_id: string; repo: Repo; available: boolean; names?: ReadonlyArray<string> }, { repository: string; available: boolean; names: ReadonlyArray<string> }];
  "cloud.server.set_available": [{ request_id: string; name: string; available: boolean }, { available: boolean; names: ReadonlyArray<string> }];
  "cloud.holdings": [Record<string, never>, { items: ReadonlyArray<Holding> }];
  "cloud.holdings.remove": [{ request_id: string; all?: boolean; kind?: Holding["kind"]; id?: string }, { removed: number }];
  "cloud.access_log": [{ limit?: number }, { entries: ReadonlyArray<AccessEntry> }];
}

export const trustCall = <M extends keyof TrustMethods>(client: Client, method: M, params: TrustMethods[M][0]): Promise<TrustMethods[M][1]> =>
  (client.call as unknown as (m: string, p: unknown) => Promise<TrustMethods[M][1]>)(method, params);

/** The runtime answered "unknown method": it predates these surfaces. */
export const unserved = (e: unknown) => (e as { error?: { code?: number } })?.error?.code === -32601;

const errorText = (e: unknown) => (e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : String(e));

// One cloud.profile.status read serves every row on a page (ten seconds), like the pane's connector cache.
const profileCache = new WeakMap<Client, { at: number; value: Promise<ProfileStatus | null> }>();
const listeners = new Set<() => void>();
const readProfile = (client: Client, fresh = false) => {
  const hit = profileCache.get(client);
  if (hit && !fresh && Date.now() - hit.at < 10_000) return hit.value;
  const value = trustCall(client, "cloud.profile.status", {}).catch(() => null);
  profileCache.set(client, { at: Date.now(), value });
  return value;
};
/** Rows re-read the status after a switch changed it. */
export const refreshProfile = (client: Client) => {
  void readProfile(client, true).then(() => listeners.forEach((l) => l()));
};

/** cloud.profile.status; null while loading, when the runtime does not serve it, or on failure. */
export function useProfileStatus(): ProfileStatus | null {
  const { client } = useRuntimeClient();
  const [status, setStatus] = useState<ProfileStatus | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const load = () => void readProfile(client).then((s) => live && setStatus(s));
    load();
    listeners.add(load);
    return () => {
      live = false;
      listeners.delete(load);
    };
  }, [client]);
  return status;
}

/** Signed in to Caveman Cloud, and the runtime serves the trust methods. */
export const cloudOn = (status: ProfileStatus | null): status is ProfileStatus => status !== null && status.state !== "off";

/**
 * The status line for a row: by `path` for a home skill (folders of one name
 * can fare differently), else by id. `null`: this runtime cannot say (it
 * names no skill paths: a Cloud computer, or an older runtime).
 */
export function profileItemFor(status: ProfileStatus, kind: ProfileItem["kind"], ids: ReadonlyArray<string | undefined>, path?: string): ProfileItem | undefined | null {
  if (path !== undefined && !status.items.some((i) => i.path !== undefined)) return null;
  return status.items.find((i) => i.kind === kind && (path === undefined ? ids.includes(i.id) : i.path === path));
}

/** What an item's badge says. `runs` claims only what This Mac checked: a server's start shows when it lists its tools on a computer. */
export function profileItemView(item: ProfileItem): { tone: "green" | "yellow" | "neutral"; label: string; title: string } {
  // A skill that goes without some of its files, or one of several of its name.
  if (item.cloud === "runs" && item.reason) return { tone: "yellow", label: `Partly in Cloud — ${item.reason}`, title: item.reason };
  if (item.cloud === "runs" && item.kind === "server")
    return { tone: "green", label: "Synced to Cloud", title: "Your Cloud computers get this server and have the program it starts. List its tools on one to check it starts there." };
  if (item.cloud === "runs") return { tone: "green", label: "Works in Cloud", title: "Your Cloud computers load this too." };
  const reason = item.reason ?? (item.cloud === "needs_runtime" ? "Cloud computers lack the program it runs" : `it needs ${thisComputer}`);
  // Kept on there, so it starts once the computer has what it needs.
  if (item.cloud === "needs_runtime") return { tone: "yellow", label: `Needs setup in Cloud — ${reason}`, title: `Your Cloud computers get it, but ${reason}.` };
  return { tone: "neutral", label: `${THIS_COMPUTER} only — ${reason}`, title: `${THIS_COMPUTER} only: ${reason}` };
}

/**
 * A row's Cloud badge for a plugin, server or skill: whether your Cloud
 * computers get it. Nothing when Cloud is off.
 */
export function CloudBadge({ kind, ids, keysOff, path }: { kind: ProfileItem["kind"]; ids: ReadonlyArray<string | undefined>; keysOff?: boolean; path?: string }) {
  const status = useProfileStatus();
  if (!cloudOn(status)) return null;
  const item = profileItemFor(status, kind, ids, path);
  if (item === null) return null;
  if (status.state === "paused") return <Tag tone="neutral" title={`${PAUSED_TEXT} Sync again in Settings > Account.`}>Removed from Cloud</Tag>;
  if (item === undefined || status.state === "pending")
    return <Tag tone="neutral" title="Caveman does not have it yet. It goes up with the next sync of your settings.">Not synced yet</Tag>;
  if (item.cloud === "runs" && keysOff)
    return <Tag tone="neutral" title="It starts on your Cloud computers without its keys. Turn on Available on Cloud computers to send them.">In Cloud without its keys</Tag>;
  const view = profileItemView(item);
  return (
    <Tag tone={view.tone} title={view.title} className="max-w-[320px]">
      {view.label}
    </Tag>
  );
}

/** Your settings were removed from Caveman Cloud (here, in the console or on another computer). */
export const PAUSED_TEXT = "Removed from Caveman, so your settings no longer sync and your Cloud computers start without them.";

export interface ConnectorCloud {
  readonly status?: string | undefined;
  readonly problem?: string | undefined;
  readonly held_by?: string | undefined;
  readonly held_reason?: string | undefined;
  readonly auth?: string | undefined;
}

/** What a connector's Cloud badge says, and whether it offers Move to Cloud (a sign-in this Mac made before linking). */
export function connectorCloudView(c: ConnectorCloud, item?: ProfileItem): { tone: "green" | "yellow" | "neutral"; label: string; title: string; move: boolean } | null {
  // Authentication is not reachability: a loopback/private endpoint stays
  // Mac-only or needs setup even before its OAuth sign-in is complete.
  if (item !== undefined && item.cloud !== "runs") return { ...profileItemView(item), move: false };
  if (c.status === "needs_sign_in" && c.problem) return { tone: "yellow", label: "Reconnect", title: c.problem, move: false };
  if (c.held_reason && (c.status === "connected" || c.status === "signing_in")) return { tone: "neutral", label: `${THIS_COMPUTER} only — Cloud can't sign in to it`, title: c.held_reason, move: false };
  if (c.status !== "connected") return null;
  if (c.held_by === "cloud") return { tone: "green", label: "Sign-in on Cloud", title: "Caveman holds this sign-in. Use List its tools on the computer to check that the server starts there.", move: false };
  if (c.auth === "github")
    return { tone: "neutral", label: `${THIS_COMPUTER} only — its GitHub login`, title: `${THIS_COMPUTER}'s own GitHub login (gh or GH_TOKEN). Your Cloud computers use the GitHub login you connect through Caveman.`, move: false };
  return {
    tone: "neutral",
    label: `${THIS_COMPUTER} only — signed in before Cloud`,
    title: `Signed in on ${thisComputer} before you signed in to Caveman, so your Cloud computers can't use it. Move it to Cloud: you sign in once more, Caveman keeps the sign-in, and ${thisComputer} forgets its copy.`,
    move: c.held_by === "this_computer",
  };
}

/**
 * A connector's or signed-in server's badge, and its one-click Move to Cloud. Nothing when Cloud is off. Cloud's
 * sign-in page opens in the click (openSoon), as a browser blocks a tab opened after the call, and stays a link
 * while the sign-in is under way.
 */
export function ConnectorCloudBadge({ id, onChanged, ...c }: ConnectorCloud & { id?: string; onChanged?: () => void }) {
  const { client } = useRuntimeClient();
  const profile = useProfileStatus();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  if (!cloudOn(profile)) return null;
  const item = id ? profileItemFor(profile, "server", [id]) : undefined;
  const view = connectorCloudView(c, item ?? undefined);
  // Until Cloud holds the sign-in, the list says signing_in (or, read before the move answered, still offers it).
  const pending = page !== null && (c.status === "signing_in" || view?.move === true) ? page : null;
  if (view === null && pending === null) return null;
  const move = async () => {
    if (!client || !id) return;
    const go = openSoon();
    setMoving(true);
    setError(null);
    try {
      const r = await client.call("connector.connect", { request_id: requestId(), id, move_to_cloud: true });
      go(r.authorization_url);
      setPage(r.authorization_url ?? null);
      if (r.problem) setError(r.problem);
    } catch (e) {
      go(null);
      setError(errorText(e));
    } finally {
      setMoving(false);
      onChanged?.();
    }
  };
  return (
    <>
      {view ? (
        <Tag tone={view.tone} title={view.title} className="max-w-[320px]">
          {view.label}
        </Tag>
      ) : null}
      {pending ? (
        <Button asChild size="sm" variant="secondary">
          <a href={pending} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
        </Button>
      ) : view?.move && client && id ? (
        <Button size="sm" variant="secondary" disabled={moving} title={error ?? view.title} onClick={() => void move()}>
          {moving ? "Opening sign-in…" : "Move to Cloud"}
        </Button>
      ) : null}
      {error ? <span role="alert" className="max-w-[240px] truncate text-[12px] text-destructive" title={error}>{error}</span> : null}
    </>
  );
}

/** Under a connector signed in on This Mac because Cloud can't: the one sentence why. */
export function ConnectorCloudNote({ reason }: { reason?: string | undefined }) {
  const profile = useProfileStatus();
  if (!cloudOn(profile) || !reason) return null;
  return <p className="mb-2 text-[12px] text-muted-foreground">{reason}</p>;
}

/**
 * "Available on Cloud computers": the one switch that lets secret values leave
 * This Mac, for one repository or one server. Turning it on asks first and
 * names every value; turning it off deletes Cloud's copy at once.
 */
export function CloudAvailableSwitch(props: {
  readonly target: "repository" | "server";
  readonly owner: string;
  readonly names: ReadonlyArray<string>;
  readonly available: boolean;
  /** While off: the names Cloud holds all the same, sent one by one (Add from this Mac, Add value). */
  readonly held?: ReadonlyArray<string>;
  /** Server keys on a Cloud computer whose servers run beside your agents' commands. */
  readonly shared?: boolean;
  readonly onSet: (available: boolean) => Promise<void>;
}) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = props.target === "repository" ? "the commands your agents run in this repository" : serverKeysWhere(props.owner, props.shared === true);
  const held = props.held ?? [];
  const set = async (available: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await props.onSet(available);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="min-w-0 flex-1 text-[13px]">
          Available on Cloud computers
          <span className="block text-[12.5px] text-muted-foreground">
            {props.available
              ? `Caveman keeps an encrypted copy of ${nameList(props.names)}. Only your own Cloud computers read it, into ${where}. Turn this off to delete Caveman's copy.`
              : held.length > 0
                ? `Caveman keeps an encrypted copy of ${nameList(held)}, added one by one. Only your own Cloud computers read it, into ${where}. ${props.names.some((n) => !held.includes(n)) ? "The other values stay" : "Values you add later stay"} on ${thisComputer}. Delete Caveman's copy in Settings > Account.`
                : `Off: the values stay on ${thisComputer}. Cloud computers start without them.`}
          </span>
        </label>
        <Switch id={id} checked={props.available} disabled={busy || (props.names.length === 0 && !props.available)} onCheckedChange={(on) => (on ? setAsking(true) : void set(false))} />
      </div>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      <UseOnCloudDialog
        open={asking}
        names={props.names}
        title={props.target === "repository" ? "Use these secrets on your Cloud computers?" : `Use ${props.owner}'s keys on your Cloud computers?`}
        where={where}
        onAnswer={(yes) => {
          setAsking(false);
          if (yes) void set(true);
        }}
      />
    </div>
  );
}

/** Where a server's keys go on a Cloud computer, and who else there can read them (I1: servers run as their own user). */
export const serverKeysWhere = (owner: string, shared: boolean) =>
  shared
    ? `the ${owner} server's process; commands your agents run on that computer can read them too`
    : `the ${owner} server's process, which runs as its own user there, apart from the commands your agents run`;

const nameList = (names: ReadonlyArray<string>) => (names.length === 0 ? "no values yet" : names.length <= 4 ? names.join(", ") : `${names.slice(0, 4).join(", ")} and ${names.length - 4} more`);

function UseOnCloudDialog(props: { open: boolean; names: ReadonlyArray<string>; title: string; lead?: string; where: string; onAnswer: (yes: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onAnswer(false)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            {props.lead ? `${props.lead} ` : null}Caveman will keep an encrypted copy of {props.names.length === 1 ? "this value" : `these ${props.names.length} values`}, sealed with its key service. Only
            your own Cloud computers can read them, into {props.where}, and every read shows in Settings &gt; Account. Turn it off any time to delete Caveman's copy.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-wrap gap-1.5 px-1">
          {props.names.map((n) => (
            <li key={n} className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[12px]">
              {n}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => props.onAnswer(false)}>
            Not now
          </Button>
          <Button size="sm" onClick={() => props.onAnswer(true)}>
            Use on Cloud
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a repository's secret.list answer says Cloud holds: all its values, or `held`, the stored names sent one by one. */
export interface RepoOnCloud {
  readonly available: boolean;
  readonly held: ReadonlyArray<string>;
}
export const repoOnCloud = (list: { readonly cloud_available?: boolean | undefined; readonly cloud_names?: ReadonlyArray<string> | undefined }): RepoOnCloud => ({
  available: list.cloud_available === true,
  held: list.cloud_names ?? [],
});

/**
 * Settings > Secrets: the repository's switch. Only while signed in to Cloud. `names` and `onCloud` come from one
 * secret.list answer, and `reload` reads it again: Cloud follows every value stored or deleted here.
 */
export function RepoCloudSecrets({ repo, names, onCloud, reload }: { repo: Repo; names: ReadonlyArray<string>; onCloud: RepoOnCloud | null; reload: () => Promise<void> }) {
  const { client } = useRuntimeClient();
  const status = useProfileStatus();
  if (!client || !cloudOn(status) || onCloud === null) return null;
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <CloudAvailableSwitch
        target="repository"
        owner={JSON.stringify(repo)}
        names={names}
        available={onCloud.available}
        held={onCloud.held}
        onSet={async (on) => {
          await trustCall(client, "cloud.secrets.set_available", { request_id: requestId(), repo, available: on });
          refreshProfile(client);
          await reload();
        }}
      />
    </section>
  );
}

/** A personal server's typed keys on Cloud computers. Only while signed in to Cloud and the server has a granted key. */
export function ServerCloudKeys({ server, onChanged }: { server: { readonly name: string; readonly credentials: ReadonlyArray<{ readonly name: string; readonly granted: boolean }> }; onChanged: () => Promise<void> }) {
  const { client } = useRuntimeClient();
  const status = useProfileStatus();
  const granted = server.credentials.filter((c) => c.granted).map((c) => c.name);
  const available = (server as { cloud_available?: boolean }).cloud_available === true;
  if (!client || !cloudOn(status) || (granted.length === 0 && !available)) return null;
  return (
    <div className="mb-2 rounded-lg bg-secondary/40 px-3 py-2">
      <CloudAvailableSwitch
        target="server"
        owner={server.name}
        names={granted}
        available={available}
        shared={status.server_keys_shared === true}
        onSet={async (on) => {
          await trustCall(client, "cloud.server.set_available", { request_id: requestId(), name: server.name, available: on });
          refreshProfile(client);
          await onChanged();
        }}
      />
    </div>
  );
}

/**
 * Sends a repository's secrets to Cloud after the person said yes. Never throws:
 * a refusal is what to tell them, and the workspace starts without the secrets.
 */
export async function optInRepository(client: Pick<Client, "call">, repo: Repo): Promise<string | undefined> {
  try {
    await trustCall(client as Client, "cloud.secrets.set_available", { request_id: requestId(), repo, available: true });
    return undefined;
  } catch (e) {
    return errorText(e);
  }
}

/**
 * The moment of need: starting a Cloud workspace on a repository whose secrets
 * are on This Mac only. `ask` resolves once you answered (or at once when there
 * is nothing to ask), and never fails the start: if Cloud refuses the secrets
 * it says so and the workspace starts without them. `answered` names the person
 * already added or skipped for this start (the setup card's missing values):
 * they are not asked about again, nor are values Cloud already holds, sent
 * one by one. Render `dialog`.
 */
export function useUseOnCloudPrompt(): { ask: (repo: Repo, answered?: ReadonlyArray<string>) => Promise<void>; dialog: ReactNode } {
  const { client } = useRuntimeClient();
  const status = useProfileStatus();
  const [asking, setAsking] = useState<{ repo: Repo; names: ReadonlyArray<string> } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const answer = useRef<((yes: boolean) => void) | null>(null);
  const ask = useCallback(
    async (repo: Repo, answered: ReadonlyArray<string> = []) => {
      if (!client || !cloudOn(status)) return;
      const list = await client.call("secret.list", { repo }).catch(() => null);
      if (list === null) return;
      const onCloud = repoOnCloud(list);
      if (onCloud.available) return;
      const names = list.secrets.map((s) => s.name).filter((n) => !answered.includes(n) && !onCloud.held.includes(n));
      if (names.length === 0) return;
      const yes = await new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setAsking({ repo, names });
      });
      setAsking(null);
      if (!yes) return;
      const problem = await optInRepository(client, repo);
      if (problem === undefined) return;
      await new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setFailed(problem);
      });
      setFailed(null);
    },
    [client, status],
  );
  const dialog = (
    <>
      <UseOnCloudDialog
        open={asking !== null}
        names={asking?.names ?? []}
        title={`This repository has ${asking?.names.length ?? 0} ${asking?.names.length === 1 ? "secret" : "secrets"} on ${thisComputer}`}
        lead="Use them on the Cloud computer? Without them, commands that need them fail there."
        where="the commands your agents run in this repository"
        onAnswer={(yes) => answer.current?.(yes)}
      />
      <Dialog open={failed !== null} onOpenChange={(open) => !open && answer.current?.(false)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Caveman did not take the secrets</DialogTitle>
            <DialogDescription>
              {failed} The values stay on {thisComputer} and the workspace starts without them; turn them on later in Settings &gt; Secrets.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" onClick={() => answer.current?.(true)}>
              Start without them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return { ask, dialog };
}

/**
 * Signing out of Caveman Cloud asks whether Cloud should also delete what it
 * holds for you (default yes). `open()` shows it; render `dialog`.
 */
export function useUnlinkConfirm(signOut: (deleteCloudCopies: boolean) => Promise<void>): { open: () => void; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [wipe, setWipe] = useState(true);
  const id = useId();
  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Sign this computer out of Caveman?</DialogTitle>
          <DialogDescription>Remote control stops, and nothing more syncs from this computer. Everything on this computer stays as it is.</DialogDescription>
        </DialogHeader>
        <label htmlFor={id} className="flex items-start gap-2.5 px-1 text-[13px]">
          <Checkbox id={id} checked={wipe} onCheckedChange={(v) => setWipe(v === true)} className="mt-0.5" />
          <span>
            Also delete what Caveman holds for you
            <span className="block text-[12.5px] text-muted-foreground">Your synced settings, the secrets and server keys you turned on, and Caveman's connector sign-ins.</span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setOpen(false);
              void signOut(wipe);
            }}
          >
            Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return {
    open: () => {
      setWipe(true);
      setOpen(true);
    },
    dialog,
  };
}
