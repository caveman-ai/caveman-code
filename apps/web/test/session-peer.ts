// A scripted Caveman Code runtime for browser tests: it speaks Session Protocol v1 over the fake socket
// (fake-socket.ts) from fixtures (fixtures.ts), and a test plays the engine's side by emitting session events.
//
// It holds the contract both ways, as the real runtime's server does (packages/runtime session-protocol/server.ts):
// a call whose params do not decode against `Methods` is refused `invalid_params` and recorded as a violation, and an
// answer, notification or event a fixture got wrong is recorded too. mountApp fails the test on any violation, so a
// fixture cannot drift from the protocol and the client cannot send what the runtime would refuse.
//
// A method nobody scripted answers `-32601` method not found, as a runtime from before it would, which the app is
// built to read; `unscripted` lists them.
import {
  ErrorCodes,
  Methods,
  Notifications,
  SessionEvent as SessionEventSchema,
  type ErrorReason,
  type MethodName,
  type NotificationName,
  type NotificationParams,
  type Params,
  type Result,
  type Session,
  type SessionEvent,
  type Workspace,
} from "@caveman-app/session-protocol";
import * as Schema from "effect/Schema";
import type { FakeSocket, SocketPeer } from "./fake-socket.ts";
import { AT, chief as chiefProfile, workspace, type RuntimeFixture } from "./fixtures.ts";

/** A call as the runtime received it. */
export interface PeerCall<M extends MethodName = MethodName> {
  readonly method: M;
  readonly params: Params<M>;
}

/** Refuse a call the way the runtime does: `throw new PeerError("invalid_state", "...")` from a handler. */
export class PeerError extends Error {
  readonly reason: ErrorReason;
  constructor(reason: ErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

type Handler<M extends MethodName> = (
  params: Params<M>,
  socket: FakeSocket,
) => Result<M> | Promise<Result<M>>;
type AnyHandler = (params: never, socket: FakeSocket) => unknown;

/** An event as a test writes it: the peer stamps the session, cursor and (unless given) the time. */
export type EventDraft = (SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, "session_id" | "cursor" | "at">
    : never
  : never) & { readonly at?: string };

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown>)(value)._tag === "Success";

export class SessionPeer implements SocketPeer {
  readonly workspaces = new Map<string, Workspace>();
  readonly journals = new Map<string, { session: Session; events: SessionEvent[] }>();
  readonly calls: PeerCall[] = [];
  /** Methods the app called that no fixture or test answered (they got method not found). */
  readonly unscripted = new Set<string>();
  /** Contract breaks, either side's: mountApp fails the test on any. */
  readonly violations: string[] = [];
  readonly sockets = new Set<FakeSocket>();
  private readonly attached = new Map<FakeSocket, Set<string>>();
  private readonly handlers = new Map<MethodName, AnyHandler>();
  private readonly listeners = new Set<(call: PeerCall) => void>();
  private nextId = 1;

  readonly fixture: RuntimeFixture;

  constructor(fixture: RuntimeFixture) {
    this.fixture = fixture;
    for (const w of fixture.workspaces) this.addWorkspace(w, fixture.events?.[w.id] ?? []);
    this.installDefaults();
  }

  // ------------------------------------------------------------------ scripting

  /** Answers `method` with `handler` from now on (replacing the default). */
  on<M extends MethodName>(method: M, handler: Handler<M>): this {
    this.handlers.set(method, handler as AnyHandler);
    return this;
  }

  /**
   * The next `method` call stays unanswered until the test settles it: a turn.submit in flight, a slow search. Later
   * calls go to the handler as before.
   */
  hold<M extends MethodName>(
    method: M,
  ): {
    readonly call: Promise<PeerCall<M>>;
    answer(result: Result<M>): void;
    refuse(reason: ErrorReason, message: string): void;
  } {
    const previous = this.handlers.get(method);
    let settle!: { resolve: (r: Result<M>) => void; reject: (e: unknown) => void };
    let seen!: (call: PeerCall<M>) => void;
    const call = new Promise<PeerCall<M>>((resolve) => (seen = resolve));
    this.handlers.set(method, ((params: Params<M>) => {
      if (previous) this.handlers.set(method, previous);
      else this.handlers.delete(method);
      seen({ method, params });
      return new Promise<Result<M>>((resolve, reject) => (settle = { resolve, reject }));
    }) as AnyHandler);
    return {
      call,
      answer: (result) => settle.resolve(result),
      refuse: (reason, message) => settle.reject(new PeerError(reason, message)),
    };
  }

