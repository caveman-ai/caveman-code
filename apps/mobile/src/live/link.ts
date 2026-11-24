// The phone's link to the person's computers, as the app sees it: who is signed in to Caveman on this phone, every
// chat of theirs on every computer, and what the way to each computer is doing, in a small store the screens read,
// with the actions their buttons call. The work is in cloud.ts (the sign-in, the lists, the relay bearer), deviceKey.ts
// (this phone's key), connection.ts (the protocol's client and handshake), source.ts (a computer's chats on the
// board), start.ts (a chat started from here), away.ts (Cloud's routes for a chat whose computer does not answer) and
// words.ts (every sentence); the heavy ones load the first time someone is signed in, so a scripted morning never
// pays for them.
//
// Signed in, the board is the person's own: every chat Caveman lists for them, on every Mac and in Cloud, in one
// list. Nobody picks a computer, connects to one or wakes one:
//
//   - The list is Caveman's (GET /code/chats), read again every few seconds while the app is up, so a chat started or
//     moved anywhere shows here.
//   - Opening a chat reaches the computer it lives on by itself: a Mac through the relay (the first time, its person
//     allows this phone once), Cloud while it runs. A place that sleeps is not woken by being looked at: the chat
//     says "Asleep", and what the phone last saw of it stays on screen.
//   - Sending is what wakes: a message for a place that does not answer goes through Caveman's queue, which wakes
//     Cloud for it or runs a sleeping Mac's chat in Cloud where that chat can go, and the phone follows the chat to
//     wherever Caveman lists it next. One place holds a chat at a time; the phone never forks one.
//
//   - A chat runs on what its place runs: the pickers list each computer's own agents and models (engines.ts), a new
//     chat's pick settles on its place, and a pick in a chat's own picker goes with its next message.
//
// Signed out, the board stays the person's own and empty beside the sign-in row. The scripted world comes back only
// from Settings > About's Start again.
import type { EngineDescriptor, Settings } from "@caveman-app/session-protocol";

import { boardEngine, forgetScriptedChoices, type ModelRef } from "../board/catalog";
import {
  adoptDevices,
  CLOUD,
  deviceById,
  deviceByLabel,
  ENGINE_NAME,
  startDevices,
  titleFrom,
  type Device,
} from "../board/model";
import {
  adoptCloudOff,
  adoptProjects,
  blocked,
  placeOf as projectOf,
  type Place as Project,
} from "../board/places";
import * as script from "../board/script";
import type { IconName } from "../components/Icon";
import { showChat, showNewChat } from "../nav/ref";
import { notice, setWhere, ui } from "../shell/ui";
import { createStore, useSelector } from "../store/core";
import { getDraft, NEW_CHAT, setDraft } from "../store/sessions";
import { clearForLive, dispatch, store } from "../store/store";
import { agents } from "./agents";
import type {
  Account,
  CloudChat,
  Computer,
  DirectAdvert,
  MoveTo,
  PhoneCloud,
  SignIn,
} from "./cloud";
import { whyNotCloud } from "./away";
import type { Connection, Link } from "./connection";
import * as platform from "./native";
import {
  catalogOf,
  cloudNeed,
  noAgentLine,
  offerOf,
  settlePick,
  stillChecking,
  type Offer,
  type Spot,
} from "./engines";
import {
  computerIdOf,
  connected,
  deviceIdOf,
  deviceOf,
  goLive,
  isLive,
  markReached,
  startsWith,
  wasReached,
  type Followed,
  type LiveStart,
  type Runtime,
} from "./seams";
import type { Board, Carried, LiveSource, SourceWords } from "./source";
import { didNotStart, ENGINE_ID, isStarting, startChat } from "./start";
import {
  CLOUD_FAILED,
  CLOUD_NAME,
  CLOUD_OFF,
  cloudLine,
  cloudRowLine,
  lidAgentsOff,
  lidWords,
  macWord,
  movingNote,
  noteOf,
  OFFLINE_AFTER_MS,
  placeOf,
  placeWord,
  planName,
  problemWords,
  queuedAnswer,
  startWords,
  WAKING_CLOUD,
  waitingLine,
  whereMark,
  whereName,
  type Note,
  type Place,
} from "./words";

/**
 * What a Mac does with its chats when it sleeps, as its person chose there: `moves`, whether they keep going in Cloud
 * (the desktop's lidMoves: only while chats are saved to Caveman and the lid's own setting is not off; `unset` reads
 * as off), and `agentsOff`, Claude Agent and Codex chats set to stay there all the same.
 */
export interface Lid {
  readonly moves: "on" | "off" | "unset";
  readonly agentsOff: boolean;
}

export interface LinkState {
  /** Who is signed in to Caveman on this phone; null: nobody; undefined: not read yet. */
  account: Account | null | undefined;
  /** A sign-in under way: the code to confirm on Caveman's page, and the page. */
  signingIn: { code: string; url: string } | null;
  /** The person's computers as Caveman last listed them, whatever state each is in; null: not listed yet. */
  computers: readonly Computer[] | null;
  /** A chat can start in Cloud from here: this Caveman runs Cloud, and lets this sign-in ask. */
  cloud: boolean;
  /** This Caveman said it runs no Cloud for this organization: Cloud is listed as that, and cannot be picked. */
  cloudOff: boolean;
  /** What each computer last said its agents are (engine.list), by computer id: what a chat there can run on. */
  engines: Readonly<Record<string, ReadonlyArray<EngineDescriptor>>>;
  /** The person's open chats as Caveman last listed them, on every computer; null: not listed yet. */
  chats: readonly CloudChat[] | null;
  /** What the way to each computer this phone has reached for is doing, by computer id. */
  links: Readonly<Record<string, Link>>;
  /** Since when each Cloud computer on its way up has been, by computer id: a wait's seconds. */
  waking: Readonly<Record<string, number>>;
  /** The chats this phone asked Caveman to run somewhere else, each since when and where to, until it is there or was refused. */
  moving: Readonly<Record<string, { readonly since: number; readonly to: string }>>;
  /** Why Caveman would not run a chat somewhere else when this phone last asked, in its own words. */
  refused: Readonly<Record<string, string>>;
  /** What each Mac that answered said its person chose for when it sleeps (its own Settings > Computers), by computer id. */
  lids: Readonly<Record<string, Lid>>;
  /** Since when Caveman could not be reached from this phone (no network); null while it can. */
  offlineSince: number | null;
  /** The last thing that could not be done, in plain words. */
  problem: string | null;
}

const links = createStore<LinkState, Partial<LinkState>>(
  {
    account: undefined,
    signingIn: null,
    computers: null,
    cloud: false,
    cloudOff: false,
    engines: {},
    chats: null,
    links: {},
    waking: {},
    moving: {},
    refused: {},
    lids: {},
    offlineSince: null,
    problem: null,
  },
  (state, patch) => ({ ...state, ...patch }),
);
const set = (patch: Partial<LinkState>) => links.dispatch(patch);

/** A slice of the link's state; re-renders only when it changes. */
export const useLink = <T>(pick: (state: LinkState) => T, equal?: (a: T, b: T) => boolean) =>
  useSelector(links, pick, equal);

/** Caveman's own Cloud, unless the build names another (a test Cloud in development). */
const CLOUD_URL = process.env.EXPO_PUBLIC_CAVEMAN_CLOUD_URL;

let cloud: Promise<PhoneCloud> | null = null;
/** The phone's one Cloud client, made the first time it is asked for. Review's routes are read through it too (pulls/live.ts). */
export const theCloud = () =>
  (cloud ??= (async () => {
    await platform.installCrypto();
    const { phoneCloud } = await import("./cloud");
    return phoneCloud({ ...(CLOUD_URL ? { url: CLOUD_URL } : null), secrets: platform.secrets });
  })());

/** What connects to a computer and holds its chats: loaded once somebody is signed in. */
type Parts = Awaited<ReturnType<typeof loadParts>>;
const loadParts = async () => {
  const [{ openConnection }, { deviceKeyOnce, loadDeviceKey }, { liveSource }, { cloudAway }] =
    await Promise.all([
      import("./connection"),
      import("./deviceKey"),
      import("./source"),
      import("./away"),
    ]);
  return {
    openConnection,
    liveSource,
    cloudAway,
    key: deviceKeyOnce(() => loadDeviceKey(platform.secrets, platform.deviceName())),
  };
};
let parts: Promise<Parts> | null = null;
const theParts = () => (parts ??= loadParts());

/** What the install says about direct channels, from the last list of computers. */
let direct: DirectAdvert | undefined;

