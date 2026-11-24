// Session Protocol values and a fake link for `caveman-code mcp`'s unit tests: a small world of chats, projects and
// engines that answers the calls the tools make, records them, and pushes workspace.changed as the runtime would.
import type {
  EngineDescriptor,
  MethodName,
  OutsideAgentLevel,
  Params,
  Project,
  Workspace,
  WorkspaceDigest,
} from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";

import type { Acquired, AgentClient, AgentLink } from "./connection.ts";

export const AT = "2026-10-31T12:00:00.000Z";
export const NOW = Date.parse(AT);
export const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

export const workspace = (over: Partial<Workspace> & { readonly id: string }): Workspace => ({
  title: `Chat ${over.id}`,
  repo: { path: "/code/app" },
  base_ref: "main",
  branch: `caveman/${over.id}`,
  engine: "claude-agent",
  computer: { id: "this-mac", kind: "this_mac", label: "This Mac", status: "online" },
  session_id: `s-${over.id}`,
  status: "idle",
  project_id: "p1",
  created_at: minutesAgo(30),
  updated_at: minutesAgo(5),
  // An idle chat in these tests finished a turn, unless a test says otherwise (activity: {} is a chat with none yet).
  ...((over.status ?? "idle") === "idle" && over.activity === undefined ? { activity: { last_outcome: "completed" as const } } : {}),
  ...over,
});

const CAPABILITIES: EngineDescriptor["capabilities"] = {
  structured: true,
  fork: true,
  steer: true,
  interrupt: true,
  tool_hooks: true,
  resume_across_machines: false,
  approvals: true,
  plans: true,
  subagents: true,
  images: true,
  mcp: true,
};

export const engine = (over: Partial<EngineDescriptor> & { readonly id: EngineDescriptor["id"]; readonly label: string }): EngineDescriptor => ({
  capabilities: CAPABILITIES,
  models: [{ id: "opus", label: "Opus", efforts: ["low", "medium", "high"], default_effort: "high" }],
  auth: { state: "signed_in", accounts: [] },
  ...over,
});

export const project = (over: Partial<Project> & { readonly id: string; readonly name: string; readonly path: string }): Project => ({
  created_at: minutesAgo(600),
  updated_at: minutesAgo(600),
  ...over,
});

export const rpcError = (reason: string, message: string, code = -32004) => new SessionProtocolError({ code, message, data: { reason: reason as never } });

type Handler = (params: Record<string, unknown>) => unknown;

/** A world the tools can operate: chats by id, digest extras by id, and every call made. */
export class FakeWorld implements AgentLink {
  readonly chats = new Map<string, Workspace>();
  readonly digests = new Map<string, Partial<WorkspaceDigest>>();
  readonly calls: Array<{ readonly method: MethodName; readonly params: Record<string, unknown>; readonly timeoutMs?: number }> = [];
  readonly handlers = new Map<MethodName, Handler>();
  projects: Array<Project> = [project({ id: "p1", name: "app", path: "/code/app" })];
  engines: Array<EngineDescriptor> = [engine({ id: "claude-agent", label: "Claude Agent" }), engine({ id: "codex", label: "Codex" })];
  level: OutsideAgentLevel = "supervised";
  refusal: string | undefined;
  private created = 0;
  private readonly listeners = new Set<(w: Workspace) => void>();

  constructor() {
    const on = (method: MethodName, handler: Handler) => this.handlers.set(method, handler);
    on("workspace.list", (p) => ({ workspaces: [...this.chats.values()].filter((w) => p.include_archived === true || w.status !== "archived") }));
    on("project.list", () => ({ projects: this.projects }));
    on("engine.list", () => ({ engines: this.engines }));
    on("settings.get", () => {
      throw rpcError("forbidden", "Outside agents can't call settings.get", -32007);
    });
    on("chat.search", () => ({ chats: [], indexing: false, meaning: "unavailable" }));
    on("workspace.digest", (p) => {
      const w = this.chats.get(String(p.workspace_id));
      if (!w) throw rpcError("not_found", `no workspace ${String(p.workspace_id)}`, -32001);
      return { workspace: w, messages: 2, queued: 0, ...this.digests.get(w.id) };
    });
    on("workspace.create", (p) => {
      const id = `ws${++this.created}`;
      const w = workspace({ id, title: (p.title as string | undefined) ?? `Task ${id}`, status: "starting", engine: (p.engine as Workspace["engine"] | undefined) ?? "claude-agent", updated_at: new Date(NOW).toISOString() });
      this.chats.set(id, w);
      return w;
    });
    on("turn.submit", () => ({ turn_id: `t${this.calls.length}`, disposition: "started" }));
    on("turn.interrupt", () => ({ turn_id: "t-running" }));
    on("ask.respond", () => ({}));
  }

  /** A chat in the world. */
  add(w: Workspace): Workspace {
    this.chats.set(w.id, w);
    return w;
  }

  /** The chat changes, and workspace.changed says so. */
  change(id: string, over: Partial<Workspace>): Workspace {
    const w = { ...this.chats.get(id)!, ...over };
    this.chats.set(id, w);
    for (const listener of this.listeners) listener(w);
    return w;
  }

  callsOf(method: MethodName): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  readonly client: AgentClient = {
    call: async <M extends MethodName>(method: M, params: Params<M>, options?: { readonly timeoutMs?: number }) => {
      this.calls.push({ method, params: params as Record<string, unknown>, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
      const handler = this.handlers.get(method);
      if (!handler) throw new SessionProtocolError({ code: -32601, message: `unknown method ${method}` });
      return handler(params as Record<string, unknown>) as never;
    },
  };

  async acquire(name: string): Promise<Acquired> {
    if (this.refusal !== undefined) return { ok: false, text: this.refusal };
    return { ok: true, session: { client: this.client, agent: { name, level: this.level } } };
  }

  onWorkspace(handler: (w: Workspace) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onReady(): () => void {
    return () => undefined;
  }

  close(): void {}
}
