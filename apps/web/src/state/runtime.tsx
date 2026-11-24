// The one connection from this client to a Caveman Code runtime, speaking
// Session Protocol v1. The desktop shell hands us the endpoint through its
// preload bridge; in a browser it comes from the link `caveman code` prints
// (?runtime=ws://...#token=...), then from localStorage. Served by Caveman
// Cloud at /code/, the window has no computer of its own and nobody picks one:
// it quietly uses one of the person's runtimes that is on line, through the relay
// on their Cloud session cookie, for what has no place of its own, and none when
// every one sleeps (state/sync/web-window.ts). Beside it, the sync hub (state/sync/hub.ts): Caveman Cloud's list of
// every chat on every computer, a pool of connections to the other runtimes, and each open chat's feed, read from
// whichever source holds it now (its runtime, Cloud's copy, this device's cache).

import type { CavemanDesktop } from "@caveman-app/desktop/bridge";
import { ConnectionClosed, connect, SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import { connectDirect } from "@caveman-app/session-protocol/direct";
import { hasSeveralSources, workspaceSources, type EngineDescriptor, type InboxAction, type Project, type PullRequest, type RuntimeHello, type Settings, type Workspace, type WorkspaceInbox } from "@caveman-app/session-protocol";
import { createContext, use, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { withoutChief } from "./chief-model.ts";
import { applyInbox } from "./inbox-state.ts";
import type { ComputerKind, PullRequestView, WorkspaceState, WorkspaceView } from "./model.ts";
import { adoptFollow, adoptPendingStart, chooseRuntime, chosenRuntime, cloudHosted, isLaptop, listComputers, listRuntimes, pendingStart, relayUrl, runtimeOfComputer, renewSession, resumeComputer, RUNTIME_CHOSEN, seenLabel, type CloudRuntime } from "./cloud.ts";
import { SaveLeftBehind, SettingsSaves, type SettingsPatch } from "./settings-saves.ts";
import { applyWorkspaceChange, catchUpMs, withPushes } from "./workspace-feed.ts";
import { settingsLag } from "../smart-view/settings-lag.ts";
import { SessionModel } from "./transcript.ts";
import type { SessionView } from "./transcript-model.ts";
import { ChatFeed, type FeedSink, type FeedState } from "./sync/chat-feed.ts";
import { latency, reportLatency, type LatencyVia } from "./sync/latency.ts";
import type { ChatListSnapshot } from "./sync/chat-list.ts";
import { mergeChats, noticeable, type MergedView } from "./sync/chats-view.ts";
import { cloudApi, cookieAuth, webPerson, type CloudApi } from "./sync/cloud-api.ts";
import { SyncHub } from "./sync/hub.ts";
import { cloudConnections, type CloudConnections } from "./sync/model-connections.ts";
import { DesktopCloudToken, desktopPerson } from "./sync/desktop-cloud.ts";
import { windowPresence } from "./sync/presence.ts";
import { allowedBefore, deviceAnswers, deviceStatusOf, installDeviceHooks, subscribeDeviceStatus } from "./device-approval.ts";
import { deviceHooks } from "./sync/device-hooks.ts";
import { indexedDbKv } from "./sync/kv.ts";
import { laterOutbox, runtimeOutbox } from "./sync/outbox.ts";
import { thisPage } from "./sync/pages.ts";
import type { PersonStatePatch, RuntimeState } from "./sync/wire.ts";
import { asCloudRuntime, chatPlaces, followed, macHere, quietHome, webWindow, type ChatPlace, type ChatPlaces, type MacHere, type WebWindow } from "./sync/web-window.ts";
import { unseenSessions } from "./unseen.ts";
import { THIS_COMPUTER, thisComputer } from "../lib/platform.ts";
import { firstSkewed, type SkewedRuntime } from "./skew.ts";

declare global {
  interface Window {
    /** The desktop shell's preload bridge: typed by the desktop package (apps/desktop/src/bridge.ts), absent in a browser. */
    cavemanDesktop?: CavemanDesktop;
  }
}

export type ConnectionStatus = "unconfigured" | "connecting" | "connected" | "error";

export interface Identity {
  readonly orgName: string;
  /** The computer this page drives: "This Mac" where the page runs on it, else its name ("Julius's MacBook"). */
  readonly computerName: string;
  /** The same inside a sentence: "this Mac", or the name. */
  readonly computerWord: string;
  /** False while the Cloud-hosted client's computer is off line (a Mac asleep, a Cloud computer suspended). */
  readonly computerOnline: boolean;
  readonly userName: string;
  readonly plan: string | null;
}

export interface RuntimeContextValue {
  readonly status: ConnectionStatus;
  readonly error: string | null;
  readonly client: Client | null;
  readonly identity: Identity;
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly raw: ReadonlyMap<string, Workspace>;
  /** The sidebar's folders (project.list), oldest first. */
  readonly projects: ReadonlyArray<Project>;
  readonly engines: ReadonlyArray<EngineDescriptor>;
  readonly settings: Settings | null;
  readonly refresh: () => Promise<void>;
  /**
   * settings.set, shown at once: `settings` carries the patch before the
   * runtime answers, then the runtime's answer; a refused save takes its patch
   * back and rejects. Absent on fixture runtimes (routes/settings/rows.tsx).
   */
  readonly saveSettings?: (patch: SettingsPatch) => Promise<void>;
  /** The last save that failed, in words, until the next save or Dismiss (Settings' header shows it). */
  readonly settingsSaveError?: string | null;
  readonly setSettingsSaveError?: (message: string | null) => void;
  /**
   * Bumps on every successful (re)open of the socket. Connection-scoped
   * subscriptions (term.attach, screencasts) are gone after a reconnect;
   * surfaces re-establish them when this changes.
   */
  readonly connection: number;
  readonly markSeen: (workspaceId: string) => void;
  /**
   * workspace.inbox, shown at once: the chat's views carry the change (inbox-state.ts applyInbox) until the
   * runtime answers; a refused change is undone and rejects. Absent on fixture runtimes.
   */
  readonly inbox?: (workspaceId: string, action: InboxAction) => Promise<void>;
  /**
   * A workspace a call just returned (workspace.create, session.fork), into the list now: its chat opens without
   * waiting for a poll. Absent on fixture runtimes.
   */
  readonly adopt?: (workspace: Workspace) => void;
}

const STORAGE_KEY = "caveman.runtime";
/** A web window asks Cloud whether it runs computers for this organization this often while in view. */
const CLOUD_ON_EVERY_MS = 60_000;
/** A runtime the relay refused a web window is not tried again for this long, unless Cloud says something new of it. */
const REFUSED_MS = 60_000;
/** What Cloud's list says of a runtime, as one word: a change in it is news. */
const saidOf = (r: RuntimeState | undefined): string => (r ? `${r.online}:${r.computer_state ?? ""}:${r.seq ?? ""}:${r.last_seen_at}` : "");
/**
 * The desktop's last workspace list, engines, settings and projects from its own runtime, painted at launch while the
 * runtime starts and replaced by its first answer. Desktop only: a browser page (Caveman Cloud's) keeps no chat
 * titles in its storage.
 */
const SNAPSHOT_KEY = "caveman.runtime.snapshot";
interface Snapshot {
  readonly workspaces: Workspace[];
  readonly engines: EngineDescriptor[];
  readonly settings: Settings | null;
  readonly projects: Project[];
}
function readSnapshot(): Snapshot | null {
  if (typeof window === "undefined" || !window.cavemanDesktop?.runtime) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "null") as Snapshot | null;
    return parsed && Array.isArray(parsed.workspaces) && Array.isArray(parsed.engines) && Array.isArray(parsed.projects) ? parsed : null;
  } catch {
    return null;
  }
}
function writeSnapshot(snapshot: Snapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full: the next launch waits for the runtime, as before.
  }
}
const SEEN_KEY = "caveman.seen";
/** The pins a window kept before Workspace.inbox.pinned_at; moved to the runtime once and removed. */
const LOCAL_PINS_KEY = "caveman.pinned";
function readLocalPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_PINS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The endpoint in a `caveman code` link: the runtime in the query, the token
 * in the #fragment, which never reaches a server or its logs (older links
 * carried it in the query).
 */
export function linkEndpoint(href: string): { url: string; token: string } | null {
  const link = new URL(href);
  const url = link.searchParams.get("runtime");
  const token = new URLSearchParams(link.hash.slice(1)).get("token") ?? link.searchParams.get("token");
  return url && token ? { url, token } : null;
}

/**
 * Store a link's endpoint, then drop it from the address bar and history. Runs
 * as this module loads, before main.tsx creates the hash router, which would
 * otherwise take #token=... for a route.
 */
export function takeLinkEndpoint(win: Pick<Window, "location" | "history" | "localStorage">): void {
  const endpoint = linkEndpoint(win.location.href);
  if (!endpoint) return;
  win.localStorage.setItem(STORAGE_KEY, JSON.stringify(endpoint));
  const params = new URLSearchParams(win.location.search);
  params.delete("runtime");
  params.delete("token");
  const rest = params.toString();
  win.history.replaceState(null, "", `${win.location.pathname}${rest ? `?${rest}` : ""}`);
}
if (typeof window !== "undefined") takeLinkEndpoint(window);

/** This build is served by Caveman Cloud: runtimes are reached through the relay. */
export const CLOUD_HOSTED = typeof window !== "undefined" && cloudHosted(window.location, window.cavemanDesktop);
// A New workspace link from This Mac (`#start=`): its task waits in this tab for the new Cloud computer.
if (CLOUD_HOSTED) adoptPendingStart(window);
// Open in Cloud from This Mac (`#follow=`): a chat that moved to a Cloud computer opens once that computer is up.
if (CLOUD_HOSTED) adoptFollow(window);