/**
 * One of the person's computers: its chats on the board (`source`, from Caveman's list, and from its runtime while one
 * is reached), and the connection to its runtime while there is one to reach and something of the person's needs it
 * (`wanted`: a chat of its on screen, a message, a chat being started). `answered`: it has answered a call.
 */
interface Conn {
  computer: Followed;
  source: LiveSource;
  made: Connection | null;
  /** The runtime `made` was opened to. */
  runtime: string;
  wanted: boolean;
  asking: boolean;
  answered: boolean;
  projects?: true;
}
const conns = new Map<string, Conn>();

const board: Board = {
  chats: () => store.get().board.chats,
  dispatch: (change) => dispatch(change),
};

/** Something that could not be done, in the shell's toast: one line, once. Waits and states are never toasts. */
const say = (text: string, icon: IconName = "alert") =>
  notice({ id: `link-${Date.now()}`, text, icon, tone: "info" });

const followedOf = (c: Computer): Followed => ({
  runtime_id: c.runtime_id,
  computer_id: c.computer_id,
  kind: c.kind,
  name: c.name,
});

/** The computer that holds a chat on the board. */
const ownerOf = (chatId: string): Conn | undefined => {
  for (const conn of conns.values()) if (conn.source.owns(chatId)) return conn;
  return undefined;
};

/** A computer's place as Caveman lists it: a Mac that answers this phone is there, whatever Caveman last heard. */
function placeFor(state: LinkState, computerId: string): Place {
  if (state.links[computerId]?.phase === "open") return { is: "running" };
  const usage = agents.get().account;
  const listed = state.computers?.find((c) => c.computer_id === computerId);
  const place = placeOf(listed);
  if (place.is !== "paused" || place.until !== undefined) return place;
  // When the plan that is used up serves again: what Cloud says beside one of its chats there (its `where`), else
  // what one of the person's computers said (account.get).
  const until = state.chats?.find(
    (c) => c.computer_id === computerId && c.where.resets_at !== undefined,
  )?.where.resets_at;
  return { is: "paused", ...(until ? { until } : resetOf(usage)) };
}

/** The person's plan by its name ("Pro"), where one of their computers said (account.get): what "Cloud is full on" names. */
const planNow = () => planName(agents.get().account?.credits?.plan);

/** When the plan's usage next resets, from what a computer said of the account; nothing where none did. */
function resetOf(account: unknown): { until?: string } {
  const windows = (
    account as {
      credits?: { windows?: ReadonlyArray<{ resets_at?: unknown; used_pct?: unknown }> };
    } | null
  )?.credits?.windows;
  const spent = windows
    ?.filter(
      (w) => typeof w.resets_at === "string" && typeof w.used_pct === "number" && w.used_pct >= 100,
    )
    .map((w) => w.resets_at as string)
    .sort();
  const until = spent?.at(-1);
  return until ? { until } : {};
}

/** The words of a message that waits for one computer: Cloud that is paused says so, never that it is waking. */
const wordsFor = (computerId: string): SourceWords => ({
  waiting: (call, where, chat) => {
    const place = placeFor(links.get(), computerId);
    // Cloud took a message for a Mac that sleeps and names nothing it waits on: it is running the chat itself.
    const taken =
      !where.cloud &&
      (call.status === "queued" || call.status === "delivered") &&
      !call.waiting &&
      place.is !== "running";
    const line = waitingLine(
      taken ? { ...call, waiting: { reason: "laptop_asleep" } } : call,
      where,
      chat,
    );
    if (!where.cloud || line === null || call.status === "expired" || call.status === "failed")
      return line;
    // Cloud that is paused, or that could not start and is being tried again, says so: never that it is waking.
    return place.is === "paused" ? placeWord(place) : place.is === "failed" ? CLOUD_FAILED : line;
  },
  // Cloud that is paused is not being woken: the answer is queued, and the chat's own line says until when.
  answer: (said, where) =>
    where.cloud && placeFor(links.get(), computerId).is === "paused"
      ? queuedAnswer(said, where).split(" · ")[0]!
      : queuedAnswer(said, where),
  unreached: "No network. Sends when you're back online.",
});

// ---------------------------------------------------------------- the person's computers, on the board

/** Where a new chat starts by default: the first Mac that is online, else Cloud. Set again only when that changes. */
let defaulted = "";
function settleWhere(repo?: string) {
  const starts = startDevices();
  // Never Cloud that is switched off, while anything else is listed.
  const first =
    starts.find((d) => d.kind === "mac" && d.status === "online") ??
    starts.find((d) => d === CLOUD && !blocked(undefined, d)) ??
    starts[0];
  if (!first) return;
  const where = ui.get().where;
  const known = deviceByLabel(where.computer);
  // A pick that still stands is the person's own: only what can no longer take a chat gives way.
  if (
    first.id === defaulted &&
    !repo &&
    known &&
    starts.includes(known) &&
    !blocked(projectOf(where.repo), known)
  )
    return;
  defaulted = first.id;
  const project = repo ?? where.repo;
  const on = blocked(projectOf(project), first)
    ? (starts.find((d) => !blocked(projectOf(project), d)) ?? first)
    : first;
  setWhere({ repo: project, computer: on.name });
}

/** The person's Macs, each by its name, and Cloud as the one place it is: what the board calls where a chat runs. */
function adopt() {
  const state = links.get();
  if (!isLive()) return;
  const status = (place: Place): Device["status"] =>
    place.is === "running"
      ? "online"
      : place.is === "waking" || place.is === "failed"
        ? "starting"
        : place.is === "offline"
          ? "offline"
          : "asleep";
  const computers = state.computers ?? [];
  const macs = computers
    .filter((c) => c.kind === "laptop")
    .map((c) =>
      deviceOf(
        followedOf(c),
        status(placeFor(state, c.computer_id)),
        Date.parse(c.last_seen_at) || undefined,
      ),
    );
  // Cloud is one place, however many computers are behind it: a new chat's is Caveman's choice.
  const inCloud = state.cloud || computers.some((c) => c.kind === "cloud");
  // Cloud that this Caveman switched off is still listed where a chat's place is picked, as its reason.
  const off = !inCloud && state.cloudOff;
  adoptCloudOff(off);
  adoptDevices(
    [...macs, ...(inCloud ? [CLOUD] : [])],
    [...macs, ...(inCloud || off ? [CLOUD] : [])],
  );
  settleWhere();
}

/** The board's id for a computer's chats: a Mac's own; Cloud's one, whichever of its computers. */
const boardDevice = (c: Pick<Computer, "computer_id" | "kind">) =>
  c.kind === "cloud" ? CLOUD.id : deviceIdOf(c);

/** A computer's chats on the board, made the first time Caveman lists the computer. */
function ensure(c: Computer, from: PhoneCloud, p: Parts): Conn {
  const had = conns.get(c.computer_id);
  if (had) {
    had.computer = followedOf(c);
    return had;
  }
  const conn: Conn = {
    computer: followedOf(c),
    made: null,
    runtime: "",
    wanted: false,
    asking: false,
    answered: false,
    source: undefined as unknown as LiveSource,
  };
  conn.source = p.liveSource({
    board,
    device: boardDevice(c),
    computer: { computer_id: c.computer_id, name: whereName(c), kind: c.kind },
    reachable: () => conn.made?.state().phase === "open",
    settled: () => settled(conn),
    away: p.cloudAway(from, p.key),
    project: (w) =>
      w.project_id ? projectNames.get(`${c.computer_id}:${w.project_id}`) : undefined,
    onError: (message) => say(message),
    words: wordsFor(c.computer_id),
  });
  conns.set(c.computer_id, conn);
  return conn;
}

/** A link opened a moment ago has settled: it answers, or it is known not to. */
const settled = (conn: Conn) =>
  new Promise<void>((resolve) => {
    const made = conn.made;
    if (!made || made.state().phase !== "connecting") return resolve();
    const off = made.subscribe((state) => {
      if (state.phase === "connecting") return;
      off();
      resolve();
    });
  });

/** Lets a computer's connection go (it sleeps, or nobody is signed in): its chats stay, as Caveman lists them. */
function letGo(conn: Conn) {
  const made = conn.made;
  if (!made) return;
  conn.made = null;
  conn.runtime = "";
  conn.asking = false;
  conn.answered = false;
  conn.source.bind(undefined);
  made.close();
  const { [conn.computer.computer_id]: _gone, ...rest } = links.get().links;
  set({ links: rest });
}