  /** Calls of `method` so far, oldest first. */
  callsOf<M extends MethodName>(method: M): Array<PeerCall<M>> {
    return this.calls.filter((c): c is PeerCall<M> => c.method === method);
  }

  /** The first call of `method` (matching `where`) made so far or from now on. */
  nextCall<M extends MethodName>(
    method: M,
    where: (params: Params<M>) => boolean = () => true,
  ): Promise<PeerCall<M>> {
    const made = this.callsOf(method).find((c) => where(c.params));
    if (made) return Promise.resolve(made);
    return new Promise((resolve) => {
      const listener = (c: PeerCall) => {
        if (c.method !== method || !where(c.params as Params<M>)) return;
        this.listeners.delete(listener);
        resolve(c as PeerCall<M>);
      };
      this.listeners.add(listener);
    });
  }

  /**
   * Appends events to a chat's journal and sends them to every connection attached to it, stamped now as the runtime
   * stamps what an engine does (the app treats an event from minutes ago as history, not news).
   */
  emit(workspaceId: string, ...drafts: EventDraft[]): SessionEvent[] {
    const journal = this.journalOf(workspaceId);
    const now = new Date().toISOString();
    const events = drafts.map((draft) => {
      const event = {
        at: now,
        ...draft,
        session_id: journal.session.id,
        cursor: journal.events.length + 1,
      } as SessionEvent;
      if (!decodes(SessionEventSchema, event))
        this.violations.push(`fixture event does not match SessionEvent: ${JSON.stringify(event)}`);
      journal.events.push(event);
      return event;
    });
    journal.session = { ...journal.session, head: journal.events.length };
    for (const [socket, sessions] of this.attached) {
      if (!sessions.has(journal.session.id)) continue;
      for (const event of events)
        this.send(socket, { jsonrpc: "2.0", method: "session.event", params: event });
    }
    return events;
  }

  /** A workspace changed (status, title, activity): stored, and pushed to every connection as the runtime does. */
  change(workspaceId: string, patch: Partial<Workspace>): Workspace {
    const next = {
      ...this.workspace(workspaceId),
      ...patch,
      updated_at: patch.updated_at ?? new Date().toISOString(),
    } as Workspace;
    this.workspaces.set(workspaceId, next);
    this.notify("workspace.changed", next);
    return next;
  }

  notify<N extends NotificationName>(name: N, params: NotificationParams<N>): void {
    if (!decodes(Notifications[name], params))
      this.violations.push(
        `fixture ${name} does not match the protocol: ${JSON.stringify(params)}`,
      );
    for (const socket of this.sockets) this.send(socket, { jsonrpc: "2.0", method: name, params });
  }

  workspace(id: string): Workspace {
    const w = this.workspaces.get(id);
    if (!w) throw new Error(`no fixture workspace ${id}`);
    return w;
  }

  /** The chat's journal, by workspace id. */
  journalOf(workspaceId: string): { session: Session; events: SessionEvent[] } {
    const journal = this.journals.get(this.workspace(workspaceId).session_id);
    if (!journal) throw new Error(`no journal for ${workspaceId}`);
    return journal;
  }

  addWorkspace(w: Workspace, events: ReadonlyArray<EventDraft> = []): void {
    this.workspaces.set(w.id, w);
    const session: Session = {
      id: w.session_id,
      workspace_id: w.id,
      engine: w.engine,
      state: "live",
      head: 0,
      created_at: w.created_at,
      updated_at: w.updated_at,
    };
    this.journals.set(w.session_id, { session, events: [] });
    // A chat's history happened before the app opened it.
    if (events.length > 0) this.emit(w.id, ...events.map((e) => ({ at: AT, ...e }) as EventDraft));
  }

