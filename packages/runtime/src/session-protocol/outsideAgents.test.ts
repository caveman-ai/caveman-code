// The outside agents' gate (outsideAgents.ts) on a fake runtime: which methods, levels and chats; the parameter
// guards; the access a chat resolves to; person-only asks from what the runtime stored; the runaway guard; the
// result and notification filters; names; the registry.
import type { AccessMode, Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import { imageItemPaths } from "./mediaRead.ts";
import {
  agentHears,
  enginesForAgents,
  gate,
  hidden,
  lineageOf,
  lowerLevel,
  makeRegistry,
  sanitizeName,
  type AgentCaller,
  type GateDeps,
} from "./outsideAgents.ts";
import { THIS_MAC } from "./projector.ts";
import type { WorkspaceRecord } from "./store.ts";

const T = "2026-10-31T10:00:00.000Z";
const record = (
  id: string,
  workspace: Partial<Workspace> = {},
  more: { access?: AccessMode; openAsks?: ReadonlyArray<{ item_id: string; kind: "question" | "approval" | "secret" | "tool"; prompt: string }> } = {},
): WorkspaceRecord =>
  ({
    workspace: { id, title: `chat ${id}`, repo: { path: "/repo" }, base_ref: "main", branch: `b-${id}`, engine: "claude-agent", computer: THIS_MAC, session_id: `s-${id}`, status: "idle", created_at: T, updated_at: T, ...workspace },
    session: { id: `s-${id}`, workspace_id: id, engine: "claude-agent", state: "live", lease: { computer_id: "this-mac", expires_at: T }, head: 0, ...(more.access ? { access: more.access } : {}), created_at: T, updated_at: T },
    internal: { threadId: `caveman:${id}`, worktreePath: null, repoPath: "/repo", ...(more.openAsks ? { openAsks: more.openAsks } : {}) },
  }) as unknown as WorkspaceRecord;

const deps = (records: ReadonlyArray<WorkspaceRecord>, over: Partial<GateDeps> = {}): GateDeps => ({
  workspace: (id) => Effect.succeed(records.find((r) => r.workspace.id === id)),
  session: (id) => Effect.succeed(records.find((r) => r.session.id === id)),
  workspaces: Effect.sync(() => records),
  projectPaths: Effect.succeed(["/repo"]),
  defaultEngine: Effect.succeed("claude-agent"),
  defaultAccess: () => Effect.succeed("full"),
  // "cursor" can't ask before acting: every chat on it runs at full access.
  accessModes: (engine) => Effect.succeed(engine === "cursor" ? (["full"] as const) : undefined),
  threadModes: (r) => Effect.succeed({ access: r.session.access ?? "full", grill: false }),
  pendingRequest: () => Effect.succeed(undefined),
  askEvent: () => Effect.succeed(undefined),
  journalImage: () => Effect.succeed(false),
  ...over,
});

const grok = (level: AgentCaller["level"] = "supervised"): AgentCaller => ({ name: "Grok", level });
const pass = (agent: AgentCaller, method: string, params: Record<string, unknown>, d: GateDeps) => Effect.runPromise(gate(agent, method, params, d));
const refusal = (agent: AgentCaller, method: string, params: Record<string, unknown>, d: GateDeps) =>
  Effect.runPromise(gate(agent, method, params, d).pipe(Effect.flip)).then((e) => ({ reason: e.reason, message: e.message }));

const mine = record("mine", { started_by: { agent: "Grok" } });
const builder = record("builder", { parent_workspace_id: "mine" });
const theirs = record("theirs");
const chief = record("chief", { kind: "chief" });
const setup = record("setup", { kind: "setup" });
const underSetup = record("under-setup", { parent_workspace_id: "setup" });
const all = [mine, builder, theirs, chief, setup, underSetup];

describe("the gate's table", () => {
  test("a method outside it is refused, whatever the level", async () => {
    for (const method of ["secret.list", "secret.set", "term.open", "term.write", "session.attach", "session.detach", "settings.set", "outside_agent.become", "outside_agent.update", "outside_agent.install", "browser.input", "computer.input", "engine.account.add", "project.remove", "chief.list", "workspace.restore"]) {
      expect(await refusal(grok("full"), method, {}, deps(all))).toEqual({ reason: "forbidden", message: `Outside agents can't call ${method}.` });
    }
  });

  test("an agent's connection says hello like every other (session-protocol client.ts), at any level", async () => {
    const hello = { client_version: "0.5.0", protocol_revision: 1 };
    expect(await pass(grok("read"), "runtime.hello", hello, deps(all))).toEqual({ params: hello });
  });

  test("levels: Read only reads, Supervised starts and steers, Full ships", async () => {
    expect((await refusal(grok("read"), "workspace.create", { request_id: "r", repo: { path: "/repo" } }, deps(all))).message).toContain("needs the Supervised level");
    expect((await refusal(grok("read"), "turn.interrupt", { request_id: "r", session_id: "s-mine" }, deps(all))).message).toContain("needs the Supervised level");
    await pass(grok("read"), "workspace.digest", { workspace_id: "theirs" }, deps(all));
    expect((await refusal(grok(), "git.push", { request_id: "r", workspace_id: "mine" }, deps(all))).message).toContain("needs the Full access level");
    expect((await refusal(grok(), "project.create", { request_id: "r", path: "/elsewhere" }, deps(all))).message).toContain("needs the Full access level");
    await pass(grok("full"), "git.push", { request_id: "r", workspace_id: "theirs" }, deps(all));
  });

  test("lowerLevel: --at-most only ever lowers", () => {
    expect(lowerLevel("full", "read")).toBe("read");
    expect(lowerLevel("supervised", "full")).toBe("supervised");
    expect(lowerLevel("full", undefined)).toBe("full");
  });
});

describe("targets", () => {
  test("never a Chief's chat or a setup chat, or one under them, for any method at any level", async () => {
    for (const id of ["chief", "setup", "under-setup"]) {
      for (const [method, params] of [
        ["workspace.digest", { workspace_id: id }],
        ["workspace.get", { workspace_id: id }],
        ["fs.diff", { workspace_id: id }],
        ["turn.submit", { request_id: "r", session_id: `s-${id}`, kind: "followup", input: { text: "hi" } }],
        ["git.commit", { request_id: "r", workspace_id: id, message: "m" }],
      ] as const) {
        expect(await refusal(grok("full"), method, params, deps(all))).toEqual({ reason: "forbidden", message: "Outside agents can't reach a Chief's chat or a setup chat." });
      }
    }
  });

  test("reads cover every other chat; below Full, changes reach only its own chats and the chats under them", async () => {
    await pass(grok("read"), "workspace.digest", { workspace_id: "theirs" }, deps(all));
    await pass(grok(), "fs.diff", { workspace_id: "theirs" }, deps(all));
    const refused = await refusal(grok(), "turn.interrupt", { request_id: "r", session_id: "s-theirs" }, deps(all));
    expect(refused.reason).toBe("forbidden");
    expect(refused.message).toContain("changes only the chats it started");
    await pass(grok(), "turn.interrupt", { request_id: "r", session_id: "s-mine" }, deps(all));
    await pass(grok(), "workspace.rename", { request_id: "r", workspace_id: "builder", title: "x" }, deps(all));
    // Another agent's name owns nothing of Grok's.
    expect((await refusal({ name: "Codex", level: "supervised" }, "workspace.archive", { request_id: "r", workspace_id: "mine" }, deps(all))).reason).toBe("forbidden");
    await pass(grok("full"), "workspace.archive", { request_id: "r", workspace_id: "theirs" }, deps(all));
    expect((await refusal(grok(), "workspace.get", { workspace_id: "nope" }, deps(all))).reason).toBe("not_found");
  });

  test("the inbox: only marking done", async () => {
    await pass(grok(), "workspace.inbox", { request_id: "r", workspace_id: "mine", action: { do: "done" } }, deps(all));
    expect((await refusal(grok(), "workspace.inbox", { request_id: "r", workspace_id: "mine", action: { do: "pin" } }, deps(all))).reason).toBe("forbidden");
  });
});

describe("workspace.create", () => {
  const create = (extra: Record<string, unknown> = {}) => ({ request_id: "r", repo: { path: "/repo" }, task: { text: "do it" }, ...extra });

  test("below Full: only a project's path, on its own branch, on This Mac, on the chat's own login", async () => {
    for (const extra of [
      { repo: { url: "https://github.com/acme/widgets" } },
      { repo: { path: "/not-a-project" } },
      { branch: "main" },
      { base_ref: "release" },
      { pull_request: { number: 7 } },
      { computer_id: "cloud-1" },
      { options: { account_id: "acct-2" } },
    ]) {
      expect((await refusal(grok(), "workspace.create", create(extra), deps(all))).reason).toBe("forbidden");
    }
    await pass(grok(), "workspace.create", create({ computer_id: THIS_MAC.id }), deps(all));
    // At Full the person's own powers apply (the handler decides).
    await pass(grok("full"), "workspace.create", create({ branch: "main", repo: { url: "https://github.com/acme/widgets" } }), deps(all));
  });

  test("grill mode is refused at every level, Full included", async () => {
    for (const level of ["supervised", "full"] as const) {
      expect((await refusal(grok(level), "workspace.create", create({ options: { mode: "grill" } }), deps(all))).message).toContain("Grill mode is the person's");
    }
  });

  test("resolved access: an explicit pick above the level is refused; left out, it is lowered to the level", async () => {
    expect((await refusal(grok(), "workspace.create", create({ options: { access: "full" } }), deps(all))).message).toContain('Access "full"');
    expect((await refusal(grok(), "workspace.create", create({ options: { access: "auto" } }), deps(all))).reason).toBe("forbidden");
    expect((await pass(grok(), "workspace.create", create(), deps(all))).params).toMatchObject({ options: { access: "ask" } });
    expect((await pass(grok(), "workspace.create", create({ options: { access: "ask" } }), deps(all))).params).toMatchObject({ options: { access: "ask" } });
    // The project's default already fits: nothing to lower.
    expect((await pass(grok(), "workspace.create", create(), deps(all, { defaultAccess: () => Effect.succeed("ask") }))).params).not.toHaveProperty("options");
    // Full keeps the person's default.
    expect((await pass(grok("full"), "workspace.create", create(), deps(all))).params).not.toHaveProperty("options");
  });

  test("an engine whose only access mode is full runs above Supervised: refused, as engine or as default engine", async () => {
    expect((await refusal(grok(), "workspace.create", create({ engine: "cursor" }), deps(all))).message).toContain("cursor runs every chat at Full access");
    expect((await refusal(grok(), "workspace.create", create(), deps(all, { defaultEngine: Effect.succeed("cursor") }))).reason).toBe("forbidden");
    await pass(grok("full"), "workspace.create", create({ engine: "cursor" }), deps(all));
  });

  test("the runaway guard: ten of its own chats running, the eleventh start is refused; chats waiting on the person don't count", async () => {
    const running = Array.from({ length: 10 }, (_, i) => record(`run-${i}`, { started_by: { agent: "Grok" }, status: i % 2 ? "working" : "starting" }));
    const refused = await refusal(grok(), "workspace.create", create(), deps([...all, ...running]));
    expect(refused.reason).toBe("rate_limited");
    expect(refused.message).toContain("10 chats working");
    const waiting = running.map((r, i) => (i === 0 ? record("run-0", { started_by: { agent: "Grok" }, status: "needs_input" }) : r));
    await pass(grok(), "workspace.create", create(), deps([...all, ...waiting]));
    // Another agent's running chats are its own count.
    await pass({ name: "Codex", level: "supervised" }, "workspace.create", create(), deps([...all, ...running]));
  });
});

describe("turn.submit", () => {
  const submit = (session: string, extra: Record<string, unknown> = {}) => ({ request_id: "r", session_id: session, kind: "followup", input: { text: "more" }, ...extra });

  test("a chat the person raised above the agent's level is theirs to message", async () => {
    const raised = record("raised", { started_by: { agent: "Grok" } }, { access: "full" });
    expect(await refusal(grok(), "turn.submit", submit("s-raised"), deps([raised]))).toEqual({
      reason: "forbidden",
      message: "The person runs this chat at Full access; only they can message it.",
    });
    const asks = record("asks", { started_by: { agent: "Grok" } }, { access: "ask" });
    await pass(grok(), "turn.submit", submit("s-asks"), deps([asks]));
    expect((await refusal(grok(), "turn.submit", submit("s-asks", { options: { access: "review" } }), deps([asks]))).reason).toBe("forbidden");
    // An engine switch to one without approvals would run it at full access.
    expect((await refusal(grok(), "turn.submit", submit("s-asks", { options: { engine: "cursor" } }), deps([asks]))).message).toContain("cursor would run this chat at Full access");
    // A switch on a chat with no stored access resolves full.
    const unknown = record("unknown", { started_by: { agent: "Grok" } });
    expect((await refusal(grok(), "turn.submit", submit("s-unknown", { options: { engine: "codex" } }), deps([unknown], { threadModes: () => Effect.succeed(undefined) }))).reason).toBe("forbidden");
  });

  test("no grill mode, no other login, nothing while a grill round is open or the person grills", async () => {
    const asks = record("asks", { started_by: { agent: "Grok" } }, { access: "ask" });
    expect((await refusal(grok("full"), "turn.submit", submit("s-asks", { options: { mode: "grill" } }), deps([asks]))).message).toContain("Grill mode");
    expect((await refusal(grok(), "turn.submit", submit("s-asks", { options: { account_id: "a2" } }), deps([asks]))).reason).toBe("forbidden");
    const round = record("round", { started_by: { agent: "Grok" } }, { access: "ask", openAsks: [{ item_id: "grill:1", kind: "question", prompt: "Which store?" }] });
    expect((await refusal(grok("full"), "turn.submit", submit("s-round"), deps([round]))).message).toContain("A grill round waits for the person");
    const grilling = deps([asks], { threadModes: () => Effect.succeed({ access: "ask", grill: true }) });
    expect((await refusal(grok("full"), "turn.submit", submit("s-asks"), grilling)).message).toContain("grill mode");
  });

  test("a steer while the chat waits on the person queues instead; a plain question leaves it a steer", async () => {
    const approval = record("approval", { started_by: { agent: "Grok" }, status: "needs_input" }, { access: "ask", openAsks: [{ item_id: "req-1", kind: "approval", prompt: "pnpm i" }] });
    expect((await pass(grok(), "turn.submit", submit("s-approval", { kind: "steer" }), deps([approval]))).params).toMatchObject({ kind: "queue" });
    const question = record("question", { started_by: { agent: "Grok" }, status: "needs_input" }, { access: "ask", openAsks: [{ item_id: "req-2", kind: "question", prompt: "Which?" }] });
    expect((await pass(grok(), "turn.submit", submit("s-question", { kind: "steer" }), deps([question]))).params).toMatchObject({ kind: "steer" });
  });

  test("a message that would start an eleventh running chat is refused; one to a running chat is not", async () => {
    const running = Array.from({ length: 10 }, (_, i) => record(`run-${i}`, { started_by: { agent: "Grok" }, status: "working" }, { access: "ask" }));
    const idle = record("idle", { started_by: { agent: "Grok" } }, { access: "ask" });
    expect((await refusal(grok(), "turn.submit", submit("s-idle"), deps([...running, idle]))).reason).toBe("rate_limited");
    await pass(grok(), "turn.submit", submit("s-run-3"), deps([...running, idle]));
  });
});

describe("ask.respond: person-only from what the runtime stored", () => {
  const card = {
    kind: "question" as const,
    questions: [
      { id: "q1", prompt: "Which store?", options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }], multi_select: false, allow_text: true },
      { id: "q2", prompt: "Pick one", options: [{ id: "a", label: "A" }], multi_select: false, allow_text: false },
    ],
  };
  const asking = record("asking", { started_by: { agent: "Grok" }, status: "needs_input" }, { access: "ask", openAsks: [{ item_id: "req-1", kind: "approval", prompt: "rm -rf" }] });
  const respond = (askId: string, response: Record<string, unknown>) => ({ request_id: "r", session_id: "s-asking", ask_id: askId, response });
  const answers = { kind: "question", answers: [{ question_id: "q1", option_ids: ["pg"], text: "fast" }, { question_id: "q2", option_ids: ["a"] }] };

  test("an approval is the person's even when the client says it's a question", async () => {
    const d = deps([asking], { pendingRequest: () => Effect.succeed({ kind: "command" }) });
    expect((await refusal(grok("full"), "ask.respond", respond("req-1", answers), d)).message).toContain("Only the person can approve this");
    for (const kind of ["permission", "file-change", "file-read", "mcp-elicitation", "auth_refresh", "dynamic_tool_call"]) {
      expect((await refusal(grok("full"), "ask.respond", respond("req-1", answers), deps([asking], { pendingRequest: () => Effect.succeed({ kind }) }))).reason).toBe("forbidden");
    }
  });

  test("grill rounds, custom tools and secret requests are the person's", async () => {
    expect((await refusal(grok("full"), "ask.respond", respond("grill:abc", answers), deps([asking]))).message).toContain("grill round");
    expect((await refusal(grok("full"), "ask.respond", respond("tool:abc", { kind: "tool", content: "x" }), deps([asking]))).reason).toBe("forbidden");
    // A secret request is no engine request: the stored open ask says what it is.
    const secret = record("asking", { started_by: { agent: "Grok" } }, { access: "ask", openAsks: [{ item_id: "sec-1", kind: "secret", prompt: "STRIPE_KEY" }] });
    expect((await refusal(grok("full"), "ask.respond", respond("sec-1", { kind: "secret", provided: true }), deps([secret]))).message).toContain("store this secret");
    // Gone: already answered.
    expect((await refusal(grok(), "ask.respond", respond("old", answers), deps([asking]))).reason).toBe("invalid_state");
  });

  test("a plain question passes, its answer marked as an outside agent's where the card takes words", async () => {
    const d = deps([asking], { pendingRequest: () => Effect.succeed({ kind: "user_input" }), askEvent: () => Effect.succeed(card) });
    const gated = await pass(grok(), "ask.respond", respond("req-1", answers), d);
    expect(gated.params).toMatchObject({
      response: {
        kind: "question",
        answers: [
          { question_id: "q1", option_ids: ["pg"], text: "Postgres: fast (answered for the person by Grok, an outside agent they connected)" },
          { question_id: "q2", option_ids: ["a"] },
        ],
      },
    });
    expect((await refusal(grok(), "ask.respond", respond("req-1", { kind: "approval", option_id: "accept" }), d)).reason).toBe("invalid_params");
    // A grill round asked through the engine's own question is still a round.
    const roundCard = deps([asking], { pendingRequest: () => Effect.succeed({ kind: "user_input" }), askEvent: () => Effect.succeed({ ...card, round: 1 }) });
    expect((await refusal(grok("full"), "ask.respond", respond("req-1", answers), roundCard)).message).toContain("grill round");
  });

  test("and only on a chat that runs at or below the agent's level", async () => {
    const raised = record("asking", { started_by: { agent: "Grok" } }, { access: "auto" });
    const d = deps([raised], { pendingRequest: () => Effect.succeed({ kind: "user_input" }), askEvent: () => Effect.succeed(card) });
    expect((await refusal(grok(), "ask.respond", respond("req-1", answers), d)).message).toBe("The person runs this chat at Auto-accept edits; only they can answer it.");
    expect((await refusal(grok(), "checkpoint.undo", { request_id: "r", session_id: "s-asking", checkpoint_id: "c1" }, d)).message).toBe(
      "The person runs this chat at Auto-accept edits; only they can undo its changes.",
    );
  });
});