function resolveEndpoint(): { url: string; token: string } | null {
  if (window.cavemanDesktop?.runtime) return window.cavemanDesktop.runtime;
  if (CLOUD_HOSTED) {
    // No bearer: the relay takes the person's Cloud session cookie (same origin).
    const runtime = chosenRuntime(localStorage);
    return runtime ? { url: relayUrl(window.location, runtime.id), token: "" } : null;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { url?: unknown; token?: unknown };
      if (typeof parsed.url === "string" && typeof parsed.token === "string") return { url: parsed.url, token: parsed.token };
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  const envUrl = import.meta.env.VITE_RUNTIME_URL as string | undefined;
  const envToken = import.meta.env.VITE_RUNTIME_TOKEN as string | undefined;
  return envUrl && envToken ? { url: envUrl, token: envToken } : null;
}

export function forgetRuntime(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Exported for the style page, which renders real components on a fixture runtime. */
export const RuntimeContext = createContext<RuntimeContextValue | null>(null);

/**
 * Just the connection, for surfaces that call the runtime but render nothing
 * from the workspace list (terminals, live views): they skip the list's
 * re-renders.
 */
export interface RuntimeClientValue {
  /** Runtime endpoint identity for local UI preferences; never its bearer token. */
  readonly scope?: string | null;
  readonly status: ConnectionStatus;
  readonly client: Client | null;
  readonly connection: number;
  /**
   * The person's Chief may be read on this client (chief.get makes it the first time): false on a Cloud computer a
   * web tab fell back to with nothing picked, and on a chat's own computer (K2). Absent: true (fixtures).
   */
  readonly chiefHere?: boolean;
}
const RuntimeClientContext = createContext<RuntimeClientValue | null>(null);

/**
 * The socket to the runtime right now: open, and whether it ever opened. The
 * client retries on its own and queues calls meanwhile, so without this a
 * refused link or a runtime that went away looked like an empty app.
 */
export interface RuntimeLink {
  readonly open: boolean;
  readonly openedOnce: boolean;
  /**
   * A browser tab's link the runtime turned down: its socket kept failing while the runtime answered on the same
   * address (linkTurnedDown). Retrying the same link can't help; the runtime prints a new one each start.
   */
  readonly refused?: boolean;
}

/** The http(s) address a ws(s) link's runtime answers on, probed when its socket keeps failing. */
export function probeUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  return String(url);
}

/**
 * Whether a link counts as turned down: the socket failed this many times in a row while the runtime answered plain
 * requests. A browser can't read why an upgrade failed (a refused token and no runtime are both 1006), and a runtime
 * that is starting answers before its socket is ready, so one failure is not enough.
 */
export const linkTurnedDown = (failuresWhileAnswering: number) => failuresWhileAnswering >= 3;
// Fixture runtimes (the style page, tests) never lose their link.
const RuntimeLinkContext = createContext<RuntimeLink>({ open: true, openedOnce: true });
export const useRuntimeLink = (): RuntimeLink => useContext(RuntimeLinkContext);

/** This build, as runtime.hello's client_version says it (CAVEMAN_APP_VERSION when the web client was built). */
const CLIENT_VERSION = (import.meta.env.VITE_CAVEMAN_VERSION as string | undefined) ?? "";

// Fixture runtimes speak this client's revision.
const RuntimeSkewContext = createContext<SkewedRuntime | null>(null);
/** The first runtime this window talks to (its own, then the other computers it holds) whose version does not fit. */
export const useRuntimeSkew = (): SkewedRuntime | null => useContext(RuntimeSkewContext);

/** What the shell says while the link is down: nothing when it is open. */
export function linkNotice(link: RuntimeLink, desktop = false): string | null {
  if (link.open) return null;
  // The runtime makes a new link each time it starts: an old one is turned down, never "unreachable".
  if (link.refused) return "This link was turned down: the runtime started again with a new one.";
  if (link.openedOnce) return "Lost the runtime on this computer. Reconnecting…";
  // The desktop app starts its own runtime beside the window: a cold start (migrations) is not an outage.
  return desktop ? "Starting Caveman Code's runtime…" : "Can't reach the runtime on this computer. Reconnecting…";
}

/**
 * The runtime's whole value as a store, beside its context: `useRuntimeSelector` reads one piece of it and re-renders
 * only when that piece changed, where `useRuntime()` re-renders on every push, poll and settings write.
 */
interface RuntimeStore {
  readonly get: () => RuntimeContextValue;
  readonly subscribe: (listener: () => void) => () => void;
}
const RuntimeStoreContext = createContext<RuntimeStore | null>(null);
const fixtureStores = new WeakMap<RuntimeContextValue, RuntimeStore>();
const noUnsubscribe = () => undefined;
/** A fixture runtime (the style page, tests) as a store that never changes. */
function fixtureStore(value: RuntimeContextValue | null): RuntimeStore {
  if (!value) throw new Error("useRuntimeSelector outside RuntimeProvider");
  let store = fixtureStores.get(value);
  if (!store) fixtureStores.set(value, (store = { get: () => value, subscribe: () => noUnsubscribe }));
  return store;
}

/** A fixture value for real components inside the app (the style page's sections): the context and its store. */
export function RuntimeFixture({ value, children }: { value: RuntimeContextValue; children: ReactNode }) {
  return (
    <RuntimeStoreContext.Provider value={fixtureStore(value)}>
      <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
    </RuntimeStoreContext.Provider>
  );
}

/**
 * One piece of the runtime's value (`select`), re-rendering only when it changes (`isEqual`, identity by default):
 * a row that reads its own workspace skips every push about another. The pieces keep their identity while unchanged
 * (workspace views, raw workspaces, engines, projects, settings and the actions).
 */
export function useRuntimeSelector<T>(select: (value: RuntimeContextValue) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  "use no memo";
  const store = useContext(RuntimeStoreContext) ?? fixtureStore(use(RuntimeContext));
  const last = useRef<{ value: RuntimeContextValue; select: (value: RuntimeContextValue) => T; picked: T } | null>(null);
  const get = (): T => {
    const value = store.get();
    const was = last.current;
    if (was && was.value === value && was.select === select) return was.picked;
    const next = select(value);
    const picked = was && isEqual(was.picked, next) ? was.picked : next;
    last.current = { value, select, picked };
    return picked;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

/** The same items in the same order (a selection of workspaces, engines). */
export function sameItems<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
}

/** The latest runtime value without subscribing to it: for handlers and announcements, never for what renders. */
export function useRuntimeGetter(): () => RuntimeContextValue {
  const store = useContext(RuntimeStoreContext) ?? fixtureStore(use(RuntimeContext));
  return store.get;
}

export function useRuntimeClient(): RuntimeClientValue {
  const ctx = useContext(RuntimeClientContext);
  if (ctx) return ctx;
  // Fixture runtimes (the style page, tests) provide only the whole context; `use` may be called conditionally.
  const whole = use(RuntimeContext);
  if (!whole) throw new Error("useRuntimeClient outside RuntimeProvider");
  return whole;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  // The runtime a web window uses can change in place (a chat started in Cloud, a move, its computer asleep): no reload.
  const [endpoint, setEndpoint] = useState(resolveEndpoint);
  /**
   * A web window has no computer of its own. Where nothing in it put it on one (a chat started in Cloud, New chat on a
   * Mac), it quietly uses a runtime of the person's that is on line, by quietHome's rule, for settings, engines and
   * projects; none while every one sleeps. Nobody picks it, nothing is stored, and nothing is woken for it.
   */
  const implicitHome = useRef<string | null>(null);
  /**
   * Runtimes the relay would not connect this window to, with Cloud's word of each then: left alone until Cloud says
   * something new of it, or REFUSED_MS on (the relay may only have been a moment behind), never retried every second.
   */
  const refusedHome = useRef(new Map<string, { readonly said: string; readonly until: number }>());
  const hubNow = useRef<SyncHub | null>(null);
  const quietNow = () => {
    const list = hubNow.current?.list?.get() ?? null;
    for (const [id, was] of refusedHome.current) if (Date.now() >= was.until || saidOf(list?.runtimes.get(id)) !== was.said) refusedHome.current.delete(id);
    return (implicitHome.current = quietHome(list, implicitHome.current, allowedBefore, new Set(refusedHome.current.keys())));
  };
  const endpointNow = () => {
    const chosen = resolveEndpoint();
    if (chosen || !CLOUD_HOSTED) return chosen;
    const quiet = quietNow();
    return quiet ? { url: relayUrl(window.location, quiet), token: "" } : null;
  };
  const followHome = useStableCallback(() =>
    setEndpoint((prev) => {
      const next = endpointNow();
      return prev?.url === next?.url && prev?.token === next?.token ? prev : next;
    }),
  );
  /** The look a refusal asks for once it is old (REFUSED_MS). */
  const lookAgainAt = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    window.addEventListener(RUNTIME_CHOSEN, followHome);
    return () => {
      window.removeEventListener(RUNTIME_CHOSEN, followHome);
      clearTimeout(lookAgainAt.current);
    };
  }, []);
  /** A web window: whether Cloud says someone is signed in here; null until it answers. Always true off the web. */
  const [signedIn, setSignedIn] = useState<boolean | null>(CLOUD_HOSTED ? null : true);
  /** Whether Cloud runs computers for this organization (GET computers' `cloud_computers`); null until it says. */
  const [cloudOn, setCloudOn] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(endpoint ? "connecting" : "unconfigured");
  const [connection, setConnection] = useState(0);
  const [link, setLink] = useState<RuntimeLink>({ open: false, openedOnce: false });
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  /** This window's own runtime's runtime.hello answer (each connection asks again). */
  const [hello, setHello] = useState<RuntimeHello | undefined>(undefined);
  // The desktop paints its last list while its runtime starts (seconds): the sidebar is there at launch.
  const [snapshot] = useState(readSnapshot);
  const [raw, setRaw] = useState<ReadonlyMap<string, Workspace>>(() => new Map(withoutChief(snapshot?.workspaces ?? []).map((w) => [w.id, w])));
  const rawNow = useRef(raw);
  rawNow.current = raw;
  const [engines, setEngines] = useState<ReadonlyArray<EngineDescriptor>>(snapshot?.engines ?? []);
  const [projects, setProjects] = useState<ReadonlyArray<Project>>(snapshot?.projects ?? []);
  const [settings, setSettings] = useState<Settings | null>(snapshot?.settings ?? null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  // The snapshot's Settings are what the runtime last said, as lastPayload takes them: a first poll that reads the
  // same never hands them over again.
  const saves = useRef(new SettingsSaves(snapshot?.settings ?? null));
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const clientRef = useRef<Client | null>(null);
  // The sync hub: Cloud's list of every chat, the other runtimes, each open chat's feed (state/sync/hub.ts).
  const homeRuntimeId = useRef<string | null>(CLOUD_HOSTED ? (chosenRuntime(localStorage)?.id ?? null) : null);
  const [desktopToken] = useState(() => new DesktopCloudToken(() => clientRef.current));
  // Cloud's person routes for computers (Update now): the web tab Cloud serves on its cookie; the desktop on the token
  // its runtime mints from This Mac's sign-in. A page on This Mac's runtime outside the desktop has neither.
  const [computersCloud] = useState<CloudApi | null>(() =>
    CLOUD_HOSTED ? cloudApi(cookieAuth()) : typeof window !== "undefined" && window.cavemanDesktop?.runtime ? cloudApi(desktopToken.auth()) : null,
  );
  // And for the person's connections (sync/model-connections.ts), which a page attached to a Cloud computer changes itself.
  const [connectionsCloud] = useState<CloudConnections | null>(() =>
    CLOUD_HOSTED ? cloudConnections(cookieAuth()) : typeof window !== "undefined" && window.cavemanDesktop?.runtime ? cloudConnections(desktopToken.auth()) : null,
  );
  const [kv] = useState(() => indexedDbKv("caveman-sync"));
  // This page among the device's open tabs and windows, which share that store: each takes over only the calls a page
  // that is gone left in its outboxes (sync/pages.ts). One per window, made outside render (thisPage).
  const [pages] = useState(thisPage);
  const [hub] = useState(
    () =>
      new SyncHub({
        // Cloud's routes come once this device knows who is signed in (useCloud): a web tab asks Cloud on its session
        // cookie, the desktop its runtime's sign-in. Each person's part of the device store is theirs alone (F-1).
        api: null,
        kv,
        pages,
        home: () => ({ runtimeId: homeRuntimeId.current, client: clientRef.current }),
        homeLocal: !CLOUD_HOSTED,
        presence: windowPresence(),
        endpoint: (runtimeId) => (CLOUD_HOSTED ? { url: relayUrl(window.location, runtimeId), token: "" } : desktopToken.endpoint(runtimeId)),
      }),
  );
  hubNow.current = hub;
  // A Mac reached through the relay asks who this device is before it takes calls (S13, device-approval.ts); what a
  // runtime is comes from Cloud's list (a Cloud computer never asks, so nobody waits for it to).
  useState(() =>
    installDeviceHooks({
      kindOf: (id) => {
        const known = hub.list?.get().runtimes.get(id)?.kind;
        if (known) return known;
        const chosen = chosenRuntime(localStorage);
        return chosen?.id === id ? (isLaptop(chosen) ? "laptop" : "cloud") : undefined;
      },
    }),
  );
  // A Mac let this browser in (or said no): it may be the window's quiet home from now on, or no longer.
  useEffect(() => (CLOUD_HOSTED ? subscribeDeviceStatus(followHome) : undefined), []);
  useEffect(() => {
    hub.start();
    return () => {
      void hub.stop();
    };
  }, [hub]);
  /** A web tab's part of the device store is settled once Cloud has said who its cookie signs in, or that nobody is. */
  const [signInKnown] = useState(() => {
    let known!: () => void;
    const promise = new Promise<void>((resolve) => (known = resolve));
    return { promise, known };
  });
  // A web tab: who its cookie signs in, then that person's list (retried while Cloud cannot say).
  useEffect(() => {
    if (!CLOUD_HOSTED) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number) =>
      void webPerson().then(
        (person) => {
          if (stopped) return;
          // oxlint-disable-next-line react/hooks -- hub.useCloud is the sync hub's method, not a React hook.
          if (person) hub.useCloud(cloudApi(cookieAuth()), person);
          setSignedIn(person !== null);
          signInKnown.known();
        },
        () => {
          if (!stopped) timer = setTimeout(() => ask(attempt + 1), Math.min(1_000 * 2 ** attempt, 30_000));
        },
      );
    ask(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hub]);
  // This device's measured latency per path (S14), to Cloud's ingest once it has Cloud (a minute at a time).
  const reporting = useRef<(() => void) | null>(null);
  useEffect(() => {
    const api = hub.cloud();
    if (!api || reporting.current) return;
    reporting.current = reportLatency(latency, api, CLOUD_HOSTED ? "web" : "desktop");
  });
  useEffect(
    () => () => {
      reporting.current?.();
      reporting.current = null;
    },
    [],
  );
  const list = useSyncExternalStore(hub.list ? hub.list.subscribe : noSubscribeList, hub.list ? hub.list.get : noList);
  const [hubVersion, setHubVersion] = useState(0);
  useEffect(() => {
    if (!CLOUD_HOSTED || !list) return;
    // The Cloud computer this window is on runs as another runtime now (a new id at every wake): it follows it there.
    const chosen = chosenRuntime(localStorage);
    const now = chosen ? followed(chosen, list) : undefined;
    if (now) chooseRuntime(localStorage, now);
    else followHome();
  }, [list]);
  // Whether Cloud runs computers for this organization: where a new chat can run (ChatPlaces). Asked once someone is
  // signed in, again each minute the window is in view, and until it answers.
  useEffect(() => {
    if (!CLOUD_HOSTED || signedIn !== true) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number) => {
      if (stopped) return;
      if (document.visibilityState === "hidden") return void (timer = setTimeout(() => ask(attempt), CLOUD_ON_EVERY_MS));
      void listComputers().then(
        (out) => {
          if (stopped) return;
          setCloudOn(out.available);
          timer = setTimeout(() => ask(0), CLOUD_ON_EVERY_MS);
        },
        () => {
          if (!stopped) timer = setTimeout(() => ask(attempt + 1), Math.min(2_000 * 2 ** attempt, CLOUD_ON_EVERY_MS));
        },
      );
    };
    ask(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [signedIn]);
  useEffect(() => hub.subscribe(() => setHubVersion((n) => n + 1)), [hub]);
  const lastPayload = useRef(
    snapshot
      ? { workspaces: JSON.stringify(snapshot.workspaces), engines: JSON.stringify(snapshot.engines), settings: JSON.stringify(snapshot.settings), projects: JSON.stringify(snapshot.projects) }
      : { workspaces: "", engines: "", settings: "", projects: "" },
  );
  /** One list per poll in flight: the workspace.changed pushes that arrived while it was out (workspace-feed.ts). */
  const pushedDuring = useRef(new Set<Workspace[]>());

  const refresh = useStableCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const pushed: Workspace[] = [];
    pushedDuring.current.add(pushed);
    const asked = saves.current.asking();
    let answers;
    try {
      answers = await Promise.all([
        c.call("workspace.list", {}),
        c.call("engine.list", {}),
        c.call("settings.get", {}),
        // A runtime from before projects answers method_not_found: its workspaces fold by repo.
        c.call("project.list", {}).catch(() => ({ projects: [] })),
      ]);
    } finally {
      pushedDuring.current.delete(pushed);
    }
    // Another computer was picked while this poll was out (its close() turns an unanswered project.list into none):
    // these answers are the last computer's.
    if (c !== clientRef.current) return;
    const [list, eng, set, proj] = answers;
    // The poll returns the same payload most ticks; new objects would
    // re-render every mounted surface every 2 s, so only changes are set.
    const seenNow = { workspaces: JSON.stringify(list.workspaces), engines: JSON.stringify(eng.engines), settings: JSON.stringify(set), projects: JSON.stringify(proj.projects) };
    // The Chief is never a chat: it lives on its own page (chief.get), whatever a runtime lists. A workspace that reads
    // the same keeps its object, so only the rows that changed re-render.
    if (seenNow.workspaces !== lastPayload.current.workspaces || pushed.length > 0) {
      const before = rawNow.current;
      const same = (w: Workspace) => {
        const was = before.get(w.id);
        return was && JSON.stringify(was) === JSON.stringify(w) ? was : w;
      };
      setRaw(withPushes(new Map(withoutChief(list.workspaces).map((w) => [w.id, same(w)])), pushed));
    }
    if (seenNow.engines !== lastPayload.current.engines) setEngines(eng.engines);
    // A save in flight shows its patch; an answer that may predate one (out when this poll was sent, or made while it
    // was out) waits for the next poll.
    if (seenNow.settings !== lastPayload.current.settings) {
      if (saves.current.polled(set, asked)) setSettings(set);
      else seenNow.settings = lastPayload.current.settings;
    }
    if (seenNow.projects !== lastPayload.current.projects) setProjects(proj.projects);
    lastPayload.current = seenNow;
  });

  const saveSettings = useStableCallback(async (patch: SettingsPatch) => {
    const c = clientRef.current;
    if (!c) throw new Error("Not connected to the runtime");
    // A save answered after another computer was picked is that computer's no more: it settles only its own saves.
    const own = saves.current;
    const id = own.begin(patch);
    setSettings(own.view());
    try {
      const saved = await c.call("settings.set", { request_id: requestId(), settings: patch });
      own.succeed(id, saved);
      if (own === saves.current) lastPayload.current.settings = JSON.stringify(saved);
    } catch (e) {
      own.fail(id);
      if (own !== saves.current) throw new SaveLeftBehind(e);
      // Whatever the runtime holds now, the next poll takes it.
      lastPayload.current.settings = "";
      throw e;
    } finally {
      if (own === saves.current) setSettings(own.view());
    }
  });
  const adopt = useStableCallback((w: Workspace) => {
    lastPayload.current.workspaces = "";
    setRaw((prev) => applyWorkspaceChange(prev, w));
  });
  /** Inbox changes sent and not yet answered, by workspace: what the views show meanwhile. */
  const [pendingInbox, setPendingInbox] = useState<ReadonlyMap<string, { readonly id: number; readonly inbox: WorkspaceInbox | undefined }>>(new Map());
  const pendingNow = useRef(pendingInbox);
  pendingNow.current = pendingInbox;
  const inboxCalls = useRef(0);
  /** False once the runtime answers that it has no workspace.inbox (one from before it): the read mark stays local. */
  const inboxSupported = useRef(true);
  const inbox = useStableCallback(async (id: string, action: InboxAction) => {
    // A synced chat's marks are the person's, kept by Cloud for every device (pins, done, snooze, read).
    const synced = mergedNow.current.find((v) => v.id === id)?.synced;
    const patch = synced && hub.list ? cloudPatch(action, synced.head) : null;
    if (patch && synced && hub.list) {
      const sessionId = mergedNow.current.find((v) => v.id === id)!.sessionId!;
      return hub.list.setState(sessionId, patch);
    }
    const c = clientRef.current;
    const w = rawNow.current.get(id);
    if (!c || !w) throw new Error(synced ? "This change needs the computer the chat runs on." : "Not connected to the runtime");
    const call = ++inboxCalls.current;
    const shown = pendingNow.current.get(id)?.inbox ?? w.inbox;
    const settle = () =>
      setPendingInbox((prev) => {
        if (prev.get(id)?.id !== call) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    setPendingInbox((prev) => new Map(prev).set(id, { id: call, inbox: applyInbox(shown, action, w.updated_at) }));
    try {
      const answer = await c.call("workspace.inbox", { request_id: requestId(), workspace_id: id, action });
      setRaw((prev) => applyWorkspaceChange(prev, answer));
    } catch (e) {
      if (e instanceof SessionProtocolError && e.error.code === -32601) {
        inboxSupported.current = false;
        throw new Error("This runtime is too old for done, snooze and pins: update it.", { cause: e });
      }
      throw e;
    } finally {
      settle();
    }
  });
  /** The latest updated_at a seen mark was sent for, by workspace: an open chat reports each version once. */
  const seenSent = useRef(new Map<string, string>());
  const markSeen = useStableCallback((id: string) => {
    // Read here is read on every device: Cloud keeps the person's seen cursor for a synced chat.
    const merged = mergedNow.current.find((v) => v.id === id);
    if (merged?.synced && merged.sessionId && hub.list && merged.synced.seenCursor < merged.synced.head) hub.list.markSeen(merged.sessionId, merged.synced.head);
    const w = rawNow.current.get(id);
    if (!w) return;
    setSeen((prev) => {
      if (prev[id] === w.updated_at) return prev;
      const next = { ...prev, [id]: w.updated_at };
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      return next;
    });
 // The runtime's mark is the one every client reads (upstream thread.visit); the local one carries a runtime without it.
    const visited = w.inbox?.visited_at;
    if (!inboxSupported.current || seenSent.current.get(id) === w.updated_at || (visited && Date.parse(visited) >= Date.parse(w.updated_at))) return;
    seenSent.current.set(id, w.updated_at);
    inbox(id, { do: "seen", through: w.updated_at }).catch(() => seenSent.current.delete(id));
  });
  // Views keep their object while their workspace, engine label and seen mark do, and the list keeps its array while
  // every view does: a push about one chat re-renders that chat's row, not every row.
  const lastViews = useRef<ReadonlyArray<WorkspaceView>>([]);
  const localViews = useMemo(() => {
    const engineLabel = new Map(engines.map((e) => [e.id, e.label]));
    const next = [...raw.values()].map((w) => {
      const pending = pendingInbox.get(w.id);
      return viewOf(pending ? withInboxOf(w, pending.inbox) : w, engineLabel.get(w.engine) ?? w.engine, seen[w.id]);
    });
    return sameItems(next, lastViews.current) ? lastViews.current : (lastViews.current = next);
  }, [raw, engines, seen, pendingInbox]);
  // The sidebar's chats: this runtime's, merged with every synced chat on the person's other computers, one row each.
  const workspaces = useMemo<ReadonlyArray<MergedView>>(() => {
    const engineLabel = new Map<string, string>(engines.map((e) => [e.id, e.label]));
    const projectByRepo = new Map(projects.flatMap((p) => (p.repository ? [[p.repository.full_name, p.id] as const] : [])));
    return mergeChats(localViews, list, homeRuntimeId.current, (id) => engineLabel.get(id) ?? id, (repo) => projectByRepo.get(repo) ?? null);
    // hubVersion: the home runtime's id lives in a ref and changes with it.
  }, [localViews, list, engines, projects, hubVersion]);
  const mergedNow = useRef(workspaces);
  mergedNow.current = workspaces;
  // A web window runs on another device (a phone, another laptop) than the runtime it uses: a Mac goes by its own name
  // in the person's list, never the browser's own OS ("this Mac" on an iPhone) nor the runtime's word for itself, and
  // any Cloud computer is "Cloud" (a person never meets a machine there by name).
  const home = CLOUD_HOSTED && homeRuntimeId.current ? list?.runtimes.get(homeRuntimeId.current) : undefined;
  const chosen = CLOUD_HOSTED ? chosenRuntime(localStorage) : null;
  const homeIsMac = home ? home.kind === "laptop" : chosen !== null && chosen.id === homeRuntimeId.current && isLaptop(chosen);
  const hostedName = CLOUD_HOSTED ? (homeIsMac ? home?.name || chosen?.computer_name || chosen?.name || "Your Mac" : "Cloud") : null;
  const computerName = hostedName ?? thisComputerName(localViews);
  const computerWord = hostedName ?? thisComputer;
  const computerOnline = home?.online !== false;
  const identity = useMemo<Identity>(() => ({ orgName: "Caveman Code", computerName, computerWord, computerOnline, userName: "You", plan: null }), [computerName, computerWord, computerOnline]);

  const firstEndpoint = useRef(endpoint);
  useEffect(() => {
    // Another computer picked in place: its list, engines, projects and Settings replace this one's (the Cloud list
    // stays: it is every computer's). Nothing of the last one shows, or is saved over, while the new one connects.
    if (firstEndpoint.current !== endpoint) {
      firstEndpoint.current = endpoint;
      lastPayload.current = { workspaces: "", engines: "", settings: "", projects: "" };
      setRaw(new Map());
      setEngines([]);
      setProjects([]);
      saves.current = new SettingsSaves();
      setSettings(null);
      setSettingsSaveError(null);
      setStatus(endpoint ? "connecting" : "unconfigured");
      setError(null);
    }
    if (CLOUD_HOSTED) homeRuntimeId.current = chosenRuntime(localStorage)?.id ?? implicitHome.current;
    if (!endpoint) {
      clientRef.current = null;
      setClient(null);
      hub.homeChanged();
      return;
    }
    let resumedAt = 0;
    let lookedAt = 0;
    /**
     * This window's Cloud computer runs as another runtime now (Cloud mints a new id at every wake): the window follows
     * its computer there, in place, and the chat on screen carries on. True when it did.
     */
    const follow = (runtime: CloudRuntime, runtimes: ReadonlyArray<CloudRuntime>): boolean => {
      const now = runtimeOfComputer(runtime, runtimes);
      if (now) chooseRuntime(localStorage, now);
      return now !== undefined;
    };
    /**
     * The relay has no such runtime for this window now: its computer sleeps, is off line or is gone. The window lets
     * it go and carries on without one, or on another that is on line (quietHome). Nothing is woken for a window that
     * only looks: one that was put to sleep stays asleep.
     */
    const letGo = (runtimeId: string) => {
      refusedHome.current.set(runtimeId, { said: saidOf(hub.list?.get().runtimes.get(runtimeId)), until: Date.now() + REFUSED_MS });
      // Cloud's list may be behind on it: read again, so the window hears when it is back.
      hub.list?.lookAgain();
      // And look once more when the refusal is old: the relay may only have been a moment behind Cloud's list.
      clearTimeout(lookAgainAt.current);
      lookAgainAt.current = setTimeout(followHome, REFUSED_MS + 50);
      if (chosenRuntime(localStorage)?.id === runtimeId) chooseRuntime(localStorage, null);
      else followHome();
    };
    // Pushes sent while the socket was down are gone: every (re)open polls once.
    let kick = () => undefined as unknown;
    // Mutating calls wait in this device's store until answered: a send made just before a reload goes out after it. A
    // web tab keeps them in the signed-in person's part (F-1), whether its computer was picked before the page opened
    // or after Cloud said who that is, so every page life opens the same outbox; they wait for that as for the socket.
    const homeId = homeRuntimeId.current;
    const handshake = CLOUD_HOSTED && homeId ? deviceHooks().handshake?.(homeId) : undefined;
    // A Cloud computer's calls wait under its computer, for the runtime it wakes as (runtimeOutbox). The computer this
    // tab chose says which that is on every page life, before Cloud's list is read; Cloud's list does for one the tab
    // fell to.
    const chosenHome = CLOUD_HOSTED ? chosenRuntime(localStorage) : null;
    const homeComputer = chosenHome?.id === homeId ? (isLaptop(chosenHome) ? undefined : chosenHome.computer_id) : CLOUD_HOSTED && homeId ? hub.cloudComputerOf(homeId) : undefined;
    const homeKept = () => runtimeOutbox(hub.store(), homeId, homeComputer, pages);
    const outbox = CLOUD_HOSTED ? laterOutbox(signInKnown.promise.then(homeKept), pages) : homeKept();
    const homeOptions = { outbox, resend: hub.resendable(homeId), clientVersion: CLIENT_VERSION, ...(handshake ? { handshake } : {}) };
    // A laptop picked in a web tab is reached directly when the network allows (S14), the relay staying beside it.
    const laptopHome = () => {
      const chosen = chosenRuntime(localStorage);
      return chosen?.id === homeId ? isLaptop(chosen) : hub.list?.get().runtimes.get(homeId ?? "")?.kind === "laptop";
    };
    const open =
      CLOUD_HOSTED && homeId
        ? (...args: Parameters<typeof connect>) =>
            connectDirect(args[0], args[1], args[2], { ...args[3], direct: { enabled: () => laptopHome() && hub.directAllowed(), iceServers: () => hub.directIceServers() } })
        : connect;
    let failuresWhileAnswering = 0;
    const c = open(endpoint.url, endpoint.token, (state, closed) => {
      if (state === "open") {
        setConnection((n) => n + 1);
        kick();
      }
      // Every retry reports again; only a change re-renders.
      setLink((prev) => (state === "open" ? (prev.open && prev.openedOnce ? prev : { open: true, openedOnce: true }) : prev.open ? { ...prev, open: false } : prev));
      if (state === "open") failuresWhileAnswering = 0;
      // A browser tab's link is a token the runtime printed: a socket that keeps failing while the runtime answers was
      // turned down, and every retry would be too. Say so and stop. The desktop's own runtime hands it a fresh link.
      if (!CLOUD_HOSTED && !window.cavemanDesktop && state !== "open" && closed instanceof ConnectionClosed && closed.code === 1006)
        void fetch(probeUrl(endpoint.url), { mode: "no-cors", cache: "no-store" }).then(
          () => {
            failuresWhileAnswering++;
            if (!linkTurnedDown(failuresWhileAnswering)) return;
            setLink((prev) => (prev.open || prev.refused ? prev : { ...prev, refused: true }));
            c.close();
          },
          () => (failuresWhileAnswering = 0),
        );
      // The relay's close codes (the client keeps retrying): 4401 sign in again; 4404 the runtime is not connected;
      // 1006 it refused the upgrade (a browser cannot read why: a runtime id Cloud revoked when its computer stopped).
      if (!CLOUD_HOSTED || !(closed instanceof ConnectionClosed)) return;
      if (closed.code === 4401) {
        // The session cookie may only need renewing: the client retries on its own and the open session stays on screen.
        void renewSession().then((renewed) => !renewed && setSignedIn(false));
        return;
      }
      if (closed.code !== 4404 && closed.code !== 1006) {
        setStatus("error");
        setError(closed.message);
        return;
      }
      const runtime = chosenRuntime(localStorage);
      // The runtime the window fell to by itself: let go at once, Cloud's list says when it is back.
      if (!homeId || runtime?.id !== homeId) return void (homeId && letGo(homeId));
      // One the window was put on (a chat started in Cloud, New chat on a Mac): ask Cloud what became of it, every few
      // seconds while the relay keeps refusing.
      if (Date.now() - lookedAt <= 3_000) return;
      lookedAt = Date.now();
      void listRuntimes().then(
        (answer) => {
          if (c !== clientRef.current) return;
          if (!answer.signedIn) return setSignedIn(false);
          // Its Cloud computer runs as another runtime now: go there.
          if (follow(runtime, answer.runtimes)) return;
          // Cloud still hears it: the relay's link to it is a moment behind, and the client retries by itself.
          const listed = answer.runtimes.find((r) => r.id === runtime.id);
          if (listed && seenLabel(listed.last_seen_at) === "Online") return;
          // A chat the person started in Cloud waits for this computer: a start is a send, and sending wakes.
          if (!isLaptop(runtime) && pendingStart(sessionStorage)?.computer_id === runtime.computer_id) {
            if (Date.now() - resumedAt <= 60_000) return;
            resumedAt = Date.now();
            return void resumeComputer(runtime.computer_id).then(
              // 404: no longer one of the person's computers.
              (status) => status === 404 && c === clientRef.current && letGo(runtime.id),
              () => undefined,
            );
          }
          letGo(runtime.id);
        },
        () => undefined,
      );
    }, homeOptions);
    clientRef.current = c;
    hubOf.set(c, hub);
    setClient(c);
    // An agent's card asked to show where to allow Caveman Code: the desktop opens its guide over System Settings.
    c.on("computer.guide", (p) => window.cavemanDesktop?.computerGuide?.open(p.permission));
    setHello(undefined);
    const offHello = c.onHello(setHello);
    hub.homeChanged();
    let stop = false;
    // Calls wait for the socket while it is down: one poll at a time, not one queued every 2 s until it is back.
    let polling = false;
    const tick = async () => {
      if (polling) return;
      polling = true;
      try {
        await refresh();
        if (!stop) {
          setStatus("connected");
          setError(null);
        }
      } catch (e) {
        if (!stop) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        polling = false;
      }
    };
    kick = () => void tick();
    // An engine probe that changed engine.list's answer (a sign-in checked at start, one made in a terminal): at once,
    // not at the next poll. Runtimes from before it never send it; the poll still catches up.
    const offEngines = c.on("engine.changed", ({ engines: next }) => {
      lastPayload.current.engines = JSON.stringify(next);
      setEngines(next);
    });
    // Smart View turned on or off (here, in another window, from the CLI): the runtime says so in every Chief view at
    // once (chief.view.updated `on`); when that differs from the settings this window holds, read them now, not at
    // the next poll, so its toggle and Settings > Chief agree with the runtime.
    const offSmartView = c.on("chief.view.updated", (view) => {
      if (settingsLag(lastPayload.current.settings, view.on)) void tick();
    });
    // Workspaces arrive as the runtime pushes them; the list's next poll applies again whatever it reads.
    const offChanged = c.on("workspace.changed", (w) => {
      for (const during of pushedDuring.current) during.push(w);
      lastPayload.current.workspaces = "";
      setRaw((prev) => applyWorkspaceChange(prev, w));
    });
    // Moves: the chat on screen moved to another computer. The view follows it in place: Cloud's list
    // names its new runtime, and its feed switches source by (epoch, cursor). Nothing reloads; the scroll stays.
    const offMoved = c.on("session.moved", () => hub.homeChanged());
    // This Mac's own runtime id (Cloud's), and Cloud's chat list once this Mac is signed in to a Cloud that syncs.
    const offCloud = CLOUD_HOSTED ? () => undefined : c.on("cloud.changed", (cloud) => desktopCloud(cloud));
    let signedIn: string | null = null;
    const desktopCloud = (cloud: { cloud_url?: string; runtime_id?: string; state: string; sync?: { available: boolean } }) => {
      if (cloud.runtime_id && homeRuntimeId.current !== cloud.runtime_id) {
        homeRuntimeId.current = cloud.runtime_id;
        hub.homeChanged();
      }
      // Signed out here (Settings, /logout, the CLI), or in as someone else: what this device kept for them goes (F-1).
      const person = (signedIn = desktopPerson(cloud));
      if (hub.hasCloud() && hub.cloudPerson() !== person) {
        desktopToken.invalidate();
        void hub.signedOut();
      }
      if (!person || hub.hasCloud() || cloud.sync?.available !== true || (cloud.state !== "connected" && cloud.state !== "off")) return;
      void desktopToken.get().then(
        () => {
          // oxlint-disable-next-line react/hooks -- hub.useCloud is the sync hub's method, not a React hook.
          if (signedIn === person) hub.useCloud(cloudApi(desktopToken.auth()), person);
        },
        () => undefined, // not signed in to a Cloud that syncs: This Mac's chats only, as before
      );
    };
    if (!CLOUD_HOSTED && window.cavemanDesktop?.runtime) void c.call("cloud.status", {}).then(desktopCloud, () => undefined);
    void tick();
    // The catch-up poll: engines, settings and projects have no push, and a runtime from before workspace.changed sends none.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void tick().finally(() => !stop && schedule()), catchUpMs(document.visibilityState !== "hidden"));
    };
    schedule();
    // Back to the window (a sign-in finished in the browser, another device changed something): look now.
    const onBack = () => {
      if (document.visibilityState === "hidden") return schedule();
      void tick();
      schedule();
    };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      stop = true;
      clearTimeout(timer);
      offChanged();
      offEngines();
      offSmartView();
      offMoved();
      offCloud();
      offHello();
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
      c.close();
      clientRef.current = null;
    };
  }, [endpoint, hub, desktopToken, kv, pages]);

  const value = useMemo<RuntimeContextValue>(
    () => ({
      status,
      error,
      client,
      identity,
      workspaces,
      raw,
      projects,
      engines,
      settings,
      refresh,
      saveSettings,
      settingsSaveError,
      setSettingsSaveError,
      connection,
      adopt,
      markSeen,
      inbox,
    }),
    [status, error, client, identity, workspaces, raw, projects, engines, settings, refresh, saveSettings, settingsSaveError, connection, adopt, markSeen, inbox],
  );
  // The store's subscribers read the value this commit made; they re-render before the frame paints.
  const [store] = useState(() => {
    let current = value;
    const listeners = new Set<() => void>();
    return {
      get: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      publish: (next: RuntimeContextValue) => {
        if (next === current) return;
        current = next;
        for (const listener of listeners) listener();
      },
    };
  });
  useLayoutEffect(() => store.publish(value), [store, value]);

  // Once the list first arrives, the most recent chats load in the background, one at a time, while the app is idle:
  // the first open of each is then as instant as a revisit.
  const prefetched = useRef<Client | null>(null);
  useEffect(() => {
    if (!client || prefetched.current === client || raw.size === 0) return;
    prefetched.current = client;
    const queue = [...raw.values()]
      .filter((w) => w.status !== "archived" && w.session_id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, PREFETCH_RECENT)
      .map((w) => w.session_id);
    let cancelled = false;
    const idle = (f: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(f, { timeout: 2000 }) : setTimeout(f, 50));
    const next = () => {
      const id = queue.shift();
      if (cancelled || id === undefined) return;
      prefetchSession(client, id, () => idle(next));
    };
    idle(next);
    return () => {
      cancelled = true;
    };
  }, [client, raw]);

  // The desktop's snapshot for its next launch, a moment after the list settles (polls and pushes alike), or as the
  // window goes if that comes first (a chat made just before quitting is on the next launch's list).
  useEffect(() => {
    if (status !== "connected" || !window.cavemanDesktop?.runtime) return;
    const write = () => writeSnapshot({ workspaces: [...raw.values()], engines: [...engines], settings, projects: [...projects] });
    const timer = setTimeout(write, 1000);
    window.addEventListener("pagehide", write);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", write);
    };
  }, [status, raw, engines, settings, projects]);

  // Pins were this window's own (localStorage) before they lived on the thread: once, after the first list, they move
  // to the runtime in the order they were pinned, so every client and the inbox agree.
  const pinsMoved = useRef(false);
  useEffect(() => {
    if (status !== "connected" || pinsMoved.current || lastPayload.current.workspaces === "") return;
    pinsMoved.current = true;
    const local = readLocalPins().filter((id) => raw.has(id) && !raw.get(id)!.inbox?.pinned_at);
    void (async () => {
      for (const id of local) await inbox(id, { do: "pin" });
      localStorage.removeItem(LOCAL_PINS_KEY);
    })().catch(() => {
      // A runtime without workspace.inbox: they move on a later launch, against one that has it.
    });
  }, [status, raw]);

  // A web window reads the person's Chief only on a Mac of theirs; a Cloud computer it uses gets none made on it.
  const chief = chiefHere(CLOUD_HOSTED, client === null ? undefined : homeIsMac ? "laptop" : "cloud");
  const clientValue = useMemo<RuntimeClientValue>(() => ({ status, client, connection, chiefHere: chief, scope: endpoint?.url ?? null }), [status, client, connection, chief, endpoint?.url]);
  // Skew: this window's own runtime first (named as Cloud's list or the tab's pick has it), then every other computer
  // this device holds a connection to (the pool's answers re-render through the hub).
  const skewed = useMemo(() => {
    const homeId = homeRuntimeId.current;
    const home = homeId ? list?.runtimes.get(homeId) : undefined;
    const chosen = CLOUD_HOSTED ? chosenRuntime(localStorage) : null;
    const own = {
      hello,
      name: home?.name ?? chosen?.computer_name ?? THIS_COMPUTER,
      kind: home?.kind ?? (chosen && !isLaptop(chosen) ? ("cloud" as const) : ("laptop" as const)),
      computerId: home?.computer_id ?? chosen?.computer_id,
    };
    const others = [...(list?.runtimes.values() ?? [])]
      .filter((r) => r.runtime_id !== homeId)
      .map((r) => ({ hello: hub.runtimeHello(r.runtime_id), name: r.name, kind: r.kind, computerId: r.computer_id }));
    return firstSkewed([own, ...others]);
    // hubVersion: the pool's answers and the home runtime's id live outside React state.
  }, [hello, list, hub, hubVersion]);
  // What a web window shows and where a new chat can run from it; null off the web.
  const webPlaces = useMemo(() => chatPlaces(list, cloudOn), [list, cloudOn]);
  const webShows = useMemo(() => webWindow(signedIn, list), [signedIn, list]);
  const usePlace = useStableCallback((place: ChatPlace | null) => {
    if (place === null || place.kind === "cloud") return chooseRuntime(localStorage, null);
    const mac = hub.list?.get().runtimes.get(place.runtimeId);
    if (mac && chosenRuntime(localStorage)?.id !== mac.runtime_id) chooseRuntime(localStorage, asCloudRuntime(mac));
  });
  const homeName = client === null ? null : homeIsMac ? computerName : "Cloud";
  // What each Mac said about this browser lives outside React (device-approval.ts): its count is the snapshot.
  const answers = useSyncExternalStore(subscribeDeviceStatus, deviceAnswers);
  const webMac = useMemo(() => macHere(list, deviceStatusOf, allowedBefore), [list, answers]);
  const web = useMemo<WebWindowValue | null>(
    () => (CLOUD_HOSTED ? { window: webShows, places: webPlaces, home: homeName === null ? null : { kind: homeIsMac ? "mac" : "cloud", name: homeName }, mac: webMac, usePlace } : null),
    [webShows, webPlaces, homeName, homeIsMac, webMac, usePlace],
  );
  return (
    <RuntimeSkewContext.Provider value={skewed}>
      <RuntimeLinkContext.Provider value={link}>
        <RuntimeClientContext.Provider value={clientValue}>
          <RuntimeStoreContext.Provider value={store}>
            <SyncHubContext.Provider value={hub}>
              <ComputersCloudContext.Provider value={computersCloud}>
                <ConnectionsCloudContext.Provider value={connectionsCloud}>
                  <WebWindowContext.Provider value={web}>
                    <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
                  </WebWindowContext.Provider>
                </ConnectionsCloudContext.Provider>
              </ComputersCloudContext.Provider>
            </SyncHubContext.Provider>
          </RuntimeStoreContext.Provider>
        </RuntimeClientContext.Provider>
      </RuntimeLinkContext.Provider>
    </RuntimeSkewContext.Provider>
  );
}