/**
 * Reaches a computer something of the person's needs: a Mac through the relay, whatever it is doing (it comes back by
 * itself); Cloud only while it runs. Never a wake: a place that sleeps is reached once a message has woken it.
 */
function reachOut(conn: Conn, from: PhoneCloud, p: Parts) {
  const listed = links.get().computers?.find((c) => c.computer_id === conn.computer.computer_id);
  if (!listed || !conn.wanted) return;
  if (listed.kind === "cloud" && !(listed.online && listed.runtime_id !== "")) return letGo(conn);
  if (conn.made && conn.runtime === listed.runtime_id) return;
  letGo(conn);
  const made = p.openConnection({
    computer: followedOf(listed),
    cloud: from,
    device: p.key,
    direct: { advert: () => direct },
    wakes: false,
    // Cloud runs it as another runtime now: the same computer, reached there.
    onWoke: (next) => {
      set({
        computers: (links.get().computers ?? []).map((c) =>
          c.computer_id === next.computer_id ? next : c,
        ),
      });
      conn.computer = followedOf(next);
      if (conn.made === made) reachOut(conn, from, p);
    },
  });
  conn.made = made;
  conn.runtime = listed.runtime_id;
  if (__DEV__) standInFor(made.client, conn);
  conn.source.bind(made.client);
  // What it runs changed (a sign-in, a key, an update): its chats' pickers list it as it is now.
  made.client.on(
    "engine.changed",
    ({ engines }) => void (conn.made === made && saidEngines(conn.computer.computer_id, engines)),
  );
  made.subscribe((state) => onLink(conn, made, state, from, p));
  onLink(conn, made, made.state(), from, p);
}

/** Something of the person's needs this computer reached from now on. */
function want(conn: Conn) {
  conn.wanted = true;
  void Promise.all([theCloud(), theParts()]).then(
    ([from, p]) => reachOut(conn, from, p),
    () => undefined,
  );
}

function onLink(conn: Conn, made: Connection, state: Link, from: PhoneCloud, p: Parts) {
  if (conn.made !== made) return;
  const id = conn.computer.computer_id;
  if (state.phase === "signed-out") return signedOut();
  // Cloud that no longer answers sleeps, and one Caveman no longer knows is gone: nothing is kept open to it, and
  // Caveman's list says what became of it.
  if ((state.phase === "asleep" && conn.computer.kind === "cloud") || state.phase === "gone") {
    letGo(conn);
    return void look();
  }
  set({ links: { ...links.get().links, [id]: state } });
  if (state.phase === "open") read(conn, from, p);
  adopt();
  conn.source.refresh();
}

/** A project by its repository, or else its name: the same one however it was found. */
const keyOf = (p: Project) => (p.github ?? p.name).toLowerCase();
/** A repository's project goes by the repository's own name on every computer, whatever folder holds it there. */
const named = (repo: string): Project => ({ name: repo.split("/").pop() || repo, github: repo });
/** Each computer's projects by their ids there, as the pickers name them: what its chats' projects are called. */
const projectNames = new Map<string, string>();
/** Where each Mac keeps each project (by the project's key): a chat started there runs in that folder. */
const folders = new Map<string, Map<string, string>>();

/**
 * The person's projects, as the web lists them: each Mac's own while it answers (project.list, with its folder
 * there), what Caveman keeps of their projects, and the repositories their chats are in.
 */
async function readProjects() {
  const from = await theCloud();
  const answering = [...conns.values()].filter(
    (c) => c.made?.state().phase === "open" && c.answered,
  );
  const [here, kept] = await Promise.all([
    Promise.all(
      answering.map((c) =>
        c.made!.client.call("project.list", {}).then(
          (r) => ({ conn: c, projects: r.projects }),
          () => ({ conn: c, projects: [] }),
        ),
      ),
    ),
    from.projects().catch(() => []),
  ]);
  if (!isLive() || !links.get().account) return;
  const places = new Map<string, Project>();
  const add = (p: Project) => {
    const was = places.get(keyOf(p));
    places.set(keyOf(p), was ? { ...was, ...p, name: was.name } : p);
  };
  for (const { conn, projects } of here) {
    const id = conn.computer.computer_id;
    const mac = conn.computer.kind === "laptop";
    const paths = new Map<string, string>();
    for (const p of projects) {
      const place: Project = {
        ...(p.repository?.host === "github.com" ? named(p.repository.full_name) : { name: p.name }),
        ...(mac ? { path: p.path } : null),
      };
      add(place);
      projectNames.set(`${id}:${p.id}`, place.name);
      if (mac) paths.set(keyOf(place), p.path);
    }
    if (mac) folders.set(id, paths);
    // Its chats go by the same names.
    conn.source.refresh();
  }
  for (const p of kept) for (const repo of p.repos) add(named(repo));
  for (const c of links.get().chats ?? []) if (c.repo) add(named(c.repo));
  adoptProjects([...places.values()]);
  // The box names a project of the person's own: the one the newest chat is in, else the first.
  const latest = store
    .get()
    .board.chats.reduce<{ repo: string; startedAt: number } | undefined>(
      (a, b) => (!a || b.startedAt > a.startedAt ? b : a),
      undefined,
    );
  const first = latest && projectOf(latest.repo) ? latest.repo : places.values().next().value?.name;
  settleWhere(projectOf(ui.get().where.repo) || !first ? undefined : first);
}

/**
 * The link opened: the computer's chats are read (again, after every drop: what came and went meanwhile is gone). Not
 * before it answers: an open socket is not yet the computer.
 */
function read(conn: Conn, from: PhoneCloud, p: Parts) {
  const made = conn.made;
  if (!made) return;
  // A connection let go of while it read has nothing to report.
  const mine =
    <T>(run: (value: T) => void) =>
    (value: T) =>
      void (conn.made === made && run(value));
  const sync = () =>
    conn.source.sync().then(
      mine(() => {
        // It answers this phone: a Mac that does has let it in.
        if (conn.computer.kind === "laptop") markReached(conn.computer.computer_id);
        openFocused();
        void readProjects().catch(() => undefined);
        void readEngines(conn);
        void readAgents();
      }),
      mine(() => undefined),
    );
  if (conn.answered) return void sync();
  if (conn.asking) return;
  conn.asking = true;
  made.client.call("workspace.list", {}).then(
    mine(() => {
      conn.answered = true;
      void sync();
      void look();
    }),
    mine(() => {
      conn.asking = false;
    }),
  );
  void from;
  void p;
}

// ---------------------------------------------------------------- what each place runs

/**
 * In development only: what stands in for a computer's own answer to a call (`__cc.link.answers`, below), to look at
 * a state a stage cannot give (its stand-in agents list no models and no sign-in, it has no plan and no builders).
 * Where an answer enters the app, which is as near the wire as there is: every frame to a Mac is sealed.
 */
