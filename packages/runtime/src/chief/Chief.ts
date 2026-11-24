// The Chiefs: the person's own coordinator chats, each a bot they hand missions to, sorting its notes and
// starting and watching chats for them (docs/chief.md). The first is made the first time a call needs one;
// the person makes more. Each Chief's conversation is a normal session on a workspace of kind "chief" with no
// repository, and its profile (chief/profiles.ts) holds its name, character, role, model, permissions, the
// projects it works in (none listed: every project) and its soul. They share one board (chief/store.ts), each
// item on one Chief's board, and one set of limits, enforced here in code, never by a prompt. Each runs only
// with its own tools (chief/tools.ts). A note or a call that names no Chief reaches one picked in code
// (pick, routeNote): one that works in the project, else the one with the latest activity. A call can reach
// any Chief (voice/Call.ts).
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ChiefProfile as EngineProfile } from "@caveman-app/engine-core/server/ChiefSessions";
import type { ChatAttachment, ModelSelection, OrchestrationV2Notification, ThreadId } from "@caveman-app/protocol";
import {
  type AccessMode,
  type ChiefAttachment,
  type ChiefAvatar,
  type ChiefBlock,
  type ChiefModelPick,
  type ChiefMoment,
  type ChiefProfile,
  type ChiefUpdates,
  type Params,
  parseThreadReferences,
  type ProjectSource,
  type Result,
  type Session,
  type SessionEvent,
  type Settings,
  type TurnInput,
  type Workspace,
} from "@caveman-app/session-protocol";
import type { Automation } from "@caveman-app/session-protocol/protocol";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import type { Memory } from "../memory/MemoryService.ts";
import { POLARITY_CLASH } from "../memory/MemoryStore.ts";
import { sameRepoUrl } from "../plugins/marketplaces.ts";
import { removeStoredAttachments } from "../session-protocol/attachments.ts";
import { ProtocolError } from "../session-protocol/handlers.ts";
import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";
import { chatFacts, keyTerms, queryTerms, score } from "./about.ts";
import { inlineImages, storeNoteImages, toStored, type WireAttachment } from "./attachments.ts";
import * as Board from "./Board.ts";
import { ChiefError } from "./Board.ts";
import { breadth, DEFAULT_AVATAR, inProjects, makeProfileStore, type OneChief, soulSection, STARTER_SOUL, type StoredProfile, toWireProfile, withoutPlaceholders, withProjects } from "./profiles.ts";
import { autonomySection, byNewest, type ChiefAutonomy, CHIEF_INSTRUCTIONS, clearProject, crewContract, crewRules, noAnswer, noteInput, projectEvidence, type ProjectLine, projectsSection, PROJECTS_IN_FULL, roleLine, routineNews, routinesSection, type SourceLine } from "./prompt.ts";
import { makeRepoProfiles, repoFacts, repoTouchedAt } from "./repos.ts";
import { makeBoardStore, type RoutineNews } from "./store.ts";
import { lessonText, makeLessonStore, type LessonItem, type LessonKind } from "./lessons.ts";
import { makeChiefTools } from "./tools.ts";
import { makeSmartView, SMART_VIEW_INSTRUCTIONS } from "./view.ts";
import { makeWatcher, openAsk } from "./watch.ts";
import { momentTitle, writeMoment } from "./moments.ts";
import { makeProofCapture } from "./proof.ts";
import { NEWS_DECISION } from "@caveman-app/automations";
import type { RoutineReport } from "../automations/services.ts";

export const CHIEF_TITLE = "Chief";
/** A Chief's private home: its working directory, never a repository. */
export const chiefHomeOf = (stateDir: string, id: string) => path.join(stateDir, "chiefs", id);
/** A Chief's name: one line, at most this long. */
const NAME_MAX = 80;
/** A Chief's role (ChiefProfile.role): one line, at most this long. */
export const ROLE_MAX = 140;
/** A new Chief's name when none is given: the first of these no Chief here has, then "Chief N". */
export const CHIEF_NAMES = ["Ugg", "Thog", "Ruk", "Oona", "Brak", "Krag", "Mog", "Zug"] as const;
/** The mascot cast, in order: a new Chief gets the first no Chief here uses, else they cycle. */
export const CHIEF_CAST = [
  "caveman",
  "cavewoman",
  "elder",
  "kid",
  "mammoth",
  "sabertooth",
  "wolf",
  "bear",
  "rhino",
  "sloth",
  "glyptodon",
  "bison",
  "elk",
  "boar",
  "beaver",
  "owl",
  "bat",
  "dino",
  "trike",
  "ptero",
  "petrock",
] as const;
/** Names compare trimmed and case-blind: "ugg " is Ugg. */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The shared limits are off unless the person turns them on (Settings > Chiefs): 0 = no limit. Chats the Chiefs run
 * at once, dollars a day, turns a day (the guard where spend is not measured, a Claude plan).
 */
export const DEFAULT_MAX_CONCURRENT = 0;
export const DEFAULT_DAILY_CAP_USD = 0;
export const DEFAULT_DAILY_TURNS = 0;
/** The limits' defaults before they were off: a saved value equal to one was never the person's choice. */
export const RETIRED_LIMIT_DEFAULTS = { chief_max_concurrent: 4, chief_daily_cap_usd: 20, chief_daily_turns: 200 } as const;
/** The saved settings without the limits still at a retired default, and whether any went. */
export const retireLimitDefaults = (saved: Readonly<Record<string, unknown>>) => {
  const keys = (Object.keys(RETIRED_LIMIT_DEFAULTS) as Array<keyof typeof RETIRED_LIMIT_DEFAULTS>).filter((key) => saved[key] === RETIRED_LIMIT_DEFAULTS[key]);
  const kept = { ...saved };
  for (const key of keys) delete kept[key];
  return { kept, changed: keys.length > 0 };
};
export const DEFAULT_ASK_ABOVE_CHATS = 3;
/** How much a Chief does without asking (Settings chief_autonomy): 2, it starts chats itself. */
export const DEFAULT_CHIEF_AUTONOMY: ChiefAutonomy = 2;
/** Minutes a Chief's question waits for the person before it goes ahead with what it recommended. */
export const DEFAULT_ASK_WAIT_MINUTES = 15;
/** A fan-out sibling waits at most this long for the first chat's first token (Claude Code's own hold). */
export const FANOUT_HOLD_MS = 5_000;

/** A Claude Agent or Codex login a Chief may run on (engineAccounts.ts chiefLogins). */
export interface ChiefLogin {
  readonly engine: string;
  readonly account_id: string;
 /** A subscription (a Claude plan, a compact login), else an API key or a cloud lane. */
  readonly plan: boolean;
}

/**
 * What the Chief runs on, from what is connected: its pick while that account is
 * (`pick`: a Caveman engine model, or a Claude Agent or Codex model on the login it names); else Auto on the Caveman
 * engine's fast floor; else a Claude plan through Claude Code; with nothing, nothing (it captures). A login on a paid
 * key (an API key, a cloud lane) and Codex run a Chief only when it picked them. A pick that names no login (the
 * picker names one only past one login, as the composer does) runs on that engine's plan where it has one, never on a
 * key beside it, else on its one login. `dropped`: the pick's account is gone, so it gave way.
 */
export function chiefModelChoice(input: {
  readonly pick: ChiefModelPick | null | undefined;
  /** The Caveman engine's connected models (connected.ts). */
  readonly connected: ReadonlyArray<string>;
  /** The Claude Agent and Codex logins signed in, each engine's active login first. */
  readonly logins: ReadonlyArray<ChiefLogin>;
}): {
  readonly choice: "pick" | "auto" | "login" | "none";
  readonly dropped: boolean;
  /** The login a Claude Agent or Codex route runs on. */
  readonly login?: ChiefLogin;
} {
  const pick = input.pick ?? undefined;
  if (pick !== undefined) {
    if (pick.engine === "caveman") {
      if (input.connected.length > 0 && (pick.model === "auto" || input.connected.includes(pick.model))) return { choice: "pick", dropped: false };
    } else {
      const mine = input.logins.filter((l) => l.engine === pick.engine);
      const login = pick.account_id !== undefined ? mine.find((l) => l.account_id === pick.account_id) : (mine.find((l) => l.plan) ?? mine[0]);
      if (login !== undefined) return { choice: "pick", dropped: false, login };
    }
  }
  const dropped = pick !== undefined;
  if (input.connected.length > 0) return { choice: "auto", dropped };
  const plan = input.logins.find((l) => l.engine === "claude-agent" && l.plan);
  return plan !== undefined ? { choice: "login", dropped, login: plan } : { choice: "none", dropped };
}

/** Workspace statuses that hold one of the Chief's chat slots. */
const HOLDS_SLOT = new Set(["starting", "working", "needs_input", "waiting"]);
/** How many chats one chat_search reads (the most recently touched): each is one small read of its journal. */
const SEARCH_SCAN = 300;

export type SubmitInput = Pick<Params<"turn.submit">, "request_id" | "kind" | "input" | "options"> & {
  readonly instructions?: string;
  /** Attachments already in the store under this thread (a note's images, chief/attachments.ts): dispatched as they are, no copy. */
  readonly stored?: ReadonlyArray<ChatAttachment>;
  readonly generated?: true;
  /** The agent that wrote it (the Chief): the message is its, never the person's, and its taint carries. */
  readonly from?: WorkspaceRecord;
 /** A wake the runtime sends: no bubble of the person's, a quiet line instead (upstream notification). */
  readonly notification?: OrchestrationV2Notification;
  /** The model this turn runs on (the Chief's pick or Auto, `selection`): a Claude Agent or Codex login moves it there. */
  readonly modelSelection?: ModelSelection;
};

/** What the Chief needs from the Session Protocol handlers (session-protocol/handlers.ts builds it). */
export interface ChiefDeps {
  readonly store: SessionStore["Service"];
  readonly stateDir: string;
  /** The runtime's attachment store (every chat's): a note's images go there too. */
  readonly attachmentsDir: string;
  readonly computer: Workspace["computer"];
  /**
   * What a Chief with this pick runs on now: the pick while its account is connected, else Auto (the Caveman
   * engine's fast floor, or a Claude Agent or Codex login when that is all there is). `dropped`: the pick
   * gave way to Auto (its account is gone, or its model is not offered now).
   */
  readonly selection: (pick: ChiefModelPick | null) => Effect.Effect<{ readonly selection: ModelSelection; readonly dropped: boolean }, ProtocolError>;
  /**
   * Whether a Chief with this pick has something to run on now (chiefModelChoice is not "none"): it thinks, else it
   * only captures. A login on a paid key counts only for a Chief that picked it.
   */
  readonly canThink: (pick: ChiefModelPick | null) => Effect.Effect<boolean>;
  /** thread.create for a Chief's thread, under a command id fixed by its thread: sent again, T3 makes it once. */
  readonly createThread: (input: { readonly threadId: ThreadId; readonly title: string; readonly worktreePath: string; readonly modelSelection: ModelSelection }) => Effect.Effect<void, ProtocolError>;
  /** Whether T3 has this thread (a Chief made before its thread was, by a quit or a failed send in between, has none). */
  readonly threadExists: (threadId: string) => Effect.Effect<boolean>;
  /**
   * workspace.create as the runtime, for the Chief: the task is its words, and `quotes` the person's, checked against
   * what they typed to it, or to `heardIn` (the session of the Chief that first heard the item it starts: Board.Item heard_in).
   */
  readonly createWorkspace: (
    p: Params<"workspace.create"> & { readonly from?: { readonly record: WorkspaceRecord; readonly quotes?: ReadonlyArray<string>; readonly heardIn?: string } },
  ) => Effect.Effect<Workspace, ProtocolError>;
  readonly submit: (record: WorkspaceRecord, p: SubmitInput) => Effect.Effect<Result<"turn.submit">, ProtocolError>;
  /** Until its running turn (if any) takes input, so a note sent next steers into it. */
  readonly steerable: (record: WorkspaceRecord) => Effect.Effect<void>;
  readonly interrupt: (record: WorkspaceRecord, requestId: string) => Effect.Effect<void, ProtocolError>;
  /** ask.respond as the runtime: a Chief answering its chat's question card (chief/tools.ts chat_answer). */
  readonly respond: (record: WorkspaceRecord, askId: string, response: Params<"ask.respond">["response"], requestId: string) => Effect.Effect<void, ProtocolError>;
  /** workspace.archive as the runtime: a fan-out sibling that could never start. */
  readonly archive: (record: WorkspaceRecord, requestId: string) => Effect.Effect<void, ProtocolError>;
  /** workspace.rename as the runtime: a Chief's new name on its workspace and thread. */
  readonly rename: (record: WorkspaceRecord, title: string) => Effect.Effect<void, ProtocolError>;
  /** A removed Chief's workspace, archived (workspace.archive refuses a Chief), and every device told. */
  readonly retire: (record: WorkspaceRecord) => Effect.Effect<void>;
  /**
   * Closes a Chief's engine session while no turn of it runs, so its next turn opens one with its profile as it is now
   * (an engine reads a Chief's prefix when its session opens). False: a turn runs, or it can't tell; try again later.
   */
  readonly reopen: (record: WorkspaceRecord) => Effect.Effect<boolean>;
  /** A removed Chief's own turn stopped and its engine session closed for good (its MCP credential revoked). */
  readonly close: (record: WorkspaceRecord) => Effect.Effect<void>;
  readonly digest: (record: WorkspaceRecord) => Effect.Effect<{ readonly status: string; readonly goal?: string; readonly latest?: string } | undefined>;
  readonly settings: Effect.Effect<Settings>;
  /** The builders at work under a chat, on this computer or another (session-protocol/builders.ts): each holds one of the Chiefs' slots. */
  readonly buildersAtWork?: (workspaceId: string) => Effect.Effect<number>;
  /** Every project, with when it was added. */
  readonly projects: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string; readonly path: string; readonly created_at?: string }>>;
  /** A project's sources (session-protocol sources.ts projectSources), its own repository first; none when it can't be read. */
  readonly projectSources: (id: string) => Effect.Effect<ReadonlyArray<ProjectSource>>;
  /** Project `id` as its row is, removed ones included; undefined: no such project. Fails when it can't be read. */
  readonly projectRow: (id: string) => Effect.Effect<{ readonly name: string; readonly removed: boolean } | undefined, unknown>;
  /** Measured spend (US dollars) since `from` of these workspaces, the Chief's own bucket included. */
  readonly spend: (from: string, workspaceIds: ReadonlySet<string>) => Effect.Effect<number>;
  /** Turns finished since `from` in these workspaces. */
  readonly turns: (from: string, workspaceIds: ReadonlySet<string>) => Effect.Effect<number>;
  /** A quiet line in a session's transcript. */
  readonly note: (record: WorkspaceRecord, title: string, body?: string) => Effect.Effect<void>;
  readonly memory: Option.Option<Memory["Service"]>;
  /** A project's routines (its automation.list rows with a `routine`), for the full boards of the Chiefs they report to. Absent: none listed. */
  readonly routines?: (projectId: string) => Effect.Effect<ReadonlyArray<Pick<typeof Automation.Type, "id" | "title" | "enabled" | "routine">>>;
}

/** What a news card and its wake carry of a routine's report at most. */
const NEWS_CHARS = 4_000;

const now = () => new Date().toISOString();
const localMidnight = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

export { ChiefError } from "./Board.ts";

/** A profile edit (chief.update): each key present replaces that field. */
export interface ChiefPatch {
  readonly name?: string;
  readonly avatar?: ChiefAvatar;
  readonly model?: ChiefModelPick | null;
  readonly access?: AccessMode | null;
  /** Empty: every project. */
  readonly project_ids?: ReadonlyArray<string>;
  /** Empty: none. */
  readonly role?: string;
  readonly soul?: string;
  /** null: Settings' again. */
  readonly autonomy?: ChiefAutonomy | null;
  readonly updates?: ChiefUpdates | null;
}

const oneChief = (record: WorkspaceRecord, profile: StoredProfile): OneChief => ({ record, profile });

/** A Chief's autonomy level (1 ask, 2 start, 3 manage): its own, else Settings' chief_autonomy, else DEFAULT_CHIEF_AUTONOMY. */
export const autonomyLevel = (own: unknown, settings: unknown): ChiefAutonomy => {
  const level = own ?? settings;
  return level === 1 || level === 2 || level === 3 ? level : DEFAULT_CHIEF_AUTONOMY;
};

export { inProjects } from "./profiles.ts";