/**
 * A pane's surfaces talk to the chat's own computer: its chat client in place of the window's (a chat on another
 * computer), and that connection's reconnect counter, not the window's.
 */
export function ChatClientScope({ client, children }: { client: Client; children: ReactNode }) {
  const outer = useRuntimeClient();
  const hub = hubOf.get(client);
  const sessionId = chatSessions.get(client);
  const subscribe = useMemo(() => (hub ? (listener: () => void) => hub.subscribe(listener) : noSubscribe), [hub]);
  const connection = useSyncExternalStore(subscribe, () => (hub && sessionId !== undefined ? hub.connectionFor(sessionId) : outer.connection));
  // A chat's own computer is never where this window reads the person's Chief.
  const value = useMemo<RuntimeClientValue>(() => ({ status: "connected", client, connection, chiefHere: false }), [client, connection]);
  return <RuntimeClientContext.Provider value={value}>{children}</RuntimeClientContext.Provider>;
}

const NO_RUNTIME: RuntimeClientValue = { status: "error", client: null, connection: 0 };
/** Below a RuntimeProvider that threw (shell/RouteError.tsx AppErrorBoundary): no runtime to call, as when it is down. */
export function NoRuntimeScope({ children }: { children: ReactNode }) {
  return <RuntimeClientContext.Provider value={NO_RUNTIME}>{children}</RuntimeClientContext.Provider>;
}

