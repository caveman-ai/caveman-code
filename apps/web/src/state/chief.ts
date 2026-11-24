// A Chief on this connection: its workspace, its profile, whether it can think,
// and its items on the shared board (chief.get, then chief.board.updated after
// every change). One store per client and Chief, shared by the sidebar's counts
// and the Chief's page.

import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import type { ChiefBoard, ChiefChangeSet, ChiefProfile, ChiefRoutine, ChiefVoice, Result, Workspace } from "@caveman-app/session-protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChiefAvailability, ChiefItem } from "./chief-model.ts";
import type { CloudRuntime } from "./cloud.ts";
import type { RuntimeState } from "./sync/wire.ts";
import { requestId, useRuntimeClient } from "./runtime.tsx";

export interface ChiefState {
  /**
   * absent: this runtime has no Chief (an older one, or its handlers have not landed). elsewhere: this window talks to a
   * Cloud computer it fell back to with nothing picked, where no Chief is made (K2); the person's is on their Mac.
   */
  readonly status: "loading" | "ready" | "absent" | "error" | "elsewhere";
  readonly workspace: Workspace | null;
  /** Its profile (name, character, model, permissions, projects, soul); null on a runtime from before several Chiefs. */
  readonly profile: ChiefProfile | null;
  readonly availability: ChiefAvailability | null;
  /** This Chief's items. */
  readonly items: ReadonlyArray<ChiefItem>;
  /** Every Chief's items (the one shared board): the sidebar counts each Chief's from it. */
  readonly allItems: ReadonlyArray<ChiefItem>;
  /** The board's change sets (one chat per repository, a contract, a merge order): its items name theirs. */
  readonly changeSets: ReadonlyArray<ChiefChangeSet>;
  /** Its project's routines, each with its last run (the board's `routines`). */
  readonly routines: ReadonlyArray<ChiefRoutine>;
  readonly error: string | null;
  /** What its model picker offers, from what is connected (chief.get). */
  readonly picker: NonNullable<Result<"chief.get">["picker"]>;
  /** Its pick; null on Auto. */
  readonly model: NonNullable<Result<"chief.get">["model"]> | null;
  /** Whether you can call it (chief.voice.*); null on a runtime without calls. */
  readonly voice: ChiefVoice | null;
}

const EMPTY: ChiefState = { status: "loading", workspace: null, profile: null, availability: null, items: [], allItems: [], changeSets: [], routines: [], error: null, picker: [], model: null, voice: null };
const ELSEWHERE: ChiefState = { ...EMPTY, status: "elsewhere" };
/** chief.get again this often: a key or credits added elsewhere turns the Chief on. */
const RECHECK_MS = 30_000;

interface Store {
  state: ChiefState;
  readonly listeners: Set<() => void>;
  /** Which Chief: its id, or "" for the home Chief (whatever its id turns out to be). */
  readonly chiefId: string;
  /** The whole board as last heard, every Chief's items: this store shows its own. */
  board: ChiefBoard | null;
  /** chief.board.updated heard so far. */
  updates: number;
  connection: number;
  refs: number;
  stop: (() => void) | null;
}
const stores = new WeakMap<Client, Map<string, Store>>();

function storeFor(client: Client, chiefId: string): Store {
  let byChief = stores.get(client);
  if (!byChief) stores.set(client, (byChief = new Map()));
  let s = byChief.get(chiefId);
  if (!s) byChief.set(chiefId, (s = { state: EMPTY, listeners: new Set(), chiefId, board: null, updates: 0, connection: -1, refs: 0, stop: null }));
  return s;
}

function set(s: Store, patch: Partial<ChiefState>) {
  s.state = { ...s.state, ...patch };
  s.listeners.forEach((l) => l());
}

/**
 * The board's items that are this Chief's. An item with no `chief_id` is from a runtime with one Chief, so it is
 * the home Chief's; until chief.get says who this Chief is, none are.
 */
export function itemsOf(b: ChiefBoard, profile: Pick<ChiefProfile, "id" | "home"> | null, legacy: boolean): ChiefBoard["items"] {
  if (legacy) return b.items;
  if (!profile) return [];
  return b.items.filter((i) => (i.chief_id === undefined ? profile.home : i.chief_id === profile.id));
}

/** What the store shows of a board, from chief.get and chief.board.updated alike. */
function shown(b: ChiefBoard, profile: ChiefProfile | null, legacy: boolean): Pick<ChiefState, "items" | "allItems" | "changeSets" | "routines"> {
  // Every routine's last run: the Routines section joins them to the automations that report to this Chief (routineRows).
  return { items: itemsOf(b, profile, legacy), allItems: b.items, changeSets: b.change_sets, routines: b.routines ?? [] };
}

function setBoard(s: Store, b: ChiefBoard) {
  s.board = b;
  set(s, shown(b, s.state.profile, s.state.status === "ready" && s.state.profile === null));
}