describe("results", () => {
  const workspaces = all.map((r) => r.workspace);

  test("workspace.list: include_chief forced off; Chief and setup chats and the chats under them dropped", async () => {
    const gated = await pass(grok("read"), "workspace.list", { include_chief: true }, deps(all));
    expect(gated.params).toEqual({ include_chief: false });
    const shown = (await Effect.runPromise(gated.result!({ workspaces }))) as { workspaces: ReadonlyArray<Workspace> };
    expect(shown.workspaces.map((w) => w.id)).toEqual(["mine", "builder", "theirs"]);
  });

  test("chat.search: hits in Chief and setup chats dropped, the page still as long as asked", async () => {
    const gated = await pass(grok("read"), "chat.search", { query: "store", limit: 2 }, deps(all));
    expect(gated.params).toEqual({ query: "store", limit: 12 });
    const hits = [chief, mine, underSetup, theirs, builder].map((r) => ({ workspace: r.workspace, passages: [], more: 0 }));
    const shown = (await Effect.runPromise(gated.result!({ chats: hits, indexing: false, meaning: "unavailable" }))) as { chats: ReadonlyArray<{ workspace: Workspace }> };
    expect(shown.chats.map((c) => c.workspace.id)).toEqual(["mine", "theirs"]);
  });

  test("media.read: only an image item of that chat's journal, and only an image", async () => {
    expect((await refusal(grok("read"), "media.read", { workspace_id: "theirs", path: "/Users/me/secret.png" }, deps(all))).reason).toBe("forbidden");
    const gated = await pass(grok("read"), "media.read", { workspace_id: "theirs", path: "shot.png" }, deps(all, { journalImage: () => Effect.succeed(true) }));
    expect(await Effect.runPromise(gated.result!({ mime_type: "image/png", data: "", path: "/x/shot.png", size: 0 }))).toMatchObject({ mime_type: "image/png" });
    expect((await Effect.runPromise(gated.result!({ mime_type: "text/markdown", data: "", path: "/x/a.md", size: 0 }).pipe(Effect.flip))).reason).toBe("invalid_params");
  });

  test("engine.list: no logins and no plan limits", async () => {
    const gated = await pass(grok("read"), "engine.list", {}, deps(all));
    const engines = { engines: [{ id: "claude-agent", label: "Claude Agent", auth: { state: "signed_in", accounts: [{ id: "a1", email: "me@example.com" }] }, usage_limits: { x: 1 }, usage_on_credits: true }] };
    expect(await Effect.runPromise(gated.result!(engines))).toEqual({ engines: [{ id: "claude-agent", label: "Claude Agent", auth: { state: "signed_in", accounts: [] } }] });
    expect(enginesForAgents(engines as never)).toEqual(await Effect.runPromise(gated.result!(engines)));
  });

  test("settings.get: only the engine and access a new chat starts on", async () => {
    const gated = await pass(grok("read"), "settings.get", {}, deps(all));
    const settings = { default_engine: "codex", default_access: "ask", theme: "dark", engines: { codex: { model: "gpt-6.1" } }, chief_daily_cap_usd: 20 };
    expect(await Effect.runPromise(gated.result!(settings))).toEqual({ default_engine: "codex", default_access: "ask" });
    expect(await Effect.runPromise(gated.result!({ theme: "dark" }))).toEqual({});
    expect((await refusal(grok("read"), "settings.set", { request_id: "r", settings: {} }, deps(all))).reason).toBe("forbidden");
  });
});