/**
 * Whether a window may read (and so make) the person's Chief on its runtime (K2): the desktop's own Mac, or a Mac of
 * theirs a web window uses; never a Cloud computer a web window uses, and never while it has no runtime at all.
 * `home`: what the web window's runtime is, undefined with none.
 */
export function chiefHere(hosted: boolean, home: "laptop" | "cloud" | undefined): boolean {
  return !hosted || home === "laptop";
}

/**
 * A browser window Caveman Cloud serves, as the shell reads it (state/sync/web-window.ts): what it shows, where a new
 * chat can run from it, and the runtime it quietly uses, by a name a page may say ("Cloud", or the Mac's own).
 */
export interface WebWindowValue {
  readonly window: WebWindow;
  readonly places: ChatPlaces;
  /** The runtime the window uses now for what has no place of its own; null with none (every place asleep, or nothing yet). */
  readonly home: { readonly kind: "mac" | "cloud"; readonly name: string } | null;
  /** The person's Mac as this browser stands with it, and so the next step while nothing of it shows here (macNext). */
  readonly mac: MacHere;
  /**
   * Puts the window on a place for a new chat there: a Mac's projects, branches and agents are then the window's own
   * (the Mac asks to allow this browser if it has not yet). Cloud, or null, lets a Mac go again: a chat in Cloud needs
   * no runtime until it starts (state/cloud.ts startOnNewCloudComputer, then state/cloud-wait.ts).
   */
  readonly usePlace: (place: ChatPlace | null) => void;
}
const WebWindowContext = createContext<WebWindowValue | null>(null);
/** The web window's own state; null in the desktop app and on a runtime's own page, which have a computer of their own. */
export const useWebWindow = (): WebWindowValue | null => useContext(WebWindowContext);
/** A web window's state for real components on a fixture page (shell/web-window.browser.tsx) and in tests. */
export function WebWindowFixture({ value, children }: { value: WebWindowValue; children: ReactNode }) {
  return <WebWindowContext.Provider value={value}>{children}</WebWindowContext.Provider>;
}

