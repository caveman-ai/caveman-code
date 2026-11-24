// The person's Chiefs on this connection (chief.list, then chief.list.updated after
// every change), and what each last said (its own workspace's activity): the
// sidebar's Chiefs section and each Chief's settings read it. One store per
// client, like the board's (chief.ts).

import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import type { ChiefAvatar, ChiefItem, ChiefProfile, Params, Workspace } from "@caveman-app/session-protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { requestId, useRuntimeClient } from "./runtime.tsx";

export interface ChiefsState {
  /** absent: a runtime from before several Chiefs (no chief.list); the sidebar shows its one Chief. */
  readonly status: "loading" | "ready" | "absent" | "error";
  /** The home Chief first, then oldest first. */
  readonly chiefs: ReadonlyArray<ChiefProfile>;
  /** Chiefs thinking right now (their workspace is working), from workspace.changed as it happens. */
  readonly working: ReadonlySet<string>;
  /** What each Chief last said and when, by its id (its workspace's): the line under its sidebar row. */
  readonly latest: ReadonlyMap<string, ChiefLatest>;
  readonly error: string | null;
}

/** A Chief's last word: its latest reply on one line (Workspace.activity.last_reply), and when its conversation last moved. */
export interface ChiefLatest {
  readonly reply: string | undefined;
  readonly at: string;
}

const EMPTY: ChiefsState = { status: "loading", chiefs: [], working: new Set(), latest: new Map(), error: null };
const NONE: ChiefsState = { status: "absent", chiefs: [], working: new Set(), latest: new Map(), error: null };

/** When a Chief's conversation last moved: its latest turn's end or start, else its workspace's last change. */
export function latestOf(w: Pick<Workspace, "updated_at" | "activity">): ChiefLatest {
  const turns = [w.activity?.turn_ended_at, w.activity?.turn_started_at].filter((at): at is string => at !== undefined).sort();
  return { reply: w.activity?.last_reply, at: turns.at(-1) ?? w.updated_at };
}

interface Store {
  state: ChiefsState;
  readonly listeners: Set<() => void>;
  /** Each Chief workspace's `updated_at` as last applied: an answer older than it (a slow workspace.get) is stale. */
  readonly seen: Map<string, string>;
  connection: number;
  refs: number;
  stop: (() => void) | null;
}
const stores = new WeakMap<Client, Store>();

function storeFor(client: Client): Store {
  let s = stores.get(client);
  if (!s) stores.set(client, (s = { state: EMPTY, listeners: new Set(), seen: new Map(), connection: -1, refs: 0, stop: null }));
  return s;
}

function set(s: Store, patch: Partial<ChiefsState>) {
  s.state = { ...s.state, ...patch };
  s.listeners.forEach((l) => l());
}

/** One Chief replaced in the list (an edit shown at once, or the runtime's answer to it). */
function put(s: Store, chief: ChiefProfile) {
  const at = s.state.chiefs.findIndex((c) => c.id === chief.id);
  set(s, { chiefs: at < 0 ? [...s.state.chiefs, chief] : s.state.chiefs.map((c) => (c.id === chief.id ? chief : c)) });
}

/** One Chief workspace's news: whether it thinks, and its last word. Unchanged values keep the store as it is. */
function heard(s: Store, w: Workspace) {
  // A workspace.get that left before a workspace.changed can land after it: the older one changes nothing.
  const last = s.seen.get(w.id);
  if (last !== undefined && w.updated_at < last) return;
  s.seen.set(w.id, w.updated_at);
  const thinking = w.status === "working";
  const was = s.state.latest.get(w.id);
  const now = latestOf(w);
  const sameLatest = was !== undefined && was.reply === now.reply && was.at === now.at;
  if (thinking === s.state.working.has(w.id) && sameLatest) return;
  const working = new Set(s.state.working);
  if (thinking) working.add(w.id);
  else working.delete(w.id);
  set(s, { working, latest: sameLatest ? s.state.latest : new Map(s.state.latest).set(w.id, now) });
}

/** Each Chief's own workspace (a profile is keyed by it), for what it last said; one that can't be read keeps no line. */
function readLatest(client: Client, s: Store, chiefs: ReadonlyArray<ChiefProfile>, again = false) {
  for (const c of chiefs) {
    if (!again && s.state.latest.has(c.id)) continue;
    client.call("workspace.get", { workspace_id: c.id }).then((w) => heard(s, w), () => undefined);
  }
}

function load(client: Client, s: Store) {
  client.call("chief.list", {}).then(
    (r) => {
      set(s, { status: "ready", chiefs: r.chiefs, error: null });
      // A new connection may have missed what they said meanwhile: read each again.
      readLatest(client, s, r.chiefs, true);
    },
    (e: unknown) => {
      const reason = e instanceof SessionProtocolError ? e.error.data?.reason : undefined;
      if (reason === "unsupported" || (e instanceof SessionProtocolError && e.error.code === -32601)) set(s, NONE);
      else if (s.state.status !== "ready") set(s, { status: "error", error: e instanceof Error ? e.message : String(e) });
    },
  );
}

function retain(client: Client, s: Store): () => void {
  if (s.refs++ === 0) {
    const offList = client.on("chief.list.updated", (r) => {
      set(s, { status: "ready", chiefs: r.chiefs, error: null });
      readLatest(client, s, r.chiefs);
    });
    // The chat list leaves Chiefs out, so their status and last word are followed here.
    const offStatus = client.on("workspace.changed", (w) => {
      if (w.kind === "chief") heard(s, w);
    });
    s.stop = () => {
      offList();
      offStatus();
    };
  }
  return () => {
    if (--s.refs > 0) return;
    s.stop?.();
    s.stop = null;
  };
}