let standIn: ((computer: Followed, method: string, answer: unknown) => unknown) | null = null;
function standInFor(client: Connection["client"], conn: Conn) {
  const call = client.call.bind(client) as (
    method: string,
    params: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  (client as { call: unknown }).call = (method: string, params: unknown, options?: unknown) =>
    call(method, params, options).then((answer) =>
      standIn ? standIn(conn.computer, method, answer) : answer,
    );
}

function saidEngines(computerId: string, engines: ReadonlyArray<EngineDescriptor>) {
  set({ engines: { ...links.get().engines, [computerId]: engines } });
}

/** What a computer says its agents are, kept for its chats' pickers: read as it answers, and again when it says they changed. */
function readEngines(conn: Conn): Promise<ReadonlyArray<EngineDescriptor> | undefined> {
  const made = conn.made;
  if (!made) return Promise.resolve(undefined);
  const id = conn.computer.computer_id;
  return made.client.call("engine.list", {}).then(
    (r) => {
      if (conn.made !== made || !links.get().account) return r.engines;
      saidEngines(id, r.engines);
      return links.get().engines[id];
    },
    () => undefined,
  );
}

/** A chat's place (`chat`), or a new chat's on the place its box names (`device`), with what is known of what it runs. */
function spotOf(state: LinkState, chat: string | null, device: string | undefined): Spot | null {
  const conn = chat !== null ? ownerOf(chat) : undefined;
  // A chat still being started is where it was started for; a new chat, where its box says.
  const on = conn ? undefined : chat !== null ? started.get(chat)?.device : device;
  const macId = conn
    ? conn.computer.kind === "laptop"
      ? conn.computer.computer_id
      : null
    : on === undefined
      ? null
      : computerIdOf(on);
  if (macId !== null) {
    const link = state.links[macId];
    const is = placeFor(state, macId).is;
    return {
      kind: "mac",
      name: whereName(
        conn?.computer ??
          state.computers?.find((c) => c.computer_id === macId) ?? {
            kind: "laptop",
            name: on ? deviceById(on).name : "",
          },
      ),
      listed: state.engines[macId],
      is: is === "running" ? "running" : is === "offline" ? "offline" : "asleep",
      ...(link?.phase === "waiting" || link?.phase === "refused"
        ? { allow: { state: link.phase, code: link.code } }
        : {}),
    };
  }
  if (!conn && on !== CLOUD.id) return null;
  const said = (kind: "laptop" | "cloud") =>
    (state.computers ?? [])
      .filter((c) => c.kind === kind)
      .map((c) => state.engines[c.computer_id])
      .find((l) => l !== undefined);
  return {
    kind: "cloud",
    listed: (conn ? state.engines[conn.computer.computer_id] : undefined) ?? said("cloud"),
    mac: said("laptop"),
  };
}

/** What a chat's picker lists (`chat`), or a new chat's on the place its box names (`device`): engines.ts offerOf. */
export const offerFor = (
  state: LinkState,
  chat: string | null,
  device: string | undefined,
  now = Date.now(),
): Offer => offerOf(spotOf(state, chat, device), now, state.computers === null);
const sameOffer = (a: Offer, b: Offer) =>
  a.engines === b.engines &&
  a.line === b.line &&
  a.missing.length === b.missing.length &&
  a.missing.every((m, i) => m.line === b.missing[i]!.line);
/** What a chat's picker lists (`chat`), or a new chat's on the place its box names (`device`). */
export const useOffer = (chat: string | null, device: string | undefined) =>
  useLink((state) => offerFor(state, chat, device), sameOffer);

/**
 * Reaches what an offer is read from. A Mac that has let this phone in before, the place itself or (for Cloud) any
 * of the person's, which hold their plans and keys: reaching it asks nobody anything. `asked`: the person opened the
 * picker, so the Mac picked is reached even the first time, and says what to do on it. Nothing is woken either way.
 */
export function wantOffer(chat: string | null, device: string | undefined, asked = false) {
  if (!isLive()) return;
  const spot = spotOf(links.get(), chat, device);
  if (!spot) return;
  const conn = chat !== null ? ownerOf(chat) : undefined;
  const on = conn ? conn.computer.computer_id : device ? computerIdOf(device) : null;
  for (const mac of conns.values()) {
    if (mac.computer.kind !== "laptop" || mac.wanted) continue;
    const own = spot.kind === "mac" && mac.computer.computer_id === on;
    if ((own && asked) || ((own || spot.kind === "cloud") && wasReached(mac.computer.computer_id)))
      want(mac);
  }
}

// ---------------------------------------------------------------- Caveman's list, read again while the app is up

/** How often Caveman is asked about the computers and chats: often while something waits, else as the web does. */
const LOOK_EVERY_MS = 4_000;
const LOOK_BUSY_MS = 1_500;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Something waits on Caveman's next word: a chat on its way somewhere, a place on its way up, a chat being started. */
const busy = () => {
  const state = links.get();
  return (
    Object.keys(state.moving).length > 0 ||
    Object.keys(state.waking).length > 0 ||
    store
      .get()
      .board.chats.some((c) => c.wait !== undefined || (isStarting(c.id) && !didNotStart(c)))
  );
};
function watch(on: boolean) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!on) return;
  const again = () => {
    timer = setTimeout(
      () => void look().finally(() => timer !== null && again()),
      busy() ? LOOK_BUSY_MS : LOOK_EVERY_MS,
    );
  };
  again();
}

let looking: Promise<void> | null = null;
/**
 * What Caveman says now of the person's computers and chats: every chat on the board where it runs, a chat that runs
 * somewhere else than before followed there by itself, and each computer something needs reached while it can be.
 */
const look = (): Promise<void> =>
  (looking ??= (async () => {
    try {
      const [from, p] = await Promise.all([theCloud(), theParts()]);
      if (!links.get().account) return;
      const [listed, chats] = await Promise.all([from.computers(), from.chats()]);
      if (!links.get().account) return;
      direct = listed.direct;
      const now = Date.now();
      // A Cloud computer on its way up counts its seconds from when this phone first saw it so.
      const waking: Record<string, number> = {};
      for (const c of listed.computers)
        if (c.kind === "cloud" && ["waking", "failed"].includes(placeOf(c).is))
          waking[c.computer_id] = links.get().waking[c.computer_id] ?? now;
      set({
        computers: listed.computers,
        cloud: listed.cloud,
        cloudOff: listed.cloudOff === true,
        chats,
        waking,
        offlineSince: null,
      });
      for (const c of listed.computers) ensure(c, from, p);
      // A computer Caveman no longer lists holds nothing of the person's any more.
      for (const [id, conn] of conns) {
        if (listed.computers.some((c) => c.computer_id === id)) continue;
        letGo(conn);
        for (const chat of conn.source.chats()) dispatch({ type: "remove", id: chat });
        conn.source.close();
        conns.delete(id);
        const { [id]: _gone, ...engines } = links.get().engines;
        set({ engines });
      }
      follow(chats);
      for (const conn of conns.values()) conn.source.seed(chats);
      settle(chats);
      tidy();
      for (const conn of conns.values()) reachOut(conn, from, p);
      adopt();
      for (const conn of conns.values()) conn.source.refresh();
      openFocused();
      if (!projectsRead) {
        projectsRead = true;
        void readProjects().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "SignedOut") return signedOut();
      // No way to Caveman right now: what the phone holds stays, and it is asked again by itself.
      if (links.get().offlineSince === null) {
        set({ offlineSince: Date.now() });
        // The chat says so once it has lasted (words.ts OFFLINE_AFTER_MS): nothing else may change meanwhile.
        setTimeout(
          () =>
            links.get().offlineSince !== null && set({ offlineSince: links.get().offlineSince }),
          OFFLINE_AFTER_MS + 50,
        );
      }
    }
  })().finally(() => (looking = null)));
let projectsRead = false;

/** The chats that run somewhere else than the computer this phone held them on, each with where it was. */
let moved: {
  readonly was: string;
  readonly session: string;
  readonly to: string;
  readonly carried: Carried | undefined;
}[] = [];

/** A chat Caveman lists on another computer now is let go of where it was: the computer it runs on holds it next. */
function follow(chats: ReadonlyArray<CloudChat>) {
  moved = [];
  for (const c of chats) {
    for (const [id, conn] of conns) {
      if (id === c.computer_id) continue;
      const was = conn.source.chatOf(c.session_id);
      if (was === undefined) continue;
      moved.push({
        was,
        session: c.session_id,
        to: c.computer_id,
        carried: conn.source.release(was),
      });
    }
  }
}

/** Each chat that moved is, on screen and in every list, the one its new place holds: the reader is taken there. */
function settle(chats: ReadonlyArray<CloudChat>) {
  void chats;
  if (moved.length === 0) return;
  const state = links.get();
  const moving = { ...state.moving };
  for (const m of moved) {
    const conn = conns.get(m.to);
    const now = conn?.source.chatOf(m.session);
    delete moving[m.was];
    // What this phone had under way for it (a message Cloud keeps for it, one not sent) goes with it.
    if (now !== undefined && m.carried) conn?.source.carry(now, m.carried);
    if (now === undefined || now === m.was) continue;
    const focused = ui.get().focused;
    const open = focused?.name === "Thread" && focused.id === m.was;
    if (open) showChat(now);
    // Once the screen has changed hands: the old one's own must not see it go and step back.
    setTimeout(() => dispatch({ type: "remove", id: m.was }), open ? 400 : 0);
  }
  set({ moving });
  moved = [];
}

/** The board holds what the person's computers hold: a chat none of them has any more goes, unless it is being started. */
function tidy() {
  for (const chat of store.get().board.chats) {
    if (isStarting(chat.id) || ownerOf(chat.id) || moved.some((m) => m.was === chat.id)) continue;
    dispatch({ type: "remove", id: chat.id });
  }
}

/** The chat on screen is followed: its computer is reached, and its transcript arrives as it happens. */
function openFocused() {
  const focused = ui.get().focused;
  if (focused?.name !== "Thread" || !focused.id) return;
  const conn = ownerOf(focused.id);
  if (!conn) return;
  if (!conn.wanted) want(conn);
  conn.source.open(focused.id);
}
ui.watch((next, prev) => {
  if (next.focused === prev.focused) return;
  openFocused();
});
// One still being started when the app last quit never was: nothing is left to make it.
for (const chat of store.get().board.chats)
  if (isStarting(chat.id)) dispatch({ type: "remove", id: chat.id });