  // ------------------------------------------------------------------ the socket's far end

  opened(socket: FakeSocket): void {
    this.sockets.add(socket);
    this.attached.set(socket, new Set());
  }

  closed(socket: FakeSocket): void {
    this.sockets.delete(socket);
    this.attached.delete(socket);
  }

  received(socket: FakeSocket, frame: string): void {
    const message = JSON.parse(frame) as { id?: number; method?: string; params?: unknown };
    if (message.id === undefined || typeof message.method !== "string") return;
    const { id, method } = message;
    if (!Object.hasOwn(Methods, method))
      return this.refuse(socket, id, -32601, `unknown method ${method}`);
    const name = method as MethodName;
    const params = (message.params ?? {}) as never;
    if (!decodes(Methods[name].params, params)) {
      this.violations.push(`the app sent ${name} params the runtime refuses: ${frame}`);
      return this.refuse(
        socket,
        id,
        ErrorCodes.invalid_params,
        `params do not match ${name}`,
        "invalid_params",
      );
    }
    const call = { method: name, params } as PeerCall;
    this.calls.push(call);
    for (const listener of [...this.listeners]) listener(call);
    const handler = this.handlers.get(name);
    if (!handler) {
      this.unscripted.add(name);
      return this.refuse(socket, id, -32601, `unknown method ${name}`);
    }
    void (async () => {
      try {
        const result = await handler(params, socket);
        if (!decodes(Methods[name].result, result))
          this.violations.push(
            `fixture answer to ${name} does not match the protocol: ${JSON.stringify(result)}`,
          );
        this.send(socket, { jsonrpc: "2.0", id, result });
        if (name === "session.attach") this.backlog(socket, params as Params<"session.attach">);
      } catch (error) {
        if (error instanceof PeerError)
          return this.refuse(socket, id, ErrorCodes[error.reason], error.message, error.reason);
        this.violations.push(`handler for ${name} threw: ${String(error)}`);
        this.refuse(socket, id, ErrorCodes.internal, "the runtime failed this call", "internal");
      }
    })();
  }

  private send(socket: FakeSocket, frame: unknown): void {
    socket.deliver(JSON.stringify(frame));
  }

  private refuse(
    socket: FakeSocket,
    id: number,
    code: number,
    message: string,
    reason?: ErrorReason,
  ): void {
    this.send(socket, {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(reason ? { data: { reason } } : {}) },
    });
  }

  /** session.attach answers first, then sends what came after the client's cursor as one batch (`batch: true`). */
  private backlog(socket: FakeSocket, params: Params<"session.attach">): void {
    const journal = this.journals.get(params.session_id);
    if (!journal) return;
    this.attached.get(socket)?.add(params.session_id);
    const events = journal.events.filter((e) => e.cursor > params.cursor);
    if (events.length > 0)
      this.send(socket, {
        jsonrpc: "2.0",
        method: "session.events",
        params: { session_id: params.session_id, events },
      });
  }

  // ------------------------------------------------------------------ what a runtime answers by default