export type ChiefPatch = Omit<Params<"chief.update">, "request_id" | "chief_id">;

/** The Chiefs, and the calls that make, edit and remove one. Every edit shows at once and rolls back if refused. */
export function useChiefs(): ChiefsState & {
  /**
   * A new Chief; what is left out takes the runtime's defaults (a free short name, an unused character, no role, the
   * starter soul). `project_id`: a runtime that gives each Chief one project puts it there (else its latest project).
   */
  readonly create: (input?: {
    readonly name?: string;
    readonly avatar?: ChiefAvatar;
    readonly role?: string;
    readonly soul?: string;
    readonly project_id?: string;
  }) => Promise<ChiefProfile>;
  readonly update: (id: string, patch: ChiefPatch) => Promise<ChiefProfile>;
  readonly remove: (id: string) => Promise<void>;
  /** Puts a chat you started on a Chief's board (chief.attach): it hears the chat's updates from then. */
  readonly attachChat: (chief: Pick<ChiefProfile, "id">, workspaceId: string) => Promise<ChiefItem>;
  /**
   * Who manages a group by topic (chief.manage, ChiefProfile.topics): `chief`'s, or no one (null). `handOver`: chats
   * already in it to put on that Chief's board too, the ones the person was shown. Resolves to the chats that went.
   */
  readonly manage: (topic: string, chief: Pick<ChiefProfile, "id"> | null, handOver?: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;
} {
  const { client: runtimeClient, connection, chiefHere = true } = useRuntimeClient();
  // A Cloud computer this tab fell back to has no Chiefs: asking would make one there.
  const client = chiefHere ? runtimeClient : null;
  const store = useMemo(() => (client ? storeFor(client) : null), [client]);
  useEffect(() => (client && store ? retain(client, store) : undefined), [client, store]);
  useEffect(() => {
    if (!client || !store || store.connection === connection) return;
    store.connection = connection;
    load(client, store);
  }, [client, store, connection]);
  const state = useSyncExternalStore(
    (l) => {
      if (!store) return () => undefined;
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
    () => store?.state ?? (chiefHere ? EMPTY : NONE),
    () => store?.state ?? (chiefHere ? EMPTY : NONE),
  );
  const need = () => {
    if (!client || !store) throw new Error("Not connected to a runtime");
    return { client, store };
  };
  return {
    ...state,
    create: async (input = {}) => {
      const { client, store } = need();
      const { chief } = await client.call("chief.create", { request_id: requestId(), ...input });
      put(store, chief);
      return chief;
    },
    update: async (id, patch) => {
      const { client, store } = need();
      const before = store.state.chiefs.find((c) => c.id === id);
      if (before) put(store, { ...before, ...patch } as ChiefProfile);
      try {
        const { chief } = await client.call("chief.update", { request_id: requestId(), chief_id: id, ...patch });
        put(store, chief);
        return chief;
      } catch (e) {
        if (before) put(store, before);
        throw e;
      }
    },
    remove: async (id) => {
      const { client, store } = need();
      await client.call("chief.remove", { request_id: requestId(), chief_id: id });
      set(store, { chiefs: store.state.chiefs.filter((c) => c.id !== id) });
    },
    attachChat: async (chief, workspaceId) => {
      const { client } = need();
      return (await client.call("chief.attach", { request_id: requestId(), chief_id: chief.id, workspace_id: workspaceId })).item;
    },
    manage: async (topic, chief, handOver = []) => {
      const { client, store } = need();
      const { chiefs, handed } = await client.call("chief.manage", { request_id: requestId(), topic, chief_id: chief?.id ?? null, ...(handOver.length > 0 ? { hand_over: [...handOver] } : {}) });
      set(store, { chiefs });
      return handed;
    },
  };
}

/** The Chief a route names, else the home Chief; null while the list loads or on a runtime without profiles. */
export function chiefFor(chiefs: ReadonlyArray<ChiefProfile>, id: string | undefined): ChiefProfile | null {
  return (id ? chiefs.find((c) => c.id === id) : undefined) ?? chiefs.find((c) => c.home) ?? null;
}

/** Where a Chief's page is: the home Chief keeps /chief. */
export const chiefPath = (chief: Pick<ChiefProfile, "id" | "home">) => (chief.home ? "/chief" : `/chief/${encodeURIComponent(chief.id)}`);

/**
 * Whether the Chief an address names was removed, here or in another window: its pages (its chat, its board) leave
 * for home. Never while the list is still loading.
 */
export function useChiefGone(chiefId: string | undefined): boolean {
  const chiefs = useChiefs();
  return chiefId !== undefined && chiefs.status === "ready" && !chiefs.chiefs.some((c) => c.id === chiefId);
}

/** The same Chief's board, filling the main pane without its conversation. */
export const chiefBoardPath = (chief: Pick<ChiefProfile, "id" | "home">) => `${chiefPath(chief)}/board`;

/** Mission control on a Chief's page (`?mission`): in its conversation's place, so a call's stage there goes too. */
export const MISSION_PARAM = "mission";

/** The Chief a call is with (VoiceCall.chief_id; none from a one-Chief runtime: home), and where its page is. */
export function callChief(chiefs: ReadonlyArray<ChiefProfile>, chiefId: string | undefined): { readonly name: string | undefined; readonly path: string } {
  const chief = chiefId ? chiefs.find((c) => c.id === chiefId) : chiefs.find((c) => c.home);
  return { name: chief?.name, path: chief ? chiefPath(chief) : "/chief" };
}
