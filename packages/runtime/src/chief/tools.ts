// A Chief's whole tool surface: in-process functions the Caveman engine declares directly
// (engine-core ChiefSessions). One set serves every Chief: each call first finds the Chief whose
// session is calling, and touches only that Chief's board, projects and chats. Limits are the
// runtime's (Chief.ts `admit`), never the model's to keep.
import { randomUUID } from "node:crypto";

import type { ChiefTool, ChiefToolCall } from "@caveman-app/engine-core/server/ChiefSessions";
import type { ChiefAttachment, SmartViewItem } from "@caveman-app/session-protocol";
import { safeUrl, type Admission } from "@caveman-app/session-protocol/smart-view";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MEMORY_SQL_DESCRIPTION } from "../memory/MemorySandbox.ts";
import { quotable } from "../memory/MemoryStore.ts";
import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";
import { submittedMessageId } from "../session-protocol/store.ts";
import { inlineImages } from "./attachments.ts";
import * as Board from "./Board.ts";
import { ChiefError } from "./Board.ts";
import { momentTitle, writeMoment } from "./moments.ts";
import type { ChiefDeps } from "./Chief.ts";
import { inProjects, type OneChief } from "./profiles.ts";
import type { BoardStore } from "./store.ts";
import { type ChiefAutonomy, type PlaybookName, PLAYBOOKS } from "./prompt.ts";
import type { SmartView } from "./view.ts";
import { openAsk, personOnly, questionCard } from "./watch.ts";


export interface ChiefToolsContext {
  readonly board: BoardStore;
  readonly store: SessionStore["Service"];
  readonly deps: ChiefDeps;
  /** The Chief whose thread this is, or undefined for a thread that is no (live) Chief's. */
  readonly chiefOf: (threadId: string) => Effect.Effect<OneChief | undefined>;
  /** The Chief is still there: read under the board's lock, so a write racing its removal is refused. */
  readonly isLive: (me: OneChief) => Effect.Effect<boolean>;
  /** The projects a Chief works in (every project, when it lists none). */
  readonly projectsOf: (me: OneChief) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string; readonly path: string }>>;
  readonly admit: (itemId: string, proposal: Board.Proposal, approved: boolean) => Effect.Effect<unknown, unknown>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** The Chief read a report from a tainted chat (a digest or a wake): from then on only notes typed after it may be quoted to remember. */
  readonly markTainted: (me: OneChief) => Effect.Effect<void>;
  /** When it last did (ms), or undefined. Its transcript keeps that report, so this holds across turns and relaunches. */
  readonly taintedSince: (me: OneChief) => Effect.Effect<number | undefined>;
  /** Minutes a question to the person waits before the Chief goes ahead with what it recommended; 0: it always waits. */
  readonly askWaitMinutes: Effect.Effect<number>;
  /** A Chief's autonomy level (its own, else Settings chief_autonomy): at 3, a question it may settle itself never waits. */
  readonly autonomy: (me: OneChief) => Effect.Effect<ChiefAutonomy>;
  /** Today's limit, shared by every Chief, is reached: no more chats or messages from any Chief today. */
  readonly overCap: Effect.Effect<boolean>;
  readonly capReason: string;
  /** chat_search: chats its board knows of, ranked by what they are about (Chief.ts searchChats). */
  readonly searchChats: (me: OneChief, query: string) => Effect.Effect<unknown, ChiefError>;
  /** Whether chat_send may message a chat: yours, adopt (put it on this Chief's board first: autonomy 2 and 3), or no (Chief.ts messageable). */
  readonly messageable: (me: OneChief, record: WorkspaceRecord) => Effect.Effect<"yours" | "adopt" | "no">;
  /** Puts a chat the person started on this Chief's board, as chief.attach does. */
  readonly adopt: (me: OneChief, workspaceId: string) => Effect.Effect<void, unknown>;
  /** A chat this Chief may reach: one it started for its items (or under one), or one the person pointed it at in a note to it. */
  readonly reachable: (me: OneChief, record: WorkspaceRecord) => Effect.Effect<boolean>;
  /** Smart View: what this Chief has put in the person's sidebar (view.ts). */
  readonly view: SmartView;
  /** A Chief memory commit (remember): its note id and version, for the card's Undo. */
  readonly remember?: (me: OneChief, input: { readonly text: string; readonly quote: string; readonly repo?: string; readonly runId: string }) => Effect.Effect<{ readonly id: string; readonly vid: string; readonly text: string; readonly as_their_words?: true }, Error>;
}

type Json = Readonly<Record<string, unknown>>;
const str = (description: string): Json => ({ type: "string", description });
const strs = (description: string): Json => ({ type: "array", items: { type: "string" }, description });
const object = (properties: Readonly<Record<string, Json>>, required: ReadonlyArray<string>): Json => ({ type: "object", properties, required, additionalProperties: false });
/** The playbook tool's names, in PLAYBOOKS' order. */
const PLAYBOOK_NAMES = Object.keys(PLAYBOOKS) as ReadonlyArray<PlaybookName>;

const MISSION_INPUT = {
  done_when: { ...str("What proves this mission done, at most 280 characters. Trimmed; empty clears it."), maxLength: 280 },
  check_in: { type: ["string", "null"], enum: ["day", "week", null], description: "Look in every day or week; text the person only for a result, a failure or a decision that is theirs. Null clears it." },
};
/** Tool calls reach this surface without JSON Schema validation; reject invalid mission fields before any write. */
const missionInput = (input: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (input.done_when !== undefined && (typeof input.done_when !== "string" || input.done_when.length > 280))
      return yield* Effect.fail(new ChiefError("done_when must be a string of at most 280 characters.", "invalid_params"));
    if (input.check_in !== undefined && input.check_in !== null && input.check_in !== "day" && input.check_in !== "week")
      return yield* Effect.fail(new ChiefError("check_in must be day, week or null.", "invalid_params"));
    return { done_when: input.done_when as string | undefined, check_in: input.check_in as Board.Item["check_in"] | null | undefined };
  });