describe("notifications", () => {
  const byId = new Map(all.map((r) => [r.workspace.id, r.workspace] as const));
  const readable = (w: Workspace) => !hidden(lineageOf(w, (id) => byId.get(id)));

  test("an agent hears workspace.changed for chats it may read and engine.changed, nothing else", () => {
    expect(agentHears("workspace.changed", theirs.workspace, readable)).toBe(true);
    expect(agentHears("workspace.changed", mine.workspace, readable)).toBe(true);
    expect(agentHears("workspace.changed", chief.workspace, readable)).toBe(false);
    expect(agentHears("workspace.changed", underSetup.workspace, readable)).toBe(false);
    expect(agentHears("engine.changed", { engines: [] }, readable)).toBe(true);
    for (const method of ["session.event", "session.events", "session.ended", "session.moved", "term.output", "term.exit", "tool.live", "chief.board.updated", "secret.changed", "outside_agent.changed", "cloud.changed", "device.requested"]) {
      expect(agentHears(method, { session_id: "s-mine", workspace_id: "mine" }, readable)).toBe(false);
    }
  });
});

describe("names", () => {
  test("control, direction and invisible characters go; 40 at most; the person's, Caveman's and a Chief's names get ' (agent)'", () => {
    expect(sanitizeName("  Grok\u0007 Build\n", [])).toBe("Grok Build");
    expect(sanitizeName("‮evil‬⁦x⁩", [])).toBe("evilx");
    expect(sanitizeName("x".repeat(60), [])).toBe("x".repeat(40));
    expect(sanitizeName("You", [])).toBe("You (agent)");
    expect(sanitizeName("y​ou", [])).toBe("you (agent)");
    expect(sanitizeName("ＣＡＶＥＭＡＮ", [])).toBe("CAVEMAN (agent)");
    expect(sanitizeName("Ada", ["Ada"])).toBe("Ada (agent)");
    expect(sanitizeName("Claude Code", ["Ada"])).toBe("Claude Code");
    expect(sanitizeName("​\u0000 ", [])).toBeUndefined();
  });
});