// A board that is the person's own from the first frame holds nothing the script starred.
if (isLive()) forgetScriptedChoices();

// ---------------------------------------------------------------- signing in and out

/** The board becomes the person's own: the script stops and the scripted world goes, for good. */
function enter() {
  if (isLive()) return;
  script.stopScript();
  clearForLive();
  goLive();
  adoptDevices([]);
  adoptProjects([]);
  forgetScriptedChoices();
  // The box names no project of the scripted world's: one of this person's own, once they are read.
  setWhere({ repo: "", computer: "" });
}

/** Every connection ends and the board is empty: nobody's chats are on a phone nobody is signed in on. */
function clear() {
  watch(false);
  for (const conn of conns.values()) {
    letGo(conn);
    conn.source.close();
  }
  conns.clear();
  projectNames.clear();
  folders.clear();
  projectsRead = false;
  defaulted = "";
  if (isLive()) {
    for (const chat of store.get().board.chats) dispatch({ type: "remove", id: chat.id });
    adoptDevices([]);
    adoptProjects([]);
    // The box names no project and no place of the person who was signed in.
    setWhere({ repo: "", computer: "" });
  }
  agents.dispatch({
    status: "signed-out",
    engines: [],
    from: "",
    kind: null,
    mac: null,
    account: null,
  });
  set({
    computers: null,
    cloudOff: false,
    engines: {},
    chats: null,
    links: {},
    waking: {},
    moving: {},
    refused: {},
    lids: {},
    offlineSince: null,
  });
}

/** The sign-in ended (revoked, or a month old): the phone says so once, where it signs in. */
function signedOut() {
  if (links.get().account === null) return;
  clear();
  set({ account: null, signingIn: null, problem: "Sign in to Caveman again." });
}

let refreshing: Promise<void> | null = null;
/**
 * Reads who is signed in on this phone and, signed in, what Caveman lists for them. As the app starts on a board that
 * is the person's own (board/useBoard.ts), and when a screen that signs in opens.
 */
export const refresh = (): Promise<void> =>
  (refreshing ??= (async () => {
    try {
      const account = await (await theCloud()).account();
      set({ account });
      if (!account) return;
      enter();
      connected({ runtime: facade, close: () => void signOut() });
      agents.dispatch({
        status: agents.get().status === "signed-out" ? "loading" : agents.get().status,
      });
      await look();
      if (timer === null) watch(true);
    } catch (error) {
      set({ problem: problemWords(error, "sign-in") });
    }
  })().finally(() => (refreshing = null)));

let pending: SignIn | null = null;
/** Signs in to Caveman: a code to confirm on Caveman's page, opened in the browser; then the person's chats. */
export async function signIn() {
  if (pending) return;
  set({ problem: null });
  try {
    pending = await (await theCloud()).signIn();
    set({ signingIn: { code: pending.user_code, url: pending.url } });
    platform.openUrl(pending.url);
    const account = await pending.done;
    set({ signingIn: null, ...(account ? { account } : null) });
    if (account) await refresh();
  } catch (error) {
    set({ signingIn: null, problem: problemWords(error, "sign-in") });
  } finally {
    pending = null;
  }
}

export const cancelSignIn = () => pending?.cancel();

/** Signs out of Caveman on this phone. Its key stays in the Keychain: a Mac that allowed it need not be asked again. */
export async function signOut() {
  clear();
  set({ account: null, signingIn: null, problem: null });
  try {
    await (await theCloud()).signOut();
  } catch {
    // Signed out here either way: Caveman ends the sign-in itself when it is next used.
  }
}

// ---------------------------------------------------------------- the open chat's place

/** What Cloud lists of a chat on the board. */
const listedChat = (state: LinkState, conn: Conn, chatId: string): CloudChat | undefined => {
  const session = conn.source.sessionOf(chatId);
  return state.chats?.find((c) => c.session_id === session);
};

/**
 * A chat's move under way, whoever asked for it: what Cloud lists of it (CONTRACT §11.2, so a move another device or
 * Cloud itself started shows here too), and this phone's own from the tap until Cloud lists it. `to` is "Cloud" or
 * the Mac's own name; the seconds count on this phone's clock for a move it asked for itself.
 */
function movingOf(
  state: LinkState,
  chatId: string,
  chat: CloudChat | undefined,
): { readonly to: string; readonly since: number; readonly waitingTurn?: boolean } | null {
  const own = state.moving[chatId];
  const listed = chat?.moving;
  if (!listed) return own ?? null;
  const mac =
    listed.to === "cloud"
      ? undefined
      : state.computers?.find((c) => c.computer_id === listed.to && c.kind === "laptop");
  const asked = Date.parse(listed.since);
  return {
    to: listed.to === "cloud" ? CLOUD_NAME : mac ? whereName(mac) : "your Mac",
    since: own?.since ?? (Number.isFinite(asked) ? asked : 0),
    ...(listed.waiting_turn ? { waitingTurn: true } : {}),
  };
}

/** Where a chat runs and, unless that place simply runs, its one state word; null on the scripted board. */
function placeMark(
  state: LinkState,
  chatId: string,
  now: number,
): { readonly name: string; readonly cloud: boolean; readonly word: string | null } | null {
  const conn = ownerOf(chatId);
  if (!conn || !isLive()) return null;
  const word = placeWord(placeFor(state, conn.computer.computer_id), now);
  // A row has room for the word alone: when a used-up plan resets is said in the chat.
  return {
    name: whereName(conn.computer),
    cloud: conn.computer.kind === "cloud",
    word: word?.startsWith("Paused") ? "Paused" : word,
  };
}

/** A chat's place beside "Runs on" in its details: the Mac's own name or "Cloud", and its state word ("Cloud · Asleep"). */
export function markFor(state: LinkState, chatId: string, now = Date.now()): string | null {
  const mark = placeMark(state, chatId, now);
  return mark ? (mark.word ? `${mark.name} · ${mark.word}` : mark.name) : null;
}
export const useMark = (chatId: string) => useLink((state) => markFor(state, chatId));

/** A chat's row mark, in the web's words: "In Cloud" or "On <Mac's name>", and its place's state word beside it. */
export interface RowMark {
  readonly where: string;
  readonly word: string | null;
}
export function rowMarkFor(state: LinkState, chatId: string, now = Date.now()): RowMark | null {
  const mark = placeMark(state, chatId, now);
  if (!mark) return null;
  // On its way somewhere else: the row says where to, in place of where it was. One that waits for its turn to end
  // still runs where it is, and the chat says the rest.
  const conn = ownerOf(chatId);
  const moving = conn ? movingOf(state, chatId, listedChat(state, conn, chatId)) : null;
  if (moving && !moving.waitingTurn) return { where: movingNote(moving).words, word: null };
  return { where: whereMark(mark), word: mark.word };
}
const sameMark = (a: RowMark | null, b: RowMark | null) =>
  a?.where === b?.where && a?.word === b?.word;
export const useRowMark = (chatId: string) =>
  useLink((state) => rowMarkFor(state, chatId), sameMark);

/**
 * The one line the open chat says over its box about where it runs (words.ts noteOf); null on the scripted board,
 * while its place runs, and (`waits`) while its own message already says what it waits for.
 */
export function noteFor(state: LinkState, chatId: string, waits = false): Note | null {
  if (!isLive()) return null;
  if (isStarting(chatId)) {
    // A chat being started says what it waits for under its own message. The one thing it cannot say there is the
    // step a Mac asks of you once, with the code to check.
    const device = started.get(chatId)?.device;
    const mac = device ? computerIdOf(device) : null;
    const asked = mac ? state.links[mac] : undefined;
    const computer = mac ? state.computers?.find((c) => c.computer_id === mac) : undefined;
    if (asked?.phase !== "waiting" || !computer) return null;
    return noteOf({
      where: { name: whereName(computer), cloud: false },
      place: { is: "running" },
      allow: { state: "waiting", code: asked.code },
    });
  }
  const conn = ownerOf(chatId);
  if (!conn) return null;
  const id = conn.computer.computer_id;
  const link = state.links[id];
  const chat = listedChat(state, conn, chatId);
  const moving = movingOf(state, chatId, chat);
  const place = placeFor(state, id);
  const note = noteOf({
    where: { name: whereName(conn.computer), cloud: conn.computer.kind === "cloud" },
    place,
    since: state.waking[id] ?? null,
    moving,
    allow:
      link?.phase === "waiting"
        ? { state: "waiting", code: link.code }
        : link?.phase === "refused"
          ? { state: "refused", code: link.code }
          : null,
    offlineSince: state.offlineSince,
    chat,
    refused: state.refused[chatId],
  });
  if (!waits || !note || moving || note.block) return note;
  // The chat's own message already says what it waits for. One thing that line cannot say: an answer queued for
  // Cloud that is paused says only that it is queued, and this line says until when.
  const own = store.get().board.chats.find((c) => c.id === chatId)?.wait?.words;
  return place.is === "paused" && own !== note.words ? note : null;
}