/** Cloud's list of the person's chats as this window holds it; null without Cloud. */
export function useChatList(hub: SyncHub | null): ChatListSnapshot | null {
  const list = hub?.list ?? null;
  const get = list ? list.get : noList;
  return useSyncExternalStore(list ? list.subscribe : noSubscribeList, get, get);
}

const everyChats = new WeakMap<ReadonlyMap<string, Workspace>, { readonly list: ChatListSnapshot | null; readonly home: string | null; readonly chats: ReadonlyMap<string, Workspace> }>();
/** sync/chats-view.ts noticeable, once per version of this runtime's list and Cloud's. */
function everyChat(raw: ReadonlyMap<string, Workspace>, list: ChatListSnapshot | null, home: string | null): ReadonlyMap<string, Workspace> {
  const known = everyChats.get(raw);
  if (known && known.list === list && known.home === home) return known.chats;
  const chats = noticeable(raw, list, home);
  everyChats.set(raw, { list, home, chats });
  return chats;
}

/**
 * One piece of every chat the person has, on any computer, as workspaces: this window's runtime's own and the rest from
 * Cloud's list, so a chat's lead and builders are found wherever they run. Re-renders only when that piece changes, as
 * useRuntimeSelector does.
 */
export function useEveryChatSelector<T>(hub: SyncHub | null, select: (chats: ReadonlyMap<string, Workspace>) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  "use no memo";
  const store = useContext(RuntimeStoreContext) ?? fixtureStore(use(RuntimeContext));
  const list = hub?.list ?? null;
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const offRuntime = store.subscribe(listener);
      const offList = list?.subscribe(listener);
      return () => {
        offRuntime();
        offList?.();
      };
    },
    [store, list],
  );
  const last = useRef<{ chats: ReadonlyMap<string, Workspace>; select: (chats: ReadonlyMap<string, Workspace>) => T; picked: T } | null>(null);
  const get = (): T => {
    const chats = everyChat(store.get().raw, list ? list.get() : null, hub?.homeRuntimeId() ?? null);
    const was = last.current;
    if (was && was.chats === chats && was.select === select) return was.picked;
    const next = select(chats);
    const picked = was && isEqual(was.picked, next) ? was.picked : next;
    last.current = { chats, select, picked };
    return picked;
  };
  return useSyncExternalStore(subscribe, get, get);
}