describe("the registry", () => {
  test("a new name starts Supervised; the person's changes and each agent_id's first name are kept in the store", async () => {
    const kv = new Map<string, string>();
    const store = { kvGet: (k: string) => Effect.sync(() => kv.get(k)), kvSet: (k: string, v: string) => Effect.sync(() => void kv.set(k, v)) };
    const registry = await Effect.runPromise(makeRegistry(store));
    const entry = await Effect.runPromise(registry.seen("id-1", "Grok", T));
    expect(entry).toEqual({ name: "Grok", level: "supervised", blocked: false, first_seen_at: T, last_seen_at: T });
    await Effect.runPromise(registry.seen("id-1", "Grok", "2026-10-31T11:00:00.000Z"));
    expect(await Effect.runPromise(registry.update("Grok", { level: "full", blocked: true }))).toMatchObject({ level: "full", blocked: true, first_seen_at: T, last_seen_at: "2026-10-31T11:00:00.000Z" });
    expect(await Effect.runPromise(registry.update("Nobody", { level: "full" }))).toBeUndefined();
    const again = await Effect.runPromise(makeRegistry(store));
    expect(again.get("Grok")).toMatchObject({ level: "full", blocked: true });
    expect(again.nameOf("id-1")).toBe("Grok");
    expect(again.nameOf("id-2")).toBeUndefined();
  });
});

describe("image items", () => {
  test("a tool's image path counts; a path written in a message or a command's output doesn't", () => {
    expect(imageItemPaths({ type: "tool.done", payload: { status: "completed", result: { saved_path: "/tmp/gen.png", saved_paths: ["/tmp/a.webp"] } } })).toEqual(["/tmp/gen.png", "/tmp/a.webp"]);
    expect(imageItemPaths({ type: "tool.started", payload: { name: "view_image", input: { path: "shots/home.png" } } })).toEqual(["shots/home.png"]);
    expect(imageItemPaths({ type: "tool.done", payload: { result: { content: [{ type: "image", source: "/tmp/cap.jpg" }] } } })).toEqual(["/tmp/cap.jpg"]);
    expect(imageItemPaths({ type: "message.done", payload: { role: "assistant", text: "![x](/Users/me/secret.png)" } })).toEqual([]);
    expect(imageItemPaths({ type: "tool.done", payload: { result: { output: "/Users/me/secret.png" } } })).toEqual([]);
    expect(imageItemPaths({ type: "tool.started", payload: { input: { command: "cat /Users/me/secret.png" } } })).toEqual([]);
  });
});