const sameNote = (a: Note | null, b: Note | null) => JSON.stringify(a) === JSON.stringify(b);
/** The open chat's line, for its screen. */
export const useNote = (chatId: string, waits = false) =>
  useLink((state) => noteFor(state, chatId, waits), sameNote);

/** Where else a chat could run, for its menu's two verbs; `why`: the few words beside a row that cannot be pressed. */
export interface RunChoice {
  readonly label: string;
  readonly why?: string;
  readonly run: () => void;
}

/**
 * The chat's two verbs: "Run in Cloud" for one on a Mac, "Run on <Mac's name>" for one in Cloud. A row that cannot work
 * says why in a few words and is not pressable; none on the scripted board or for a chat being started.
 *
 * Whether it can work is what Cloud lists of the chat, before anyone asks (CONTRACT §11.1): `movable`, and the code
 * of why not. A chat Cloud does not list has nothing saved to run anywhere else; one whose Mac has not said either
 * way can be asked for, and Cloud's own answer is the backstop.
 */
export function runChoices(state: LinkState, chatId: string): readonly RunChoice[] {
  if (!isLive() || isStarting(chatId)) return [];
  const conn = ownerOf(chatId);
  if (!conn) return [];
  const chat = listedChat(state, conn, chatId);
  // The first sentence is the few words a row has room for; what to do next is in it where there is something to do.
  const stays =
    state.chats === null ? undefined : whyNotCloud(chat)?.split(". ")[0]!.replace(/\.$/, "");
  if (conn.computer.kind !== "cloud") {
    if (!state.cloud && !state.computers?.some((c) => c.kind === "cloud")) return [];
    return [
      {
        label: "Run in Cloud",
        ...(stays ? { why: stays } : {}),
        run: () => void runInCloud(chatId),
      },
    ];
  }
  return (state.computers ?? [])
    .filter((c) => c.kind === "laptop")
    .map((mac) => {
      const place = placeFor(state, mac.computer_id);
      const why =
        stays ??
        (place.is === "running"
          ? undefined
          : `${whereName(mac)} is ${place.is === "offline" ? "offline" : "asleep"}`);
      return {
        label: `Run on ${whereName(mac)}`,
        ...(why ? { why } : {}),
        run: () => void runOnMac(chatId, mac.computer_id),
      };
    });
}
const sameChoices = (a: readonly RunChoice[], b: readonly RunChoice[]) =>
  a.length === b.length && a.every((x, i) => x.label === b[i]!.label && x.why === b[i]!.why);
export const useRunChoices = (chatId: string) =>
  useLink((state) => runChoices(state, chatId), sameChoices);

/**
 * Runs a chat somewhere else: Caveman's own move, as the same chat (one place holds it at a time), and the phone
 * follows it there. What Caveman refuses is kept in its own words for the chat's one line.
 */
async function move(chatId: string, to: MoveTo, name: string) {
  const conn = ownerOf(chatId);
  if (!conn || links.get().moving[chatId] !== undefined) return;
  const { [chatId]: _was, ...refused } = links.get().refused;
  set({ moving: { ...links.get().moving, [chatId]: { since: Date.now(), to: name } }, refused });
  try {
    await (to === "cloud"
      ? conn.source.runInCloud(chatId)
      : conn.source.runOn(chatId, to.computer_id));
    await look();
  } catch (error) {
    set({ refused: { ...links.get().refused, [chatId]: problemWords(error, "other", planNow()) } });
  }
  const { [chatId]: _moved, ...moving } = links.get().moving;
  set({ moving });
}
export const runInCloud = (chatId: string) => move(chatId, "cloud", "Cloud");
export const runOnMac = (chatId: string, computerId: string) =>
  move(
    chatId,
    { computer_id: computerId },
    whereName(links.get().computers?.find((c) => c.computer_id === computerId)),
  );

// ---------------------------------------------------------------- Settings > Computers

/** One chat that will not carry on in Cloud when its Mac sleeps: "Pauses · Claude isn't connected". */
export interface LidLine {
  readonly id: string;
  readonly title: string;
  readonly what: string;
  readonly why: string;
}

/** Settings > Computers, as it reads: a row per Mac, and Cloud as one row that opens to a line per project. */
export interface ComputersView {
  readonly macs: readonly {
    readonly id: string;
    readonly name: string;
    readonly chats: number;
    readonly word: "Online" | "Asleep" | "Offline";
    /** This phone is not allowed there yet: what to do on the Mac, and the code to check. */
    readonly allow?: { readonly words: string; readonly code?: string };
    /** While it is on line and keeps chats going in Cloud: only the chats that will not carry on when it sleeps. */
    readonly lid: readonly LidLine[];
  }[];
  /** Null where the person has nothing in Cloud and cannot start there. */
  readonly cloud: {
    readonly chats: number;
    readonly line: string;
    readonly projects: readonly {
      readonly name: string;
      readonly chats: number;
      readonly word: string;
    }[];
  } | null;
}

/**
 * "When <Mac> sleeps", in the desktop's words for the same chats: nothing unless the Mac said its chats keep going in
 * Cloud, then each chat Cloud lists as staying (its code, CONTRACT §11.1), and each Claude Agent or Codex chat where
 * those were set to stay. The desktop reads the Mac's own summary (cloud.lid.summary), which a Mac gives only to a
 * window on it; Cloud's code for a chat is that summary's reason.
 */
function lidLines(
  state: LinkState,
  mac: Computer,
  chats: readonly CloudChat[],
): readonly LidLine[] {
  const lid = state.lids[mac.computer_id];
  if (lid?.moves !== "on" || state.links[mac.computer_id]?.phase !== "open") return [];
  return chats.flatMap((chat) => {
    const said =
      chat.movable === false
        ? lidWords(chat.stays?.code, chat.engine, whereName(mac))
        : chat.movable === true &&
            lid.agentsOff &&
            (chat.engine === "claude-agent" || chat.engine === "codex")
          ? lidAgentsOff(chat.engine === "codex" ? "Codex" : "Claude Agent")
          : null;
    return said ? [{ id: chat.session_id, title: chat.title || "A chat", ...said }] : [];
  });
}

/** `usedPct`: the share of the month's plan Cloud's time took, where one of the person's computers said (account.get). */
export function computersView(state: LinkState, now = Date.now(), usedPct?: number): ComputersView {
  const computers = state.computers ?? [];
  const chats = (state.chats ?? []).filter((c) => c.kind === "chat");
  const on = (id: string) => chats.filter((c) => c.computer_id === id);
  const macs = computers
    .filter((c) => c.kind === "laptop")
    .map((c) => {
      const link = state.links[c.computer_id];
      const allow =
        link?.phase === "waiting"
          ? { words: `On ${whereName(c)}, choose Allow when it shows this code.`, code: link.code }
          : link?.phase === "refused"
            ? { words: `Allow this phone on ${whereName(c)} (Settings > General).` }
            : undefined;
      return {
        id: c.computer_id,
        name: whereName(c),
        chats: on(c.computer_id).length,
        word: macWord(placeFor(state, c.computer_id)),
        ...(allow ? { allow } : {}),
        lid: lidLines(state, c, on(c.computer_id)),
      };
    });
  const clouds = computers.filter((c) => c.kind === "cloud");
  if (clouds.length === 0 && !state.cloud) return { macs, cloud: null };
  // One line per project: its chats, and the one word for where they run now.
  const projects = new Map<string, { chats: number; places: Place[] }>();
  for (const c of clouds) {
    const place = placeFor(state, c.computer_id);
    for (const chat of on(c.computer_id)) {
      const name = chat.repo?.split("/").pop() || "Folder";
      const had = projects.get(name) ?? { chats: 0, places: [] };
      projects.set(name, { chats: had.chats + 1, places: [...had.places, place] });
    }
  }
  const used = clouds
    .filter((c) => on(c.computer_id).length > 0)
    .map((c) => placeFor(state, c.computer_id));
  return {
    macs,
    cloud: {
      chats: clouds.reduce((sum, c) => sum + on(c.computer_id).length, 0),
      // No chat there, nothing to say of it: a state word is about where chats run.
      line: used.length > 0 ? cloudRowLine(used, usedPct, now) : "",
      projects: [...projects].map(([name, p]) => ({
        name,
        chats: p.chats,
        word: cloudLine(p.places, now),
      })),
    },
  };
}
const sameView = (a: ComputersView, b: ComputersView) => JSON.stringify(a) === JSON.stringify(b);
export function useComputers() {
  const usedPct = useSelector(agents, (a) => a.account?.credits?.computers?.used_pct);
  return useLink((state) => computersView(state, Date.now(), usedPct), sameView);
}