/**
 * A Chief's system text: its role first when it has one (prompt.ts roleLine), then the constant text every Chief
 * reads. Its role and name change only by chief.update, which reopens its session.
 */
export const chiefInstructions = (profile: Pick<ChiefProfile, "name" | "role">) =>
  [...(profile.role ? [roleLine(profile.name, profile.role)] : []), CHIEF_INSTRUCTIONS, SMART_VIEW_INSTRUCTIONS].join("\n\n");

/** A role as kept (ChiefProfile.role): one line, trimmed; empty is none. Undefined: too long. */
export const cleanRole = (role: string) => {
  const line = role.replace(/\s+/g, " ").trim();
  return line.length > ROLE_MAX ? undefined : line;
};

export const makeChief = (deps: ChiefDeps) =>
  Effect.gen(function* () {
    const { store } = deps;
    const board = yield* makeBoardStore(store);
    const profiles = makeProfileStore(store.sql);
    const lessons = makeLessonStore(store.sql);
    /** Only the person's board handlers call this; the Chief's tools never teach it its own choices. */
    const learn = (kind: LessonKind, item: Board.Item, before?: Board.Item, position?: number) =>
      Effect.gen(function* () {
        if (item.chief_id === undefined) return;
        const projects = yield* deps.projects;
        const named = (i: Board.Item): LessonItem => ({ ...i, project_ids: i.project_ids.map((id) => projects.find((p) => p.id === id)?.name ?? id), ...(position === undefined ? {} : { position }) });
        yield* lessons.add({ chief_id: item.chief_id, item_id: item.id, kind, text: lessonText(kind, named(item), before === undefined ? undefined : named(before)), at: now() });
      });
    // Smart View: what each Chief put in the person's sidebar (view.ts), on unless Settings turns it off.
    const view = yield* makeSmartView({ store, on: deps.settings.pipe(Effect.map((s) => s.chief_smart_view !== false)) });
    // Making, editing and removing Chiefs, one at a time.
    const ensureLock = yield* Semaphore.make(1);
    // One admission at a time: two starts can never both take the last slot.
    const admission = yield* Semaphore.make(1);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    /** Every Chief, after each make, edit or removal (chief.list.updated). */
    const listChanges = yield* PubSub.unbounded<ReadonlyArray<ChiefProfile>>();

    // ---------------------------------------------------------------- the Chiefs

    /** Every Chief not removed, oldest first: their wire profiles. */
    const listed = profiles.live.pipe(Effect.map((rows) => rows.map(toWireProfile)));
    const publishList = listed.pipe(Effect.flatMap((chiefs) => PubSub.publish(listChanges, chiefs)), Effect.asVoid);

    /** A Chief by its id (its workspace's), unless it was removed. */
    const byId = (id: string) =>
      Effect.gen(function* () {
        const profile = yield* profiles.get(id);
        if (profile === undefined || profile.removed_at !== undefined) return undefined;
        const record = yield* store.getWorkspace(id);
        return record === undefined || record.workspace.kind !== "chief" ? undefined : oneChief(record, profile);
      });
    const mustBe = (id: string) =>
      byId(id).pipe(Effect.flatMap((found) => (found ? Effect.succeed(found) : Effect.fail(new ChiefError(`No Chief ${id}.`, "not_found")))));
    /**
     * The thread's Chief: undefined for a thread that is no Chief's; `removed` for a Chief removed since, or one
     * with no profile, whose thread must never open again (as a Chief or as a coding session).
     */
    const ofThread = (threadId: string) =>
      Effect.gen(function* () {
        const record = yield* store.getByThread(threadId);
        if (record === undefined || record.workspace.kind !== "chief") return undefined;
        const profile = yield* profiles.get(record.workspace.id);
        return profile === undefined || profile.removed_at !== undefined ? ("removed" as const) : oneChief(record, profile);
      });
    const chiefOf = (threadId: string) => ofThread(threadId).pipe(Effect.map((found) => (found === "removed" ? undefined : found)));
    /** The Chief whose board the item is on. */
    const ownerOf = (item: Board.Item) => (item.chief_id === undefined ? Effect.succeed(undefined) : byId(item.chief_id));

    /**
     * A Chief from before profiles (the one workspace of kind chief) gets its profile, once, as the home Chief, in every
     * project: Settings' chief_model becomes its model and chief_rules its soul, and the board's rows from then are its.
     */
    const adoptLegacy = Effect.gen(function* () {
      const home = yield* profiles.home;
      // Its items are its own (a runtime with one Chief left them unnamed). One whose workspace is gone is replaced as
      // any Chief is (replaceGone, later in the pass), its open items handed on, never left on a removed Chief.
      if (home !== undefined) return yield* board.setHome(home.id);
      const [legacy] = (yield* store.listWorkspaces())
        .filter((r) => r.workspace.kind === "chief" && r.workspace.status !== "archived")
        .sort((a, b) => a.workspace.created_at.localeCompare(b.workspace.created_at));
      if (legacy === undefined || (yield* profiles.get(legacy.workspace.id)) !== undefined) return;
      const s = yield* deps.settings;
      const at = now();
      yield* profiles.put({
        id: legacy.workspace.id,
        name: legacy.workspace.title || CHIEF_TITLE,
        avatar: DEFAULT_AVATAR,
        model: s.chief_model ?? null,
        access: null,
        project_ids: [],
        soul: (s.chief_rules ?? "").trim() !== "" ? s.chief_rules! : STARTER_SOUL,
        home: true,
        created_at: at,
        updated_at: at,
      });
      yield* board.setHome(legacy.workspace.id);
    });

    const cleanName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    /** A new Chief's name: the first of CHIEF_NAMES no live Chief has, else "Chief 2", "Chief 3", …. */
    const nextName = Effect.gen(function* () {
      const taken = (yield* profiles.live).map((p) => p.name);
      const free = CHIEF_NAMES.find((name) => !taken.some((t) => sameName(t, name)));
      if (free !== undefined) return free;
      let n = 2;
      while (taken.some((t) => sameName(t, `${CHIEF_TITLE} ${n}`))) n++;
      return `${CHIEF_TITLE} ${n}`;
    });
    /** A new Chief's character: the first of the cast no live Chief uses, else the cast in turn. */
    const nextAvatar = Effect.gen(function* () {
      const live = yield* profiles.live;
      const used = new Set(live.map((p) => p.avatar.character));
      const character = CHIEF_CAST.find((c) => !used.has(c)) ?? CHIEF_CAST[live.length % CHIEF_CAST.length]!;
      return { ...DEFAULT_AVATAR, character } satisfies ChiefAvatar;
    });
    /** Refused when another live Chief has this name (trimmed, case-blind). */
    const nameFree = (name: string, except?: string) =>
      profiles.live.pipe(
        Effect.flatMap((live) => {
          const other = live.find((p) => p.id !== except && sameName(p.name, name));
          return other === undefined ? Effect.void : Effect.fail(new ChiefError(`Another Chief is called ${other.name}`, "invalid_state"));
        }),
      );
    const roleTooLong = () => new ChiefError(`A Chief's role is one line of at most ${ROLE_MAX} characters.`, "invalid_params");

    /**
     * A new Chief: its private folder, its workspace and profile (written together, so neither is ever there without
     * the other), then its thread. Any failure on the way takes back what was made: no Chief is left half made.
     * `projectIds`: the projects it works in (none: every project). Unnamed, it takes a short name; no soul, the
     * starter. `takesOver` writes the rows instead (`put`, in its own transaction): a Chief made in place of one whose
     * workspace is gone, which takes that one's work in the same transaction. Its rows then hold that work, so a failed
     * thread leaves them, and the next call that reaches it sends the thread again (healed).
     */
    const make = (input: {
      readonly projectIds: ReadonlyArray<string>;
      readonly name?: string | undefined;
      readonly avatar?: ChiefAvatar | undefined;
      readonly role?: string | undefined;
      readonly soul?: string | undefined;
      readonly takesOver?: (id: string, put: Effect.Effect<void>) => Effect.Effect<void>;
    }) =>
      Effect.gen(function* () {
        const id = randomUUID();
        const folder = chiefHomeOf(deps.stateDir, id);
        const at = now();
        const name = input.name ?? (yield* nextName);
        const avatar = input.avatar ?? (yield* nextAvatar);
        const profile: StoredProfile = {
          id,
          name,
          avatar,
          model: null,
          // Its chats take what any new chat in their project takes (null), until the person picks for it.
          access: null,
          project_ids: [...input.projectIds],
          ...(input.role ? { role: input.role } : {}),
          soul: input.soul ?? STARTER_SOUL,
          home: false,
          created_at: at,
          updated_at: at,
        };
        const threadId = `caveman:${id}` as ThreadId;
        const session: Session = { id: randomUUID(), workspace_id: id, engine: "caveman", state: "live", lease: { computer_id: deps.computer.id, expires_at: "9999-12-31T23:59:59.000Z" }, head: 0, created_at: at, updated_at: at };
        const record: WorkspaceRecord = {
          workspace: {
            id,
            title: name,
            repo: { path: folder },
            base_ref: "",
            branch: "",
            engine: "caveman",
            computer: deps.computer,
            session_id: session.id,
            status: "idle",
            kind: "chief",
            created_at: at,
            updated_at: at,
          },
          session,
          internal: { threadId, worktreePath: folder, repoPath: null, setup: "none" },
        };
        const chosen = yield* deps.selection(profile.model);
        const undo = Effect.gen(function* () {
          yield* store.sql`DELETE FROM caveman_sp_workspaces WHERE id = ${id}`.pipe(Effect.ignore);
          yield* store.sql`DELETE FROM chief_profiles WHERE id = ${id}`.pipe(Effect.ignore);
          yield* Effect.sync(() => fs.rmSync(folder, { recursive: true, force: true })).pipe(Effect.ignore);
        });
        const put = store.putWorkspace(record).pipe(Effect.andThen(profiles.put(profile)));
        yield* Effect.gen(function* () {
          yield* Effect.sync(() => fs.mkdirSync(folder, { recursive: true, mode: 0o700 }));
          // Registered before T3 hears of the thread, so the journal never misses its first event; with its profile.
          yield* input.takesOver === undefined ? store.sql.withTransaction(put) : input.takesOver(id, put.pipe(Effect.orDie));
        }).pipe(Effect.onError(() => undo));
        const thread = deps.createThread({ threadId, title: name, worktreePath: folder, modelSelection: chosen.selection });
        yield* input.takesOver === undefined ? thread.pipe(Effect.onError(() => undo)) : thread;
        yield* store.publishWorkspace(record.workspace);
        yield* publishList;
        return oneChief(record, profile);
      });

    /** Each of `ids` once, all of them the person's projects (not_found for one that is not). */
    const knownProjects = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const projects = yield* deps.projects;
        const unique = [...new Set(ids)];
        const unknown = unique.find((id) => !projects.some((p) => p.id === id));
        return unknown === undefined ? unique : yield* Effect.fail(new ChiefError(`No project ${unknown}.`, "not_found"));
      });
    /**
     * Every project, the one with the latest chat activity first; one with no chats by its checkout's last change, else
     * when it was added. Where a note that names no project goes when its words settle none (routeNote).
     */
    const activeProjects = Effect.gen(function* () {
      const projects = yield* deps.projects;
      const last = new Map<string, string>();
      for (const r of yield* store.listWorkspaces()) {
        const id = r.workspace.project_id;
        if (id === undefined || r.workspace.kind !== undefined) continue;
        if ((last.get(id) ?? "") < r.workspace.updated_at) last.set(id, r.workspace.updated_at);
      }
      return projects
        .map((p) => {
          const lastChatAt = last.get(p.id);
          const touchedAt = repoTouchedAt(p.path) ?? p.created_at;
          return { p, ...(lastChatAt === undefined ? {} : { lastChatAt }), ...(touchedAt === undefined ? {} : { touchedAt }) };
        })
        .sort(byNewest)
        .map((k) => k.p);
    });

    /** Every live Chief with its workspace (kind chief), oldest first: the ones a call, a note or an item can reach. */
    const liveChiefs = Effect.gen(function* () {
      const out: Array<OneChief> = [];
      for (const profile of yield* profiles.live) {
        const record = yield* store.getWorkspace(profile.id);
        if (record !== undefined && record.workspace.kind === "chief") out.push(oneChief(record, profile));
      }
      return out;
    });
    /** When a Chief last did anything: its workspace's last change (each turn moves it), or its newest item's when later. */
    const activityOf = (me: OneChief, items: ReadonlyArray<Board.Item>) =>
      items.reduce((at, item) => (item.chief_id === me.profile.id && item.updated_at > at ? item.updated_at : at), me.record.workspace.updated_at);
    /**
     * The Chief, among `chiefs`, that a call naming none reaches: one that works in `projectId`, the one with the fewest
     * projects first (every project counts as most), then the oldest; else (or with no project) the one with the latest
     * activity (activityOf), the oldest on a tie. Undefined: none.
     */
    const pickAmong = (chiefs: ReadonlyArray<OneChief>, projectId: string | undefined, items: ReadonlyArray<Board.Item>) => {
      const oldest = (a: OneChief, b: OneChief) => a.profile.created_at.localeCompare(b.profile.created_at) || a.profile.id.localeCompare(b.profile.id);
      const there = chiefs.filter((c) => inProjects(c.profile, projectId)).sort((a, b) => breadth(a.profile) - breadth(b.profile) || oldest(a, b));
      if (there[0] !== undefined) return there[0];
      const at = new Map(chiefs.map((c) => [c.profile.id, activityOf(c, items)] as const));
      return [...chiefs].sort((a, b) => at.get(b.profile.id)!.localeCompare(at.get(a.profile.id)!) || oldest(a, b))[0];
    };
    /** pickAmong every live Chief. */
    const pick = (projectId: string | undefined) =>
      Effect.gen(function* () {
        const chiefs = yield* liveChiefs;
        return pickAmong(chiefs, projectId, yield* board.all);
      });

    /** An item a gone Chief leaves: open (the person's notes and asks) or running (its chats still need watching). */
    const leftBy = (chiefId: string) => (item: Board.Item) => item.chief_id === chiefId && (Board.OPEN_STATES.has(item.state) || Board.RUNNING_STATES.has(item.state));
    /**
     * An item handed to Chief `to` (Board.handedTo), saying `detail`. A note its Chief heard keeps where (`heardIn`, that
     * Chief's session), so a quote of it still checks against the person's words there.
     */
    const handed = (item: Board.Item, to: string, heardIn: string | undefined, detail: string, at: string): Board.Item & { readonly chief_id: string } => ({
      ...Board.handedTo(item, detail, at),
      chief_id: to,
      ...(item.heard_in === undefined && item.delivered === true && heardIn !== undefined ? { heard_in: heardIn } : {}),
    });
    /** An item's project: its first that is still there, else that of its first chat in one; undefined: none. */
    const projectOfItem = (item: Board.Item, exists: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const own = item.project_ids.find((id) => exists.has(id));
        if (own !== undefined) return own;
        for (const id of item.workspace_ids) {
          const there = (yield* store.getWorkspace(id))?.workspace.project_id;
          if (there !== undefined && exists.has(there)) return there;
        }
        return undefined;
      });
    /**
     * The open and running items `gone` leaves, each handed (Board.handedTo) to the Chief that takes it: another one that
     * works in the item's project, else the one with the latest activity (pickAmong), in one transaction, read under the
     * board's lock, that also marks `gone` removed. False, with nothing written, when it leaves items and no other Chief
     * is there to take them. `heardIn`: its session, where the person typed the words its notes hold.
     */
    const handOff = (gone: StoredProfile, heardIn: string | undefined, detail: string) =>
      Effect.gen(function* () {
        const others = (yield* liveChiefs).filter((c) => c.profile.id !== gone.id);
        const exists = new Set((yield* deps.projects).map((p) => p.id));
        return yield* board.move((items) =>
          Effect.gen(function* () {
            const at = now();
            const left = items.filter(leftBy(gone.id));
            if (left.length > 0 && others.length === 0) return { moved: [], value: false };
            const moved: Array<Board.Item & { readonly chief_id: string }> = [];
            for (const item of left) moved.push(handed(item, pickAmong(others, yield* projectOfItem(item, exists), items)!.profile.id, heardIn, detail, at));
            return { moved, within: profiles.put({ ...gone, removed_at: at, updated_at: at }), value: true };
          }),
        );
      });

    /** A Chief whose thread T3 has: one made before its thread was (a quit or a failed send in between) has none. */
    const whole = (record: WorkspaceRecord) => deps.threadExists(record.internal.threadId);
    /**
     * A Chief as a call reaches it, whole: one made before its thread was (a launch cut short, or one made in place of a
     * Chief whose workspace was gone) gets its thread now, the same thread.create again, which T3 takes once (its command
     * id is fixed by the thread).
     */
    const healed = (me: OneChief) =>
      Effect.gen(function* () {
        if (yield* whole(me.record)) return me;
        return yield* ensureLock.withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* whole(me.record))) {
              const { selection } = yield* deps.selection(me.profile.model);
              yield* deps.createThread({ threadId: me.record.internal.threadId as ThreadId, title: me.profile.name, worktreePath: me.record.internal.worktreePath ?? chiefHomeOf(deps.stateDir, me.profile.id), modelSelection: selection });
            }
            return me;
          }),
        );
      });

    /** Done once the startup pass (startup, which watch runs first) went through or failed. */
    const startedUp = yield* Deferred.make<void>();
    /** Before any call that reaches a Chief: the startup pass, so no call sees a Chief or a board from before it. */
    const settled = Deferred.await(startedUp);

    /**
     * The Chief a call names: `chiefId`'s; else one that works in `projectId` (one the person does not have: not_found),
     * else the one with the latest activity (pick). With no Chief at all the first is made, "Chief", in every project,
     * under ensureLock so two calls make one. No project is needed.
     */
    const resolve = (input: { readonly chiefId?: string | undefined; readonly projectId?: string | undefined }) =>
      Effect.gen(function* () {
        yield* settled;
        if (input.chiefId !== undefined) return yield* healed(yield* mustBe(input.chiefId));
        if (input.projectId !== undefined) yield* knownProjects([input.projectId]);
        const found =
          (yield* pick(input.projectId)) ??
          (yield* ensureLock.withPermits(1)(
            Effect.gen(function* () {
              return (yield* pick(input.projectId)) ?? (yield* make({ projectIds: [], name: CHIEF_TITLE }));
            }),
          ));
        return yield* healed(found);
      });

    /** Every Chief (chief.list). */
    const list = settled.pipe(Effect.andThen(listed));

    /**
     * A new Chief (chief.create) in `projectIds` (each one of the person's projects; none: every project). No project is
     * needed. Unnamed, it takes the first free short name; with no soul, the starter.
     */
    const create = (input: {
      readonly projectIds?: ReadonlyArray<string> | undefined;
      readonly name?: string | undefined;
      readonly avatar?: ChiefAvatar | undefined;
      readonly role?: string | undefined;
      readonly soul?: string | undefined;
    }) =>
      Effect.gen(function* () {
        yield* settled;
        const projectIds = yield* knownProjects(input.projectIds ?? []);
        const role = input.role === undefined ? undefined : cleanRole(input.role);
        if (role === undefined && input.role !== undefined) return yield* Effect.fail(roleTooLong());
        return yield* ensureLock.withPermits(1)(
          Effect.gen(function* () {
            const name = input.name === undefined ? undefined : cleanName(input.name);
            if (name === "") return yield* Effect.fail(new ChiefError("A Chief's name can't be blank.", "invalid_params"));
            if (name !== undefined) yield* nameFree(name);
            const made = yield* make({ projectIds, name, avatar: input.avatar, role, soul: input.soul });
            return toWireProfile(made.profile);
          }),
        );
      });

    /**
     * Your edit of a Chief's profile (chief.update). A new name renames its workspace; the rest reaches its next turn. A
     * new soul, role (or name beside one) or project list reopens its session before then (stale), as its autonomy and
     * its projects' sources do (refresh).
     */
    const update = (id: string, patch: ChiefPatch) =>
      Effect.gen(function* () {
        const projectIds = patch.project_ids === undefined ? undefined : yield* knownProjects(patch.project_ids);
        const role = patch.role === undefined ? undefined : cleanRole(patch.role);
        if (role === undefined && patch.role !== undefined) return yield* Effect.fail(roleTooLong());
        return yield* ensureLock.withPermits(1)(
          Effect.gen(function* () {
            const me = yield* mustBe(id);
            const name = patch.name === undefined ? undefined : cleanName(patch.name);
            if (name === "") return yield* Effect.fail(new ChiefError("A Chief's name can't be blank.", "invalid_params"));
            if (name !== undefined) yield* nameFree(name, id);
            if (name !== undefined && name !== me.record.workspace.title) yield* deps.rename(me.record, name);
            // Its own levels: a patch key replaces it, null goes back to Settings'. Its next turn reads them (refresh); its gate at once.
            const { autonomy: ownAutonomy, updates: ownUpdates, role: ownRole, ...kept } = me.profile;
            const autonomy = patch.autonomy === undefined ? ownAutonomy : (patch.autonomy ?? undefined);
            const updates = patch.updates === undefined ? ownUpdates : (patch.updates ?? undefined);
            const nextRole = role === undefined ? ownRole : role === "" ? undefined : role;
            const edited: StoredProfile = {
              ...kept,
              ...(autonomy === undefined ? {} : { autonomy }),
              ...(updates === undefined ? {} : { updates }),
              ...(nextRole === undefined ? {} : { role: nextRole }),
              ...(name === undefined ? {} : { name }),
              ...(patch.avatar === undefined ? {} : { avatar: patch.avatar }),
              ...(patch.model === undefined ? {} : { model: patch.model }),
              ...(patch.access === undefined ? {} : { access: patch.access }),
              ...(patch.soul === undefined ? {} : { soul: patch.soul }),
              updated_at: now(),
            };
            const next = projectIds === undefined ? edited : withProjects(edited, projectIds);
            yield* profiles.put(next);
            // Its prefix changed: its next turn reopens its session with it (marked once the new profile is stored).
            const moved = projectIds !== undefined && (projectIds.length !== me.profile.project_ids.length || projectIds.some((p) => !me.profile.project_ids.includes(p)));
            const renamed = name !== undefined && name !== me.profile.name && nextRole !== undefined;
            if ((patch.soul !== undefined && patch.soul !== me.profile.soul) || nextRole !== ownRole || renamed || moved) stale.add(id);
            yield* publishList;
            return toWireProfile(next);
          }),
        );
      });

    /** Settings.chief_soul changed: every Chief's next turn reopens its session with it, as its own soul's edit does. */
    const soulChanged = profiles.live.pipe(
      Effect.map((all) => {
        for (const p of all) stale.add(p.id);
      }),
    );

    /**
     * Removes a Chief (chief.remove), any Chief. Its open and running items move to the Chiefs that take them (handOff),
     * which watch their chats from then on, in the same transaction that marks its profile removed, so any board write
     * of its from then on is refused (a tool call already past its check included: the check is under the board's
     * lock). The last Chief with open items is refused: they would have nowhere to go. Then its workspace is archived,
     * and its own turn stopped and its engine session closed. Under admission's lock (taken before the Chiefs' own,
     * which capture and chief.get wait on), so nothing of its starts while it goes.
     */
    const remove = (id: string) =>
      Effect.gen(function* () {
        const me = yield* admission.withPermits(1)(
          ensureLock.withPermits(1)(
            Effect.gen(function* () {
              const me = yield* mustBe(id);
              if (!(yield* handOff(me.profile, me.record.session.id, `Moved here from ${me.profile.name} when it was removed.`))) {
                return yield* Effect.fail(new ChiefError("Make another Chief first: its missions need somewhere to go.", "invalid_state"));
              }
              views.delete(id);
              stale.delete(id);
              return me;
            }),
          ),
        );
        // Outside the locks: its turn may take a moment to stop.
        yield* deps.close(me.record);
        yield* deps.retire(me.record);
        yield* board.publish;
        yield* publishList;
        // Notes it never sorted go to their new Chief now.
        yield* catchUp;
      });

    /**
     * project.remove took the project away: it leaves every Chief's list. A Chief whose list it empties retires as
     * chief.remove takes one (profile marked removed, own turn stopped, engine session closed, workspace archived), and
     * its open items are dropped, each saying why. Another Chief's open item in that project is dropped too, unless it
     * names other projects, which it keeps. An item whose chats still run (outside the project: its own chats were
     * archived first) stays as it is, saying so, since its chats still work. One transaction, under the board's lock.
     */
    const retireProject = (projectId: string, projectName: string) =>
      Effect.gen(function* () {
        const gone = yield* admission.withPermits(1)(
          ensureLock.withPermits(1)(
            Effect.gen(function* () {
              const live = yield* profiles.live;
              const retiring = new Set(live.filter((p) => p.project_ids.length > 0 && p.project_ids.every((id) => id === projectId)).map((p) => p.id));
              const narrowed = live.filter((p) => !retiring.has(p.id) && p.project_ids.includes(projectId));
              const chatsRun = (item: Board.Item) =>
                Effect.forEach(item.workspace_ids, (id) => store.getWorkspace(id)).pipe(Effect.map((records) => records.some((r) => r !== undefined && r.workspace.status !== "archived" && HOLDS_SLOT.has(r.workspace.status))));
              const touched = yield* board.update("project_removed", (items) =>
                Effect.gen(function* () {
                  const at = now();
                  const write: Array<Board.Item> = [];
                  for (const item of items) {
                    if (item.chief_id === undefined || !(Board.OPEN_STATES.has(item.state) || Board.RUNNING_STATES.has(item.state))) continue;
                    const theirs = retiring.has(item.chief_id);
                    if (!theirs && !item.project_ids.includes(projectId)) continue;
                    // Work in other projects too: it stays, there. A draft naming the project could never start (its
                    // first chat would fail before the rest), so it goes, and the item is drafted again (Board.undraft).
                    if (!theirs && item.project_ids.some((id) => id !== projectId)) {
                      const kept = { ...item, project_ids: item.project_ids.filter((id) => id !== projectId), updated_at: at };
                      write.push(item.proposal?.project_ids.includes(projectId) ? { ...Board.undraft(kept, at), detail: `${projectName} was removed, so this is drafted again.` } : kept);
                      continue;
                    }
                    write.push(
                      Board.RUNNING_STATES.has(item.state) && (yield* chatsRun(item))
                        ? { ...item, detail: `${projectName} was removed, but its chats still run elsewhere, so it stays until they finish.`, updated_at: at }
                        : { ...Board.drop(item, at), detail: `Dropped: ${projectName} was removed.` },
                    );
                  }
                  for (const p of live) if (retiring.has(p.id)) yield* profiles.put({ ...p, removed_at: at, updated_at: at });
                  for (const p of narrowed) yield* profiles.put({ ...withProjects(p, p.project_ids.filter((id) => id !== projectId)), updated_at: at });
                  return { write, value: write.length > 0 };
                }),
              );
              const out: Array<OneChief> = [];
              for (const p of live) {
                if (!retiring.has(p.id)) continue;
                views.delete(p.id);
                stale.delete(p.id);
                const record = yield* store.getWorkspace(p.id);
                if (record !== undefined && record.workspace.kind === "chief") out.push(oneChief(record, p));
              }
              // Its Projects section lost one: its next turn reads the shorter list.
              for (const p of narrowed) stale.add(p.id);
              return { out, changed: touched || retiring.size > 0 || narrowed.length > 0 };
            }),
          ),
        );
        for (const me of gone.out) {
          yield* deps.close(me.record);
          yield* deps.retire(me.record);
        }
        if (gone.changed) {
          yield* board.publish;
          yield* publishList;
        }
      });

    /**
     * Chiefs whose workspace is gone (a profile an older build or a crash left): no Chief now. Each one's open and
     * running items go to the Chiefs that take them (handOff); with no other Chief there, one made in its place (its
     * name, character, role, soul and projects, a new workspace) takes them, in the transaction that marks it removed.
     * Under ensureLock.
     */
    const replaceGone = Effect.gen(function* () {
      for (const p of yield* profiles.live) {
        const record = yield* store.getWorkspace(p.id);
        if (record !== undefined && record.workspace.kind === "chief") continue;
        const detail = `Moved here from ${p.name} when it was removed.`;
        if (yield* handOff(p, undefined, detail)) continue;
        yield* make({
          projectIds: p.project_ids,
          name: p.name,
          avatar: p.avatar,
          role: p.role,
          soul: p.soul,
          takesOver: (id, put) =>
            board.move((items) => {
              const at = now();
              // Marked removed before the new one is written: the same name is free for it.
              return Effect.succeed({ moved: items.filter(leftBy(p.id)).map((i) => handed(i, id, undefined, detail, at)), within: profiles.put({ ...p, removed_at: at, updated_at: at }).pipe(Effect.andThen(put)), value: undefined });
            }),
        });
      }
    });

    /** A Chief still there (not removed): only such a Chief's board takes writes. */
    const isLive = (id: string) => profiles.get(id).pipe(Effect.map((profile) => profile !== undefined && profile.removed_at === undefined));

    /** Chiefs whose soul, role or project list changed since their session opened. */
    const stale = new Set<string>();
    /** The levels each Chief's open session read in its prefix (sections), as levelsKey says them. */
    const openedAt = new Map<string, string>();
    const levelsKey = (l: { readonly autonomy: ChiefAutonomy }) => `${l.autonomy}`;
    /** The projects and sources each Chief's open session read in its Projects section (sections), as sourcesKey says them. */
    const openedSources = new Map<string, string>();
    /**
     * A changed Chief's session (its soul, role, project list, its autonomy, a project added to or removed from the ones
     * it works in, or one of their sources) closes before its next turn (only while none runs), so that turn reads its
     * new prefix.
     */
    const refresh = (me: OneChief) =>
      Effect.gen(function* () {
        const opened = openedAt.get(me.profile.id);
        const openedWith = openedSources.get(me.profile.id);
        const changed =
          stale.has(me.profile.id) ||
          (opened !== undefined && opened !== levelsKey(yield* levelsOf(me.profile.id))) ||
          (openedWith !== undefined && openedWith !== sourcesKey(yield* sourcesOf(me)));
        if (!changed) return;
        if (yield* deps.reopen(me.record)) {
          stale.delete(me.profile.id);
          openedAt.delete(me.profile.id);
          openedSources.delete(me.profile.id);
        }
      });

    /**
     * What a Chief runs on now: its pick, else Auto. A pick whose account is gone gives way to Auto: its profile
     * goes back to Auto, and its transcript says so once.
     */
    const selectionOf = (me: OneChief) =>
      Effect.gen(function* () {
        const { selection, dropped } = yield* deps.selection(me.profile.model);
        if (dropped && me.profile.model !== null && (yield* profiles.clearModel(me.profile.id, JSON.stringify(me.profile.model), now()))) {
          yield* deps.note(me.record, "The Chief's model is no longer connected, so it runs on Auto.").pipe(Effect.ignore);
          yield* publishList;
        }
        return selection;
      });

    // ---------------------------------------------------------------- limits

    /** One set of limits for every Chief, counted over all their chats. */
    const limits = Effect.gen(function* () {
      const s = yield* deps.settings;
      return {
        maxConcurrent: s.chief_max_concurrent ?? DEFAULT_MAX_CONCURRENT,
        dailyCapUsd: s.chief_daily_cap_usd ?? DEFAULT_DAILY_CAP_USD,
        dailyTurns: s.chief_daily_turns ?? DEFAULT_DAILY_TURNS,
        askAbove: s.chief_ask_above_chats ?? DEFAULT_ASK_ABOVE_CHATS,
        askWaitMinutes: s.chief_ask_wait_minutes ?? DEFAULT_ASK_WAIT_MINUTES,
      };
    });
    /**
     * A Chief's own level, read fresh (a chief.update counts at once): its profile's, else Settings' (chief_autonomy),
     * else the default. What the person hears is fixed (watch.ts wakes): profile and Settings `updates` stay on the wire
     * for older clients, unread.
     */
    const levelsOf = (chiefId: string | undefined) =>
      Effect.gen(function* () {
        const s = yield* deps.settings;
        const own = chiefId === undefined ? undefined : yield* profiles.get(chiefId);
        return { autonomy: autonomyLevel(own?.autonomy, s.chief_autonomy) };
      });

    /** Chats started for these chats' items, and everything delegated under them. */
    const treeOf = (linked: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const all = yield* store.listWorkspaces();
        const byId = new Map(all.map((r) => [r.workspace.id, r]));
        const inTree = (record: WorkspaceRecord): boolean => {
          let at: WorkspaceRecord | undefined = record;
          for (let hops = 0; at !== undefined && hops < 8; hops++) {
            if (linked.has(at.workspace.id)) return true;
            at = at.workspace.parent_workspace_id === undefined ? undefined : byId.get(at.workspace.parent_workspace_id);
          }
          return false;
        };
        return all.filter(inTree);
      });
    /** The chats every Chief started, and everything delegated under them: what the shared limits count. */
    const chiefWorkspaces = board.linkedWorkspaces.pipe(Effect.flatMap((ids) => treeOf(new Set(ids))));
    /** The chats one Chief started for its items, and everything delegated under them. */
    const workspacesOf = (chiefId: string) => board.of(chiefId).pipe(Effect.flatMap((items) => treeOf(new Set(items.flatMap((i) => i.workspace_ids)))));
    /** Fan-out siblings waiting in this process for the first chat's token: each holds a slot until its task is sent. */
    const liveHolds = new Set<string>();
    /**
     * What holds one of the Chiefs' slots now: a chat they started that is working, not through its first turn yet, or a
     * sibling held here; and every builder at work under such a chat. The limit is on agents at once, so a Chief held
     * to 4 never has 4 chats each running 8 builders (P12).
     */
    const activeChats = Effect.gen(function* () {
      let n = 0;
      const held = new Set((yield* board.held).map((row) => row.workspace_id));
      for (const id of yield* board.linkedWorkspaces) {
        if (deps.buildersAtWork !== undefined) n += yield* deps.buildersAtWork(id);
        // A sibling whose hold is gone (its send failed, the runtime restarted) holds nothing until it gets its task.
        if (held.has(id)) {
          if (liveHolds.has(id)) n++;
          continue;
        }
        const record = yield* store.getWorkspace(id);
        if (record === undefined || record.workspace.status === "archived") continue;
        if (HOLDS_SLOT.has(record.workspace.status)) {
          n++;
          continue;
        }
        const finished = yield* store.sql<{ n: number }>`SELECT 1 AS n FROM caveman_sp_events WHERE session_id = ${record.session.id} AND type = 'turn.done' LIMIT 1`.pipe(Effect.orElseSucceed(() => []));
        if (finished.length === 0) n++;
      }
      return n;
    });
    /**
     * Why a chat a Chief started may not start a builder now, in one sentence for its agent, or undefined: its builders
     * count toward the Chiefs' limit on agents at once, as its own chat does. Off (0) or a chat no Chief started: no hold.
     */
    const builderHold = (workspaceId: string) =>
      Effect.gen(function* () {
        const l = yield* limits;
        if (l.maxConcurrent <= 0 || !(yield* board.linkedWorkspaces).includes(workspaceId)) return undefined;
        return (yield* activeChats) >= l.maxConcurrent
          ? `Not started: the Chiefs run ${l.maxConcurrent === 1 ? "one agent" : `${l.maxConcurrent} agents`} at once (Settings > Chiefs), builders included, and ${l.maxConcurrent === 1 ? "it is" : "they are all"} at work. Do this part yourself, or wait for one to finish.`
          : undefined;
      });
    /** Every Chief (removed ones too: what they spent today still counts) and every chat they started. */
    const todays = Effect.gen(function* () {
      const ids = new Set((yield* chiefWorkspaces).map((r) => r.workspace.id));
      for (const r of yield* store.listWorkspaces()) if (r.workspace.kind === "chief") ids.add(r.workspace.id);
      return ids;
    });
    const spentToday = todays.pipe(Effect.flatMap((ids) => deps.spend(localMidnight(), ids)));
    /**
     * Today's limit is reached, in dollars or in turns: no Chief starts, sends or thinks any more until
     * tomorrow (the person can still type to them). The turn guard holds on every model, a plan's included.
     */
    const overCap = Effect.gen(function* () {
      const l = yield* limits;
      if (l.dailyCapUsd > 0 && (yield* spentToday) >= l.dailyCapUsd) return true;
      return l.dailyTurns > 0 && (yield* todays.pipe(Effect.flatMap((ids) => deps.turns(localMidnight(), ids)))) >= l.dailyTurns;
    });
    const CAP_REASON = "Today's limit for Chief-started work is reached; it waits until tomorrow.";

    // ---------------------------------------------------------------- projects

    const projectName = Effect.gen(function* () {
      const projects = yield* deps.projects;
      return (id: string) => projects.find((p) => p.id === id)?.name ?? id;
    });
    /** The projects a Chief sees and starts chats in (every project, when it lists none), in the order they were added. */
    const projectsOf = (me: OneChief) =>
      deps.projects.pipe(
        Effect.map((projects) => projects.filter((p) => inProjects(me.profile, p.id)).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id))),
      );
    /** A path a note names, under a project root: a file read is one stat, so a note's few mentions cost nothing. */
    const existsUnder = (root: string, relative: string) => {
      const full = path.resolve(root, relative);
      return full.startsWith(root + path.sep) && fs.existsSync(full);
    };
    /**
     * Each project's chats, newest first: when it was last touched and their titles. With `me`, none another Chief
     * started: a Chief sees only its own board (as boardContext does).
     */
    const projectChats = (me: OneChief | undefined) =>
      Effect.gen(function* () {
        const others = new Set<string>();
        if (me !== undefined) for (const item of yield* board.all) if (item.chief_id !== undefined && item.chief_id !== me.profile.id) for (const id of item.workspace_ids) others.add(id);
        const chats = new Map<string, Array<{ readonly at: string; readonly title: string }>>();
        for (const r of yield* store.listWorkspaces()) {
          const id = r.workspace.project_id;
          if (id === undefined || r.workspace.kind !== undefined || r.workspace.parent_workspace_id !== undefined || others.has(r.workspace.id)) continue;
          chats.set(id, [...(chats.get(id) ?? []), { at: r.workspace.updated_at, title: r.workspace.title.trim() }]);
        }
        for (const list of chats.values()) list.sort((a, b) => b.at.localeCompare(a.at));
        return chats as ReadonlyMap<string, ReadonlyArray<{ readonly at: string; readonly title: string }>>;
      }).pipe(Effect.orElseSucceed(() => new Map<string, ReadonlyArray<{ readonly at: string; readonly title: string }>>()));
    /** What the runtime knows of each repository's code (repos.ts): built once per checkout, again when it changes. */
    const repoProfile = makeRepoProfiles();
    /**
     * Projects as prompt.ts reads them (ProjectLine): what tells namesakes and clones apart, what each one's code is,
     * and when the person last had chats there and what they were.
     */
    const linesOf = (projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly path: string }>, chats: ReadonlyMap<string, ReadonlyArray<{ readonly at: string; readonly title: string }>>) =>
      Effect.forEach(
        projects,
        (p) =>
          Effect.promise(() => repoProfile(p.path)).pipe(
            Effect.map((profile): ProjectLine => {
              const mine = chats.get(p.id) ?? [];
              const touchedAt = repoTouchedAt(p.path);
              const titles = [...new Set(mine.map((c) => c.title).filter((t) => t !== ""))].slice(0, 10);
              return {
                id: p.id,
                name: p.name,
                path: p.path,
                ...repoFacts(p.path),
                ...(mine[0] === undefined ? {} : { lastChatAt: mine[0].at }),
                ...(touchedAt === undefined ? {} : { touchedAt }),
                ...(profile === undefined ? {} : { profile }),
                ...(titles.length === 0 ? {} : { recentChats: titles }),
              };
            }),
          ),
        { concurrency: 4 },
      );
    /** A project with several sources: each as its Projects section lists it, with its own facts and profile. */
    const sourceLines = (sources: ReadonlyArray<ProjectSource>) =>
      Effect.forEach(
        sources,
        (s) =>
          (s.path === undefined ? Effect.succeed(undefined) : Effect.promise(() => repoProfile(s.path!))).pipe(
            Effect.map((profile): SourceLine => {
              const facts = s.path === undefined ? {} : repoFacts(s.path);
              const remote = facts.remote ?? (s.repository === undefined ? undefined : `${s.repository.host}/${s.repository.full_name}`);
              return {
                name: s.name,
                kind: s.kind,
                ...(s.path === undefined ? {} : { path: s.path }),
                ...(remote === undefined ? {} : { remote }),
                ...(facts.description === undefined ? {} : { description: facts.description }),
                ...(s.focus ? { focus: s.focus } : {}),
                ...(profile === undefined ? {} : { profile }),
              };
            }),
          ),
        { concurrency: 4 },
      );
    /**
     * A Chief's projects as its Projects section reads them: the PROJECTS_IN_FULL with the latest activity (its chats
     * there, else its checkout's last change) in full, each with its sources when it has several (`full`); the rest by
     * name and path (`rest`). Both in the order the projects were added, so the section reads the same until the list
     * changes.
     */
    const projectLines = (me: OneChief, sources: ReadonlyMap<string, ReadonlyArray<ProjectSource>>) =>
      Effect.gen(function* () {
        const mine = yield* projectsOf(me);
        const chats = yield* projectChats(me);
        const recent = new Set(
          mine
            .map((p) => {
              const lastChatAt = chats.get(p.id)?.[0]?.at;
              const touchedAt = repoTouchedAt(p.path);
              return { id: p.id, ...(lastChatAt === undefined ? {} : { lastChatAt }), ...(touchedAt === undefined ? {} : { touchedAt }) };
            })
            .sort(byNewest)
            .slice(0, PROJECTS_IN_FULL)
            .map((p) => p.id),
        );
        const lines = yield* linesOf(
          mine.filter((p) => recent.has(p.id)),
          chats,
        );
        const full = yield* Effect.forEach(lines, (line) => {
          const own = sources.get(line.id) ?? [];
          return own.length < 2 ? Effect.succeed(line) : sourceLines(own).pipe(Effect.map((each) => ({ ...line, sources: each })));
        });
        return { full, rest: mine.filter((p) => !recent.has(p.id)).map((p) => ({ id: p.id, name: p.name, path: p.path })) };
      });
    /** The sources of each project a Chief works in, by project. */
    const sourcesOf = (me: OneChief) =>
      projectsOf(me).pipe(
        Effect.flatMap((mine) => Effect.forEach(mine, (p) => deps.projectSources(p.id).pipe(Effect.map((s) => [p.id, s] as const)), { concurrency: 4 })),
        Effect.map((pairs) => new Map(pairs) as ReadonlyMap<string, ReadonlyArray<ProjectSource>>),
      );
    /**
     * What a Chief's Projects section depends on of its projects and their sources: a project added to or gone from the
     * ones it works in, or a source added, removed or moved, reopens its session.
     */
    const sourcesKey = (sources: ReadonlyMap<string, ReadonlyArray<ProjectSource>>) =>
      JSON.stringify([...sources].map(([id, list]) => [id, list.map((s) => [s.name, s.kind, s.path ?? s.repository?.full_name ?? "", s.focus ?? ""])]));
    /**
     * The project a note that names no Chief is for, picked in code with no model call: the one its words, a path or a
     * file in it, or the chat on the person's screen settle (prompt.ts projectEvidence, clearProject), else the one with
     * the latest chat activity. Undefined with no project.
     */
    const routeNote = (text: string, shownWorkspaceId?: string) =>
      Effect.gen(function* () {
        const projects = yield* activeProjects;
        if (projects.length <= 1) return projects[0];
        const shown = shownWorkspaceId === undefined ? undefined : (yield* store.getWorkspace(shownWorkspaceId))?.workspace.project_id;
        const clear = clearProject(projectEvidence(yield* linesOf(projects, yield* projectChats(undefined)), text, existsUnder, shown));
        return projects.find((p) => p.id === clear?.id) ?? projects[0];
      });

    // ---------------------------------------------------------------- starting chats

    /** Fan-out hold: per engine, model and project, the first chat's first token (or FANOUT_HOLD_MS). */
    const warming = new Map<string, Deferred.Deferred<void>>();
    /**
     * The first chat's request is in flight once its turn starts (setting up its copy can take a while);
     * from then its siblings wait at most FANOUT_HOLD_MS for its first token.
     */
    const firstToken = (sessionId: string) =>
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(store.events);
        // A turn's own output: the chat's worktree row comes before any turn.
        const token = (e: SessionEvent) => e.turn_id !== undefined && ["message.delta", "reasoning.delta", "tool.started", "message.done", "turn.done"].includes(e.type) && !(e.type === "message.done" && e.payload.role === "user");
        // What it did before this subscription, then what it does next.
        const head = (yield* store.getBySession(sessionId))?.session.head ?? 0;
        const before = yield* store.readEvents(sessionId, 0, head);
        const next = (match: (e: SessionEvent) => boolean) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* PubSub.take(sub);
              if (event.session_id === sessionId && match(event)) return;
            }
          });
        if (before.some(token)) return;
        if (!before.some((e) => e.type === "turn.started")) yield* next((e) => e.type === "turn.started" || token(e)).pipe(Effect.timeoutOption("60 seconds"));
        yield* next(token).pipe(Effect.timeoutOption(`${FANOUT_HOLD_MS} millis`));
      }).pipe(Effect.scoped, Effect.asVoid);

    /** A moment of a chat on its board, in a Chief's conversation (moments.ts), each once; a removed Chief's goes nowhere. */
    const moment = (chiefId: string, m: ChiefMoment, chat: string) =>
      Effect.gen(function* () {
        const me = yield* byId(chiefId);
        if (me !== undefined) yield* writeMoment(store, me.record, m, momentTitle(m, chat));
      });

    /**
     * Starts the item's chats from its proposal, one per project id (a project its Chief works in, once per chat), as
     * the item's Chief: in its projects only, with its permissions and the crew rules of the shared soul and its own.
     * Siblings on one engine, model and project wait for the first one's first token, so they read its prompt cache
     * instead of each writing it.
     */
    const startChats = (item: Board.Item, proposal: Board.Proposal) =>
      Effect.gen(function* () {
        const started: Array<{ readonly workspace_id: string; readonly title: string; readonly project_id: string }> = [];
        const me = yield* ownerOf(item);
        if (me === undefined) return { started, error: "This item's Chief was removed." };
        const projects = yield* deps.projects;
        const names = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
        const settings = yield* deps.settings;
        const engine = settings.default_engine;
        const model = settings.engines[engine]?.model ?? "";
        const counts = new Map<string, number>();
        // Every Chief's crew rules (Settings.chief_soul), then its own.
        const rules = [settings.chief_soul ?? "", me.profile.soul]
          .map((soul) => crewRules(withoutPlaceholders(soul)))
          .filter((r) => r !== "")
          .join("\n");
        // Its projects only, approved or not: that is all it may touch.
        const outside = proposal.project_ids.find((id) => projects.some((p) => p.id === id) && !inProjects(me.profile, id));
        if (outside !== undefined) return { started, error: `${names(outside)} is not one of ${me.profile.name}'s projects: its chats start only in those.` };
        for (const [i, projectId] of proposal.project_ids.entries()) {
          const project = projects.find((p) => p.id === projectId);
          if (!project) return { started, error: `No project ${projectId}: pick one from the project list.` };
          // The sources it names and no others, as a chat of this project (Board.sourcesPlace).
          const known = proposal.sources === undefined ? [] : yield* deps.projectSources(projectId);
          const gone = (proposal.sources ?? []).filter((name) => !known.some((s) => s.name === name));
          if (gone.length > 0) return { started, error: `${gone.join(", ")} is no longer a source of ${project.name}: its sources are ${known.map((s) => s.name).join(", ")}.` };
          const place = proposal.sources === undefined ? undefined : Board.sourcesPlace(proposal.sources.map((name) => known.find((s) => s.name === name)!));
          if (typeof place === "string") return { started, error: place };
          const where = place === undefined ? { repo: { path: project.path } } : { repo: place.repo, project_id: projectId, sources: place.sources };
          const n = (counts.get(projectId) ?? 0) + 1;
          counts.set(projectId, n);
          const title = `${proposal.title}${proposal.project_ids.filter((id) => id === projectId).length > 1 ? ` ${n}` : ""}`.slice(0, 120);
          // Its images ride with its brief: the chat keeps its own copy (as every chat does its turns' attachments).
          const task = { text: `${proposal.brief.trim()}${rules === "" ? "" : `\n\n<crew_rules>\n${rules}\n</crew_rules>`}\n\n${crewContract(me.profile.name)}`, ...(yield* taskImages(proposal.attachments)) };
          const key = `${engine}\0${model}\0${projectId}\0${"sources" in where ? where.sources.join(",") : ""}`;
          const warm = warming.get(key);
          const request = `chief:${item.id}:${i}:${item.workspace_ids.length + started.length}`;
          const effort = proposal.tier === "fast" ? "low" : proposal.tier === "frontier" ? "high" : undefined;
          // Its chats run with the permissions picked for it; with none picked (null), with what a new chat in that
          // project takes (the project's default, else Settings'), as if it passed nothing.
          const access = me.profile.access === null ? {} : { access: me.profile.access };
          // The person's words it quotes: in this Chief's transcript, or the one of the Chief that heard the item first.
          const from = { record: me.record, quotes: proposal.quotes, ...(item.heard_in === undefined ? {} : { heardIn: item.heard_in }) };
          const create = (withTask: boolean) =>
            deps
              .createWorkspace({ request_id: request, ...where, title, engine, from, ...(withTask ? { task } : {}), options: { ...access, ...(effort ? { effort } : {}) } })
              .pipe(
                // A tier the default model has no effort for runs at its default.
                Effect.catchIf(
                  (error) => effort !== undefined && /effort/.test(error.message),
                  () => deps.createWorkspace({ request_id: `${request}:default`, ...where, title, engine, from, ...(withTask ? { task } : {}), ...(me.profile.access === null ? {} : { options: access }) }),
                ),
              );
          // Each chat is linked the moment it exists, so one that fails later is still counted, watched and never made twice.
          const made = yield* Effect.result(
            warm === undefined
              ? Effect.gen(function* () {
                  // The first of its kind: it writes the cache; the rest of its kind wait for its first token.
                  const gate = yield* Deferred.make<void>();
                  warming.set(key, gate);
                  const workspace = yield* create(true).pipe(Effect.tapError(() => Effect.sync(() => warming.delete(key)).pipe(Effect.andThen(Deferred.succeed(gate, undefined)))));
                  yield* board.link(item.id, workspace.id, { runId: proposal.run_id });
                  runFork(firstToken(workspace.session_id).pipe(Effect.ensuring(Deferred.succeed(gate, undefined).pipe(Effect.andThen(Effect.sync(() => warming.get(key) === gate && warming.delete(key)))))));
                  return workspace;
                })
              : Effect.gen(function* () {
                  const workspace = yield* create(false);
                  yield* board.link(item.id, workspace.id, { runId: proposal.run_id, task: task.text, attachments: proposal.attachments });
                  liveHolds.add(workspace.id);
                  runFork(Deferred.await(warm).pipe(Effect.andThen(sendTask(workspace.id)), Effect.ensuring(Effect.sync(() => liveHolds.delete(workspace.id)))));
                  return workspace;
                }),
          );
          if (made._tag === "Failure") return { started, error: made.failure.message };
          started.push({ workspace_id: made.success.id, title, project_id: projectId });
          // The person sees it start in the Chief's conversation, with no word from the Chief.
          yield* moment(me.profile.id, { kind: "started", workspace_id: made.success.id, item_id: item.id }, title).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: a moment was not written", cause)));
        }
        return { started };
      });

    /** A brief's images as a turn takes them (inline), or nothing; a file gone from the store fails the start, saying so. */
    const taskImages = (refs: ReadonlyArray<ChiefAttachment> | undefined): Effect.Effect<Pick<TurnInput, "attachments">, ProtocolError> =>
      refs === undefined || refs.length === 0
        ? Effect.succeed({})
        : Effect.try({
            try: () => ({ attachments: inlineImages(deps.attachmentsDir, refs) }),
            catch: (error) => new ProtocolError({ reason: "invalid_state", message: error instanceof Error ? error.message : String(error) }),
          });
    /** A held sibling's task, sent once (a stable request id: sending it again after a restart changes nothing). If it can't be sent, the sibling is archived. */
    const sendTask = (workspaceId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const row = (yield* board.held).find((r) => r.workspace_id === workspaceId);
        if (row === undefined) return;
        const record = yield* store.getWorkspace(workspaceId);
        if (record === undefined || record.workspace.status === "archived") return yield* abandon(workspaceId);
        // From the Chief whose item it was started for.
        const item = yield* board.get(row.item_id);
        const me = item === undefined ? undefined : yield* ownerOf(item);
        if (me === undefined) return yield* abandon(workspaceId);
        // Its own images, kept with its task: the item's draft is gone once its chats start.
        const images = yield* taskImages(row.attachments);
        yield* deps.submit(record, { request_id: `chief-task:${workspaceId}`, kind: "followup", input: { text: row.task, ...images }, from: me.record });
        yield* board.release(workspaceId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("chief: a held chat could not start; archiving it", { workspace: workspaceId, cause }).pipe(Effect.andThen(abandon(workspaceId))),
        ),
      );
    /** A chat that never got its task: archived and unlinked; an item left with no chats waits in the Queue again. */
    const abandon = (workspaceId: string) =>
      Effect.gen(function* () {
        const itemId = yield* board.itemOfWorkspace(workspaceId);
        const record = yield* store.getWorkspace(workspaceId);
        if (record !== undefined && record.workspace.status !== "archived") yield* deps.archive(record, `chief-abandon:${workspaceId}`).pipe(Effect.ignore);
        yield* board.unlink(workspaceId);
        yield* board.update("abandon", (items) =>
          Effect.succeed({ write: items.filter((i) => i.id === itemId && i.workspace_ids.length === 0 && Board.RUNNING_STATES.has(i.state)).map((i) => Board.requeue(i, now())), value: undefined }),
        );
      });

    /** Why the runtime will not start it now, or undefined when it may. */
    const holdReason = (item: Board.Item, proposal: Board.Proposal, approved: boolean) =>
      Effect.gen(function* () {
        const l = { ...(yield* limits), autonomy: (yield* levelsOf(item.chief_id)).autonomy };
        if (!approved) {
          // Counted over the item's chats and everything the same Chief turn started or has waiting to start,
          // so splitting one piece of work across calls or items changes nothing.
          const chats = new Set(item.workspace_ids);
          let waiting = 0;
          if (proposal.run_id !== undefined) {
            for (const id of yield* board.runChats(proposal.run_id)) chats.add(id);
            for (const other of yield* board.all) {
              if (other.id === item.id || (other.state !== "blocked" && other.state !== "proposed") || other.proposal?.run_id !== proposal.run_id) continue;
              waiting += other.proposal.project_ids.length;
            }
          }
          // Autonomy: 1 and 2 propose past "Ask first above"; 3 proposes nothing. The limits below hold at every level.
          if (l.autonomy < 3 && chats.size + waiting + proposal.project_ids.length > l.askAbove) return { state: "proposed", reason: `It needs more than ${l.askAbove} chats, so the person starts it (Suggested chats).` } as const;
        }
        if (yield* overCap) return { state: "blocked", on: { kind: "cap" } as ChiefBlock, reason: CAP_REASON } as const;
        if (l.maxConcurrent > 0 && (yield* activeChats) + proposal.project_ids.length > l.maxConcurrent) {
          return { state: "blocked", on: { kind: "capacity" } as ChiefBlock, reason: `${l.maxConcurrent} chats already run at most; it starts when one finishes.` } as const;
        }
        return undefined;
      });

    /**
     * Admission for one item's chats, in code: the autonomy rules (unless the person approved it),
     * the daily cap and the concurrency limit, shared by every Chief. Starts it, proposes it, or blocks it,
     * and says which. `still` is checked under the lock: a second Start, or a readmission from an older
     * snapshot, finds the item already moving and starts nothing.
     */
    const admit = (itemId: string, drafted: Board.Proposal, approved: boolean, still: (item: Board.Item) => boolean = () => true) =>
      admission.withPermits(1)(
        Effect.gen(function* () {
          const item = yield* board.get(itemId);
          if (!item) return yield* Effect.fail(new ChiefError(`No item ${itemId}`));
          if (Board.CLOSED_STATES.has(item.state)) return yield* Effect.fail(new ChiefError(`${itemId} is ${item.state}`));
          if (!still(item)) return { state: item.state, item_id: itemId, reason: `It is ${item.state} already.` };
          // Approved (Start, a readmission): the item's own draft as it is now, not the caller's older copy.
          const proposal = approved && item.proposal !== undefined ? item.proposal : drafted;
          // Only a live Chief starts anything.
          const me = yield* ownerOf(item);
          if (me === undefined) return yield* Effect.fail(new ChiefError(`${itemId}'s Chief was removed.`, "invalid_state"));
          // A draft naming a project its Chief may no longer use (its list changed since) can never start: back to
          // the Queue without it, saying why, so its Chief drafts it again (or the person's Start asks it to).
          const outside = yield* outsideProject(me, proposal);
          if (outside !== undefined && !Board.RUNNING_STATES.has(item.state)) {
            const reason = `${outside} is not one of ${me.profile.name}'s projects, so this waits in the Queue to be drafted again.`;
            yield* board.update("requeue", (items) => {
              const current = items.find((i) => i.id === itemId);
              if (current === undefined) return Effect.succeed({ write: [], value: undefined });
              const { proposal: _drafted, ...rest } = Board.requeue(current, now());
              return Effect.succeed({ write: [{ ...rest, detail: reason }], value: undefined });
            });
            return { state: "queued" as const, item_id: itemId, reason };
          }
          const hold = yield* holdReason(item, proposal, approved || item.start);
          // More chats for an item whose chats already run wait as an item of their own, so the running one keeps moving.
          const heldId =
            hold === undefined || !Board.RUNNING_STATES.has(item.state)
              ? itemId
              : yield* board.update("add", (items) => {
                  const added = Board.add(items, { id: `ci-${randomUUID().slice(0, 8)}`, ...(item.chief_id === undefined ? {} : { chief_id: item.chief_id }), text: proposal.title, title: proposal.title, source: "chief", state: "queued", project_ids: [...new Set(proposal.project_ids)] }, now());
                  return Effect.succeed({ write: [added], value: added.id });
                });
          if (hold?.state === "proposed") {
            yield* board.update("propose", (items) => Effect.succeed({ write: [Board.propose(items.find((i) => i.id === heldId)!, proposal, now())], value: undefined }));
            return { state: "proposed" as const, item_id: heldId, reason: hold.reason };
          }
          if (hold?.state === "blocked") {
            yield* board.update("block", (items) => {
              const current = items.find((i) => i.id === heldId)!;
              // Still blocked on the same thing with the same draft (a readmission tick): no write, no broadcast.
              const same = current.state === "blocked" && current.blocked_on?.kind === hold.on.kind && JSON.stringify(current.proposal) === JSON.stringify(proposal);
              return Effect.succeed({ write: same ? [] : [{ ...Board.block(current, hold.on, now()), proposal }], value: undefined });
            });
            return { state: "blocked" as const, item_id: heldId, reason: hold.reason };
          }
          const { started, error } = yield* startChats(item, proposal);
          if (started.length > 0) {
            yield* board.update("start", (items) => {
              const current = items.find((i) => i.id === itemId)!;
              const projects = Board.RUNNING_STATES.has(item.state) ? [...current.project_ids, ...proposal.project_ids] : proposal.project_ids;
              return Effect.succeed({ write: [Board.start({ ...current, title: item.title ?? proposal.title, project_ids: [...new Set(projects)] }, started.map((c) => c.workspace_id), now())], value: undefined });
            });
          }
          if (error !== undefined) return yield* Effect.fail(new ChiefError(started.length === 0 ? error : `Started ${started.length} of ${proposal.project_ids.length} chats; the rest failed: ${error}`));
          return { state: "started" as const, item_id: itemId, chats: started };
        }),
      );

    /** The name of a project in the draft that its Chief may not use, if any (a project since removed is startChats' to refuse). */
    const outsideProject = (me: OneChief, proposal: Board.Proposal) =>
      deps.projects.pipe(
        Effect.map((projects) => {
          const id = proposal.project_ids.find((pid) => projects.some((p) => p.id === pid) && !inProjects(me.profile, pid));
          return id === undefined ? undefined : (projects.find((p) => p.id === id)?.name ?? id);
        }),
      );

    const blockedOnLimit = (item: Board.Item) => item.state === "blocked" && item.proposal !== undefined && (item.blocked_on?.kind === "capacity" || item.blocked_on?.kind === "cap");
    /** Items blocked on capacity or the cap whose chats were drafted, every Chief's: started, in Queue order, while they fit. */
    const readmit = Effect.gen(function* () {
      for (const item of (yield* board.all).filter(blockedOnLimit)) {
        const result = yield* admit(item.id, item.proposal!, true, blockedOnLimit).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (result?.state === "blocked") return;
      }
    });

    // ---------------------------------------------------------------- each Chief's turns

    /**
     * What each Chief's next turn reads of the board. `fullBoard`: the whole of its board, after the runtime starts
     * and after a compaction of its history; else only what changed on its board since `renderedSeq`.
     */
    const views = new Map<string, { fullBoard: boolean; compactions: number; renderedSeq: number; told: Set<string> }>();
    const viewOf = (chiefId: string) => {
      let view = views.get(chiefId);
      if (view === undefined) views.set(chiefId, (view = { fullBoard: true, compactions: 0, renderedSeq: 0, told: new Set() }));
      return view;
    };
    /** The board text for a Chief's next turn (its own items only), and `read`, which marks it seen once a turn has taken it. */
    const boardContext = (me: OneChief) =>
      Effect.gen(function* () {
        const view = viewOf(me.profile.id);
        const names = yield* projectName;
        const seq = yield* board.head;
        const full = view.fullBoard;
        const generation = view.compactions;
        let text: string;
        let told: ReadonlyArray<string>;
        if (full) {
          const chats = yield* chatLines(me);
          text = Board.renderFull((yield* board.items).filter((i) => i.chief_id === me.profile.id), chats, names);
          const routines = yield* routinesOf(me);
          if (routines !== "") text = `${text}\n${routines}`;
          told = chats.map((c) => c.id);
        } else {
          const delta = yield* board.touchedSince(view.renderedSeq, me.profile.id);
          const fresh = yield* introduced(me, view.told);
          text = Board.renderDelta(delta.changed, delta.removed, fresh, names, Board.BOARD_BUDGET_CHARS, delta.person);
          // Only the chats the delta found room for: one cut for the budget is introduced in a later turn.
          told = Board.shownChats(text, fresh);
        }
        const read = Effect.sync(() => {
          if (full && generation === view.compactions) {
            view.fullBoard = false;
            view.told = new Set();
          }
          for (const id of told) view.told.add(id);
          view.renderedSeq = Math.max(view.renderedSeq, seq);
        });
        return { text, read };
      });
    /**
     * The routines whose runs report to this Chief, as its full board lists them: what each checks and when, and its
     * last run's decision. A routine that names a Chief still there is that Chief's; one that names none (or a Chief
     * gone since) goes to the Chief its project's runs reach (pickAmong), as routineReport sends them.
     */
    const routinesOf = (me: OneChief) =>
      Effect.gen(function* () {
        const read = deps.routines;
        if (read === undefined) return "";
        const chiefs = yield* liveChiefs;
        const items = yield* board.all;
        const live = new Set(chiefs.map((c) => c.profile.id));
        const rows = yield* Effect.forEach(
          yield* deps.projects,
          (p) =>
            read(p.id).pipe(
              Effect.timeoutOption("5 seconds"),
              Effect.map(Option.getOrElse(() => [])),
              Effect.catchCause(() => Effect.succeed([])),
              Effect.map((found) => found.map((row) => ({ row, projectId: p.id }))),
            ),
          { concurrency: 4 },
        );
        const last = new Map((yield* board.routines).map((r) => [r.automation_id, r] as const));
        return routinesSection(
          rows.flat().flatMap(({ row, projectId }) => {
            if (row.routine === undefined) return [];
            const { chief_id: named, ...routine } = row.routine;
            const to = named !== undefined && live.has(named) ? named : pickAmong(chiefs, projectId, items)?.profile.id;
            if (to !== me.profile.id) return [];
            const ran = last.get(row.id);
            return [{ name: row.title, enabled: row.enabled, ...routine, ...(ran === undefined ? {} : { last: ran }) }];
          }),
        );
      });
    /**
     * The chats a Chief's board knows of: the chats of its own items, then the running chats no Chief started in its
     * projects; never another Chief's. `idleToo`: also the idle chats no Chief started there (chat_search reads them).
     */
    const boardChats = (me: OneChief, idleToo = false) =>
      Effect.gen(function* () {
        const linked = new Map<string, Board.Item>();
        for (const item of yield* board.all) for (const id of item.workspace_ids) linked.set(id, item);
        const mine = (r: WorkspaceRecord) => {
          const item = linked.get(r.workspace.id);
          return item === undefined ? (idleToo || HOLDS_SLOT.has(r.workspace.status)) && inProjects(me.profile, r.workspace.project_id) : item.chief_id === me.profile.id;
        };
        return (yield* store.listWorkspaces())
          .filter((r) => r.workspace.kind !== "chief" && r.workspace.parent_workspace_id === undefined && r.workspace.status !== "archived" && mine(r))
          .map((record) => ({ record, item: linked.get(record.workspace.id) }));
      });
    /**
     * The sources a chat works in, its primary first, when its project (`sources`) has several: a chat in several says
     * them (Workspace.source, checkouts); a chat in one is in the source whose checkout it was made from.
     */
    const chatRepos = (record: WorkspaceRecord, sources: ReadonlyArray<ProjectSource>): ReadonlyArray<string> => {
      if (sources.length < 2) return [];
      const { workspace } = record;
      if (workspace.checkouts !== undefined) return [workspace.source ?? "", ...workspace.checkouts.map((c) => c.name)].filter((name) => name !== "");
      const real = (at: string) => {
        try {
          return fs.realpathSync(at);
        } catch {
          return path.resolve(at);
        }
      };
      const { repo } = workspace;
      const at = record.internal.repoPath ?? ("path" in repo ? repo.path : undefined);
      // A chat in a clone it made of a source (repo.url): that source, whose clone the project may not list yet.
      const own =
        (at === undefined ? undefined : sources.find((s) => s.path !== undefined && real(s.path) === real(at))) ??
        ("url" in repo ? sources.find((s) => s.repository !== undefined && sameRepoUrl(s.repository.clone_url, repo.url)) : undefined);
      return own === undefined ? [] : [own.name];
    };
    /** One chat as a board line: its key terms from its own words (about.ts), its repos (`sources`: of each project, by id), and whether it is active (listed in full). */
    const chatLineOf = (record: WorkspaceRecord, item: Board.Item | undefined, names: (id: string) => string, sources: ReadonlyMap<string, ReadonlyArray<ProjectSource>>) =>
      Effect.gen(function* () {
        const project = record.workspace.project_id === undefined ? "" : names(record.workspace.project_id);
        const facts = yield* chatFacts(store, record);
        const about = keyTerms({ title: record.workspace.title, ...facts, project });
        const repos = chatRepos(record, sources.get(record.workspace.project_id ?? "") ?? []);
        return {
          line: {
            id: record.workspace.id,
            title: record.workspace.title,
            project,
            status: record.workspace.status,
            started_at: record.workspace.created_at,
            ...(item ? { item_id: item.id } : {}),
            ...(about.length > 0 ? { about } : {}),
            ...(repos.length > 0 ? { repos } : {}),
            active: HOLDS_SLOT.has(record.workspace.status) || (item !== undefined && Board.RUNNING_STATES.has(item.state)),
          } satisfies Board.ChatLine,
          facts,
        };
      });
    /** The chats a Chief's full board lists: its own items' first, every one with what it is about. */
    const chatLines = (me: OneChief) =>
      Effect.gen(function* () {
        const names = yield* projectName;
        const sources = yield* sourcesOf(me);
        const chats = [...(yield* boardChats(me))].sort((a, b) => Number(b.item !== undefined) - Number(a.item !== undefined));
        return yield* Effect.forEach(chats, ({ record, item }) => chatLineOf(record, item, names, sources).pipe(Effect.map((c) => c.line)));
      });
    /**
     * Chats on a Chief's board it has not been told of since its last full board: ones the person started in its
     * projects, or put on its board, or that a group it manages put there. A chat it started is not news. One not through its first message yet waits for
     * it (its line would say nothing), unless a minute has passed.
     */
    const introduced = (me: OneChief, told: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const names = yield* projectName;
        const sources = yield* sourcesOf(me);
        const fresh: Array<Board.ChatLine> = [];
        for (const { record, item } of yield* boardChats(me)) {
          // Put there by the person, or by its group (ChiefProfile.topics): news either way.
          if (told.has(record.workspace.id) || (item !== undefined && item.source !== "attached" && item.source !== "topic")) continue;
          const { line, facts } = yield* chatLineOf(record, item, names, sources);
          if (facts.goal === undefined && Date.now() - Date.parse(record.workspace.created_at) < 60_000) continue;
          fresh.push(line);
        }
        return fresh;
      });

    // Every send into a Chief goes through one queue, in order (so in order per Chief): notes, wakes, Start asks.
    const deliveries = yield* Queue.unbounded<Effect.Effect<void, unknown>>();
    const enqueue = (effect: Effect.Effect<void, unknown>) => Queue.offer(deliveries, effect).pipe(Effect.asVoid);
    const deliverer = Effect.forever(Queue.take(deliveries).pipe(Effect.flatMap((delivery) => delivery.pipe(Effect.catchCause((cause) => Effect.logWarning("chief: a delivery did not reach the Chief", cause))))));

    /** The watcher, once made below (its drain gives a note the updates its Chief has not heard). */
    let watcher: Effect.Success<ReturnType<typeof makeWatcher>> | undefined;
    /**
     * A note into its item's Chief: a new turn, or steered into the one running (notes typed close together share a turn).
     * `call`: a spoken note's call turns (voice/Call.ts), read with it, never part of its words.
     */
    const deliver = (item: Board.Item, mode: "decide" | "start", call?: string, showing?: string) =>
      Effect.gen(function* () {
        const me = yield* ownerOf(item);
        // Its Chief was removed: nothing to tell (its open items went to other Chiefs, and catch-up tells them).
        if (me === undefined) return;
        yield* refresh(me);
        yield* deps.steerable(me.record);
        const context = yield* boardContext(me);
        const modelSelection = yield* selectionOf(me);
        // The chat updates it has not heard yet (watch.ts) go in this turn, not in a wake after it. Taken last, so only
        // the send itself can fail with them in hand (and holds them again).
        const updates = watcher === undefined ? { lines: [], ids: [], heard: Effect.void } : yield* watcher.drain(me.profile.id);
        // Stable per item and mode, so sending again (after a failure or a restart) never makes a second message: T3
        // replays one it took. One T3 refused (a steer into a run a quit cut off) can never go through under its id,
        // and was never delivered: the note goes again under the next id (…:1, …:2), walked in the same order after a
        // restart, so an id T3 took is always reached again before any newer one.
        const tries = `${me.profile.id}:${mode}:${item.id}`;
        const refused = refusals.get(tries) ?? 0;
        const requestId = `chief-${mode}:${item.id}${refused === 0 ? "" : `:${refused}`}`;
        const sent = yield* deps
          .submit(me.record, {
            request_id: requestId,
            kind: "steer",
            modelSelection,
            input: { text: item.text },
            // Its images: the files the note stored under this Chief's thread, read as they are.
            ...(item.attachments?.length ? { stored: item.attachments.map(toStored) } : {}),
            instructions: noteInput({ itemId: item.id, text: item.text, mode, ...(item.source === "voice" ? { via: "voice" as const } : {}), ...(call ? { call } : {}), ...(showing ? { showing } : {}), ...(item.attachments?.length ? { attachments: item.attachments } : {}), ...(item.project_ids.length > 0 ? { projects: item.project_ids } : {}) }, [...updates.lines, context.text].filter((text) => text !== "").join("\n")),
          })
          .pipe(
            Effect.tapError((error) => (error.refused === true ? Effect.sync(() => refusals.set(tries, refused + 1)) : Effect.void)),
            // The note did not go: its updates wait for the next send or wake.
            Effect.tapError(() => (watcher === undefined ? Effect.void : watcher.holdAgain(updates.ids))),
          );
        yield* board.markDelivered(item.id, me.profile.id, { session: me.record.session.id, request: requestId });
        yield* updates.heard;
        refusals.delete(tries);
        // The person's own note (typed or said): the run it went into may open what they asked to see (Smart View).
        if (Board.TYPED_SOURCES.has(item.source)) yield* view.noteRun(me.profile.id, sent.turn_id);
        // A turn queued behind the running one reads this board later: the next send says it again, fresher.
        if (sent.disposition !== "queued") yield* context.read;
      });
    /** Notes on their way, and how often each failed (three strikes and it waits for the person). */
    const pending = new Set<string>();
    const failures = new Map<string, number>();
    /** Per Chief, mode and note: how many of its request ids T3 refused (deliver sends under the next). */
    const refusals = new Map<string, number>();
    const sendNote = (item: Board.Item, call?: string, showing?: string) =>
      pending.has(item.id)
        ? Effect.void
        : Effect.sync(() => pending.add(item.id)).pipe(
            Effect.andThen(
              enqueue(
                deliver(item, item.start ? "start" : "decide", call, showing).pipe(
                  // A send that met the Chief between turns (one ending as a queued wake starts) goes again at once, in
                  // its place in the queue: its request id is stable, so it never makes a second message, and the note
                  // is not left for the catch-up tick to send later, behind notes typed after it.
                  Effect.retry({ times: 2, schedule: Schedule.spaced("300 millis") }),
                  Effect.tapError(() => Effect.sync(() => failures.set(item.id, (failures.get(item.id) ?? 0) + 1))),
                  Effect.ensuring(Effect.sync(() => pending.delete(item.id))),
                ),
              ),
            ),
          );
    /**
     * The line a typed note carries for the worker chat that was on the person's screen, the typed-note answer to a
     * call's showing: line (prompt.ts). It names the chat, its board item when it has one, and its project, so the
     * Chief can read "that"/"this"/"it" and start work in the right project. Undefined for a chat that is gone, is one
     * of the Chief's own, or is a chat the Chief cannot reach.
     */
    const showingLine = (me: OneChief, workspaceId: string) =>
      Effect.gen(function* () {
        const record = yield* deps.store.getWorkspace(workspaceId);
        if (record === undefined || record.workspace.kind === "chief") return undefined;
        const itemId = yield* board.itemOfWorkspace(workspaceId);
        const title = record.workspace.title.replace(/"/g, "'");
        const where = [itemId ? `item ${itemId}` : undefined, `chat ${workspaceId}`, record.workspace.project_id ? `project ${record.workspace.project_id}` : undefined].filter(Boolean).join(", ");
        return `showing: "${title}" (${where}): the worker chat on the person's screen as they typed; "that", "this" and "it" mean it, and work for it belongs in its project`;
      });

    /**
     * A note onto a Chief's board (chief.capture, or said on a call), before any model call; then to that Chief unless
     * it only queues, or nothing is connected to think with (catch-up sends it later). `chiefId` absent: a Chief that
     * works in `projectId` (resolve); with neither, one that works in the project the note points at (routeNote), else
     * the one with the latest activity, in code.
     */
    const capture = (input: {
      readonly chiefId?: string | undefined;
      readonly projectId?: string | undefined;
      readonly text: string;
      readonly source: Board.Item["source"];
      readonly mode: "decide" | "queue" | "start";
      readonly call?: string;
      /** Images with the note, inline: stored under this Chief's thread, referenced from the item. */
      readonly attachments?: ReadonlyArray<WireAttachment>;
      /** The worker chat on the person's screen as they typed: the Chief is told its chat id, title and project (showingLine). */
      readonly showing?: { readonly workspaceId: string };
    }) =>
      Effect.gen(function* () {
        const me =
          input.chiefId !== undefined || input.projectId !== undefined
            ? yield* resolve({ chiefId: input.chiefId, projectId: input.projectId })
            : yield* Effect.gen(function* () {
                yield* settled;
                const project = yield* routeNote(input.text, input.showing?.workspaceId);
                return yield* resolve({ projectId: project?.id });
              });
        // What was on their screen: a line naming that chat and its project, read with the note (the typed note's answer
        // to a call's showing: line). A chat that is gone, or is a Chief, carries no signal.
        const showing = input.showing === undefined ? undefined : yield* showingLine(me, input.showing.workspaceId);
        // Into the store first (a refused image refuses the note, nothing written); out again if the item never lands.
        const images = yield* Effect.try({
          try: () => storeNoteImages(deps.attachmentsDir, me.record.internal.threadId, input.attachments ?? []),
          catch: (error) => new ChiefError(error instanceof Error ? error.message : String(error), "invalid_params"),
        });
        // An image sent alone still reads as something on the board and to the Chief.
        const text = input.text.trim() !== "" ? input.text : images.refs.length > 1 ? `${images.refs.length} images` : "An image";
        const added = yield* board
          .update("capture", (items) =>
            isLive(me.profile.id).pipe(
              Effect.map((live) => {
                if (!live) return { write: [], value: undefined };
                // Sent in a project (project_id) its Chief works in: the item is that project's, and its note says so, so
                // a Chief in several projects knows where the work goes.
                const project = input.projectId !== undefined && inProjects(me.profile, input.projectId) ? [input.projectId] : [];
                const next = Board.add(items, { id: `ci-${randomUUID().slice(0, 8)}`, chief_id: me.profile.id, text, source: input.source, state: input.mode === "queue" ? "queued" : "unsorted", start: input.mode === "start", attachments: images.refs, project_ids: project }, now());
                return { write: [next], value: next };
              }),
            ),
          )
          .pipe(Effect.tap((added) => (added === undefined ? Effect.sync(() => removeStoredAttachments(images.paths)) : Effect.void)));
        if (added === undefined) return yield* Effect.fail(new ChiefError(`No Chief ${me.profile.id}.`, "not_found"));
        if (input.mode !== "queue" && (yield* deps.canThink(me.profile.model))) yield* sendNote(added, input.call, showing);
        return added;
      });
    /** One attach at a time: a chat is never put on two items. */
    const attaching = yield* Semaphore.make(1);
    /**
     * A chat the person started themselves, put on a Chief's board (chief.attach) as a started item titled from the
     * chat: linked like one the Chief started, so the watcher follows it, the Chief hears its updates and may message
     * and answer it. The same chat again on the same board answers its item.
     */
    const attach = (input: { readonly chiefId?: string | undefined; readonly workspaceId: string; readonly sending?: true; readonly source?: "attached" | "topic" }) =>
      attaching.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* store.getWorkspace(input.workspaceId);
          if (record === undefined || record.workspace.kind === "chief") return yield* Effect.fail(new ChiefError(`No chat ${input.workspaceId}.`, "not_found"));
          // A builder belongs to its lead's item, never one of its own (possibly on another Chief's board).
          if (record.workspace.parent_workspace_id !== undefined) return yield* Effect.fail(new ChiefError(`${record.workspace.title.trim() || "That chat"} is an agent under another chat: put its lead on the board.`, "invalid_state"));
          const title = record.workspace.title.trim() || "Untitled chat";
          if (record.workspace.status === "archived") return yield* Effect.fail(new ChiefError(`${title} is archived.`, "invalid_state"));
          // No Chief named: one that works in its project (resolve).
          const projectId = record.workspace.project_id;
          if (input.chiefId === undefined && projectId === undefined) return yield* Effect.fail(new ChiefError(`${title} is in no project, so no Chief takes it.`, "invalid_state"));
          const me = input.chiefId !== undefined ? yield* mustBe(input.chiefId) : yield* resolve({ projectId });
          if (!inProjects(me.profile, projectId)) {
            return yield* Effect.fail(
              new ChiefError(input.chiefId === undefined ? `${title} is in a project no Chief works in: add it to a Chief's projects first.` : `${title} is in a project ${me.profile.name} does not work in.`, "invalid_state"),
            );
          }
          const linked = yield* board.itemOfWorkspace(record.workspace.id);
          const on = linked === undefined ? undefined : yield* board.get(linked);
          if (on !== undefined) {
            if (on.chief_id === me.profile.id) return on;
            const owner = on.chief_id === undefined ? undefined : yield* byId(on.chief_id);
            return yield* Effect.fail(new ChiefError(`${title} is on ${owner?.profile.name ?? "another Chief"}'s board already.`, "invalid_state"));
          }
          const added = yield* board.update("attach", (items) =>
            isLive(me.profile.id).pipe(
              Effect.map((live) => {
                if (!live) return { write: [], value: undefined };
                const at = now();
                const fresh = Board.add(items, { id: `ci-${randomUUID().slice(0, 8)}`, chief_id: me.profile.id, text: title, title: title.slice(0, 120), source: input.source ?? "attached", state: "queued", ...(record.workspace.project_id ? { project_ids: [record.workspace.project_id] } : {}) }, at);
                const next = { ...Board.start(fresh, [], at), delivered: true };
                return { write: [next], value: next };
              }),
            ),
          );
          if (added === undefined) return yield* Effect.fail(new ChiefError(`No Chief ${me.profile.id}.`, "not_found"));
          yield* board.link(added.id, record.workspace.id);
          // Its state from the chat's latest turn, and its Chief told, as for a chat it started.
          // chat_send adopting it (sending): the message it is about to get starts its next turn, so its last finished
          // turn is no news and no wake, and the item stays started.
          if (watcher !== undefined) yield* watcher.adopt(record.workspace.id, input.sending === true);
          return (yield* board.get(added.id)) ?? added;
        }),
      );

    /** The live Chief that manages the group `topic` (ChiefProfile.topics), if one does. */
    const managerOf = (topic: string | undefined) =>
      topic === undefined ? Effect.succeed(undefined) : profiles.live.pipe(Effect.map((all) => all.find((p) => p.topics?.includes(topic))));

    /**
     * A chat leaving its group: off `chiefId`'s board, when a group put it there (source topic) and that board is
     * `chiefId`'s. One the person added by hand, one on another Chief's board, or one whose chats still run (the board
     * must keep watching them, as chief.items.remove refuses the person) stays.
     */
    const leaveByTopic = (workspaceId: string, chiefId: string) =>
      Effect.gen(function* () {
        const linked = yield* board.itemOfWorkspace(workspaceId);
        const item = linked === undefined ? undefined : yield* board.get(linked);
        if (item?.source !== "topic" || item.chief_id !== chiefId || Board.RUNNING_STATES.has(item.state)) return;
        yield* board.unlink(workspaceId);
        yield* board.remove(item.id);
      });

    /**
     * Who manages a group (chief.manage): `chiefId`'s, taken from whichever Chief had it, or no one (null). With
     * `handOver` (chats already in the group, as the app listed them), those go on its board as its group's (source topic); a chat on a board
     * already, archived, or outside the Chief's projects is left where it is. Chats join from then on (followTopics).
     */
    const manage = (input: { readonly topic: string; readonly chiefId: string | null; readonly handOver: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const topic = input.topic.replace(/\s+/g, " ").trim();
        if (topic === "") return yield* Effect.fail(new ChiefError("A group's name can't be blank.", "invalid_params"));
        const to = yield* ensureLock.withPermits(1)(
          Effect.gen(function* () {
            const to = input.chiefId === null ? undefined : yield* mustBe(input.chiefId);
            const at = now();
            for (const p of yield* profiles.live) {
              const has = p.topics?.includes(topic) === true;
              const wants = p.id === to?.profile.id;
              if (has === wants) continue;
              const topics = wants ? [...(p.topics ?? []), topic] : (p.topics ?? []).filter((t) => t !== topic);
              const { topics: _, ...rest } = p;
              yield* profiles.put({ ...rest, ...(topics.length > 0 ? { topics } : {}), updated_at: at });
            }
            return to;
          }),
        );
        yield* publishList;
        const handed: string[] = [];
        if (to !== undefined) {
          for (const id of new Set(input.handOver)) {
            const record = yield* store.getWorkspace(id);
            if (record === undefined || record.workspace.topic !== topic || record.workspace.kind !== undefined || record.workspace.parent_workspace_id !== undefined || record.workspace.status === "archived") continue;
            const linked = yield* board.itemOfWorkspace(id);
            if (linked !== undefined && (yield* board.get(linked)) !== undefined) continue;
            const took = yield* attach({ chiefId: to.profile.id, workspaceId: id, source: "topic" }).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
            if (took) handed.push(id);
          }
        }
        return { chiefs: yield* listed, handed };
      });

    /**
     * Chats as they join and leave groups (Workspace.topic, named by the title writer or set by the person): one joining
     * a managed group goes on that Chief's board, as chief.attach takes it (refusals stay quiet: a chat on another board
     * stays there, one outside the Chief's projects stays the person's); one leaving it comes off the board of the
     * Chief that manages the group it left, when a group put it there. A group renamed under the same Chief moves nothing. Chats already in a group when the runtime starts are
     * where they were: only changes from then on count.
     */
    const followTopics = Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(store.workspaceChanges);
      const seen = new Map((yield* store.listWorkspaces()).map((r) => [r.workspace.id, r.workspace.topic] as const));
      while (true) {
        const workspace = yield* PubSub.take(sub);
        if (workspace.kind !== undefined || workspace.parent_workspace_id !== undefined) continue;
        const before = seen.get(workspace.id);
        seen.set(workspace.id, workspace.topic);
        if (before === workspace.topic || workspace.status === "archived") continue;
        // One chat's move failing, a store error or a defect (a bad row), skips that chat, never the following.
        yield* Effect.gen(function* () {
          const from = yield* managerOf(before);
          const to = yield* managerOf(workspace.topic);
          const linked = yield* board.itemOfWorkspace(workspace.id);
          const on = linked === undefined ? undefined : yield* board.get(linked);
          // Off the board of the Chief that manages the group it left, when a group put it there and that Chief isn't
          // its new group's too. A board whose Chief gave the group up (to no one or another Chief) keeps what it has,
          // as chief.manage leaves it.
          if (from !== undefined && from.id !== to?.id && on?.source === "topic" && on.chief_id === from.id) yield* leaveByTopic(workspace.id, from.id);
          if (to !== undefined && on?.chief_id !== to.id) yield* attach({ chiefId: to.id, workspaceId: workspace.id, source: "topic" }).pipe(Effect.ignore);
        }).pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning("Chief: a chat's group move failed", { workspaceId: workspace.id, cause }))));
      }
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) => Effect.logWarning("Chief: following groups stopped", { cause })),
    );

    /** Notes and routine news that never reached their Chief (captured with no key, a failed send, a restart), sent now in Queue order. */
    const catchUp = Effect.gen(function* () {
      const live = new Map((yield* profiles.live).map((p) => [p.id, p] as const));
      const thinks = new Map<string, boolean>();
      for (const item of yield* board.all) {
        if (item.delivered || item.source === "chief" || (failures.get(item.id) ?? 0) >= 3) continue;
        const owner = item.chief_id === undefined ? undefined : live.get(item.chief_id);
        if (owner === undefined) continue;
        if (!thinks.has(owner.id)) thinks.set(owner.id, yield* deps.canThink(owner.model));
        if (!thinks.get(owner.id)) continue;
        if (item.state === "unsorted" || (item.start && Board.OPEN_STATES.has(item.state))) yield* sendNote(item);
      }
      // Routine news no Chief heard yet: a restart cut it short, or its Chief could not think then.
      for (const news of yield* board.unheardNews) yield* deliverNews(news).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: a routine's news did not reach its Chief", cause)));
    });

    /**
     * Tells a Chief something about its board now, in the delivery queue: true once its message is in. Over today's
     * limit no Chief thinks: the board still moves, its line says what changed, and the next note carries the changes.
     * Otherwise the wake's own message is that line (its notification), once. `heard` runs once either is in, or at
     * once for a Chief removed since, which hears nothing again.
     */
    const wakeNow = (chiefId: string, summary: string, text: string, requestId: string, heard: Effect.Effect<void> = Effect.void) =>
      Effect.gen(function* () {
        const me = yield* byId(chiefId);
        if (me === undefined) {
          yield* heard;
          return false;
        }
        if (!(yield* deps.canThink(me.profile.model))) return false;
        if (yield* overCap) {
          yield* deps.note(me.record, summary);
          yield* heard;
          return false;
        }
        yield* refresh(me);
        const context = yield* boardContext(me);
        const sent = yield* deps.submit(me.record, {
          request_id: requestId,
          kind: "followup",
          modelSelection: yield* selectionOf(me),
          input: { text: [text, ...(context.text === "" ? [] : ["", context.text])].join("\n") },
          notification: { source: { kind: "system" }, outcome: "updated", summary },
          generated: true,
        });
        yield* heard;
        if (sent.disposition !== "queued") yield* context.read;
        return true;
      });
    /** A wake: the runtime tells a Chief something about its board (its chats changed, a scheduled item is due). */
    const wake = (chiefId: string, summary: string, text: string, heard?: Effect.Effect<void>, requestId = `chief-wake:${randomUUID()}`) =>
      enqueue(wakeNow(chiefId, summary, text, requestId, heard).pipe(Effect.asVoid));

    // ---------------------------------------------------------------- tools and profile

    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    // Kept with the runtime's settings, so a relaunch still knows a Chief's transcript holds a tainted report.
    const taintKey = (chiefId: string) => `chief.tainted_since:${chiefId}`;
    /** A Chief read outside content (a tainted chat's report, a peer's message, unverified memory). */
    const markTainted = (chiefId: string) =>
      Effect.gen(function* () {
        yield* store.kvSet(taintKey(chiefId), now());
        // Its memory taint too, so every chat it starts or messages from now on carries it (memory's carryTaint).
        const record = yield* store.getWorkspace(chiefId);
        if (record !== undefined && Option.isSome(deps.memory)) yield* deps.memory.value.taint(record.internal.threadId);
      });
    const taintedSince = (chiefId: string) => store.kvGet(taintKey(chiefId)).pipe(Effect.map((at) => (at === undefined ? undefined : Date.parse(at))));
    const chatTainted = (record: WorkspaceRecord) => (Option.isSome(deps.memory) ? deps.memory.value.tainted(record.internal.threadId) : Effect.succeed(false));

    /** remember: a told note in user/ or one of its projects' repositories, quoting only what was typed after its last tainted report. */
    const rememberWith = (memory: Memory["Service"]) => (me: OneChief, input: { readonly text: string; readonly quote: string; readonly repo?: string }) =>
      Effect.gen(function* () {
        const project = input.repo === undefined ? undefined : (yield* projectsOf(me)).find((p) => p.id === input.repo);
        if (input.repo !== undefined && project === undefined) return yield* Effect.fail(new ChiefError(`No project ${input.repo}: pick one from the project list.`));
        const since = yield* taintedSince(me.profile.id);
        const save = (text: string) => memory.remember(me.record.internal.threadId, { text, quote: input.quote, ...(project ? { repoPath: project.path } : {}), ...(since === undefined ? {} : { typedAfter: since }) });
        // The note flipped the quote's polarity (a "don't" the person did not say, or one they did that the note lost): the
        // rule is kept in their own words instead of failing, since the quote itself is what they said, verbatim.
        const saved = yield* save(input.text).pipe(
          Effect.map((row) => ({ ...row, text: input.text })),
          Effect.catchIf(
            (error) => error.message.includes(POLARITY_CLASH),
            () => save(input.quote).pipe(Effect.map((row) => ({ ...row, text: input.quote, as_their_words: true as const }))),
          ),
        );
        // Its prefix carries the person's user/ notes (a repository's are not in it): the next turn opens a session that reads this one.
        if (project === undefined) stale.add(me.profile.id);
        return saved;
      });

    /** Chats a Chief may reach: the ones it started for its items (and what they delegated), and chats the person pointed it at in a note to it. */
    const reachable = (me: OneChief, record: WorkspaceRecord) =>
      Effect.gen(function* () {
        if ((yield* workspacesOf(me.profile.id)).some((r) => r.workspace.id === record.workspace.id)) return true;
        return (yield* board.of(me.profile.id)).some((item) => item.source !== "chief" && parseThreadReferences(item.text).some((ref) => ref.workspace_id === record.workspace.id));
      });

    const autonomyOf = (me: OneChief) => levelsOf(me.profile.id).pipe(Effect.map((l) => l.autonomy), Effect.orElseSucceed(() => DEFAULT_CHIEF_AUTONOMY));
    /**
     * Whether a Chief may message a chat: one it may reach (yours); at autonomy 2 or 3, also a chat the person started
     * in its projects that is on no board (adopt: chat_send puts it on this Chief's board first, so its updates come
     * here from then on). At 1, or a chat on another Chief's board or outside its projects: no.
     */
    const messageable = (me: OneChief, record: WorkspaceRecord) =>
      Effect.gen(function* () {
        if (yield* reachable(me, record)) return "yours" as const;
        if ((yield* autonomyOf(me)) < 2) return "no" as const;
        const unclaimed = (yield* boardChats(me, true)).some((c) => c.item === undefined && c.record.workspace.id === record.workspace.id);
        return unclaimed ? ("adopt" as const) : ("no" as const);
      });

    /**
     * chat_search: the chats a Chief's board knows of, idle ones too, ranked by how well what they are about (title,
     * key terms, goal, latest ask, branch, latest answer) matches the words of `query`; the best five. Each says whether
     * the Chief may message it (messageable), so it never starts a second chat for work one already does.
     */
    const searchChats = (me: OneChief, query: string) =>
      Effect.gen(function* () {
        const terms = queryTerms(query);
        if (terms.length === 0) return yield* Effect.fail(new ChiefError("Say what the chat is about: a word from its topic, platform, feature, file or pull request.", "invalid_params"));
        const names = yield* projectName;
        // The most recently touched first, and a bound on how many are read.
        const sources = yield* sourcesOf(me);
        const chats = [...(yield* boardChats(me, true))].sort((a, b) => b.record.workspace.updated_at.localeCompare(a.record.workspace.updated_at)).slice(0, SEARCH_SCAN);
        const found: Array<{ readonly score: number; readonly active: boolean; readonly at: string; readonly result: Record<string, unknown> }> = [];
        for (const { record, item } of chats) {
          const { line, facts } = yield* chatLineOf(record, item, names, sources);
          const match = score(terms, {
            title: record.workspace.title,
            ...(line.about ? { about: line.about } : {}),
            ...facts,
            ...(record.workspace.branch ? { branch: record.workspace.branch } : {}),
            ...(line.repos ? { repos: line.repos } : {}),
          });
          if (match.score === 0) continue;
          const reach = yield* messageable(me, record);
          found.push({
            score: match.score,
            active: line.active,
            at: record.workspace.updated_at,
            result: {
              workspace_id: record.workspace.id,
              title: record.workspace.title,
              project: line.project,
              ...(line.repos ? { repos: line.repos.join(", ") } : {}),
              status: record.workspace.status,
              ...(item ? { item_id: item.id } : {}),
              ...(line.about ? { about: line.about.join(", ") } : {}),
              ...(facts.goal ? { goal: facts.goal.replace(/\s+/g, " ").slice(0, 240) } : {}),
              matched: match.matched.join(", "),
              ...(reach === "adopt"
                ? { not_on_your_board: "The person started it. chat_send puts it on your board, and you hear its updates from then on." }
                : reach === "no"
                  ? { not_yours: "It is on no board of yours: ask the person to add it to your board, or to link it in a note, before you message it." }
                  : {}),
            },
          });
        }
        found.sort((a, b) => b.score - a.score || Number(b.active) - Number(a.active) || b.at.localeCompare(a.at));
        return { terms, chats: found.slice(0, 5).map((f) => f.result), ...(found.length === 0 ? { none: "No chat of yours or in your projects matches. Ask the person which one they mean, or start one." } : {}) };
      });
    const tools = makeChiefTools({
      view,
      board,
      searchChats,
      messageable,
      adopt: (me, workspaceId) => attach({ chiefId: me.profile.id, workspaceId, sending: true }).pipe(Effect.asVoid),
      chiefOf,
      projectsOf,
      isLive: (me) => isLive(me.profile.id),
      store,
      deps,
      admit,
      runPromise,
      markTainted: (me) => markTainted(me.profile.id),
      taintedSince: (me) => taintedSince(me.profile.id),
      askWaitMinutes: limits.pipe(Effect.map((l) => l.askWaitMinutes)),
      autonomy: (me: OneChief) => levelsOf(me.profile.id).pipe(Effect.map((l) => l.autonomy)),
      overCap,
      capReason: CAP_REASON,
      reachable,
      ...(Option.isSome(deps.memory) ? { remember: rememberWith(deps.memory.value) } : {}),
    });

    /**
     * A Chief's prefix after its constant text: the soul every Chief shares (Settings.chief_soul), its autonomy level, its
     * own soul, its id (what a routine it sets up names), the projects it works in (prompt.ts projectsSection), the
     * memory brief. Nothing here changes from turn to turn: a change reopens its session (refresh).
     */
    const sections = (me: OneChief) =>
      Effect.gen(function* () {
        const levels = yield* levelsOf(me.profile.id);
        openedAt.set(me.profile.id, levelsKey(levels));
        const sources = yield* sourcesOf(me);
        openedSources.set(me.profile.id, sourcesKey(sources));
        const { full, rest } = yield* projectLines(me, sources);
        const brief = Option.isSome(deps.memory) ? yield* deps.memory.value.brief(me.record.internal.threadId, "caveman") : "";
        const shared = soulSection((yield* deps.settings).chief_soul ?? "");
        const soul = soulSection(me.profile.soul);
        const learned = yield* lessons.of(me.profile.id);
        return [
          ...(shared === "" ? [] : [{ title: "Soul, every Chief", text: shared }]),
          { title: "Autonomy", text: autonomySection(levels.autonomy) },
          ...(soul === "" ? [] : [{ title: "Soul", text: soul }]),
          { title: "Your id", text: me.profile.id },
          { title: "Projects", text: projectsSection(full, rest, me.profile.project_ids.length === 0) },
          ...(brief === "" ? [] : [{ title: "Memory", text: brief }]),
          ...(learned.length === 0 ? [] : [{ title: "Lessons", text: learned.map((lesson) => `- ${lesson.text}`).join("\n") }]),
        ];
      });
    /**
     * The profile of whichever Chief owns the thread, undefined for any other thread. Fails closed: once the
     * thread is a Chief's it never answers undefined (that would open it as a coding session); a removed Chief's
     * thread, or one the runtime can't place, fails, and the session does not open.
     */
    const profile = (threadId: ThreadId) =>
      ofThread(threadId).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.succeed(undefined)
            : found === "removed"
              ? Effect.fail(new Error("This Chief was removed."))
              : sections(found).pipe(
                  Effect.catchCause((cause) => Effect.logWarning("chief: its sections failed; it runs without them", cause).pipe(Effect.as([]))),
                  Effect.map((s): EngineProfile => ({ instructions: chiefInstructions(found.profile), sections: s, tools })),
                ),
        ),
      );

    // ---------------------------------------------------------------- watcher

    /** Items whose go-ahead is on its way to their Chief (in the delivery queue). */
    const goingAhead = new Set<string>();
    /**
     * Questions the person left unsettled past their wait: each Chief is woken to go ahead with the answer it
     * recommended, then the question is settled. Its wake has a stable request id, so one that a restart or a failure
     * cuts short goes again on a later tick and never twice; over today's limit, or with nothing to think with, they wait.
     */
    const goAhead = Effect.gen(function* () {
      const at = now();
      const due = (yield* board.all).filter((i) => i.asked?.go_ahead_at !== undefined && i.asked.go_ahead_at <= at && !Board.CLOSED_STATES.has(i.state));
      // A Chief with nothing to run on hears nothing: wakeNow says so for each.
      if (due.length === 0 || (yield* overCap)) return;
      for (const item of due) {
        const asked = item.asked!;
        const chiefId = item.chief_id;
        if (chiefId === undefined || goingAhead.has(item.id)) continue;
        goingAhead.add(item.id);
        yield* enqueue(
          Effect.gen(function* () {
            // Settled meanwhile (its Chief acted on it, the chat went on): nothing to go ahead with.
            if ((yield* board.get(item.id))?.asked?.asked_at !== asked.asked_at) return;
            // The person wrote to this Chief since: that may have answered it, so the Chief checks first.
            const typedSince = (yield* board.of(chiefId)).some((i) => Board.TYPED_SOURCES.has(i.source) && i.created_at > asked.asked_at);
            // A card that closed with its turn is no card to answer: the answer goes to the chat as a message.
            const record = asked.workspace_id === undefined ? undefined : yield* store.getWorkspace(asked.workspace_id);
            const cardOpen = asked.ask_id !== undefined && record !== undefined && (yield* openAsk(store, record))?.id === asked.ask_id;
            const { ask_id: _card, ...withoutCard } = asked;
            const sent = yield* wakeNow(chiefId, "No answer, so it goes ahead", noAnswer(item.id, cardOpen ? asked : withoutCard, typedSince), `chief-go-ahead:${item.id}:${asked.asked_at}`);
            if (!sent) return;
            yield* board.update("go_ahead", (items) =>
              Effect.succeed({ write: items.filter((i) => i.id === item.id && i.asked?.asked_at === asked.asked_at).map((i) => Board.settle(i, now())), value: undefined }),
            );
          }).pipe(Effect.ensuring(Effect.sync(() => goingAhead.delete(item.id)))),
        );
      }
    });

    /**
     * Missions due a look-in (Board.checkInDue), one wake per Chief. Each is claimed (checked_at) before its wake leaves,
     * so no later tick or retry sends it twice, and handed back when it is no longer open or its Chief's as the wake
     * leaves the queue (asked about, closed, handed to another Chief meanwhile) or the wake never became a turn (today's limit reached meanwhile, a
     * failed send, its Chief removed): a later tick sends it then. Over the limit, or for a Chief with nothing to think
     * with, nothing is claimed; a restart with one still in the delivery queue skips that look-in. The claim is
     * bookkeeping (store.ts moveCheckIns): no board change for the Chief, and updated_at (which routing reads) stays.
     */
    const checkIns = Effect.gen(function* () {
      const at = now();
      const waiting = (yield* board.all).filter((i) => i.chief_id !== undefined && Board.checkInDue(i, Date.parse(at)));
      if (waiting.length === 0 || (yield* overCap)) return;
      const live = new Map((yield* profiles.live).map((p) => [p.id, p] as const));
      const thinking = new Set<string>();
      for (const chiefId of new Set(waiting.map((i) => i.chief_id!))) {
        const owner = live.get(chiefId);
        if (owner !== undefined && (yield* deps.canThink(owner.model))) thinking.add(chiefId);
      }
      const mine = waiting.filter((i) => thinking.has(i.chief_id!));
      const claimed = new Set(yield* board.moveCheckIns(mine.map((i) => ({ id: i.id, from: i.checked_at, to: at }))));
      const byChief = new Map<string, Array<Board.Item>>();
      for (const item of mine) if (claimed.has(item.id)) byChief.set(item.chief_id!, [...(byChief.get(item.chief_id!) ?? []), item]);
      for (const [chiefId, items] of byChief) {
        const was = new Map(items.map((i) => [i.id, i.checked_at]));
        const handBack = (back: ReadonlyArray<Board.Item>) => board.moveCheckIns(back.map((i) => ({ id: i.id, from: at, to: was.get(i.id) })));
        yield* enqueue(
          Effect.gen(function* () {
            // Read from the whole board: a mission handed to another Chief meanwhile gets its claim back too.
            const held = (yield* board.all).filter((i) => was.has(i.id) && i.checked_at === at);
            const stays = (i: Board.Item) => i.chief_id === chiefId && Board.checkInOpen(i);
            const open = held.filter(stays);
            yield* handBack(held.filter((i) => !stays(i)));
            if (open.length === 0) return;
            const sent = yield* wakeNow(
              chiefId,
              `${open.length} mission check-in${open.length === 1 ? "" : "s"}`,
              open.map((i) => `<check_in item="${i.id}" pace="${i.check_in}">Look in on this mission; text the person only for a result, a failure or a decision that is theirs.</check_in>`).join("\n"),
              `chief-check-in:${chiefId}:${at}`,
            ).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: a check-in did not reach its Chief", cause).pipe(Effect.as(false))));
            if (!sent) yield* handBack(open);
          }),
        );
      }
    });

    /** After a restart: held siblings get their tasks (or are archived); notes and routine news that never arrived are sent (catchUp). */
    const recover = Effect.gen(function* () {
      for (const row of yield* board.held) if (!liveHolds.has(row.workspace_id)) yield* sendTask(row.workspace_id);
      yield* catchUp;
    });

    watcher = yield* makeWatcher({
      store,
      board,
      wake,
      readmit,
      onCompaction: (chiefId) =>
        Effect.sync(() => {
          const view = viewOf(chiefId);
          view.fullBoard = true;
          view.compactions++;
        }),
      tainted: chatTainted,
      markTainted,
      moment,
      tick: Effect.all(
        [
          catchUp,
          goAhead.pipe(Effect.catchCause((cause) => Effect.logWarning("chief: going ahead failed", cause))),
          checkIns.pipe(Effect.catchCause((cause) => Effect.logWarning("chief: mission check-ins failed", cause))),
        ],
        { discard: true },
      ),
      captureProof: makeProofCapture({ board, attachmentsDir: deps.attachmentsDir, chiefThread: (item) => ownerOf(item).pipe(Effect.map((me) => me?.record.internal.threadId)) }),
    });
    /**
     * What a start leaves to do, once the runtime takes commands (making a Chief sends T3 its thread, which waits for
     * that, and the routes this is built with must exist first). A Chief from before profiles gets its profile
     * (adoptLegacy); every other Chief from an older build is a Chief as it is, whatever its projects. A project removed
     * by a run that quit before its Chiefs heard of it leaves their lists as project.remove takes it (retireProject).
     * Chiefs whose workspace is gone are replaced (replaceGone). Chiefs half made by a failed chief.create of an older
     * build (a workspace of kind chief with no profile), and Chiefs whose profile was marked removed before their
     * workspace was archived (a quit in between), are archived, so no list shows them; their threads never open
     * (profile fails closed). A failure is logged and the next start tries again; every chief.* call waits for it
     * (settled).
     */
    const startup = Effect.gen(function* () {
      yield* ensureLock.withPermits(1)(adoptLegacy);
      const looked = new Set<string>();
      const projectGone = new Map<string, string>();
      // Every project a Chief lists, and every one an open or running item names: a Chief in every project lists none,
      // though its items name theirs.
      const named = [...(yield* profiles.live).flatMap((p) => p.project_ids), ...(yield* board.all).filter((i) => Board.OPEN_STATES.has(i.state) || Board.RUNNING_STATES.has(i.state)).flatMap((i) => i.project_ids)];
      for (const id of named) {
        if (looked.has(id)) continue;
        looked.add(id);
        // Can't tell: it stays, and the next start looks again.
        const row = yield* deps.projectRow(id).pipe(Effect.option);
        if (Option.isSome(row) && (row.value === undefined || row.value.removed)) projectGone.set(id, row.value?.name ?? "Its project");
      }
      for (const [projectId, name] of projectGone) {
        yield* retireProject(projectId, name).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: taking a removed project off its Chiefs failed; the next start tries again", cause)));
      }
      yield* ensureLock.withPermits(1)(replaceGone).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: replacing a Chief whose workspace is gone failed; the next start tries again", cause)));
      for (const record of yield* store.listWorkspaces()) {
        if (record.workspace.kind !== "chief" || record.workspace.status === "archived") continue;
        const profile = yield* profiles.get(record.workspace.id);
        if (profile === undefined || profile.removed_at !== undefined) yield* deps.retire(record);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("chief: the startup pass failed; the next start runs it again", cause)),
      Effect.ensuring(Deferred.succeed(startedUp, undefined)),
    );
    /** Fork it once, when the runtime takes commands: it runs for the route's life, after the startup pass. */
    const watch = startup.pipe(Effect.andThen(Effect.all([deliverer, recover.pipe(Effect.andThen(watcher.run)), followTopics], { concurrency: "unbounded", discard: true })));

    /**
     * A routine's run (outputs.chief): its row on the board, always, naming the Chief it reports to: the one its file
     * names (`to`) while that Chief is there, else one that works in its project (pick). Only a run whose step decided
     * news reaches that Chief: the report goes in its conversation as a news card (no model turn), then wakes it with
     * the report as data. That is outside content, so the Chief is marked tainted first. A quiet run wakes no one. The
     * news is kept until the wake is in (chief_routine_news), so a restart before that delivers it then; a report handed
     * over again, or news already heard, does nothing twice.
     */
    const routineReport = (report: RoutineReport) =>
      Effect.gen(function* () {
        const named = report.chiefId === undefined ? undefined : yield* byId(report.chiefId);
        const to = named ?? (yield* pick(report.projectId));
        yield* board.putRoutine({
          automation_id: report.automationId,
          project_id: report.projectId,
          ...(to === undefined ? {} : { chief_id: to.profile.id }),
          name: report.automation,
          run_id: report.runId,
          ran_at: report.at,
          status: report.status,
          ...(report.decision === undefined ? {} : { decision: report.decision }),
          summary: report.summary,
        });
        if (report.status !== "succeeded" || report.decision !== NEWS_DECISION) return;
        const said = report.summary.trim() || `${report.automation} found news.`;
        const news: RoutineNews = {
          run_id: report.runId,
          automation_id: report.automationId,
          project_id: report.projectId,
          ...(to === undefined ? {} : { chief_id: to.profile.id }),
          name: report.automation,
          report: said.length > NEWS_CHARS ? `${said.slice(0, NEWS_CHARS - 1)}…` : said,
          at: report.at,
        };
        if (yield* board.putNews(news)) yield* deliverNews(news);
      });
    /** News runs on their way into a Chief's queue in this process: a report handed over again meanwhile waits for it. */
    const newsGoing = new Set<string>();
    /**
     * A news run's card (once per run), then, when its Chief can think, its wake, which marks it heard once it is in. Its
     * Chief is the one it reported to, while that one is there, else one that works in its project (pick). A Chief that
     * cannot think yet (no key, or over today's limit) gets the card alone: catchUp's tick wakes it once it can. No
     * Chief: nobody hears it.
     */
    const deliverNews = (news: RoutineNews) =>
      Effect.suspend(() => {
        if (newsGoing.has(news.run_id)) return Effect.void;
        newsGoing.add(news.run_id);
        const done = Effect.sync(() => void newsGoing.delete(news.run_id));
        return Effect.gen(function* () {
          yield* settled;
          const me = (news.chief_id == null ? undefined : yield* byId(news.chief_id)) ?? (yield* pick(news.project_id));
          if (me === undefined) {
            yield* board.markNewsHeard(news.run_id);
            return yield* done;
          }
          const m: ChiefMoment = { kind: "news", text: news.report, routine: { automation_id: news.automation_id, name: news.name, run_id: news.run_id } };
          yield* writeMoment(store, me.record, m, momentTitle(m, news.name));
          // Over today's limit it would only be noted, never acted on: it waits, as for a Chief that cannot think.
          if (!(yield* deps.canThink(me.profile.model)) || (yield* overCap)) return yield* done;
          yield* markTainted(me.profile.id);
          const text = routineNews({ name: news.name, automationId: news.automation_id, runId: news.run_id, report: news.report });
          yield* enqueue(
            wakeNow(me.profile.id, momentTitle(m, news.name), text, `chief-news:${news.run_id}`, board.markNewsHeard(news.run_id)).pipe(Effect.asVoid, Effect.ensuring(done)),
          );
        }).pipe(Effect.onError(() => done));
      });

    /** What today's limit still leaves, in dollars; undefined with no dollar cap. */
    const capRoom = Effect.gen(function* () {
      const l = yield* limits;
      return l.dailyCapUsd > 0 ? Math.max(0, l.dailyCapUsd - (yield* spentToday)) : undefined;
    });


    return {
      board,
      learn,
      builderHold,
      list,
      create,
      update,
      remove,
      retireProject,
      soulChanged,
      /** Done once the startup pass went through: every chief.* call waits for it. */
      settled,
      byId,
      mustBe,
      resolve,
      chiefOf,
      listChanges,
      view,
      profile,
      deliver,
      sendNote,
      capture,
      attach,
      manage,
      catchUp,
      enqueue,
      wake,
      admit,
      /** Items waiting on a limit start now, while they fit (a limit raised or removed). */
      readmit,
      limits,
      tools,
      watch,
      spentToday,
      overCap,
      capRoom,
      activeChats,
      routineReport,
      /**
       * The Chief each routine's reports go to now, as routineReport picks it: the one its file names (`to`) while that
       * Chief is there, else one that works in its project (pickAmong); undefined with no Chief at all. All of a list at
       * once, after the startup pass as chief.* calls are, so a Chief it is replacing is never the answer: one wait of at
       * most 5 seconds, and one read of the Chiefs and the board.
       */
      routineChiefs: (routines: ReadonlyArray<{ readonly projectId: string; readonly named: string | undefined }>) =>
        Effect.gen(function* () {
          if (routines.length === 0) return [];
          yield* settled.pipe(Effect.timeoutOption("5 seconds"));
          const chiefs = yield* liveChiefs;
          const items = yield* board.all;
          const live = new Set(chiefs.map((c) => c.profile.id));
          return routines.map(({ projectId, named }) => (named !== undefined && live.has(named) ? named : pickAmong(chiefs, projectId, items)?.profile.id));
        }),
      /**
       * Whether this Chief (absent: the one a call naming none reaches, pick; none, false) has something to run on now:
       * chief.get's availability. Makes no Chief.
       */
      available: (chiefId: string | undefined) => {
        const found: Effect.Effect<OneChief | undefined, unknown> = chiefId === undefined ? settled.pipe(Effect.andThen(pick(undefined))) : resolve({ chiefId });
        return found.pipe(
          Effect.flatMap((me) => (me === undefined ? Effect.succeed(false) : deps.canThink(me.profile.model))),
          Effect.orElseSucceed(() => false),
        );
      },
    };
  });

export type Chief = Effect.Success<ReturnType<typeof makeChief>>;