const noSubscribeList = () => () => undefined;
const noList = (): ChatListSnapshot | null => null;

/** A workspace.inbox action as the person's state Cloud keeps for a synced chat; null for what only the runtime does. */
function cloudPatch(action: InboxAction, head: number): PersonStatePatch | null {
  switch (action.do) {
    case "pin":
      return { pinned: true };
    case "unpin":
      return { pinned: false };
    case "done":
      return { done: true, pinned: false };
    case "reopen":
      return { done: false };
    case "snooze":
      return { snoozed_until: action.until };
    case "wake":
      return { snoozed_until: null };
    case "seen":
      return { seen_cursor: head };
    case "unread":
      return null;
  }
}

/** The window's sync hub, for surfaces that open chats on other computers (PaneFrame) and the sidebar's glyphs. */
const SyncHubContext = createContext<SyncHub | null>(null);
export const useSyncHub = (): SyncHub | null => useContext(SyncHubContext);
/** A scripted sync hub for real components on a fixture page (shell/x1-review-builders.browser.tsx). */
export function SyncHubFixture({ hub, children }: { hub: SyncHub; children: ReactNode }) {
  return <SyncHubContext.Provider value={hub}>{children}</SyncHubContext.Provider>;
}
export const ComputersCloudContext = createContext<CloudApi | null>(null);
/** Cloud's routes for this person's computers from this device (cookie on the web Cloud serves, token on the desktop). */
export const useComputersCloud = (): CloudApi | null => useContext(ComputersCloudContext);
export const ConnectionsCloudContext = createContext<CloudConnections | null>(null);
/** Cloud's routes for this person's connections from this device; null where the device holds no Cloud session. */
export const useConnectionsCloud = (): CloudConnections | null => useContext(ConnectionsCloudContext);