/** The desktop's lidMoves (apps/web routes/settings/lid-summary.ts), from a Mac's own settings. */
const lidOf = (
  settings: Pick<Settings, "sync_chats" | "move_to_cloud" | "move_other_engines">,
): Lid => {
  const saved = settings.sync_chats ?? settings.move_to_cloud;
  return {
    moves:
      saved === undefined
        ? "unset"
        : saved === true && settings.move_to_cloud !== false
          ? "on"
          : "off",
    agentsOff: settings.move_other_engines === false,
  };
};

/**
 * Asks each Mac that answers what its person chose for when it sleeps: as Settings > Computers opens, and while it is
 * open. A Mac that has let this phone in before is reached for it; nothing is woken and nobody is asked anything.
 */
export function readLids() {
  if (!isLive()) return;
  for (const conn of conns.values()) {
    if (conn.computer.kind !== "laptop") continue;
    const id = conn.computer.computer_id;
    if (!conn.wanted && wasReached(id)) want(conn);
    const made = conn.made;
    if (!made || made.state().phase !== "open" || !conn.answered) continue;
    made.client.call("settings.get", {}).then(
      (settings) => {
        if (conn.made === made && links.get().account)
          set({ lids: { ...links.get().lids, [id]: lidOf(settings) } });
      },
      () => undefined,
    );
  }
}

// ---------------------------------------------------------------- what the board's seams reach

/** Each chat started from here, by its placeholder: what to start again when its first message was not sent. */
const started = new Map<string, LiveStart>();
/** Each chat that did not start, by its placeholder: whether trying again can work. */
const unstarted = new Map<string, boolean>();

/** Whether trying a chat that did not start again can work; false for what no second try changes. */
export const canTryAgain = (chatId: string): boolean => unstarted.get(chatId) !== false;

/**
 * A chat that did not start is let go: its words go back to the New chat box, over whatever the box holds, with
 * anything typed under it while it was being started. The box is where its place and its model are picked again.
 */
export function discardStart(chatId: string) {
  const request = started.get(chatId);
  if (!request) return;
  const words = [request.text, ...(after.get(chatId) ?? [])].join("\n\n");
  const box = getDraft(NEW_CHAT).trim();
  setDraft(NEW_CHAT, box ? `${words}\n\n${box}` : words);
  // Once it is left it goes (the watch below), with what was kept for it.
  showNewChat();
}
/** What was typed under a chat while it was still being started, by its placeholder: sent once the chat is there. */
const after = new Map<string, string[]>();

/** A follow-up for a chat that is still being started: it waits under the first message, and goes when the chat is there. */
function later(chat: string, text: string) {
  const all = [...(after.get(chat) ?? []), text];
  after.set(chat, all);
  // One line says what they all wait for, under the last of them.
  const above = (store.get().board.chats.find((c) => c.id === chat)?.items ?? []).map((item) =>
    item.kind === "you" && item.state === "sending" ? { ...item, state: "sent" as const } : item,
  );
  dispatch({
    type: "update",
    id: chat,
    patch: {
      items: [
        ...above,
        { kind: "you", id: `${chat}:after:${all.length}`, text, at: Date.now(), state: "sending" },
      ],
    },
  });
}

const facade: Runtime = {
  owns: (chat) => ownerOf(chat) !== undefined || started.has(chat),
  send(chat, text, kind) {
    const conn = ownerOf(chat);
    if (!conn) return void (started.has(chat) && later(chat, text));
    want(conn);
    conn.source.send(chat, text, kind);
    void look();
  },
  resend(chat, item) {
    const again = started.get(chat);
    if (again) {
      // A chat that did not start is started again, with the same words, in the same place on screen.
      started.delete(chat);
      unstarted.delete(chat);
      const waiting = after.get(chat) ?? [];
      after.delete(chat);
      const focused = ui.get().focused;
      const open = focused?.name === "Thread" && focused.id === chat;
      const next = start(again);
      // What was typed under it goes with it.
      if (next) for (const text of waiting) later(next, text);
      if (next && open) showChat(next);
      setTimeout(() => dispatch({ type: "remove", id: chat }), open ? 400 : 0);
      return;
    }
    const conn = ownerOf(chat);
    if (!conn) return;
    want(conn);
    conn.source.resend(chat, item);
    void look();
  },
  stop(chat) {
    const conn = ownerOf(chat);
    if (!conn) return;
    want(conn);
    conn.source.stop(chat);
  },
  holds(chat, said) {
    const conn = ownerOf(chat);
    if (!conn) return null;
    if (said) want(conn);
    return conn.source.hold(chat, said);
  },
  choose(chat, pick) {
    const conn = ownerOf(chat);
    if (!conn) return;
    // Only what its computer lists goes with a message: a model, an effort or a speed it lacks would be refused.
    const engine = ENGINE_ID[pick.engine];
    const model = links
      .get()
      .engines[conn.computer.computer_id]?.find((e) => e.id === engine)
      ?.models.find((m) => m.id === pick.model);
    const speeds = model?.speeds ?? [];
    conn.source.choose(chat, {
      engine,
      ...(model ? { model: model.id } : {}),
      ...(model && pick.effort && model.efforts.includes(pick.effort)
        ? { effort: pick.effort }
        : {}),
      // Standard is a pick too, where the model has a faster speed to leave.
      ...(pick.speed &&
      speeds.length > 0 &&
      (pick.speed === "standard" || speeds.includes(pick.speed))
        ? { speed: pick.speed }
        : {}),
    });
  },
  async respond(chat, reply) {
    const conn = ownerOf(chat);
    if (!conn) return false;
    want(conn);
    const heard = await conn.source.respond(chat, reply);
    void look();
    return heard;
  },
};

// ---------------------------------------------------------------- the person's agents and plan, for Settings

let readingAgents: Promise<void> | null = null;
/**
 * What one of the person's computers says of their agents and plan (engine.list, account.get): a Mac first, else
 * Cloud while it runs. Reaching for them wakes nothing: with no computer answering, Settings says which one it waits
 * for.
 */
export const readAgents = (): Promise<void> =>
  (readingAgents ??= (async () => {
    const state = links.get();
    if (!state.account)
      return void agents.dispatch({
        status: state.account === null ? "signed-out" : "loading",
        engines: [],
        from: "",
        kind: null,
        mac: null,
        account: null,
      });
    const all = [...conns.values()];
    const macs = all.filter((c) => c.computer.kind === "laptop");
    // A Mac holds the person's own sign-ins, so it is the one asked; Cloud only where they have no Mac at all.
    for (const conn of macs.length > 0 ? macs : all) if (!conn.wanted) want(conn);
    const open = (c: Conn) => c.made?.state().phase === "open" && c.answered;
    const answering = macs.find(open) ?? all.find(open);
    if (!answering) {
      const mac = macs[0];
      const place = mac ? placeFor(state, mac.computer.computer_id) : null;
      const settling = all.some(
        (c) =>
          c.wanted &&
          (c.made?.state().phase === "connecting" ||
            (c.made?.state().phase === "open" && !c.answered)),
      );
      // What a computer said before stands while it is out of reach for a moment.
      if (agents.get().status === "ready" && settling) return;
      return void agents.dispatch({
        status:
          state.computers === null || settling || place?.is === "running" ? "loading" : "away",
        engines: [],
        from: "",
        kind: null,
        mac:
          mac && place && place.is !== "running"
            ? {
                name: whereName(mac.computer),
                state: place.is === "offline" ? "Offline" : "Asleep",
              }
            : null,
      });
    }
    const client = answering.made!.client;
    const [listed, account] = await Promise.all([
      client.call("engine.list", {}).then(
        (r) => r.engines,
        () => null,
      ),
      client.call("account.get", {}).then(
        (r) => r,
        () => null,
      ),
    ]);
    if (!links.get().account || listed === null) return;
    saidEngines(answering.computer.computer_id, listed);
    agents.dispatch({
      status: "ready",
      engines: listed,
      from: whereName(answering.computer),
      kind: answering.computer.kind === "laptop" ? "mac" : "cloud",
      mac: null,
      account,
    });
  })().finally(() => (readingAgents = null)));

