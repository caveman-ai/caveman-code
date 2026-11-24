// Settings > Models & keys, "sign in once": the rows of an agent's plans and keys that work everywhere (kept in
// Caveman Cloud), connecting a plan, and what a page with no Mac app behind it shows in its place.
// The words and the states are connections-model.ts; the runtime's side is the Session Protocol's "Sign in once".
import type { EngineAccount, EngineDescriptor } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { Input } from "@caveman-app/ui/components/input";
import { VendorMark } from "@caveman-app/ui/components/model-picker";
import { Icon, DragDropVerticalIcon, MoreHorizontalIcon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { thisComputer } from "../../lib/platform.ts";
import {
  requestId,
  useConnectionsCloud,
  useRuntimeClient,
  useRuntimeSelector,
} from "../../state/runtime.tsx";
import type { CloudConnectionList } from "../../state/sync/model-connections.ts";
import {
  accountsFromCloud,
  agentStatus,
  asksClaudeToken,
  canUseFirst,
  cloudIdOf,
  connectingLine,
  connectionsOf,
  connectionState,
  CODE_NOT_TAKEN,
  enterCode,
  MANAGE,
  PASTE_CODE,
  PASTE_CODE_LABEL,
  planOf,
  planOffer,
  removeEverywhere,
  saysFromMac,
  SIGN_IN_PAGE,
  whereLabel,
  type ConnectionState,
  type PlanEngine,
} from "./connections-model.ts";
import { SettingRow } from "./rows.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A wait the runtime answers at once is asked again no sooner than this. */
const WAIT_AGAIN_MS = 2_000;
/** A sign-in is given this long (the runtime ends its own after a quarter of an hour). */
const GIVE_UP_MS = 16 * 60_000;
export const TOOK_TOO_LONG = "The sign-in was not approved in time.";

/** The time, read again every `everyMs`: a state that names a time ("Expires in 5 days") stays true while the page is open. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

const TONE: Record<ConnectionState["tone"], string> = {
  ok: "",
  warn: "text-warning",
  bad: "text-destructive",
  quiet: "",
};

/** Where a plan, key or login works and, for one that needs the person, the state it is in: the grey line under its name. */
export function AccountPlace({
  account,
  now,
  extra,
}: {
  account: EngineAccount;
  now: number;
  extra?: ReactNode;
}) {
  const state = account.connection ? connectionState(account.connection, now) : undefined;
  // A kind the admin turned off works nowhere: the row says only that.
  const where = state?.is === "off" ? undefined : whereLabel(account.where);
  const said = state?.text ? state : undefined;
  if (where === undefined && said === undefined && !extra) return null;
  return (
    <span className="block truncate">
      {where}
      {said ? (
        <>
          {where ? " · " : null}
          <span className={TONE[said.tone]}>{said.text}</span>
        </>
      ) : null}
      {extra ? (
        <>
          {where || said ? " · " : null}
          {extra}
        </>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------ connecting a plan
//
// A plan's sign-in is the runtime's state (EngineDescriptor.auth.connecting): every window of the computer draws it,
// and only the window that started it can end it. What this window started is kept here, outside any component, so
// the agent's row, the lid's list and a chat's card all know it is theirs and none of them ends it by closing.

type Mine = {
  readonly requestId: string;
  readonly at: "starting" | "waiting";
  readonly url?: string | undefined;
  readonly code?: string | undefined;
};
type Ended = { readonly at: "failed"; readonly why: string };
const started = new Map<string, Mine | Ended>();
const watchers = new Set<() => void>();
const keep = (engine: string, value: Mine | Ended | undefined) => {
  if (value === undefined) started.delete(engine);
  else started.set(engine, value);
  for (const watcher of watchers) watcher();
};
const watch = (watcher: () => void) => (watchers.add(watcher), () => void watchers.delete(watcher));
/** Forgets every sign-in this window started, as a reload does: for tests, which share the module. */
export const forgetConnects = () => {
  started.clear();
  for (const watcher of watchers) watcher();
};

export interface ConnectOptions {
  /** Codex: a code typed on its page, for a browser that cannot reach this computer. */
  readonly deviceCode?: boolean;
  /** A Claude plan that ends, connected again: the old one goes once the new one is kept. */
  readonly replaces?: EngineAccount | undefined;
  /** This window's own open sign-in is started over (with a code, say): the runtime ends it and starts this one in its place. */
  readonly restart?: boolean;
}

/**
 * Runs one sign-in to its end: the runtime starts the official CLI's own (engine.account.add `everywhere`), which opens
 * the provider's page in the browser, and this waits for the person's approval there (engine.account.complete).
 * Nothing is typed or pasted, unless Claude's page shows a code (Connect.paste).
 */
async function connect(
  engine: EngineDescriptor["id"],
  client: Client,
  refresh: () => Promise<void>,
  options: ConnectOptions,
  restarts?: string,
) {
  const id = requestId();
  const mine = () => {
    const now = started.get(engine);
    return now !== undefined && now.at !== "failed" && now.requestId === id;
  };
  keep(engine, { requestId: id, at: "starting" });
  try {
    // `connecting`: the open sign-in this one takes the place of, named by the request that started it (this window's).
    const res = await client.call("engine.account.add", {
      request_id: id,
      engine,
      everywhere: true,
      ...(engine === "codex" ? { chatgpt: true } : {}),
      ...(options.deviceCode ? { device_code: true } : {}),
      ...(restarts ? { connecting: restarts } : {}),
    });
    if (!mine()) return;
    keep(engine, { requestId: id, at: "waiting", url: res.sign_in?.url, code: res.sign_in?.code });
    void refresh().catch(() => undefined);
    const until = Date.now() + GIVE_UP_MS;
    for (;;) {
      const asked = Date.now();
      const answer = await client.call(
        "engine.account.complete",
        { request_id: requestId(), engine, account_id: "connecting", callback_url: "" },
        { timeoutMs: 120_000 },
      );
      if (!mine()) return;
      if (answer.waiting !== true) break;
      if (Date.now() > until) throw new Error(TOOK_TOO_LONG);
      const again = WAIT_AGAIN_MS - (Date.now() - asked);
      if (again > 0) await new Promise((resolve) => setTimeout(resolve, again));
      if (!mine()) return;
    }
 // A Claude plan connected again is a plan of its own: the one it replaces goes. (compact takes its account's place by itself.)
    if (options.replaces?.connection?.kind === "claude_plan") {
      await client
        .call("engine.account.remove", {
          request_id: requestId(),
          engine,
          account_id: options.replaces.id,
        })
        .catch(() => undefined);
    }
    keep(engine, undefined);
    await refresh().catch(() => undefined);
  } catch (e) {
    if (mine()) keep(engine, { at: "failed", why: message(e) });
    void refresh().catch(() => undefined);
  }
}

/**
 * Starts an agent's plan sign-in from anywhere (onboarding's Continue). Nothing while one of this window's is open,
 * unless it is to be started over (`restart`).
 */
export function startConnect(
  engine: EngineDescriptor["id"],
  client: Client,
  refresh: () => Promise<void>,
  options: ConnectOptions = {},
): void {
  const now = started.get(engine);
  const open = now !== undefined && now.at !== "failed" ? now : undefined;
  if (open !== undefined && options.restart !== true) return;
  void connect(engine, client, refresh, options, open?.requestId);
}

export interface Connect {
  /** A sign-in of this agent's plan is open on its computer, whoever started it. */
  readonly pending: boolean;
  /** This window started it: only it may cancel. */
  readonly mine: boolean;
  /** When it started, as the runtime says it. */
  readonly since: string | undefined;
  /** The provider's page, and Codex's code: this window's own sign-in only. */
  readonly url: string | undefined;
  readonly code: string | undefined;
  /** How this window's last sign-in ended, until its next. */
  readonly failed: string | undefined;
  readonly start: (options?: ConnectOptions) => void;
  /** Ends this window's own sign-in. Nothing else does: not Escape, not leaving the page. */
  readonly cancel: () => void;
  /**
   * Claude: the code its page shows when it cannot hand the sign-in back to this computer, typed into the CLI by the
   * runtime. Taken, the sign-in's own wait ends the line. Not taken, this rejects with why, and the line links to the
   * new page claude started over on.
   */
  readonly paste: (code: string) => Promise<void>;
}

/** One agent's plan sign-in as this window sees it. `client`: the runtime of the computer the sign-in is made on. */
export function useConnect(
  engine: Pick<EngineDescriptor, "id" | "auth"> | undefined,
  client: Client | null,
  refresh: () => Promise<void>,
): Connect {
  const id = engine?.id;
  const local = useSyncExternalStore(
    watch,
    () => (id === undefined ? undefined : started.get(id)),
    () => undefined,
  );
  const published = engine?.auth.connecting;
  const own = local !== undefined && local.at !== "failed" ? local : undefined;
  // Its add was answered with a sign-in another window had already started: that one is not this window's to end.
  const self =
    own !== undefined && (published === undefined || published.request_id === own.requestId)
      ? own
      : undefined;
  return {
    pending: published !== undefined || own !== undefined,
    mine: self !== undefined,
    since: published?.since,
    url: self?.url,
    code: self?.code,
    failed: local?.at === "failed" ? local.why : undefined,
    start: (options = {}) => {
      if (id !== undefined && client !== null) startConnect(id, client, refresh, options);
    },
    cancel: () => {
      const now = id === undefined ? undefined : started.get(id);
      if (id === undefined || now === undefined || now.at === "failed") return;
      keep(id, undefined);
      // Named by the request that started it: the runtime ends no one else's.
      void client
        ?.call("engine.account.remove", {
          request_id: requestId(),
          engine: id,
          account_id: `connecting:${now.requestId}`,
        })
        .catch(() => undefined)
        .then(() => refresh().catch(() => undefined));
    },
    paste: async (code) => {
      if (id === undefined || client === null) return;
      const answer = await client.call(
        "engine.account.complete",
        { request_id: requestId(), engine: id, account_id: "connecting", callback_url: code },
        { timeoutMs: 120_000 },
      );
      if (answer.waiting !== true) return;
      // Still waiting after a code is a code claude did not take. When it started over, only its new page gives one.
      const now = started.get(id);
      if (answer.url !== undefined && now !== undefined && now.at !== "failed")
        keep(id, { ...now, url: answer.url });
      throw new Error(answer.refused ?? CODE_NOT_TAKEN);
    },
  };
}

/**
 * Connects an agent's plan for every computer, from anywhere in the app (a card in a chat, New chat, the lid's
 * consent): the one sign-in Settings > Models & keys starts, on this window's own computer, never a chat's.
 * `useConnectAgent("claude-agent").start()` opens the provider's page in the browser; `pending`, `mine`, `failed`
 * and `cancel` say and end it, and `<Connecting connect={...} />` is its one line while it waits.
 */
export function useConnectAgent(engine: EngineDescriptor["id"]): Connect {
  const home = useRuntimeSelector((v) => v.client);
  const here = useRuntimeSelector((v) => v.engines).find((e) => e.id === engine);
  const refresh = useRuntimeSelector((v) => v.refresh);
  return useConnect(here, home, refresh);
}

/** How often a page with no computer behind it reads Cloud's list again: a plan connected from the Mac app shows by itself. */
const CLOUD_LIST_MS = 4_000;

/**
 * The person's plans and keys as Cloud itself lists them, kept fresh while `enabled`: what a browser window with no
 * computer behind it reads (Settings > Models & keys, and New chat before Send). `list` is null until Cloud answers;
 * `failed`: its last read did not.
 */
export function useCloudConnectionList(enabled = true): {
  readonly list: CloudConnectionList | null;
  readonly failed: boolean;
} {
  const cloud = useConnectionsCloud();
  const [list, setList] = useState<CloudConnectionList | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!cloud || !enabled) return;
    let live = true;
    const read = () =>
      cloud.list().then(
        (next) => live && (setList(next), setFailed(false)),
        () => live && setFailed(true),
      );
    void read();
    const timer = setInterval(() => void read(), CLOUD_LIST_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [cloud, enabled]);
  return { list, failed: failed || (enabled && !cloud) };
}

const FOCUS = "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A sign-in in progress, in one line: where to approve it and for how long it has waited, then, in the window that
 * started it, the page as a link (a browser that did not open by itself) and Cancel. Claude's page opened from that
 * link cannot hand the sign-in back to this computer and shows a code instead: the field under the line takes it.
 */
export function Connecting({
  connect,
  codex = false,
  here = thisComputer,
}: {
  connect: Connect;
  codex?: boolean;
  here?: string;
}) {
  const now = useNow(1_000);
  const since = connect.since === undefined ? Number.NaN : Date.parse(connect.since);
  const waited = Number.isFinite(since)
    ? Math.max(0, Math.round((now - since) / 1_000))
    : undefined;
  const line = (
    <span role="status" className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="min-w-0 break-words">
        {connect.code ? enterCode(connect.code) : connectingLine(here)}
      </span>
      {waited !== undefined ? (
        <span className="tabular-nums">
          {waited < 60 ? `${waited}s` : `${Math.floor(waited / 60)}m ${waited % 60}s`}
        </span>
      ) : null}
      {connect.url ? (
        <a
          href={connect.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(FOCUS, "text-foreground underline underline-offset-2")}
        >
          {SIGN_IN_PAGE}
        </a>
      ) : null}
      {connect.mine && codex && !connect.code ? (
        <button
          type="button"
          className={cn(FOCUS, "text-foreground underline underline-offset-2")}
          // Its own sign-in is started over with a code: one call, so no other window's can slip in between.
          onClick={() => connect.start({ deviceCode: true, restart: true })}
        >
          Use a code instead
        </button>
      ) : null}
    </span>
  );
  return connect.mine && connect.url && !codex ? (
    <>
      {line}
      <PasteCode connect={connect} />
    </>
  ) : (
    line
  );
}

/**
 * The code Claude's page shows, pasted under the line: Enter or Finish sends it (no form, as the line sits in
 * phrasing content). The field never keeps it. A code the runtime refuses says why, and the sign-in keeps waiting.
 */
function PasteCode({ connect }: { connect: Connect }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = () => {
    const value = code.trim();
    if (value === "" || busy) return;
    setCode("");
    setBusy(true);
    setError(null);
    connect
      .paste(value)
      .catch((e: unknown) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="mt-1.5 flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-2">
        <Input
          type="text"
          aria-label={PASTE_CODE_LABEL}
          placeholder={PASTE_CODE}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            finish();
          }}
          className="h-7 min-w-0 max-w-80 flex-1 font-mono text-[12.5px] placeholder:font-sans"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || code.trim() === ""}
          onClick={finish}
        >
          {busy ? "Signing in…" : "Finish"}
        </Button>
      </span>
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** How long a Cloud computer's runtime reuses one read of the list: a page that wrote to Cloud itself shows Cloud's answer that long. */
const RUNTIME_LIST_MS = 5_500;

/**
 * What can be done to an agent's plans and keys from this page, and through what. On this computer's own runtime:
 * engine.account.*. On a Cloud computer, whose runtime changes none (EngineDescriptor.auth.everywhere `manage`):
 * Cloud's own routes on the person's Cloud session, where this device holds one. `shown`: Cloud's answer to such a
 * write, in place of the runtime's list until the runtime has read it again.
 */
export type ConnectionWrites = ReturnType<typeof useConnectionWrites>;
export function useConnectionWrites(engine: EngineDescriptor) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const cloud = useConnectionsCloud();
  const viaCloud = engine.auth.everywhere === "manage" || engine.auth.no_sign_in_here === true;
  const [shown, setShown] = useState<ReadonlyArray<EngineAccount> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const listed = engine.auth.accounts;
  const wrote = useCallback(
    async (list: CloudConnectionList) => {
      setShown(accountsFromCloud(list, engine.id, listed));
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => void refresh().finally(() => setShown(null)),
        RUNTIME_LIST_MS,
      );
      await refresh();
    },
    [engine.id, listed, refresh],
  );
  const call = (action: (c: Client) => Promise<unknown>) =>
    client ? action(client).then(() => refresh()) : Promise.resolve();
  const moveToTop = (account: EngineAccount) =>
    viaCloud
      ? cloud!.moveToTop(cloudIdOf(account.id)).then(wrote)
      : call((c) =>
          c.call("engine.account.activate", {
            request_id: requestId(),
            engine: engine.id,
            account_id: account.id,
          }),
        );
  const connections = shown ?? connectionsOf(engine.auth.accounts);
  return {
    /** Nothing here can change a plan or key: the page says where that is done. */
    readOnly: viaCloud && cloud === null,
    /** The agent's plans and keys as the page shows them now. */
    connections,
    moveToTop,
    /** The order after a drag: each one that moved goes to the top in turn, the last of them first. */
    order: async (ids: ReadonlyArray<string>) => {
      for (const id of moves(
        connections.map((a) => a.id),
        ids,
      )) {
        const account = connections.find((a) => a.id === id);
        if (account) await moveToTop(account);
      }
    },
    remove: (account: EngineAccount) =>
      viaCloud
        ? cloud!.remove(cloudIdOf(account.id)).then(wrote)
        : call((c) =>
            c.call("engine.account.remove", {
              request_id: requestId(),
              engine: engine.id,
              account_id: account.id,
            }),
          ),
    /** A page with no Mac app: a Claude plan from the line `claude setup-token` printed. */
    addClaudeToken: (token: string) => cloud!.addClaudePlan(token).then(wrote),
  };
}

/**
 * The plans and keys to send to the top, in turn, so the order `from` becomes `to`: the runtime moves one to the top
 * at a time. One moved to the top is one move; anything else replays the part of the new order that changed, its
 * last first.
 */
export function moves(
  from: ReadonlyArray<string>,
  to: ReadonlyArray<string>,
): ReadonlyArray<string> {
  let last = to.length - 1;
  while (last >= 0 && to[last] === from[last]) last--;
  if (last < 0) return [];
  const top = to[0]!;
  if (from.filter((id) => id !== top).join("\0") === to.slice(1).join("\0")) return [top];
  return to.slice(0, last + 1).reverse();
}

/**
 * An agent's plans and keys as rows, in the order they are tried: name, where it works and its state, then a menu
 * with what can be done: reconnect a plan that ends, move it to the top, remove it everywhere. Dragging a row changes
 * the order. `tag`: the agent's tag field.
 */
export function ConnectionRows({
  engine,
  writes,
  busy,
  run,
  onReconnect,
  tag,
}: {
  engine: EngineDescriptor;
  writes: ConnectionWrites;
  busy: boolean;
  /** Runs one write, with the page's busy and error handling. */
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** Starts the sign-in again for a plan that ends; absent where this page cannot connect one. */
  onReconnect?: ((account: EngineAccount) => void) | undefined;
  tag?: ((account: EngineAccount) => ReactNode) | undefined;
}) {
  const now = useNow();
  const [removing, setRemoving] = useState<EngineAccount | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const confirm = removing ? removeEverywhere(removing.label) : null;
  const ordered = writes.connections.length > 1 && !writes.readOnly;
  const drop = (onto: string) => {
    const from = dragging;
    setDragging(null);
    setOver(null);
    if (from === null || from === onto) return;
    const ids = writes.connections.map((a) => a.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(onto), 0, from);
    void run(() => writes.order(ids));
  };
  return (
    <>
      {writes.connections.map((a) => {
        const state = a.connection ? connectionState(a.connection, now) : undefined;
        const reconnect = state?.reconnect === true && onReconnect !== undefined;
        const top = !writes.readOnly && canUseFirst(writes.connections, a);
        return (
          <div
            key={a.id}
            draggable={ordered && !busy}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              setDragging(a.id);
            }}
            onDragEnd={() => (setDragging(null), setOver(null))}
            onDragOver={(e) => {
              if (dragging === null || dragging === a.id) return;
              e.preventDefault();
              setOver(a.id);
            }}
            onDrop={(e) => (e.preventDefault(), drop(a.id))}
            className={cn(
              "transition-colors duration-75",
              dragging === a.id && "opacity-50",
              over === a.id && "bg-accent/40",
            )}
          >
            <SettingRow
              icon={
                <span className="flex items-center gap-1">
                  {ordered ? (
                    <Icon
                      icon={DragDropVerticalIcon}
                      className="size-3.5 cursor-grab text-[hsl(var(--subtle-foreground))]"
                      aria-hidden
                    />
                  ) : null}
                  <VendorMark engine={engine.id} model={a.provider ? `${a.provider}/` : ""} />
                </span>
              }
              label={
                <span title={a.label} className="block truncate">
                  {a.label}
                </span>
              }
              description={<AccountPlace account={a} now={now} />}
            >
              {tag?.(a)}
              {writes.readOnly && !reconnect ? null : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`${a.label} options`}
                    >
                      <Icon icon={MoreHorizontalIcon} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[200px]">
                    {reconnect ? (
                      <DropdownMenuItem onSelect={() => onReconnect(a)}>Reconnect</DropdownMenuItem>
                    ) : null}
                    {top ? (
                      <DropdownMenuItem onSelect={() => void run(() => writes.moveToTop(a))}>
                        Move to top
                      </DropdownMenuItem>
                    ) : null}
                    {writes.readOnly ? null : (
                      <>
                        {reconnect || top ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuItem onSelect={() => setRemoving(a)}>Remove…</DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </SettingRow>
          </div>
        );
      })}
      {removing && confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setRemoving(null))}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirm}
          destructive
          onConfirm={() => {
            const account = removing;
            setRemoving(null);
            void run(() => writes.remove(account));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * On a page with no Mac app behind it (the web on a Cloud computer), where an agent's plan is not connected: the Mac
 * app is where it is done, in one click; a Claude plan can also be added by the line its own CLI prints, under
 * "No Mac?". Nothing where this page can connect it itself (the agent's own row has that button), nor where that row
 * already says it and there is no token to take.
 */
export function PlanOfferRows({
  engine,
  writes,
  busy,
  run,
}: {
  engine: EngineDescriptor;
  writes: ConnectionWrites;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [noMac, setNoMac] = useState(false);
  const plan = planOf(engine.id);
  if (plan === undefined || planOffer(engine) !== "manage") return null;
  const id = engine.id as PlanEngine;
  if (
    id === "claude-agent"
      ? !asksClaudeToken(writes.connections, Date.now())
      : writes.connections.some((a) => a.connection?.kind === plan.kind)
  )
    return null;
  // The token is taken only where this device holds the person's own Cloud session.
  const paste = id === "claude-agent" && !writes.readOnly;
  // Where the agent's own row already says where it is connected, and there is no token to take: said once.
  if (!paste && saysFromMac(agentStatus(engine, Date.now()))) return null;
  // A plan that ends is there already, on the row above: this one is how it is connected again.
  const again = writes.connections.some((a) => a.connection?.kind === plan.kind);
  return (
    <>
      <SettingRow
        label={again ? MANAGE.againFromMac : plan.name}
        description={again ? undefined : MANAGE.fromMac}
      >
        {paste ? (
          <Button size="sm" variant="ghost" aria-expanded={noMac} onClick={() => setNoMac(!noMac)}>
            {MANAGE.noMac}
          </Button>
        ) : null}
      </SettingRow>
      {paste && noMac ? (
        <SettingRow label={<SetupTokenLine />}>
          <TokenForm busy={busy} onAdd={(token) => run(() => writes.addClaudeToken(token))} />
        </SettingRow>
      ) : null}
    </>
  );
}

/** "Run `claude setup-token` on any computer and paste the token here.", its command in the code face. */
function SetupTokenLine() {
  const [before, command, after] = MANAGE.claudeToken.split("`");
  return (
    <span className="text-[12.5px] text-muted-foreground">
      {before}
      <code className="font-mono">{command}</code>
      {after}
    </span>
  );
}

/** The line `claude setup-token` printed: typed once into a password field, cleared on submit, never kept. */
function TokenForm({ busy, onAdd }: { busy: boolean; onAdd: (token: string) => Promise<void> }) {
  const [token, setToken] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = token.trim();
    // The field never keeps a token, whatever the answer.
    setToken("");
    if (value) void onAdd(value);
  };
  return (
    <form onSubmit={submit} className="flex w-[280px] max-w-full items-center gap-2">
      <Input
        type="password"
        // A token is not a site password: keep browsers and password managers from offering to save it.
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        spellCheck={false}
        aria-label="Claude plan token"
        placeholder="Paste the token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="h-7 min-w-0 flex-1 font-mono placeholder:font-sans"
      />
      <Button type="submit" size="sm" disabled={busy || token.trim() === ""}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}