/** A chat client for a chat that runs on another computer, known to the session stores (useSession reads through the hub). */
export function chatClientFor(hub: SyncHub, sessionId: string): Client {
  const known = chatClients.get(hub)?.get(sessionId);
  if (known) return known;
  const client = hub.clientFor(sessionId);
  hubOf.set(client, hub);
  chatSessions.set(client, sessionId);
  let byId = chatClients.get(hub);
  if (!byId) chatClients.set(hub, (byId = new Map()));
  byId.set(sessionId, client);
  return client;
}
const chatClients = new WeakMap<SyncHub, Map<string, Client>>();
const chatSessions = new WeakMap<Client, string>();

/** The id a runtime gives its own computer (projector.ts THIS_MAC). */
export const THIS_MAC_ID = "this-mac";
/**
 * A chat that lives on this window's own computer, parked or not: never one this computer let go to another of the
 * person's Macs (its record has that Mac's id and name), nor a chat Cloud's list shows on another computer.
 */
export const livesHere = (w: Pick<WorkspaceView, "computer">) => w.computer.kind === "this_mac" && (w.computer.id ?? THIS_MAC_ID) === THIS_MAC_ID;
/** This window's own computer by name, from the chats that live on it. */
export const thisComputerName = (views: ReadonlyArray<WorkspaceView>) => views.find(livesHere)?.computer.label ?? THIS_COMPUTER;

export function useRuntime(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useRuntime outside RuntimeProvider");
  return ctx;
}

const views = new WeakMap<Workspace, { readonly engineLabel: string; readonly seenAt: string | undefined; readonly view: WorkspaceView }>();
/** toView, made once per version of a workspace (a push or poll that changed it makes a new raw object). */
function viewOf(w: Workspace, engineLabel: string, seenAt: string | undefined): WorkspaceView {
  const known = views.get(w);
  if (known && known.engineLabel === engineLabel && known.seenAt === seenAt) return known.view;
  const view = toView(w, engineLabel, seenAt);
  views.set(w, { engineLabel, seenAt, view });
  return view;
}

/** A workspace as the screens read it, for a fixture page that has no runtime to make its views (shell/*.browser.tsx). */
export const workspaceView = (w: Workspace, engineLabel: string): WorkspaceView => viewOf(w, engineLabel, w.updated_at);

/** The workspace showing a pending inbox change (a new object, so its view is made again). */
function withInboxOf(w: Workspace, inbox: WorkspaceInbox | undefined): Workspace {
  const { inbox: _, ...rest } = w;
  return inbox ? { ...rest, inbox } : rest;
}

/** A read mark that is the same moment as `updated_at` or later (the runtime's ISO and ours may differ in form). */
const readThrough = (seenAt: string, updatedAt: string) => Date.parse(seenAt) >= Date.parse(updatedAt);

/** A pull request as the screens read it. */
const prView = (p: PullRequest): PullRequestView => ({ number: p.number, url: p.url, state: p.state, ...(p.checks ? { checks: p.checks } : {}), ...(p.review ? { review: p.review } : {}), ...(p.base_ci ? { base_ci: p.base_ci } : {}) });

/** A repository as the screens name it: a folder by its own name, a remote by owner/name; empty when it names none. */
export const repoLabel = (repo: Workspace["repo"]): string =>
  "path" in repo ? (repo.path.split("/").filter(Boolean).pop() ?? repo.path) : repo.url.replace(/^.*[/:]([^/]+\/[^/]+?)(\.git)?$/, "$1");

/**
 * Whether a repository is on GitHub, for its mark: a remote at github.com, or the `owner/name` Cloud lists a chat's
 * repository by (Cloud takes GitHub's only). A folder, or a remote anywhere else, is not.
 */
export const repoOnGitHub = (repo: Workspace["repo"]): boolean =>
  "url" in repo && (/(^|[/@.])github\.com[/:]/.test(repo.url) || /^[^/:@\s]+\/[^/:@\s]+$/.test(repo.url));

function toView(w: Workspace, engineLabel: string, localSeenAt: string | undefined): WorkspaceView {
  // The runtime's read mark when it has one, its mark-unread included; the local one carries a runtime without it.
  const seenAt = w.inbox?.visited_at ?? localSeenAt;
  return {
    id: w.id,
    title: w.title,
    repo: repoLabel(w.repo),
    repoRef: w.repo,
    branch: w.branch,
    state: stateOf(w.status),
    asleep: w.status === "parked",
    detail: null,
    engine: { id: w.engine, label: engineLabel },
    computer: { kind: w.computer.kind as ComputerKind, label: w.computer.label, id: w.computer.id },
    parentId: w.parent_workspace_id ?? null,
    ...(w.automation ? { automationStep: true } : {}),
    sessionId: w.session_id,
    projectId: w.project_id ?? null,
    ...(w.topic ? { topic: w.topic } : {}),
    ...(w.topic && w.topic_icon ? { topicIcon: w.topic_icon } : {}),
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    unread: seenAt !== undefined ? !readThrough(seenAt, w.updated_at) : w.status !== "idle",
    ...(w.subagents?.length
      ? {
          subagents: w.subagents.map((s) => ({
            itemId: s.item_id,
            parentItemId: s.parent_item_id ?? null,
            title: s.title,
            engine: s.agent ?? w.engine,
            state: s.status === "interrupted" ? ("stopped" as const) : s.status,
            startedAt: s.started_at,
            endedAt: s.ended_at ?? null,
          })),
        }
      : {}),
    ...(w.pull_request ? { pullRequest: prView(w.pull_request) } : {}),
    ...(w.unmerged ? { unmerged: { files: w.unmerged.files, commits: w.unmerged.commits } } : {}),
    // A chat in several sources: each one's pull request and unlanded work, the primary's first.
    ...(hasSeveralSources(w)
      ? {
          sources: workspaceSources(w).map((s) => ({
            name: s.name,
            ...(s.pull_request ? { pullRequest: prView(s.pull_request) } : {}),
            ...(s.unmerged ? { unmerged: { files: s.unmerged.files, commits: s.unmerged.commits } } : {}),
            ...(!s.primary && s.repository ? { repo: s.repository.full_name, host: s.repository.host } : {}),
          })),
        }
      : {}),
    ...(w.started_by ? { startedBy: w.started_by.agent } : {}),
    ...(w.preview ? { preview: { command: w.preview.command, path: w.preview.path } } : {}),
    ...(w.inbox && (w.inbox.done_at || w.inbox.snoozed_until || w.inbox.pinned_at)
      ? {
          inbox: {
            doneAt: w.inbox.done_at ?? null,
            snoozedUntil: w.inbox.snoozed_until ?? null,
            snoozedAt: w.inbox.snoozed_at ?? null,
            pinnedAt: w.inbox.pinned_at ?? null,
          },
        }
      : {}),
    ...(w.activity?.last_reply ? { reply: w.activity.last_reply } : {}),
    ...(w.activity
      ? {
          activity: {
            ask: w.activity.ask ?? null,
            turnStartedAt: w.activity.turn_started_at ?? null,
            lastOutcome: w.activity.last_outcome ?? null,
            turnEndedAt: w.activity.turn_ended_at ?? null,
            ...(w.activity.awaiting ? { awaiting: true } : {}),
            todos: w.activity.todos ?? null,
            readyToBuild: w.activity.ready_to_build === true,
          },
        }
      : {}),
  };
}

function stateOf(status: Workspace["status"]): WorkspaceState {
  switch (status) {
    case "needs_input":
      return "needs_input";
    case "starting":
    case "working":
      return "working";
    case "waiting":
    case "parked":
      return "queued";
    case "idle":
      return "completed";
    case "failed":
      return "failed";
    case "archived":
      return "archived";
  }
}

/** How full the engine's context window is: the latest context.updated (never a transcript item). */
export interface ContextUse {
  readonly used_tokens: number;
  readonly window_tokens: number;
  /** Where the engine compacts by itself, below the window. */
  readonly compact_at_tokens?: number;
}

interface SessionStore {
  /** The transcript so far; a new one after the chat's journal was rewritten (a new epoch). */
  readonly model: SessionModel;
  readonly epoch: number | undefined;
  /** Changes only for replayed history, so a returning view skips old arrivals. */
  readonly historyVersion: number;
  context: ContextUse | null;
  /** Where its events come from now and how that is going (state/sync/chat-feed.ts); null before it opened. */
  readonly feed: FeedState | null;
  readonly subscribe: (l: () => void) => () => void;
  /** Null until the session's history has loaded once: a chat opens whole, never row by row. */
  readonly get: () => SessionView | null;
  /** Whether `get` has a view, without making one. */
  readonly ready: () => boolean;
  /** Attach while anyone holds it; the returned function lets go. */
  /**
   * `view`: a pane or card is opening it (its time to first content is measured), and once the last view lets go it
   * stays attached a while (LIVE_UNSEEN); a prefetch is not, and detaches as it lets go.
   */
  readonly retain: (view?: boolean) => () => void;
  /** Attached: held, or let go by its views and still live. */
  readonly held: () => boolean;
  /** The person's message on screen as it is sent; the returned function takes it back (a failed or queued send). */
  readonly echo: (id: string, text: string) => () => void;
  /** A stop sent with request id `id`, shown at once (S14); the returned function takes it back (the stop was refused). */
  readonly stop: (id: string) => () => void;
}

// One store per session per window, shared by every component that shows
// it (the pane's chat, its Overview cards, the inbox preview), so a session is
// attached once however many views it has. The last KEEP_SESSIONS let go keep
// their transcript: switching back re-attaches from where it stopped, with no
// replay, so opening a chat seen this run is instant. With a sync hub the
// chat's feed reads it from wherever it runs (or Cloud's copy) and keeps it in
// this device's cache; a fixture client reads it from that client alone.
const sessionStores = new WeakMap<object, Map<string, SessionStore>>();
/** The window's sync hub for its own client and for every chat client it hands out (SyncHub.clientFor). */
const hubOf = new WeakMap<Client, SyncHub>();
// ponytail: a count, not bytes; a byte budget if people keep thousand-turn chats around.
const KEEP_SESSIONS = 24;
/** A history with no attach answer naming its head this long after opening shows what has come rather than not at all. */
const LOAD_PATIENCE_MS = 1500;
/** Recent chats loaded in the background once the app is up (well inside KEEP_SESSIONS). */
const PREFETCH_RECENT = 8;
/**
 * Chats whose views let go that stay attached: a chat switched away from (its pane keeps it rendered, hidden, and
 * React's Activity stops its effects), the split view behind the Chief. Shown again, it is live at once: no re-attach
 * to wait for, no catch-up landing after it paints, no "Reconnecting" line pushing the chat up and back. The most
 * recent ones stay; older ones detach (and re-attach from where they stopped when shown).
 */