// ---------------------------------------------------------------- a chat started from the phone

/** How long a chat being started waits for its place to come up and answer. */
const REACH_WAIT_MS = 180_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A computer's chats once it answers this phone. Starting a chat is something that needs the place: a Mac is reached,
 * and Cloud, which Caveman is already bringing up for the chat, is reached as soon as it runs. `said` hears the one
 * line the wait says, as it changes.
 */
async function reach(computerId: string, said: (line: string) => void): Promise<LiveSource> {
  if (!conns.has(computerId)) await look();
  for (const from = Date.now(); ; await sleep(250)) {
    const conn = conns.get(computerId);
    const state = links.get();
    if (!state.account) throw new Error("Sign in to Caveman again (Settings > Account).");
    if (conn) {
      if (!conn.wanted) want(conn);
      if (conn.made?.state().phase === "open" && conn.answered) return conn.source;
      const link = state.links[computerId];
      const name = whereName(conn.computer);
      const mac = conn.computer.kind === "laptop";
      if (link?.phase === "refused")
        throw new Error(`Allow this phone on ${name} (Settings > General).`);
      if (mac && link?.phase === "asleep") throw new Error(`${name} is asleep.`);
      const place = placeFor(state, computerId);
      if (!mac && place.is === "paused")
        throw new Error(placeWord(place) ?? "Paused · plan used up");
      // A Mac asking its person about this phone says so in the chat, with the code (noteFor): here it is still sending.
      said(mac ? "Sending" : place.is === "failed" ? CLOUD_FAILED : WAKING_CLOUD);
    }
    if (Date.now() - from > REACH_WAIT_MS)
      throw new Error(
        conn?.computer.kind === "laptop"
          ? `${whereName(conn.computer)} didn't answer.`
          : "Cloud couldn't start.",
      );
  }
}

/** A start that no second try changes: the chat says why, and offers only to take its words back. */
class Stays extends Error {}

/**
 * The pick as a place takes it, once it answers: the agent and model picked where it runs them; where it does not,
 * that agent's own default model, or (for a pick nobody made, Settings' default) the first agent it does run. An
 * agent the person picked themselves is never swapped for another: the chat says the place lacks it.
 */
async function settleAt(
  computerId: string,
  pick: Pick<LiveStart, "engine" | "model" | "picked">,
): Promise<Pick<LiveStart, "engine" | "model">> {
  const conn = conns.get(computerId);
  let listed = links.get().engines[computerId];
  // Not said yet, or still finding out what it is signed in to: asked, for a few seconds at most.
  for (
    let asked = 0;
    conn && asked < 8 && (listed === undefined || stillChecking(listed));
    asked++
  ) {
    if (asked > 0) await sleep(750);
    listed = (await readEngines(conn)) ?? listed;
  }
  // It would not say: as picked, and the computer answers for itself.
  if (!listed) return pick;
  const offer = catalogOf(listed);
  const cloud = conn?.computer.kind === "cloud";
  const name = conn ? whereName(conn.computer) : "its computer";
  const none = noAgentLine({ name, cloud });
  const wanted: ModelRef = { engine: ENGINE_ID[pick.engine], model: pick.model };
  if (offer.length > 0 && pick.picked && !offer.some((e) => e.id === wanted.engine)) {
    // In Cloud, the web's sentence for what the agent still needs there, where one of the person's Macs says.
    const state = links.get();
    const mac = (state.computers ?? [])
      .filter((c) => c.kind === "laptop")
      .map((c) => state.engines[c.computer_id])
      .find((l) => l !== undefined);
    const need = cloud
      ? cloudNeed(
          mac?.find((e) => e.id === wanted.engine),
          Date.now(),
        )
      : null;
    throw new Stays(
      `${need ? need.line : `${ENGINE_NAME[pick.engine]} isn't set up ${cloud ? "for Cloud" : `on ${name}`}.`} Pick another model.`,
    );
  }
  const settled = settlePick(offer, wanted);
  const engine = settled ? boardEngine(settled.engine) : undefined;
  if (!settled || !engine) throw new Error(none);
  return { engine, model: settled.model };
}

/** Starts a chat: a project, one of the person's Macs or Cloud, and the first message. Its placeholder's id, or "". */
function start(request: LiveStart): string {
  if (!links.get().account) {
    // Nobody is signed in: the words stay in the box, and the box says the one thing to do.
    if (!getDraft(NEW_CHAT).trim()) setDraft(NEW_CHAT, request.text);
    say("Sign in to Caveman first (Settings > Account)");
    return "";
  }
  if (!request.repo) {
    // Nothing to start it in: the words stay in the box, and the box says what is missing.
    if (!getDraft(NEW_CHAT).trim()) setDraft(NEW_CHAT, request.text);
    say("Pick a project first");
    return "";
  }
  const picked = request.device ? deviceById(request.device) : undefined;
  const mac =
    picked?.kind === "mac" && picked.id.startsWith("live:") && picked.id !== CLOUD.id
      ? picked.id.slice("live:".length)
      : null;
  const project = projectOf(request.repo) ?? { name: request.repo };
  // Its folder on the Mac picked, where that Mac has one: another Mac's folder means nothing there.
  const path = mac ? folders.get(mac)?.get(keyOf(project)) : undefined;
  const id = startChat(
    {
      text: request.text,
      title: titleFrom(request.text),
      project: { name: project.name, github: project.github, path },
      engine: request.engine,
      model: request.model,
      effort: request.effort,
      speed: request.speed,
      picked: request.picked,
      on: mac && picked ? { kind: "mac", computer_id: mac, name: picked.name } : { kind: "cloud" },
    },
    {
      board,
      device: (computerId) =>
        computerId && mac ? deviceIdOf({ computer_id: computerId }) : CLOUD.id,
      startInCloud: async (input) => {
        const made = await (await theCloud()).startInCloud(input);
        void look();
        return made;
      },
      reach,
      settle: settleAt,
      onStarted: (placeholder, real) => {
        started.delete(placeholder);
        for (const text of after.get(placeholder) ?? []) facade.send(real, text, "followup");
        after.delete(placeholder);
        const focused = ui.get().focused;
        const open = focused?.name === "Thread" && focused.id === placeholder;
        if (open) showChat(real);
        // Once the screen has changed hands: the placeholder's own must not see it go and step back.
        setTimeout(() => dispatch({ type: "remove", id: placeholder }), open ? 400 : 0);
        openFocused();
      },
      // What was typed stays in the chat, marked as not sent, with why under it (start.ts): Try again starts it
      // again, with everything typed under it, and Discard puts it back in the New chat box.
      onFailed: (placeholder, _text, _why, again) => void unstarted.set(placeholder, again),
      words: (error, where) => startWords(error, where, planNow()),
      // Cloud that is switched off stays off, and a place that lacks the agent picked lacks it the next time too.
      retries: (error) => !(error instanceof Stays) && problemWords(error, "start") !== CLOUD_OFF,
    },
  );
  started.set(id, request);
  return id;
}
startsWith(start);

// A chat that did not start has said why to whoever read it: once left, it goes.
ui.watch((next, prev) => {
  if (next.focused === prev.focused) return;
  const on = next.focused?.name === "Thread" ? next.focused.id : null;
  for (const chat of store.get().board.chats) {
    if (!didNotStart(chat) || chat.id === on) continue;
    started.delete(chat.id);
    after.delete(chat.id);
    unstarted.delete(chat.id);
    dispatch({ type: "remove", id: chat.id });
  }
});

// In development the link's state sits beside the store's on `globalThis.__cc` (board/useBoard.ts): `__cc.link.get()`,
// and `__cc.link.set({...})` pins a state a stage cannot reach (no network, a plan that is used up), to look at it.
// `__cc.link.answers(fn)` stands `fn(computer, method, answer)` in for what each computer answers a call from then on
// (a stage's stand-in agents list no models and no sign-in, and it has no plan and no builders), and reads every
// computer that answers again.
if (__DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  const answers = (as: typeof standIn) => {
    standIn = as;
    for (const conn of conns.values()) {
      void readEngines(conn);
      void conn.source.sync().catch(() => undefined);
    }
    void readAgents();
    readLids();
  };
  g.__cc = { ...g.__cc, link: { get: links.get, set, look, agents, answers } };
}