function load(client: Client, s: Store) {
  const updates = s.updates;
  client.call("chief.get", s.chiefId === "" ? {} : { chief_id: s.chiefId }).then(
    (r) => {
      // The runtime reads the board before it waits on the model picker and voice: an update heard while this was out
      // can be newer than the answer's board. Any change after the update's has an update of its own to come.
      const board = s.updates !== updates && s.board ? s.board : r.board;
      s.board = board;
      const profile = r.chief ?? null;
      set(s, {
        status: "ready",
        workspace: r.workspace,
        profile,
        availability: r.availability,
        ...shown(board, profile, profile === null),
        error: null,
        picker: r.picker ?? [],
        model: r.model ?? null,
        voice: r.voice ?? null,
      });
    },
    (e: unknown) => {
      const reason = e instanceof SessionProtocolError ? e.error.data?.reason : undefined;
      // An older runtime has no chief.* at all; this one refuses it until its handlers land.
      if (reason === "unsupported" || (e instanceof SessionProtocolError && e.error.code === -32601)) set(s, { status: "absent", error: null });
      // Someone else's Cloud account through the relay: the Chief is the owner's alone (runtime chief/handlers.ts).
      else if (reason === "forbidden") set(s, { status: "error", error: "the Chief belongs to this computer's owner" });
      // Removed (here or in another window): nothing to show.
      else if (reason === "not_found") set(s, { status: "error", error: "this Chief was removed" });
      else if (s.state.status !== "ready") set(s, { status: "error", error: e instanceof Error ? e.message : String(e) });
    },
  );
}

function retain(client: Client, s: Store): () => void {
  if (s.refs++ === 0) {
    const offBoard = client.on("chief.board.updated", (b) => {
      s.updates++;
      setBoard(s, b);
    });
    // A rename, a new character or model from another window or the settings sheet.
    const offList = client.on("chief.list.updated", (r) => {
      const mine = r.chiefs.find((c) => (s.chiefId === "" ? c.home : c.id === s.chiefId));
      if (!mine || !s.state.profile) return;
      set(s, { profile: mine, model: mine.model });
      if (s.board) setBoard(s, s.board);
    });
    const off = () => {
      offBoard();
      offList();
    };
    const timer = setInterval(() => load(client, s), RECHECK_MS);
    s.stop = () => {
      off();
      clearInterval(timer);
    };
  }
  return () => {
    if (--s.refs > 0) return;
    s.stop?.();
    s.stop = null;
  };
}

/**
 * A Chief (`chiefId`, else the home Chief) and its items; `setItems` shows your own edit at once, until the runtime's
 * board replaces it.
 */
export function useChief(chiefId?: string): ChiefState & {
  readonly client: Client | null;
  readonly setItems: (items: ReadonlyArray<ChiefItem>) => void;
  /** Pins the Chief to a model (null: Auto), shown at once; kept on its profile (chief.update). */
  readonly setModel: (model: ChiefState["model"]) => Promise<void>;
  /** The voice engine's key (null removes it): checked, then kept sealed on the runtime's computer. */
  readonly setVoiceKey: (engine: string, key: string | null) => Promise<void>;
} {
  const { client: runtimeClient, connection, chiefHere = true } = useRuntimeClient();
  // Not here: no client at all, so nothing asks chief.get (which would make a Chief on that computer).
  const client = chiefHere ? runtimeClient : null;
  const key = chiefId ?? "";
  const store = useMemo(() => (client ? storeFor(client, key) : null), [client, key]);
  useEffect(() => (client && store ? retain(client, store) : undefined), [client, store]);
  // Every (re)connect reads it afresh: the notifications sent while away are gone.
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
    () => store?.state ?? (chiefHere ? EMPTY : ELSEWHERE),
    () => store?.state ?? (chiefHere ? EMPTY : ELSEWHERE),
  );
  const setModel = async (model: ChiefState["model"]) => {
    if (!client || !store) return;
    const before = store.state.model;
    set(store, { model });
    const profile = store.state.profile;
    // A runtime from before several Chiefs keeps its one Chief's model in Settings.
    const saved = profile
      ? client.call("chief.update", { request_id: requestId(), chief_id: profile.id, model })
      : client.call("settings.set", { request_id: requestId(), settings: { chief_model: model } });
    await saved.then(
      () => load(client, store),
      (e: unknown) => {
        set(store, { model: before });
        throw e;
      },
    );
  };
  const setVoiceKey = async (engine: string, key: string | null) => {
    if (!client || !store) return;
    set(store, { voice: await client.call("chief.voice.key", { request_id: requestId(), engine, key }) });
  };
  return { ...state, client, setItems: (items) => store && set(store, { items }), setModel, setVoiceKey };
}

/**
 * Where the person's Chief is when this window has none (status elsewhere): their Mac, the one online first, as the
 * computer this tab can pick (chooseRuntime). Null when no Mac of theirs is in Cloud's list.
 */
export function chiefMac(runtimes: Iterable<RuntimeState>): CloudRuntime | null {
  const macs = [...runtimes].filter((r) => r.kind === "laptop").sort((a, b) => Number(b.online) - Number(a.online));
  const mac = macs[0];
  return mac ? { id: mac.runtime_id, name: mac.name, computer_id: mac.computer_id, computer_name: mac.name, computer_driver: "local", last_seen_at: mac.last_seen_at } : null;
}