const LIVE_UNSEEN = 8;
const unseen = unseenSessions(LIVE_UNSEEN);

function sessionStore(client: Client, sessionId: string): SessionStore {
  const hub = hubOf.get(client) ?? null;
  const owner: object = hub ?? client;
  let byId = sessionStores.get(owner);
  if (!byId) sessionStores.set(owner, (byId = new Map()));
  const known = byId.get(sessionId);
  if (known) {
    // Most recently used last: the Map's order is the eviction order.
    byId.delete(sessionId);
    byId.set(sessionId, known);
    return known;
  }
  let model = new SessionModel();
  let historyVersion = 0;
  let feedState: FeedState | null = null;
  let feed: ChatFeed | null = null;
  /** The epoch of what `model` holds, kept while nobody holds the store so the next open resumes on it. */
  let epoch: number | undefined;
  const listeners = new Set<() => void>();
  let frame = 0;
  let refs = 0;
  // The attach reply names the head; the backlog up to it arrives after. Until it has, views see nothing: one render of
  // the whole chat, not one per frame of a replay.
  let loaded = false;
  let head = Number.POSITIVE_INFINITY;
  /** The history has taken longer than LOAD_PATIENCE_MS: with no head to wait for, what has arrived shows as it comes. */
  let overdue = false;
  /** A view held it since it attached: once let go, it stays attached for a while (LIVE_UNSEEN). */
  let viewed = false;
  /** A view opened it before it had loaded: when, to measure the time to first content (S14). */
  let openedAt: number | null = null;
  let fromCache = false;
  const firstContent = () => {
    if (openedAt === null) return;
    const via: LatencyVia = fromCache ? "cache" : feedState?.kind === "copy" ? "copy" : hub ? hub.viaFor(sessionId) : "loopback";
    latency.record("open", via, performance.now() - openedAt);
    openedAt = null;
  };
  const notify = () => {
    if (!loaded) {
      if (Math.max(0, model.lastCursor) < head && !(overdue && head === Number.POSITIVE_INFINITY && model.lastCursor > 0)) return;
      loaded = true;
      firstContent();
    }
    // Deltas arrive many per frame; render at most once per frame.
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      listeners.forEach((l) => l());
    });
  };
  const showAnyway = () => {
    if (loaded) return;
    loaded = true;
    if (model.lastCursor > 0) firstContent();
    notify();
  };
  // A slow history keeps the pane's loading line until all of it is in (up to the head the attach named). Shown at the
  // patience with nothing in it, the chat sat empty, with no loading line, for as long as the attach took (seconds on a
  // busy runtime); shown with part of it, the chat opened its seen register (Transcript seen.ts) on that part, and the
  // rest of its history played in word by word as if it had just arrived. Only a feed with no head to wait for (no
  // attach answer yet) shows what has come once the patience is over.
  const patienceOver = () => {
    overdue = true;
    notify();
  };
  const sink: FeedSink = {
    reset: () => {
      // The journal was rewritten: nothing shown from the old one stays (sends still queued show again).
      model = new SessionModel();
      historyVersion++;
      store.context = null;
      head = Number.POSITIVE_INFINITY;
      showQueued();
      notify();
    },
    apply: (event, historical) => {
      if (historical) historyVersion++;
      if (event.type === "context.updated") store.context = event.payload;
      model.apply(event);
      notify();
    },
    attached: (session) => {
      head = session.head;
      model.setForkedAt(session.forked_from?.cursor ?? 0);
      // The attach reply holds the mode now; the backlog replayed after it must not override it.
      model.setMode(session.mode ?? "default", session.head);
      model.setAccess(session.access);
      model.setMovedFrom(session.moved_from?.runtime_id ?? null);
      notify();
    },
    painted: () => {
      fromCache = true;
      showAnyway();
    },
  };
  // Sends this window queued in Cloud for the chat: shown in its transcript as the person's messages, dimmed, with
  // where they wait, until the runtime's own message for each takes its place (same item id).
  const showQueued = () => {
    if (!hub) return;
    let changed = false;
    for (const q of hub.queuedCalls(sessionId)) {
      if (q.text !== undefined && q.itemId !== undefined) changed = model.queued(q.itemId, q.text, q.line) || changed;
    }
    if (changed) notify();
  };
  let offQueued: (() => void) | null = null;
  const onState = (state: FeedState) => {
    feedState = state;
    // Cloud's copy and an ended subscription have no head to wait for: show what there is.
    if (state.kind === "copy" || state.kind === "ended") showAnyway();
    listeners.forEach((l) => l());
  };
  /** Nobody holds it any more: stop reading its events, keeping the transcript so far for the next open. */
  const detach = () => {
    viewed = false;
    epoch = feed?.position().epoch;
    offQueued?.();
    offQueued = null;
    if (hub) hub.close(sessionId);
    else feed?.close();
    feed = null;
    // Over the budget: drop the least recently used sessions nobody holds.
    for (const [id, s] of byId) {
      if (byId.size <= KEEP_SESSIONS) break;
      if (s !== store && !s.held()) byId.delete(id);
    }
  };
  const store: SessionStore = {
    get epoch() { return feed?.position().epoch ?? epoch; },
    get model() {
      return model;
    },
    get historyVersion() {
      return historyVersion;
    },
    context: null,
    get feed() {
      return feedState;
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: () => (loaded ? model.snapshot() : null),
    ready: () => loaded,
    retain: (view = false) => {
      if (view && !loaded && openedAt === null) openedAt = performance.now();
      if (view) viewed = true;
      if (refs++ === 0) {
        // Let go by its views a moment ago and still attached: nothing to open, nothing to catch up on.
        if (!unseen.take(store)) {
          if (!loaded) setTimeout(patienceOver, LOAD_PATIENCE_MS);
          const start = { epoch, cursor: Math.max(0, model.lastCursor) };
          if (hub) {
            feed = hub.openFeed(sessionId, sink, onState, start);
            offQueued = hub.subscribe(showQueued);
            showQueued();
            // A chat this window just started in Cloud has no history to wait for: its first message shows now.
            if (hub.startOf(sessionId)) showAnyway();
          }
          else {
            feed = new ChatFeed({ sessionId, sink, onState, start });
            feed.use({ kind: "runtime", runtimeId: "direct", client });
          }
        }
      }
      return () => {
        if (--refs > 0) return;
        if (!viewed) return detach();
        unseen.keep(store, detach);
      };
    },
    held: () => refs > 0 || unseen.has(store),
    stop: (id) => {
      const shownIn = model;
      shownIn.stop(id);
      notify();
      return () => {
        shownIn.unstop(id);
        notify();
      };
    },
    echo: (id, text) => {
      const shownIn = model;
      shownIn.echo(id, text);
      notify();
      return () => {
        shownIn.unecho(id);
        notify();
      };
    },
  };
  byId.set(sessionId, store);
  return store;
}

/**
 * Loads a session's history before its first view (a chat row under the pointer, the recent chats once the app is
 * idle), so opening it shows the whole chat at once. Lets go once loaded; the store keeps it (KEEP_SESSIONS).
 */
export function prefetchSession(client: Client | null, sessionId: string | null | undefined, then?: () => void): void {
  if (!client || !sessionId) return void then?.();
  const store = sessionStore(client, sessionId);
  if (store.get() !== null || store.held()) return void then?.();
  const release = store.retain();
  const done = () => {
    off();
    clearTimeout(timer);
    release();
    then?.();
  };
  const off = store.subscribe(() => {
    if (store.get() !== null) done();
  });
  const timer = setTimeout(done, LOAD_PATIENCE_MS * 2);
}

/**
 * The model and effort a session's latest turn started on, only where some view already loaded it
 * (never attaches): who-runs-it marks for a delegated agent with no runner from the runtime.
 */
export function loadedTurn(client: Client | null, sessionId: string | null | undefined): SessionView["turn"] {
  return (client && sessionId ? sessionStores.get(hubOf.get(client) ?? client)?.get(sessionId)?.get()?.turn : null) ?? null;
}

const noSubscribe = () => () => undefined;
const noView = () => null;

/** `loadedTurn`, kept current: a view open while the history is still on its way (a row's hover prefetch) updates once it lands. Never attaches either. */
export function useLoadedTurn(client: Client | null, sessionId: string | null | undefined): SessionView["turn"] {
  const store = client && sessionId ? (sessionStores.get(hubOf.get(client) ?? client)?.get(sessionId) ?? null) : null;
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, () => store?.get()?.turn ?? null);
}

/** Whether a session's history is in (its view would show it whole), without attaching or making a view. */
export function useSessionReady(client: Client | null, sessionId: string | null | undefined): boolean {
  const store = useMemo(() => (client && sessionId ? sessionStore(client, sessionId) : null), [client, sessionId]);
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, () => store?.ready() ?? false);
}

/** Live transcript for one session: attaches from the start, folds events, detaches when the last view goes. */
export function useSession(sessionId: string | null): {
  view: SessionView | null;
  model: SessionModel | null;
  epoch: number | undefined;
  historyVersion: number;
  context: ContextUse | null;
  echo: SessionStore["echo"] | null;
  stop: SessionStore["stop"] | null;
  /** Where the chat is read from now and how that is going: the pane's state line (live, reconnecting, Cloud's copy). */
  feed: FeedState | null;
} {
  const { client } = useRuntimeClient();
  const store = useMemo(() => (client && sessionId ? sessionStore(client, sessionId) : null), [client, sessionId]);
  useEffect(() => store?.retain(true), [store]);
  const view = useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.get : noView);
  const feed = useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? () => store.feed : noView);
  return { view, model: store?.model ?? null, epoch: store?.epoch, historyVersion: store?.historyVersion ?? 0, context: store?.context ?? null, echo: store?.echo ?? null, stop: store?.stop ?? null, feed };
}

/** The runtime's item id for the message a turn.submit sends (state/sync/message-id.ts). */
export { submittedMessageId } from "./sync/message-id.ts";

export function requestId(): string {
  return crypto.randomUUID();
}