  private installDefaults(): void {
    const f = this.fixture;
    const list = (p: Params<"workspace.list">) =>
      [...this.workspaces.values()].filter(
        (w) =>
          (p.include_archived || w.status !== "archived") &&
          (p.parent_workspace_id === undefined || w.parent_workspace_id === p.parent_workspace_id),
      );
    this.on("workspace.list", (p) => ({ workspaces: list(p) }));
    // A Chief's own chat has the Chief's id: one the fixture lists is answered as it is, else as chief.get answers it.
    this.on("workspace.get", (p) => {
      const chief = this.workspaces.has(p.workspace_id)
        ? undefined
        : f.chiefs?.find((c) => c.id === p.workspace_id);
      return chief
        ? workspace(chief.id, { kind: "chief", title: chief.name })
        : this.workspace(p.workspace_id);
    });
    this.on("engine.list", () => ({ engines: [...f.engines] }));
    this.on("settings.get", () => f.settings);
    this.on(
      "settings.set",
      (p) => (f.settings = { ...f.settings, ...p.settings } as typeof f.settings),
    );
    this.on("project.list", () => ({ projects: [...f.projects] }));
    if (f.chiefs) {
      const chiefs = f.chiefs;
      this.on("chief.list", () => ({ chiefs: [...chiefs] }));
      // A Chief's own chat (its id is the Chief's, as the runtime's is), its profile and the shared board; no calls.
      this.on("chief.get", (p) => {
        let chief = chiefs.find((c) =>
          p.chief_id
            ? c.id === p.chief_id
            : p.project_id
              ? c.project_id === p.project_id && c.project_default
              : c.home,
        );
        // Naming neither, a runtime with no home Chief answers with a project's default (the latest project's, there).
        if (!chief && !p.chief_id && !p.project_id) chief = chiefs.find((c) => c.project_default);
        // A project's default Chief is made the first time it is asked for, named after the project.
        const project = f.projects.find((x) => x.id === p.project_id);
        if (!chief && !p.chief_id && project) {
          chief = chiefProfile(`c-${project.id}`, project.name, {
            project_id: project.id,
            project_default: true,
            project_ids: [project.id],
          });
          chiefs.push(chief);
          this.notify("chief.list.updated", { chiefs: [...chiefs] });
        }
        if (!chief)
          throw new PeerError("not_found", `no Chief ${p.chief_id ?? p.project_id ?? "home"}`);
        return {
          workspace: workspace(chief.id, { kind: "chief", title: chief.name }),
          chief,
          availability: "ready" as const,
          board: f.board ?? { items: [], change_sets: [] },
        };
      });
      // Another Chief, in `project_id` (its default when it has none yet), named "Chief N" unless named.
      this.on("chief.create", (p) => {
        const project = f.projects.find((x) => x.id === p.project_id);
        const first =
          project && !chiefs.some((c) => c.project_id === project.id && c.project_default);
        const chief = chiefProfile(
          `c-${chiefs.length + 1}`,
          p.name ?? `Chief ${chiefs.length + 1}`,
          {
            ...(project ? { project_id: project.id, project_ids: [project.id] } : {}),
            ...(first ? { project_default: true as const } : {}),
          },
        );
        chiefs.push(chief);
        this.notify("chief.list.updated", { chiefs: [...chiefs] });
        return { chief };
      });
    }
    if (f.automations) {
      const automations = f.automations;
      const find = (id: string) => {
        const a = automations.find((x) => x.id === id);
        if (!a) throw new PeerError("not_found", `no automation ${id}`);
        return a;
      };
      this.on("automation.list", (p) => ({
        automations: automations.filter((a) => !p.project_id || a.project_id === p.project_id),
      }));
      this.on("automation.set_enabled", (p) => {
        const next = { ...find(p.id), enabled: p.enabled };
        automations.splice(automations.indexOf(find(p.id)), 1, next);
        return next;
      });
      this.on("automation.run", (p) => ({ ...find(p.id), run_id: `run-${this.nextId++}` }));
      // A file's text is its path's, in the checkout named (a draft's `<project>@<branch>`).
      this.on("automation.file_read", (p) => ({ text: `# ${p.project_id}:${p.path}\n` }));
      // A file from text, on, as the person's own create makes it; a draft with that text is then the project's.
      this.on("automation.create", (p) => {
        if (!("text" in p.from))
          throw new PeerError("invalid_params", "templates are not scripted here");
        const name = p.from.name;
        const draft = automations.findIndex(
          (a) => a.worktree !== undefined && a.id.endsWith(`:${p.scope}:${name}`),
        );
        const { worktree: _, ...like } = automations[draft] ?? automations[0]!;
        const made = {
          ...like,
          id: `file:${p.project_id}:${p.scope}:${name}`,
          title: name,
          project_id: p.project_id,
          scope: p.scope,
          enabled: true,
        };
        automations.splice(draft === -1 ? automations.length : draft, draft === -1 ? 0 : 1, made);
        return { automation: made, written: [`.caveman/local/automations/${name}.yaml`] };
      });
    }
    this.on("keybindings.get", () => ({ keybindings: [] }));
    this.on("engine.commands", () => ({ commands: [...(f.commands ?? [])] }));
    this.on("fs.search", (p) => {
      const paths = (f.files ?? [])
        .filter((path) => path.toLowerCase().includes(p.query.toLowerCase()))
        .slice(0, p.limit ?? 50);
      return { paths, truncated: false };
    });
    this.on("session.attach", (p) => {
      const journal = this.journals.get(p.session_id);
      if (!journal) throw new PeerError("not_found", `no session ${p.session_id}`);
      return { session: journal.session, epoch: 1 };
    });
    this.on("session.detach", (p, socket) => {
      this.attached.get(socket)?.delete(p.session_id);
      return {};
    });
    this.on("workspace.inbox", (p) => {
      const w = this.workspace(p.workspace_id);
      // Done and reopen move the chat as the runtime's do, without bumping updated_at (inbox.ts withInbox).
      if (p.action.do === "done" || p.action.do === "reopen") {
        const { done_at: _, ...rest } = w.inbox ?? {};
        const inbox =
          p.action.do === "done" ? { ...rest, done_at: new Date().toISOString() } : rest;
        const { inbox: __, ...bare } = w;
        const next = (Object.keys(inbox).length > 0 ? { ...bare, inbox } : bare) as Workspace;
        this.workspaces.set(w.id, next);
        this.notify("workspace.changed", next);
        return next;
      }
      if (p.action.do !== "seen") return w;
      const next = { ...w, inbox: { ...w.inbox, visited_at: p.action.through } } as Workspace;
      this.workspaces.set(w.id, next);
      return next;
    });
    // The person's topic and its emoji: left out, the emoji stays while the name does (handlers.ts workspace.topic).
    this.on("workspace.topic", (p) => {
      const { topic: _, topic_icon: was, ...bare } = this.workspace(p.workspace_id);
      const icon =
        p.topic === null
          ? undefined
          : p.icon === undefined
            ? p.topic === this.workspace(p.workspace_id).topic
              ? was
              : undefined
            : (p.icon ?? undefined);
      const next = {
        ...bare,
        ...(p.topic === null ? {} : { topic: p.topic }),
        ...(icon ? { topic_icon: icon } : {}),
      } as Workspace;
      this.workspaces.set(next.id, next);
      this.notify("workspace.changed", next);
      return next;
    });
    this.on("workspace.prewarm", () => ({}));
    this.on("workspace.create", (p) => {
      const n = this.nextId++;
      const project = f.projects.find((pr) => "path" in p.repo && pr.path === p.repo.path);
      const now = new Date().toISOString();
      const { project_id: _, ...made } = workspace(`ws-new-${n}`, {
        session_id: `s-new-${n}`,
        title: p.task?.text.slice(0, 40) ?? "New chat",
        repo: p.repo,
        engine: p.engine ?? f.settings.default_engine,
        status: "working",
        created_at: now,
        updated_at: now,
      });
      const w: Workspace = { ...made, ...(project ? { project_id: project.id } : {}) };
      this.addWorkspace(
        w,
        p.task ? [{ type: "message.done", payload: { role: "user", text: p.task.text } }] : [],
      );
      this.notify("workspace.changed", w);
      return w;
    });
    this.on("turn.submit", (p) => ({
      turn_id: `turn-${this.nextId++}`,
      disposition: p.kind === "steer" ? "steered" : p.kind === "queue" ? "queued" : "started",
    }));
    this.on("turn.interrupt", () => ({}));
    this.on("ask.respond", () => ({}));
    this.on("queue.list", () => ({ turns: [] }));
    // Titles only, matched by their words, as the runtime's index finds them.
    this.on("chat.search", (p) => {
      const q = p.query.toLowerCase();
      const chats = [...this.workspaces.values()].flatMap((workspace) => {
        const start = workspace.title.toLowerCase().indexOf(q);
        if (start < 0 || q === "") return [];
        const passage = {
          kind: "title" as const,
          cursor: 0,
          at: workspace.updated_at,
          text: workspace.title,
          marks: [{ start, end: start + q.length }],
          by: "words" as const,
        };
        return [{ workspace, passages: [passage], more: 0 }];
      });
      return { chats, indexing: false, meaning: "unavailable" as const };
    });
  }
}