/** The person's notes the Chief may quote: what they typed, never what the Chief or an automation added. */
export const verifyQuotes = (items: ReadonlyArray<Board.Item>, quotes: ReadonlyArray<string>) => {
  // The only words a quote may come from: what the person typed, or said on a call.
  const typed = items.filter((item) => Board.TYPED_SOURCES.has(item.source)).map((item) => item.text);
  for (const quote of quotes) {
    // As long as memory needs a quote to be (memory/MemoryStore.ts quotable); the runtime checks it again when it stores it.
    if (!quotable(quote)) return `Too short to stand for the person's words: "${String(quote).slice(0, 80)}" (a quote is at least 20 characters and 4 words).`;
    if (!typed.some((text) => text.includes(quote))) return `Not the person's words: "${quote.slice(0, 80)}" is not verbatim in any note they typed.`;
  }
  return undefined;
};

/**
 * A project the Chief named: by id, by its id without the kind (c7b7… for caveman-repo:c7b7…), or by its name, each
 * when only one project has it. Models copy the name from the list, and drop the kind; a retry costs a turn.
 */
const projectNamed = (projects: ReadonlyArray<{ readonly id: string; readonly name: string }>, named: string) => {
  const one = <A,>(found: ReadonlyArray<A>) => (found.length === 1 ? found[0] : undefined);
  return (projects.find((p) => p.id === named) ?? one(projects.filter((p) => named !== "" && p.id.endsWith(`:${named}`))) ?? one(projects.filter((p) => p.name === named)))?.id;
};

export const makeChiefTools = (ctx: ChiefToolsContext): ReadonlyArray<ChiefTool> => {
  const { board, store } = ctx;
  const now = () => new Date().toISOString();
  /** Projects by id or name: only the ones this Chief works in. Another project is refused, by name. */
  const projectIds = (me: OneChief, raw: unknown) =>
    Effect.gen(function* () {
      const mine = yield* ctx.projectsOf(me);
      const ids: Array<string> = [];
      for (const named of Array.isArray(raw) ? raw.map(String) : []) {
        const id = projectNamed(mine, named);
        if (id === undefined) {
          const all = yield* ctx.deps.projects;
          const other = all.find((p) => p.id === projectNamed(all, named));
          const own = mine.length === 0 ? "none yet: the person adds a project first" : mine.length > 4 ? "the Projects section" : mine.map((p) => p.name).join(", ");
          return yield* Effect.fail(
            new ChiefError(
              other === undefined
                ? `No project ${named}. Yours: ${own}.`
                : `${other.name} is not one of your projects, so your chats can't start there. Yours: ${own}. Tell the person in one line; they can add it in your settings.`,
            ),
          );
        }
        ids.push(id);
      }
      return ids;
    });
  /**
   * chat_start's sources: each one of the project's, by its name or its repository (owner/name, any case), as its name;
   * none named is the project's own. A repository that is no source is refused: adding one is the person's. So is a
   * set no chat works in exactly (Board.sourcesPlace).
   */
  const sourcesNamed = (projectId: string, raw: unknown) =>
    Effect.gen(function* () {
      const wanted = Array.isArray(raw) ? raw.map((name) => String(name).trim()).filter((name) => name !== "") : [];
      if (wanted.length === 0) return undefined;
      const all = yield* ctx.deps.projectSources(projectId);
      const names: Array<string> = [];
      for (const name of wanted) {
        const source = all.find((s) => s.name === name) ?? all.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.repository?.full_name.toLowerCase() === name.toLowerCase());
        if (source === undefined) {
          const project = (yield* ctx.deps.projects).find((p) => p.id === projectId)?.name ?? "your project";
          return yield* Effect.fail(
            new ChiefError(
              `${name} is not a source of ${project}: its sources are ${all.map((s) => s.name).join(", ") || "its own repository"}. Adding a repository is the person's, in the project's settings.`,
              "invalid_params",
            ),
          );
        }
        if (!names.includes(source.name)) names.push(source.name);
      }
      const place = Board.sourcesPlace(names.map((name) => all.find((s) => s.name === name)!));
      if (typeof place === "string") return yield* Effect.fail(new ChiefError(place, "invalid_params"));
      return names;
    });
  /** One of this Chief's items: another Chief's is no item here. */
  const item = (me: OneChief, id: unknown) =>
    board.get(String(id)).pipe(
      Effect.flatMap((found) => (found !== undefined && found.chief_id === me.profile.id ? Effect.succeed(found) : Effect.fail(new ChiefError(`No item ${String(id)} on the board.`)))),
    );
  const chat = (me: OneChief, id: unknown) =>
    Effect.gen(function* () {
      const record = yield* store.getWorkspace(String(id));
      if (record === undefined || record.workspace.kind === "chief") return yield* Effect.fail(new ChiefError(`No chat ${String(id)}.`));
      if (!(yield* ctx.reachable(me, record))) return yield* Effect.fail(new ChiefError(`${String(id)} is not a chat you started or one the person pointed you at.`));
      return record;
    });
  /**
   * A chat a Chief may read (chat_digest): one it may reach, or any chat in its projects, so "what's going on" covers the
   * chats it did not start. Messaging one still takes `chat` (or chat_send's adopt).
   */
  const readable = (me: OneChief, id: unknown) =>
    Effect.gen(function* () {
      const record = yield* store.getWorkspace(String(id));
      if (record === undefined || record.workspace.kind === "chief") return yield* Effect.fail(new ChiefError(`No chat ${String(id)}.`));
      const ours = inProjects(me.profile, record.workspace.project_id);
      if (!ours && !(yield* ctx.reachable(me, record))) return yield* Effect.fail(new ChiefError(`${String(id)} is not a chat in your projects, nor one the person pointed you at.`));
      return record;
    });
  /**
   * A board write for this Chief: refused once it is removed, checked under the board's lock, so a call that passed
   * chiefOf just before its removal lands nothing on its board.
   */
  const guarded = <A>(me: OneChief, kind: string, change: (items: ReadonlyArray<Board.Item>) => { readonly write: ReadonlyArray<Board.Item>; readonly value: A }) =>
    board
      .update(kind, (items) =>
        ctx.isLive(me).pipe(
          Effect.map((live): { readonly write: ReadonlyArray<Board.Item>; readonly value: { readonly done: A } | undefined } => {
            if (!live) return { write: [], value: undefined };
            const out = change(items);
            return { write: out.write, value: { done: out.value } };
          }),
        ),
      )
      .pipe(Effect.flatMap((out) => (out !== undefined ? Effect.succeed(out.done) : Effect.fail(new ChiefError(`${me.profile.name} was removed.`)))));
  const write = (me: OneChief, kind: string, change: (items: ReadonlyArray<Board.Item>) => ReadonlyArray<Board.Item>) => guarded(me, kind, (items) => ({ write: change(items), value: undefined }));
  const one = (me: OneChief, id: string, change: (item: Board.Item) => Board.Item) => write(me, "chief", (items) => items.filter((i) => i.id === id).map(change));
  /**
   * An item whose chats run, or finished and wait on review or the person, is followed by its state alone (the watcher,
   * the pull request follower, the removal guard): it leaves for done or dropped, never to wait again.
   */
  const stillFollowed = (item: Board.Item) =>
    Board.RUNNING_STATES.has(item.state)
      ? `${item.id} is ${item.state}: its chats are followed and you are woken as they move, so it can't wait again (scheduled, queued or after another item). Done or dropped takes it off.`
      : undefined;
  // Numbers are allocated by the store, not Board.add. Read the persisted item after writing so a new
  // item can be named in this same turn, before the next board_changes arrives.
  const itemReceipt = (me: OneChief, id: string) => item(me, id).pipe(Effect.map((i) => ({ item_id: i.id, ...(i.number === undefined ? {} : { item_ref: `[[${i.number}]]` }) })));
  /** Its question about this chat is settled (the Chief answered or messaged it). */
  const settleChat = (me: OneChief, workspaceId: string) =>
    write(me, "settle", (items) => items.filter((i) => i.chief_id === me.profile.id && i.asked?.workspace_id === workspaceId).map((i) => Board.settle(i, now())));

  const tool = (
    name: string,
    description: string,
    input: Json,
    run: (input: Record<string, unknown>, call: ChiefToolCall, me: OneChief) => Effect.Effect<unknown, unknown>,
  ): ChiefTool => ({
    name,
    description,
    input,
    run: (threadId, raw, call) =>
      ctx.runPromise(
        Effect.gen(function* () {
          // The calling thread's Chief: everything this call touches is its own.
          const me = yield* ctx.chiefOf(threadId);
          if (me === undefined) return yield* Effect.fail(new ChiefError(`Only the Chief may use ${name}.`));
          return yield* run((raw ?? {}) as Record<string, unknown>, call, me);
        }).pipe(Effect.mapError((error) => (error instanceof Error ? error : new ChiefError(String((error as { message?: unknown })?.message ?? error))))),
      ),
  });

  /**
   * Images the Chief names, by id, from its own notes' <attachments> or its chats' screenshots (chat_update proof=,
   * chief/proof.ts): references on its board only, never a path or anything else of the store, so a chat gets exactly
   * what the person sent the Chief or another chat showed.
   */
  const noteImages = (me: OneChief, ids: unknown): Effect.Effect<ReadonlyArray<ChiefAttachment>, ChiefError> =>
    Effect.gen(function* () {
      const wanted = Array.isArray(ids) ? ids.map(String) : [];
      if (wanted.length === 0) return [];
      const known = new Map(
        (yield* board.of(me.profile.id)).flatMap((i) => [
          ...(i.attachments ?? []).map((a) => [a.id, a] as const),
          ...(i.proof ?? []).flatMap((p) => p.images.map(({ id, name, mime_type, size_bytes }) => [id, { id, name, mime_type, size_bytes }] as const)),
        ]),
      );
      const found: Array<ChiefAttachment> = [];
      for (const id of wanted) {
        const image = known.get(id);
        if (image === undefined) return yield* Effect.fail(new ChiefError(`No image ${id} on your board: pass ids from a note's <attachments> or a chat_update's proof=.`, "not_found"));
        found.push(image);
      }
      return found;
    });
  /** Those images as a chat's turn takes them (inline); a file gone from the store says so. */
  const imagesInline = (refs: ReadonlyArray<ChiefAttachment>) =>
    Effect.try({ try: () => inlineImages(ctx.deps.attachmentsDir, refs), catch: (error) => new ChiefError(error instanceof Error ? error.message : String(error), "invalid_state") });
  /**
   * Smart View: the item a view_open names, checked as every other tool checks what it names (a project of this
   * Chief's, a chat it may reach, an http(s) address), with the title its tab and view_list show.
   */
  const viewItem = (me: OneChief, input: Record<string, unknown>) =>
    Effect.gen(function* () {
      const text = (key: string) => (typeof input[key] === "string" && input[key].trim() !== "" ? input[key].trim() : undefined);
      const named = text("title");
      const need = (key: string, what: string) => (text(key) === undefined ? Effect.fail(new ChiefError(`${String(input.kind)} needs ${key}: ${what}.`)) : Effect.succeed(text(key)!));
      const address = (raw: string) => {
        const url = safeUrl(raw);
        return url === undefined ? Effect.fail(new ChiefError(`${raw.slice(0, 80)} is not an http or https address.`)) : Effect.succeed(url);
      };
      switch (input.kind) {
        case "pr": {
          const [projectId] = yield* projectIds(me, [yield* need("project_id", "the pull request's project")]);
          const number = Number(input.number);
          if (!Number.isInteger(number) || number <= 0) return yield* Effect.fail(new ChiefError("pr needs number: the pull request's number."));
          const view = input.view === "files" || input.view === "discussion" || input.view === "guide" ? input.view : undefined;
          const item: SmartViewItem = { kind: "pr", project_id: projectId!, number, ...(view === undefined ? {} : { view }) };
          return { item, title: named ?? `#${number}` };
        }
        case "chat": {
          const record = yield* chat(me, yield* need("workspace_id", "the chat"));
          return { item: { kind: "chat", workspace_id: record.workspace.id } as SmartViewItem, title: named ?? record.workspace.title };
        }
        case "image":
        case "video": {
          const kind = input.kind;
          const url = text("url");
          if (url !== undefined) return { item: { kind, url: yield* address(url) } as SmartViewItem, title: named ?? (url.split(/[?#]/)[0]!.split("/").pop() || url) };
          const path = yield* need("path", "a file in the chat's checkout, or url");
          const record = yield* chat(me, yield* need("workspace_id", "the chat whose checkout has the file"));
          return { item: { kind, workspace_id: record.workspace.id, path } as SmartViewItem, title: named ?? (path.split("/").pop() || path) };
        }
        case "web": {
          const url = yield* address(yield* need("url", "the page's address"));
          return { item: { kind: "web", url } as SmartViewItem, title: named ?? new URL(url).host };
        }
        default:
          return yield* Effect.fail(new ChiefError(`kind is one of pr, chat, image, video, web.`));
      }
    });
  /** What happened to a view_open, for the Chief: never an error, so a no is never retried. */
  const viewSaid = (admission: Admission) => {
    switch (admission.kind) {
      case "off":
        return { opened: false, smart_view: "off", said: "Smart View is off (the person turned it off): nothing opened. Link or name it in your reply instead." };
      case "opened":
        return admission.entry.asked
          ? { opened: true, id: admission.entry.id, said: "In front in the person's sidebar." }
          : { opened: true, id: admission.entry.id, said: "In the person's sidebar: in front if they weren't using it, else as a tab that pulses until they look. No need to say you opened it." };
      case "surfaced":
        return { opened: true, id: admission.entry.id, said: "Already open; brought to the front." };
      case "already_open":
        return { opened: false, id: admission.entry.id, said: `Already in their sidebar since ${Board.clock(admission.entry.opened_at)}; left as it is.` };
      case "closed_recently":
        return { opened: false, id: admission.entry.id, said: `The person closed it at ${Board.clock(admission.entry.closed_at!)}: it stays closed unless they ask for it. Say it in words if it matters.` };
      case "too_many_open":
        return { opened: false, said: `${admission.open} of yours are open: close one you no longer need (view_close) first, or say it in words.` };
      case "too_soon":
        return { opened: false, said: `You opened something moments ago: nothing opened. Say it in words; open it later (in ${Math.ceil(admission.retryAfterMs / 1000)}s or more) only if it still matters.` };
    }
  };
  return [
    tool(
      "queue_add",
      "Put something on the Queue that is not a note the person already typed (a follow-up you will need). Set done_when for a mission whose end is not obvious; check_in sets its pace.",
      object({ text: str("What it is, in a line."), title: str("A short name."), project_ids: strs("Its projects, by id."), ...MISSION_INPUT }, ["text"]),
      (input, _call, me) =>
        Effect.gen(function* () {
          const mission = yield* missionInput(input);
          const ids = yield* projectIds(me, input.project_ids);
          const id = yield* guarded(me, "add", (items) => {
            const added = Board.add(items, { id: `ci-${randomUUID().slice(0, 8)}`, chief_id: me.profile.id, text: String(input.text), source: "chief", state: "queued", ...(input.title ? { title: String(input.title) } : {}), ...(Array.isArray(input.project_ids) ? { project_ids: ids } : {}) }, now());
            return { write: [Board.mission(added, mission, now())], value: added.id };
          });
          return yield* itemReceipt(me, id);
        }),
    ),
    tool(
      "queue_update",
      "Sort an item: give it a title, projects, done_when proof and check_in pace, make it wait for another item of the same request (after_item_id), or set it queued, done or dropped. Mark done only when its proof meets done_when, and say what proves it in their terms (what now works), never a test run or a state.",
      object(
        {
          item_id: str("The item."),
          title: str("A short name."),
          ...MISSION_INPUT,
          project_ids: strs("Its projects, by id."),
          after_item_id: str("It waits until this item is done: only a part of the same request that builds on it, never another request."),
          state: { type: "string", enum: ["queued", "done", "dropped"], description: "queued: ready to start; done; dropped." },
        },
        ["item_id"],
      ),
      (input, _call, me) =>
        Effect.gen(function* () {
          const mission = yield* missionInput(input);
          const current = yield* item(me, input.item_id);
          const ids = yield* projectIds(me, input.project_ids);
          if (input.after_item_id !== undefined) yield* item(me, input.after_item_id);
          // Applied to the item as it is under the board's lock: what the watcher, the pull request follower or the
          // person wrote since it was read above stays.
          const next = yield* guarded(me, "chief", (items): { readonly write: ReadonlyArray<Board.Item>; readonly value: Board.Item | string | undefined } => {
            const fresh = items.find((i) => i.id === current.id);
            if (fresh === undefined) return { write: [], value: undefined };
            const followed = input.after_item_id !== undefined || input.state === "queued" ? stillFollowed(fresh) : undefined;
            if (followed !== undefined) return { write: [], value: followed };
            // Its Chief acting on it settles any question about it (the person answered, or it no longer matters).
            let next = Board.settle(fresh, now());
            next = Board.mission(next, mission, now());
            next = input.title !== undefined || input.project_ids !== undefined ? Board.sort(next, { ...(input.title ? { title: String(input.title) } : {}), ...(Array.isArray(input.project_ids) ? { project_ids: ids } : {}) }, now()) : next;
            if (input.after_item_id !== undefined) next = Board.block(next, { kind: "item", item_id: String(input.after_item_id) }, now());
            if (input.state === "queued") next = Board.requeue(next, now());
            if (input.state === "done") next = Board.done(next, now());
            if (input.state === "dropped") next = Board.drop(next, now());
            return { write: [next], value: next };
          });
          if (next === undefined) return yield* Effect.fail(new ChiefError(`No item ${current.id} on the board.`));
          if (typeof next === "string") return yield* Effect.fail(new ChiefError(next, "invalid_state"));
          return { ...(yield* itemReceipt(me, current.id)), state: next.state };
        }),
    ),
    tool("queue_drop", "Drop an item: it will not be done.", object({ item_id: str("The item.") }, ["item_id"]), (input, _call, me) =>
      item(me, input.item_id).pipe(Effect.flatMap((current) => one(me, current.id, (i) => Board.drop(i, now())).pipe(Effect.as({ item_id: current.id, state: "dropped" })))),
    ),
    tool(
      "queue_order",
      "Reorder the Queue: these items first, in this order. Items the person pinned keep their place.",
      object({ item_ids: strs("Item ids, first first.") }, ["item_ids"]),
      // Among its own items only: their slots trade places, every other Chief's stay put.
      (input, _call, me) =>
        write(me, "order", (items) => Board.orderByChief(items.filter((i) => i.chief_id === me.profile.id), Array.isArray(input.item_ids) ? input.item_ids.map(String) : [], now())).pipe(Effect.as("Reordered.")),
    ),
    tool(
      "chat_start",
      "Start chats for an item in your projects: one per entry of project_ids (repeat an id for several chats). In a project with several sources, sources picks the repositories they check out. The runtime may answer proposed (the person starts it) or blocked (a limit); report it, never work around it.",
      object(
        {
          item_id: str("The note's item."),
          project_ids: { type: "array", items: { type: "string" }, minItems: 1, description: "One of your projects' ids, once per chat: the project the work is in." },
          sources: strs("The sources of the first project named these chats check out, by name from the Projects section: only the ones the task needs (one for work in one repository, several for a change across them). Absent: the project's own repository alone."),
          title: str("The chat's title, a few words."),
          brief: str("What the chat gets instead of your conversation, in short labelled lines: goal, the check that means done, projects and starting files, constraints and decisions, what not to touch, and the person's words as they wrote them. The runtime adds how to report and ask."),
          quotes: strs("The person's own words this is for, each verbatim from their notes."),
          tier: { type: "string", enum: ["fast", "frontier"], description: "The chat's effort on the default new-chat model (Settings > General > New chats, Auto when offered): fast runs it low for chores, frontier high for hard work; absent: its default effort. Never picks the model." },
          attachments: strs("Images to hand the chat with its brief: ids from a note's <attachments> or a chat_update's proof=. The chat gets them as image input, its own copy. Always this, never a file path: the store is not the chat's to read, and the chat may run on another computer."),
        },
        ["project_ids", "title", "brief"],
      ),
      (input, call, me) =>
        Effect.gen(function* () {
          // A resumed turn replays the same call: it gets the first answer, never a second set of chats.
          const memo = call.idempotencyKey === undefined ? undefined : `chief.chat_start:${call.idempotencyKey}`;
          const answered = memo === undefined ? undefined : yield* store.kvGet(memo);
          if (answered !== undefined) return JSON.parse(answered) as unknown;
          const chosen = yield* projectIds(me, input.project_ids);
          if (chosen.length === 0) return yield* Effect.fail(new ChiefError("project_ids needs at least one project."));
          const sources = input.sources === undefined ? undefined : yield* sourcesNamed(chosen[0]!, input.sources);
          const quotes = Array.isArray(input.quotes) ? input.quotes.map(String) : [];
          // Only words the person typed to this Chief.
          const refusal = verifyQuotes(yield* board.of(me.profile.id), quotes);
          if (refusal) return yield* Effect.fail(new ChiefError(refusal));
          // Only images the person sent this Chief, checked before anything is made.
          const attachments = yield* noteImages(me, input.attachments);
          // A note's item, or a new one on the board for this work.
          const target =
            input.item_id === undefined
              ? yield* guarded(me, "add", (items) => {
                  const added = Board.add(items, { id: `ci-${randomUUID().slice(0, 8)}`, chief_id: me.profile.id, text: String(input.title), title: String(input.title), source: "chief", state: "queued", project_ids: chosen }, now());
                  return { write: [added], value: added };
                })
              : yield* item(me, input.item_id);
          const proposal: Board.Proposal = {
            project_ids: chosen,
            ...(sources === undefined ? {} : { sources }),
            brief: String(input.brief),
            title: String(input.title).slice(0, 120),
            quotes,
            ...(input.tier === "fast" || input.tier === "frontier" ? { tier: input.tier } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            run_id: call.runId,
          };
          // Each chat it starts stores the quotes as the person's words there (createWorkspace's `from`).
          const admitted = yield* ctx.admit(target.id, proposal, false);
          // Keep the admission state/reason intact. Each child gets its own link even when several share an item.
          const result = admitted && typeof admitted === "object" && "item_id" in admitted && typeof admitted.item_id === "string"
            ? {
                ...admitted,
                ...(yield* itemReceipt(me, admitted.item_id)),
                ...("chats" in admitted && Array.isArray(admitted.chats) ? { chats: admitted.chats.map((c: { workspace_id: string }) => ({ ...c, chat_ref: `[[chat:${c.workspace_id}]]` })) } : {}),
              }
            : admitted;
          // ponytail: one settings key per durable chat_start, never pruned; prune by age if it ever matters.
          if (memo !== undefined) yield* store.kvSet(memo, JSON.stringify(result));
          return result;
        }),
    ),
    tool(
      "chat_send",
      "Send one of your chats a message from you, running or finished: steer goes into its running turn (a finished chat starts its next turn with it), queue waits for its next one. A chat chat_search marks not_on_your_board goes on your board with it.",
      object(
        {
          workspace_id: str("The chat."),
          text: str("What it should do, then why, in a sentence or two it can act on alone."),
          mode: { type: "string", enum: ["steer", "queue"] },
          attachments: strs("Images to send with it: ids from a note's <attachments> or a chat_update's proof=. The chat gets them as image input, its own copy. Always this, never a file path."),
        },
        ["workspace_id", "text", "mode"],
      ),
      (input, call, me) =>
        Effect.gen(function* () {
          const target = yield* store.getWorkspace(String(input.workspace_id));
          if (target === undefined || target.workspace.kind === "chief") return yield* Effect.fail(new ChiefError(`No chat ${String(input.workspace_id)}.`));
          const reach = yield* ctx.messageable(me, target);
          if (reach === "no") return yield* Effect.fail(new ChiefError(`${String(input.workspace_id)} is not a chat you started or one the person pointed you at.`));
          if (yield* ctx.overCap) return yield* Effect.fail(new ChiefError(ctx.capReason));
          const images = yield* imagesInline(yield* noteImages(me, input.attachments));
          // A message from it would cancel the person's grill round (a person's message ends an open round).
          const open = yield* openAsk(store, target);
          if (open?.ask.kind === "question" && open.ask.round !== undefined) return yield* Effect.fail(new ChiefError(`${target.workspace.title} is in a grill round with the person: it waits for them.`));
          // A chat the person started, at autonomy 2 or 3: on this Chief's board first, so the turn this starts reports here.
          if (reach === "adopt") yield* ctx.adopt(me, target.workspace.id);
          const sent = yield* ctx.deps.submit(target, {
            request_id: `chief-send:${call.idempotencyKey ?? call.callId}`,
            kind: input.mode === "queue" ? "queue" : "steer",
            input: { text: String(input.text), ...(images.length > 0 ? { attachments: images } : {}) },
            from: me.record,
          });
          yield* settleChat(me, target.workspace.id);
          return { workspace_id: target.workspace.id, disposition: sent.disposition, ...(reach === "adopt" ? { added_to_your_board: true } : {}) };
        }),
    ),
    tool("chat_digest", "A chat's state, goal and latest answer: any chat in your projects. Only to answer the person; the board already says where your chats stand.", object({ workspace_id: str("The chat.") }, ["workspace_id"]), (input, _call, me) =>
      Effect.gen(function* () {
        const target = yield* readable(me, input.workspace_id);
        const digest = yield* ctx.deps.digest(target);
        // Outside content in that chat: the Chief may not remember from an older note after reading it.
        if (Option.isSome(ctx.deps.memory) && (yield* ctx.deps.memory.value.tainted(target.internal.threadId))) yield* ctx.markTainted(me);
        return { workspace_id: target.workspace.id, title: target.workspace.title, status: target.workspace.status, ...digest };
      }),
    ),
    tool(
      "chat_search",
      "Find a chat by what it is about, when a note names one by its topic (\"the windows session\", \"the onboarding PR\") and no board line plainly matches: its title, key terms, goal, latest ask, branch and latest answer, idle chats and the person's own chats in your projects too. The best five, each with its goal and whether you may message it.",
      object({ query: str("Words from its topic: a platform, feature, file, repository or pull request.") }, ["query"]),
      (input, _call, me) => ctx.searchChats(me, String(input.query ?? "")),
    ),
    tool("chat_stop", "Stop a chat's running turn (its delegated agents stop too).", object({ workspace_id: str("The chat.") }, ["workspace_id"]), (input, call, me) =>
      Effect.gen(function* () {
        const target = yield* chat(me, input.workspace_id);
        yield* ctx.deps.interrupt(target, `chief-stop:${call.idempotencyKey ?? call.callId}`);
        return { workspace_id: target.workspace.id, stopped: true };
      }),
    ),
    tool(
      "remember",
      "Save something the person told you as their own (Told) memory note: in user/ for everything, or in one of your projects' repository. quote must be their exact words, and the note must read the way they said it: one that says no, never or don't needs a quote that does (else the quote itself is kept as the note). A note about the person (no repo) is in your prefix from your next turn.",
      object({ text: str("The note, as it should stay true, in the same polarity as the quote (a note that says no, never or don't needs a quote that does)."), quote: str("The person's exact words it comes from: a verbatim run of one note, on the note's topic."), repo: str("The id of one of your projects, for a note about its repository; absent: about the person.") }, ["text", "quote"]),
      (input, call, me) =>
        Effect.gen(function* () {
          if (ctx.remember === undefined) return yield* Effect.fail(new ChiefError("Memory is off on this runtime."));
          const quote = String(input.quote);
          // Only words the person typed to this Chief.
          const items = yield* board.of(me.profile.id);
          // Tainted some other way with no stamp yet (memory saw it first): from now on, then.
          if ((yield* ctx.taintedSince(me)) === undefined && Option.isSome(ctx.deps.memory) && (yield* ctx.deps.memory.value.tainted(me.record.internal.threadId))) yield* ctx.markTainted(me);
          const since = yield* ctx.taintedSince(me);
          // After a report with outside content, only a note the person typed since then counts.
          const fresh = since === undefined ? items : items.filter((i) => Date.parse(i.created_at) > since);
          const refusal = verifyQuotes(fresh, [quote]);
          if (refusal) return yield* Effect.fail(new ChiefError(since === undefined ? refusal : `${refusal} You read a chat with outside content, so only words typed since then count.`));
          const [repo] = input.repo ? yield* projectIds(me, [input.repo]) : [];
          return yield* ctx.remember(me, { text: String(input.text), quote, ...(repo ? { repo } : {}), runId: call.runId });
        }),
    ),
    tool(
      "ask",
      "Ask the person one question, with the answer you recommend. Unless must_wait, you go ahead with it after the person's wait (a <no_answer> line tells you). Then end your turn: their answer arrives as the next note.",
      object(
        {
          question: str("The question, standing on its own: one sentence that names the choice."),
          recommended: str("The answer you recommend, as you would act on it."),
          item_id: str("The item it holds up. Without one, nothing goes ahead by itself."),
          workspace_id: str("The chat whose question this is, when you pass on a chat's question."),
          ask_id: str("That chat's question card (ask=… in its update), when it raised one."),
          must_wait: { type: "boolean", description: "True when only the person can settle it, or going ahead could not be undone: it waits for them however long it takes." },
        },
        ["question", "recommended"],
      ),
      (input, _call, me) =>
        Effect.gen(function* () {
          const manage = input.must_wait !== true && (yield* ctx.autonomy(me)) === 3;
          if (input.item_id === undefined && !manage) return "Asked. End your turn now; the answer arrives as the next note.";
          const current = input.item_id === undefined ? undefined : yield* item(me, input.item_id);
          const target = input.workspace_id === undefined ? undefined : yield* chat(me, input.workspace_id);
          const open = target === undefined ? undefined : yield* openAsk(store, target);
          if (input.ask_id !== undefined && (target === undefined || open?.id !== String(input.ask_id))) {
            return yield* Effect.fail(new ChiefError(`No open question card ${String(input.ask_id)}${target === undefined ? ": name its chat (workspace_id)" : ` in ${target.workspace.title}`}.`));
          }
          // What only the person answers (an approval, a secret, a grill round) never goes ahead without them.
          const theirs = personOnly(open) !== undefined;
          // Autonomy 3 (manage): a question the Chief may settle itself goes ahead now, with nothing put to the person.
          if (manage && !theirs) {
            const there = target === undefined ? "" : input.ask_id === undefined ? " It is the chat's question: send the answer there with chat_send (steer)." : ` It is the chat's question card: answer it with chat_answer (ask ${String(input.ask_id)}).`;
            return `Not asked: your autonomy is level 3, so go ahead now with the answer you recommended: ${String(input.recommended)}.${there} Ask with must_wait only what is the person's (see Autonomy).`;
          }
          if (current === undefined) return "Asked. End your turn now; the answer arrives as the next note.";
          const minutes = yield* ctx.askWaitMinutes;
          const at = now();
          const goAhead = input.must_wait === true || theirs || minutes <= 0 ? undefined : new Date(Date.parse(at) + minutes * 60_000).toISOString();
          const asked: Board.Asked = {
            question: String(input.question),
            recommended: String(input.recommended),
            asked_at: at,
            ...(goAhead === undefined ? {} : { go_ahead_at: goAhead }),
            ...(target === undefined ? {} : { workspace_id: target.workspace.id }),
            ...(input.ask_id === undefined ? {} : { ask_id: String(input.ask_id) }),
          };
          yield* one(me, current.id, (i) => Board.ask(i, asked, at));
          return goAhead === undefined
            ? "Asked; it waits for the person. End your turn now; the answer arrives as the next note."
            : `Asked. Unless the person answers first, you go ahead with your recommended answer at ${Board.clock(goAhead)}. End your turn now; the answer arrives as the next note.`;
        }),
    ),
    tool(
      "chat_answer",
      "Answer a chat's question card (ask=… in its update) for the person, when their notes, your soul, memory or the board settle it. Never an approval or a secret: those are the person's.",
      object(
        {
          workspace_id: str("The chat."),
          ask_id: str("Its question card."),
          answers: {
            type: "array",
            minItems: 1,
            description: "One per question you answer.",
            items: object({ question_id: str("The question's id, in [ ] in the update."), option_ids: strs("The options you pick, by id."), text: str("Your answer in words: what you pick and why, or a free answer.") }, ["question_id"]),
          },
        },
        ["workspace_id", "ask_id", "answers"],
      ),
      (input, call, me) =>
        Effect.gen(function* () {
          const target = yield* chat(me, input.workspace_id);
          if (yield* ctx.overCap) return yield* Effect.fail(new ChiefError(ctx.capReason));
          const open = yield* openAsk(store, target);
          if (open === undefined || open.id !== String(input.ask_id)) return yield* Effect.fail(new ChiefError(`${target.workspace.title} waits on no question card ${String(input.ask_id)}: it was answered or withdrawn.`));
          // Only a plain question: an approval, a secret or a grill round waits for the person, whatever the Chief says.
          const card = questionCard(open);
          if (card === undefined) {
            const what = { question: "a grill round", approval: "an approval", secret: "a secret request", tool: "a tool call for the person's app" }[open.ask.kind];
            return yield* Effect.fail(new ChiefError(`${String(input.ask_id)} is ${what}: only the person answers it.`));
          }
          const given = (Array.isArray(input.answers) ? input.answers : []) as ReadonlyArray<{ question_id?: unknown; option_ids?: unknown; text?: unknown }>;
          const answers = [];
          for (const q of card.questions) {
            const a = given.find((g) => String(g.question_id) === q.id);
            if (a === undefined) return yield* Effect.fail(new ChiefError(`Answer every question on the card: ${q.id} has no answer.`));
            const picked = Array.isArray(a.option_ids) ? a.option_ids.map(String) : [];
            const unknown = picked.find((id) => !q.options.some((o) => o.id === id));
            if (unknown !== undefined) return yield* Effect.fail(new ChiefError(`${unknown} is no option of ${q.id}: pick from ${q.options.map((o) => o.id).join(", ")}.`));
            if (!q.multi_select && picked.length > 1) return yield* Effect.fail(new ChiefError(`${q.id} takes one option.`));
            const words = typeof a.text === "string" && a.text.trim() !== "" ? a.text.trim() : undefined;
            if (words !== undefined && !q.allow_text && picked.length === 0) return yield* Effect.fail(new ChiefError(`${q.id} takes only its options: pick from ${q.options.map((o) => o.id).join(", ")}.`));
            if (picked.length === 0 && words === undefined) return yield* Effect.fail(new ChiefError(`${q.id} needs an option or words.`));
            // Where the card takes words, the chat reads what was picked and that its Chief (not the person) answered;
            // where it takes only its options, the options go alone (the brief told the chat its Chief may answer).
            const labels = picked.map((id) => q.options.find((o) => o.id === id)!.label);
            const text = `${[...labels, ...(words === undefined ? [] : [words])].join(": ")} (answered by ${me.profile.name}, your Chief, not the person)`;
            answers.push({ question_id: q.id, option_ids: picked, ...(q.allow_text ? { text } : {}) });
          }
          yield* ctx.deps.respond(target, open.id, { kind: "question", answers }, `chief-answer:${call.idempotencyKey ?? call.callId}`);
          yield* settleChat(me, target.workspace.id);
          return { workspace_id: target.workspace.id, answered: open.id };
        }),
    ),
    tool(
      "memory_sql",
      MEMORY_SQL_DESCRIPTION,
      object({ sql: str("One SELECT."), params: { type: "array", description: "Positional parameters." } }, ["sql"]),
      (input, _call, me) =>
        Effect.gen(function* () {
          if (Option.isNone(ctx.deps.memory)) return yield* Effect.fail(new ChiefError("Memory is off on this runtime."));
          const sql = String(input.sql);
          const output = yield* ctx.deps.memory.value.query(me.record.internal.threadId, sql, Array.isArray(input.params) ? input.params : []);
          // Unverified notes are outside content: reading them is a tainted report.
          if (/\bunverified\b/i.test(sql)) yield* ctx.markTainted(me);
          return output;
        }),
    ),
    tool(
      "schedule",
      "Hold an item that waits until a time: then it is due and you are woken (a check-in, or a timed start). Not one whose chats run: you are woken as they move.",
      object({ item_id: str("The item."), at: str("When, as an ISO 8601 date and time.") }, ["item_id", "at"]),
      (input, _call, me) =>
        Effect.gen(function* () {
          const current = yield* item(me, input.item_id);
          const at = Date.parse(String(input.at));
          if (!Number.isFinite(at)) return yield* Effect.fail(new ChiefError(`${String(input.at)} is not a date and time.`));
          const when = new Date(at).toISOString();
          const refused = yield* guarded(me, "chief", (items) => {
            const fresh = items.find((i) => i.id === current.id);
            if (fresh === undefined) return { write: [], value: `No item ${current.id} on the board.` };
            const followed = stillFollowed(fresh);
            return followed !== undefined ? { write: [], value: followed } : { write: [Board.schedule(fresh, when, now())], value: undefined };
          });
          if (refused !== undefined) return yield* Effect.fail(new ChiefError(refused, "invalid_state"));
          return { item_id: current.id, not_before: when };
        }),
    ),
    // Smart View (view.ts, session-protocol smartView.ts): the person's sidebar beside this chat.
    tool(
      "view_open",
      "Open something in the person's sidebar beside your chat, when seeing it beats reading about it: a pull request ready for review (its guide), a chat they should look at, a screenshot or clip, a page to try. At most one per result, never for progress. The runtime decides how: it never moves what they are reading (it adds a tab that pulses instead), never reopens what they closed, and holds back a burst; the answer says what happened.",
      object(
        {
          kind: { type: "string", enum: ["pr", "chat", "image", "video", "web"], description: "pr: a pull request; chat: one of your chats; image, video: a picture or clip; web: a page." },
          project_id: str("pr: its project, by id."),
          number: { type: "integer", description: "pr: its number." },
          view: { type: "string", enum: ["guide", "discussion", "files"], description: "pr: where it opens; default its guide." },
          workspace_id: str("chat: the chat. image, video: the chat whose checkout has `path`."),
          path: str("image, video: the file, in that chat's checkout."),
          url: str("web: the page (http or https; a local dev server is fine). image, video: its address, instead of a path."),
          title: str("Its tab's name, a few words; default the PR number, the chat's title, the file or the host."),
          note: str("One line on why it is worth a look."),
          asked: { type: "boolean", description: "True only when the person asked to see it in their latest note: it then comes to the front." },
        },
        ["kind"],
      ),
      (input, call, me) =>
        Effect.gen(function* () {
          const { item, title } = yield* viewItem(me, input);
          const { admission, askedIgnored } = yield* ctx.view.open(me.profile.id, { item, title, note: typeof input.note === "string" ? input.note : undefined, asked: input.asked === true }, call.runId);
          const said = viewSaid(admission);
          // Only a turn the person's own note started may say they asked, once; this open was treated as unasked.
          return askedIgnored ? { ...said, asked: false, said: `${said.said} (asked counts only once, in the turn the person's note started: treated as not asked.)` } : said;
        }),
    ),
    tool(
      "view_close",
      "Tidy up something you opened in the person's sidebar (its id from view_open or view_list) that no longer matters: replaced or superseded. Only a tab they never looked at closes; one they looked at stays theirs until they close it.",
      object({ id: str("The id view_open answered.") }, ["id"]),
      (input, _call, me) =>
        Effect.gen(function* () {
          // Allowed while Smart View is off: tidying up never adds anything.
          const view = yield* ctx.view.get(me.profile.id);
          const id = String(input.id);
          if (!view.entries.some((e) => e.id === id && e.state === "open")) return yield* Effect.fail(new ChiefError(`Nothing of yours is open as ${id}: view_list says what is.`, "not_found"));
          yield* ctx.view.close(me.profile.id, id, "chief");
          return { closed: true, id };
        }),
    ),
    tool("view_list", "What you have open in the person's sidebar, and what they closed lately (leave those closed).", object({}, []), (_input, _call, me) =>
      ctx.view.get(me.profile.id).pipe(
        Effect.map((view) => ({
          smart_view: view.on ? "on" : "off",
          open: view.entries.filter((e) => e.state === "open").map((e) => ({ id: e.id, kind: e.item.kind, title: e.title, opened_at: e.opened_at, ...(e.note === undefined ? {} : { note: e.note }) })),
          closed_by_person: view.entries.filter((e) => e.closed_by === "person").map((e) => ({ id: e.id, title: e.title, closed_at: e.closed_at })),
        })),
      ),
    ),
    // What only some turns need, out of the prefix (prompt.ts PLAYBOOKS): read when a turn calls for it.
    tool(
      "playbook",
      "Read a playbook: how to handle one kind of turn. Your Playbooks list says when to read which, and an update that needs one names it.",
      object({ name: { type: "string", enum: PLAYBOOK_NAMES, description: "Which playbook." } }, ["name"]),
      (input) => {
        const name = String(input.name);
        return Object.hasOwn(PLAYBOOKS, name) ? Effect.succeed(PLAYBOOKS[name as PlaybookName]) : Effect.fail(new ChiefError(`No playbook ${name}: one of ${PLAYBOOK_NAMES.join(", ")}.`, "invalid_params"));
      },
    ),
    tool(
      "react",
      "Acknowledge a person's note that needs no words (queued, started or noted) with a reaction instead of a sentence. Never both.",
      object({ item_id: str("The note's item on your board."), emoji: { type: "string", enum: ["👍", "👀", "✅", "❤️"] } }, ["item_id", "emoji"]),
      (input, _call, me) =>
        Effect.gen(function* () {
          const note = yield* item(me, input.item_id);
          const emoji = input.emoji;
          if (emoji !== "👍" && emoji !== "👀" && emoji !== "✅" && emoji !== "❤️") return yield* Effect.fail(new ChiefError("Choose 👍, 👀, ✅ or ❤️.", "invalid_params"));
          const session = note.sent_in ?? note.heard_in;
          if (!Board.TYPED_SOURCES.has(note.source) || !note.delivered || note.sent_as === undefined || session === undefined)
            return yield* Effect.fail(new ChiefError("That note has no delivered message to react to.", "invalid_state"));
          const heard = yield* store.getBySession(session);
          if (heard === undefined) return yield* Effect.fail(new ChiefError("That note's conversation is no longer here.", "not_found"));
          const moment = { kind: "reaction", item_id: note.id, message_id: submittedMessageId(session, note.sent_as), emoji } as const;
          const written = yield* writeMoment(store, heard, moment, momentTitle(moment, ""));
          return { reacted: true, written, message_id: moment.message_id, emoji };
        }),
    ),
  ];
};
