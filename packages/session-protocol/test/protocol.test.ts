import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";
import { buildJsonSchema, schemaPath } from "../scripts/json-schema.ts";
import {
  ChiefAvatar,
  ChiefBoard,
  ChiefItem,
  ChiefProfile,
  EngineDescriptor,
  ErrorCodes,
  isMutating,
  Methods,
  Notifications,
  PanelContribution,
  VoiceCall,
  Session,
  SessionEvent,
  type SessionEventType,
  Settings,
  Workspace,
  type MethodName,
} from "../src/protocol.ts";

const roundTrip = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  expect(Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(value))).toEqual(value);

const at = "2026-10-14T12:00:00.000Z";
const computer = { id: "c1", kind: "this_mac", label: "This Mac", status: "online" };
const workspace = {
  id: "w1",
  title: "Move off pkg/errors",
  repo: { url: "https://github.com/acme/api" },
  base_ref: "main",
  branch: "caveman/move-off-pkg-errors",
  engine: "claude-agent",
  computer,
  session_id: "s1",
  status: "working",
  parent_workspace_id: "w0",
  created_at: at,
  updated_at: at,
};
const session = {
  id: "s1",
  workspace_id: "w1",
  engine: "acp:gemini",
  engine_session_ref: "native-123",
  state: "live",
  lease: { computer_id: "c1", expires_at: at },
  head: 42,
  forked_from: { session_id: "s0", cursor: 7 },
  created_at: at,
  updated_at: at,
};
const mail = {
  id: "m1",
  verb: "note",
  authority: "agent",
  channel: "api",
  from_workspace_id: "w2",
  to_workspace_id: "w1",
  body: "tests pass on api",
  wakes: false,
  created_at: at,
};

// `satisfies` makes the compiler fail when an event type has no sample.
const payloads = {
  "turn.started": { engine: "caveman", model: "sonnet", effort: "high", mode: "grill" },
  "message.delta": { text: "Hel" },
  "message.done": {
    role: "user",
    text: "Fix the login bug",
    attachments: [{ type: "image", name: "a.png", mime_type: "image/png", data: "iVBORw0K" }],
  },
  "reasoning.delta": { text: "thinking" },
  "tool.started": { name: "Bash", title: "Run tests", kind: "command", input: { command: "go test ./..." } },
  "tool.output": { text: "ok\n", stream: "stdout" },
  "tool.done": { status: "completed", result: { exit_code: 0 } },
  "plan.updated": {
    kind: "todos",
    steps: [
      { text: "Read the handler", status: "completed" },
      { text: "Fix it", status: "in_progress" },
    ],
  },
  "diff.changed": {
    files: [{ path: "b.go", old_path: "a.go", status: "renamed", additions: 3, deletions: 1 }],
  },
  // A grill round: round number, a markdown body and the recommended option.
  "ask.user": {
    kind: "question",
    round: 2,
    questions: [
      {
        id: "q1",
        prompt: "Which database?",
        detail: "We store **sessions** and audit logs.",
        options: [
          { id: "o1", label: "Postgres", description: "default" },
          { id: "o2", label: "SQLite" },
        ],
        recommended: "o1",
        multi_select: false,
        allow_text: true,
      },
    ],
  },
  "ask.resolved": {
    outcome: "answered",
    response: { kind: "question", answers: [{ question_id: "q1", option_ids: ["pg"] }] },
  },
  "subagent.started": { title: "Explore the repo", agent: "explorer" },
  "subagent.done": { status: "completed", summary: "found 3 call sites" },
  "checkpoint.created": { checkpoint_id: "cp1", ref: "refs/caveman/checkpoints/s1/3", files: [{ path: "pilot.md", additions: 45, deletions: 0 }] },
  "checkpoint.resolved": { checkpoint_id: "cp1", resolution: "undone", files: ["pilot.md"] },
  "session.restored": { at: 12, branch_workspace_id: "w2" },
  "goal.updated": { objective: "Ship the parser", native: false },
  "grill.finished": { doc_path: "docs/", summary: "Toggle in Settings, system default." },
  "context.updated": { used_tokens: 41000, window_tokens: 200000 },
  "compaction.started": {},
  "compaction.done": { status: "completed", before_tokens: 182000, after_tokens: 31000 },
  "model.routed": { model: "claude-haiku-5-5" },
  "queue.updated": {
    turns: [
      { turn_id: "t9", text: "then run the tests", queued_at: at },
      { turn_id: "t10", text: "Review finished.", queued_at: at, from: { workspace_id: "w2", title: "Release lead" } },
      { turn_id: "t11", text: "Triage the inbox", queued_at: at, scheduled_task: { task_id: "task-1", title: "Nightly triage" } },
    ],
  },
  "turn.done": { status: "interrupted" },
  usage: {
    engine: "caveman",
    model: "claude-sonnet-4-5",
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
    cost: { usd: 0.0123, basis: "list_price" },
  },
  "session.parked": { reason: "move" },
  "session.resumed": { computer_id: "c2" },
  "engine.status": {
    engine: "codex",
    auth: "api_key",
    rate_limit: { limited: true, resets_at: at },
    version: "0.50.0",
  },
  notification: { level: "info", title: "Builder finished", mail },
  "voice.call": { call_id: "vc1", state: "ended", duration_ms: 134_000, reason: "person" },
  "voice.turn": { call_id: "vc1", role: "person", text: "add dark mode to the runs page", handoff: { item_id: "ci-1", text: "add dark mode to the runs page" } },
  error: { reason: "engine_unavailable", message: "claude not found on PATH" },
} satisfies Record<SessionEventType, unknown>;

describe("schemas round-trip", () => {
  test("every event type", () => {
    Object.entries(payloads).forEach(([type, payload], i) =>
      roundTrip(SessionEvent, {
        session_id: "s1",
        cursor: i + 1,
        at,
        turn_id: "t1",
        item_id: `i${i}`,
        parent_item_id: "sub1",
        type,
        payload,
      }),
    );
    roundTrip(SessionEvent, {
      session_id: "s1",
      cursor: 1,
      at,
      type: "error",
      payload: { reason: "engine_unavailable", message: "Overloaded", retry: { attempt: 2, max_attempts: 5, delay_ms: 4000 } },
    });
    roundTrip(SessionEvent, {
      session_id: "s1",
      cursor: 1,
      at,
      type: "ask.user",
      payload: {
        kind: "approval",
        title: "Run rm -rf build?",
        tool_item_id: "i3",
        options: [
          { id: "once", label: "Allow once", decision: "allow" },
          { id: "no", label: "Deny", decision: "deny" },
        ],
      },
    });
    // A scheduled task's prompt says which task sent it.
    roundTrip(SessionEvent, {
      session_id: "s1",
      cursor: 1,
      at,
      type: "message.done",
      payload: { role: "user", text: "Triage the inbox", scheduled_task: { task_id: "task-1", title: "Nightly triage" } },
    });
    roundTrip(SessionEvent, { session_id: "s1", cursor: 1, at, type: "message.done", payload: { role: "user", text: "Triage the inbox", scheduled_task: { task_id: "task-1" } } });
    // Full access, and the engine asked anyway: why, in its words and as a cause the client explains.
    roundTrip(SessionEvent, {
      session_id: "s1",
      cursor: 1,
      at,
      type: "ask.user",
      payload: {
        kind: "approval",
        title: 'Claude wants to run rm -r -- "$rr/$h"',
        reason: "Dangerous rm on a path built from a variable",
        full_access_override: "engine_check",
        options: [
          { id: "accept", label: "Approve", decision: "allow" },
          { id: "decline", label: "Decline", decision: "deny" },
        ],
      },
    });
    expect(() =>
      Schema.decodeUnknownSync(SessionEvent)({ session_id: "s1", cursor: 1, at, type: "ask.user", payload: { kind: "approval", title: "x", full_access_override: "settings", options: [] } }),
    ).toThrow();
  });

  test("a patch's every file, a deny's note and an option's preview", () => {
    const ev = (type: string, payload: unknown) => ({ session_id: "s1", cursor: 1, at, item_id: "i1", type, payload });
    // A Codex patch that changed three files: each one, the move's old path too; the title still names the first.
    roundTrip(
      SessionEvent,
      ev("tool.started", {
        name: "edit",
        title: "/w/c.ts",
        kind: "edit",
        input: { path: "/w/c.ts" },
        files: [
          { path: "/w/d.ts", old_path: "/w/c.ts", status: "renamed" },
          { path: "/w/e.ts", status: "deleted" },
          { path: "/w/a.ts", status: "added" },
        ],
      }),
    );
    expect(() => Schema.decodeUnknownSync(SessionEvent)(ev("tool.started", { name: "edit", title: "a", kind: "edit", input: {}, files: [{ path: "a", status: "moved" }] }))).toThrow();
    // An approval whose deny can carry a note, and the deny that carries it.
    roundTrip(
      SessionEvent,
      ev("ask.user", {
        kind: "approval",
        title: "Claude wants to run rm -rf build",
        accepts_feedback: true,
        options: [
          { id: "accept", label: "Allow", decision: "allow" },
          { id: "decline", label: "Deny", decision: "deny" },
        ],
      }),
    );
    roundTrip(Methods["ask.respond"].params, { request_id: "r1", session_id: "s1", ask_id: "a1", response: { kind: "approval", option_id: "decline", feedback: "Keep build/, clean dist/ instead" } });
    roundTrip(Methods["project.import_chats"].params, { request_id: "r1", project_id: "caveman-repo:abc" });
    roundTrip(Methods["project.import_chats"].result, { imported: 3, already: 1, skipped: 0 });
    roundTrip(SessionEvent, ev("ask.resolved", { outcome: "answered", response: { kind: "approval", option_id: "decline", feedback: "Keep build/" } }));
    expect(() => Schema.decodeUnknownSync(Methods["ask.respond"].params)({ request_id: "r1", session_id: "s1", ask_id: "a1", response: { kind: "approval", option_id: "decline", feedback: "" } })).toThrow();
    // A question's options can show what each looks like.
    roundTrip(
      SessionEvent,
      ev("ask.user", {
        kind: "question",
        questions: [
          {
            id: "q1",
            prompt: "Which layout?",
            options: [
              { id: "a", label: "Sidebar", description: "Nav on the left", preview: "┌──┬──────┐\n│▤ │      │\n└──┴──────┘" },
              { id: "b", label: "Top bar", description: "Nav on top" },
            ],
            multi_select: false,
            allow_text: true,
          },
        ],
      }),
    );
  });

  test("a webhook automation's filters and dedupe", () => {
    const automation = {
      id: "scheduled-task:1",
      title: "Triage new issues",
      prompt: "Triage {{body.issue.title}}",
      enabled: true,
      trigger: {
        type: "webhook",
        path: "/api/hooks/h1/tok",
        url: null,
        signed: true,
        filters: [
          { path: "headers.x-github-event", op: "equals", value: "issues" },
          { path: "body.action", op: "in", value: ["opened", "reopened"] },
          { path: "body.issue.labels[].name", op: "not_equals", value: "wontfix" },
          { path: "body.sender", op: "exists" },
        ],
        dedupe: { replay_key: "{{headers.x-github-delivery}}", coalesce_key: "{{body.issue.number}}", coalesce_window_seconds: 300 },
      },
      project_id: "p1",
      engine: "claude-agent",
      model: "claude-opus-5-5",
      next_run_at: null,
      last_run_at: null,
      last_status: "never",
      last_error: null,
      run_count: 0,
      source: "app",
    };
    roundTrip(Methods["automation.set_webhook_rules"].result, automation);
    roundTrip(Methods["automation.set_webhook_rules"].params, { request_id: "r1", id: "scheduled-task:1", filters: [], dedupe: {} });
    roundTrip(Methods["automation.set_webhook_rules"].params, { request_id: "r1", id: "scheduled-task:1", filters: automation.trigger.filters });
    roundTrip(Methods["automation.save"].params, {
      request_id: "r1",
      id: "scheduled-task:1",
      title: "Triage",
      prompt: "Triage it",
      enabled: true,
      trigger: { type: "webhook", keep_secret: true, filters: [{ path: "query.source", op: "starts_with", value: "gh" }], dedupe: { replay_key: "{{query.id}}" } },
      project_id: "p1",
      engine: "claude-agent",
    });
    const bad = (params: unknown) => expect(() => Schema.decodeUnknownSync(Methods["automation.set_webhook_rules"].params)(params)).toThrow();
    // Only request values; an `in` value with a comma would not survive a form's list; 16 filters at most.
    bad({ request_id: "r1", id: "t", filters: [{ path: "env.HOME", op: "exists" }] });
    bad({ request_id: "r1", id: "t", filters: [{ path: "body.action", op: "in", value: ["a,b"] }] });
    bad({ request_id: "r1", id: "t", filters: [{ path: "body.action", op: "in", value: [] }] });
    bad({ request_id: "r1", id: "t", filters: Array.from({ length: 17 }, () => ({ path: "body", op: "exists" })) });
    bad({ request_id: "r1", id: "t", dedupe: { coalesce_window_seconds: 5 } });
    // A key reads the request; plain text or an unknown placeholder would dedupe everything or nothing.
    bad({ request_id: "r1", id: "t", dedupe: { replay_key: "always" } });
    bad({ request_id: "r1", id: "t", dedupe: { coalesce_key: "{{env.HOME}}" } });
    roundTrip(Methods["automation.set_webhook_rules"].params, { request_id: "r1", id: "t", dedupe: { coalesce_key: "pr-{{body.pull_request.number}}", coalesce_window_seconds: 10 } });
  });

  test("resources", () => {
    roundTrip(Workspace, workspace);
    roundTrip(Workspace, { ...workspace, repo: { path: "/Users/me/api" } });
    roundTrip(Workspace, { ...workspace, activity: { ask: { kind: "approval", prompt: "Run rm -rf build?" }, turn_started_at: at, last_outcome: "interrupted", todos: { done: 2, total: 5 }, ready_to_build: true } });
    roundTrip(Workspace, { ...workspace, activity: { last_outcome: "completed", turn_ended_at: at, awaiting: true } });
    roundTrip(Workspace, { ...workspace, activity: {} });
    expect(() => Schema.decodeUnknownSync(Workspace)({ ...workspace, activity: { ask: { kind: "plan", prompt: "x" } } })).toThrow();
    roundTrip(Session, session);
    roundTrip(Session, { ...session, mode: "grill" });
    roundTrip(EngineDescriptor, {
      id: "claude-agent",
      label: "Claude Agent",
      capabilities: {
        structured: true,
        fork: true,
        steer: false,
        interrupt: true,
        tool_hooks: true,
        resume_across_machines: false,
        approvals: true,
        plans: true,
        subagents: true,
        images: true,
        mcp: true,
        grill_mode: true,
      },
      models: [{ id: "opus", label: "Opus", efforts: ["low", "medium", "high"], default_effort: "high" }],
      auth: {
        state: "signed_in",
        accounts: [{ id: "a1", label: "me@example.com", kind: "login", active: true }],
      },
      version: "2.1.0",
      upgrade: { version: "2.2.0", hint: "npm i -g @anthropic-ai/claude-code" },
    });
    roundTrip(Settings, {
      default_engine: "caveman",
      default_computer_id: "c1",
      engines: { codex: { model: "gpt-5.5", effort: "xhigh" } },
      theme: "dark",
      notifications: { needs_input: true, turn_done: false },
    });
    const pal = Object.fromEntries(["shell", "panel", "raised", "hover", "border", "text", "dim", "accent", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"].map((k) => [k, "#1e1e2e"]));
    const base = { default_engine: "caveman", default_computer_id: "c1", engines: {}, theme: "system", notifications: { needs_input: true, turn_done: true } };
    roundTrip(Settings, { ...base, color_theme: "custom:night", custom_themes: [{ id: "custom:night", name: "Night", source: "acme.night", dark: pal }] });
    // A Chief's replies have their own switch; absent, it is on.
    roundTrip(Settings, { ...base, notifications: { needs_input: true, turn_done: true, chief_messages: false } });
    const bad = (value: unknown) => expect(() => Schema.decodeUnknownSync(Settings)(value)).toThrow();
    // Only "#rrggbb" reaches the page's style: no CSS, no other colour syntax.
    bad({ ...base, custom_themes: [{ id: "custom:x", name: "X", dark: { ...pal, accent: "red; background: url(x)" } }] });
    bad({ ...base, custom_themes: [{ id: "custom:x", name: "X", dark: { ...pal, accent: "#FFF" } }] });
    // A custom id never shadows a built-in.
    bad({ ...base, custom_themes: [{ id: "dracula", name: "X", dark: pal }] });
    bad({ ...base, custom_themes: Array.from({ length: 41 }, (_, i) => ({ id: `custom:t${i}`, name: "T", dark: pal })) });
  });

  test("method params", () => {
    roundTrip(Methods["turn.submit"].params, {
      request_id: "r1",
      session_id: "s1",
      kind: "steer",
      input: { text: "use the v2 client instead" },
      options: { model: "opus", effort: "max" },
    });
    roundTrip(Methods["turn.submit"].params, {
      request_id: "r1",
      session_id: "s1",
      kind: "followup",
      input: { text: "Add a dark mode toggle" },
      options: { mode: "grill" },
    });
    roundTrip(Methods["mail.claim"].params, { request_id: "r2", session_id: "s1", paths: ["api/**"] });
    roundTrip(Methods["mail.wait"].params, { session_id: "s1", after: "m1", workspace_ids: ["w2"], timeout_ms: 0 });
    roundTrip(Methods["mail.wait"].result, { messages: [mail], finished: [workspace], timed_out: false });
    roundTrip(Methods["fs.read"].params, { workspace_id: "w1", path: "src/a..b/main.go", ref: "refs/caveman/checkpoints/s1/3" });
    roundTrip(Methods["fs.diff"].params, { workspace_id: "w1", from: "origin/main", to: "cp1", paths: ["api/x.go"] });
    // The chat's own servers say who started them; an older runtime's list (no attribution, no can_stop) still reads.
    roundTrip(Methods["workspace.servers"].result, {
      servers: [
        { port: 5173, url: "http://localhost:5173", process_name: "node", pid: 4242, started_by: "terminal", terminal_id: "term-1" },
        { port: 3000, url: "http://localhost:3000", pid: 4343, started_by: "agent" },
        { port: 8080, url: "http://localhost:8080" },
      ],
      can_stop: true,
    });
    roundTrip(Methods["workspace.servers"].result, { servers: [{ port: 5173, url: "http://localhost:5173", process_name: "node" }] });
    expect(() => Schema.decodeUnknownSync(Methods["workspace.servers"].result)({ servers: [{ port: 1, url: "u", started_by: "shell" }] })).toThrow();
    roundTrip(Methods["workspace.servers.stop"].params, { request_id: "r9", workspace_id: "w1", pid: 4242, port: 5173 });
    // One edit step's recorded change: a patch, or the content an engine sent without one.
    roundTrip(Methods["tool.diff"].params, { workspace_id: "w1", item_id: "item-7" });
    roundTrip(Methods["tool.diff"].result, { path: "src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n", changes: [{ operation: "update", path: "src/b.ts", old_path: "src/a.ts" }] });
    roundTrip(Methods["tool.diff"].result, { path: "src/a.ts", before: "a", after: "b" });
    roundTrip(Methods["engine.account.add"].params, { request_id: "r3", engine: "caveman", provider: "openai", key: "sk-test" });
    roundTrip(Methods["engine.account.add"].params, { request_id: "r4", engine: "claude-agent" });
    roundTrip(Methods["engine.account.activate"].params, { request_id: "r5", engine: "codex", account_id: "codex" });
    // Sign in once: a plan connected for every computer, by the CLI's own sign-in or the line it printed elsewhere.
    roundTrip(Methods["engine.account.add"].params, { request_id: "r4", engine: "claude-agent", everywhere: true });
    roundTrip(Methods["engine.account.add"].params, { request_id: "r4", engine: "claude-agent", everywhere: true, token: ("sk-" + "ant-oat01-only-a-test-value") });
    roundTrip(Methods["engine.account.add"].params, { request_id: "r4", engine: "codex", chatgpt: true, everywhere: true, device_code: true });
    roundTrip(Methods["engine.account.add"].result, {
      accounts: [
        { id: "connection:c1", label: "Claude plan", kind: "login", active: true, where: "everywhere", connection: { kind: "claude_plan", status: "used_up", used_up_until: at, expires_at: at } },
        { id: "connection:c2", label: "Anthropic key", kind: "api_key", active: false, where: "cloud", connection: { kind: "api_key", status: "ready", off: true } },
        { id: "claudeAgent:default", label: "ada@example.com", kind: "login", active: false, where: "this_mac" },
      ],
      sign_in: { command: "", message: "Approve in your browser.", url: "https://claude.ai/oauth/authorize?x=1", code: "ABCD-1234" },
    });
    roundTrip(Methods["engine.account.complete"].params, { request_id: "r4", engine: "claude-agent", account_id: "connecting", callback_url: "" });
    // The person has not approved yet: an answer that says so, never an error.
    roundTrip(Methods["engine.account.complete"].result, { accounts: [], waiting: true });
    expect(() => Schema.decodeUnknownSync(Methods["engine.account.complete"].result)({ accounts: [], waiting: false })).toThrow();
    expect(() => Schema.decodeUnknownSync(Methods["engine.account.add"].result)({ accounts: [{ id: "a", label: "a", kind: "login", active: true, where: "everywhere", connection: { kind: "claude_plan", status: "asleep" } }] })).toThrow();
    expect(() => Schema.decodeUnknownSync(Methods["engine.account.add"].result)({ accounts: [{ id: "a", label: "a", kind: "login", active: true, where: "the_moon" }] })).toThrow();
    // First run: GitHub or Google straight away, or an email that prefills Cloud's sign-in.
    roundTrip(Methods["cloud.signin"].params, { request_id: "r6", provider: "github" });
    roundTrip(Methods["cloud.signin"].params, { request_id: "r6", email: "ada@example.com" });
    roundTrip(Methods["github.connect"].params, { request_id: "r7" });
    roundTrip(Methods["github.connect"].result, { url: "https://caveman.so/connect/github" });
    expect(() => Schema.decodeUnknownSync(Methods["cloud.signin"].params)({ request_id: "r6", provider: "gitlab" })).toThrow();
    // The push a pull request's patches were read at, handed back when one of their files is opened whole.
    roundTrip(Methods["pr.diff"].result, { head_sha: "abc", revision: "3", files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" }], omitted: [] });
    roundTrip(Methods["pr.file"].params, { project_id: "p1", number: 7, path: "src/a.ts", status: "modified", revision: "3" });
  });

  test("the Chief", () => {
    const item = {
      id: "ci1",
      text: "renumber 0391, it collides",
      title: "Renumber 0391",
      state: "blocked",
      rank: 1.5,
      pinned: false,
      project_ids: ["caveman-repo:1"],
      blocked_on: { kind: "item", item_id: "ci0" },
      not_before: at,
      source: "capture",
      workspace_ids: [],
      created_at: at,
      updated_at: at,
    };
    const changeSet = { id: "cs1", title: "Rename workspace", project_ids: ["p1", "p2"], contract: "GET /v1/spaces", merge_order: ["p2", "p1"], state: "open", created_at: at, updated_at: at };
    roundTrip(Workspace, { ...workspace, kind: "chief", repo: { path: "/state/chief" }, base_ref: "", branch: "" });
    roundTrip(ChiefBoard, { items: [item, { ...item, id: "ci2", state: "needs_you", detail: "tests fail", blocked_on: { kind: "capacity" } }], change_sets: [changeSet] });
    // An item follows its chat's pull request: its state, checks and review decision when the host reports them.
    const pr = { number: 31, url: "https://github.com/o/r/pull/31", state: "open", checks: "failing", review: "changes_requested" };
    roundTrip(ChiefBoard, { items: [{ ...item, id: "ci3", state: "needs_you", detail: "Checks are failing on #31.", pull_request: pr, workspace_ids: ["w1"] }], change_sets: [] });
    roundTrip(Workspace, { ...workspace, pull_request: { number: 31, url: pr.url, state: "merged" } });
    roundTrip(Workspace, { ...workspace, pull_request: pr });
    roundTrip(Methods["chief.get"].result, { workspace: { ...workspace, kind: "chief" }, availability: "no_key", board: { items: [], change_sets: [] } });
    roundTrip(Methods["chief.capture"].params, { request_id: "r1", text: "also fix the gemini wrap", source: "composer", mode: "decide" });
    // A note carries the images attached to it and the worker chat that was on screen as the person typed.
    roundTrip(Methods["chief.capture"].params, { request_id: "r1", text: "make that bigger", mode: "decide", showing: { workspace_id: "ws-9" }, attachments: [{ type: "image", name: "shot.png", mime_type: "image/png", data: "aGk=" }] });
    // Several Chiefs: each a profile, each item on one Chief's board.
    const profile = {
      id: "w-chief-2",
      name: "Flint",
      avatar: { character: "mammoth", tone: "medium" },
      model: { engine: "caveman", model: "anthropic/claude-haiku-4-5", effort: "low" },
      access: "ask",
      project_ids: ["caveman-repo:1"],
      soul: "# Soul\n\n## Crew rules\nRun the tests before you report.",
      home: false,
      created_at: at,
      updated_at: at,
    };
    roundTrip(ChiefProfile, profile);
    // access null: its chats take what a new chat in their project takes.
    roundTrip(ChiefProfile, { ...profile, id: "w-chief", name: "Chief", avatar: { character: "custom:my-pal-2", tone: "dark" }, model: null, access: null, project_ids: [], home: true });
    roundTrip(ChiefItem, { ...item, chief_id: "w-chief-2" });
    roundTrip(Methods["chief.get"].params, { chief_id: "w-chief-2" });
    roundTrip(Methods["chief.get"].params, {});
    // One Chief per project: its project, fixed, and the project's default; project_ids kept for older clients.
    roundTrip(ChiefProfile, { ...profile, project_id: "caveman-repo:1", project_default: true });
    roundTrip(Methods["chief.get"].params, { project_id: "caveman-repo:1" });
    roundTrip(Methods["chief.create"].params, { request_id: "r1", project_id: "caveman-repo:1", name: "Flint" });
    roundTrip(Methods["chief.capture"].params, { request_id: "r1", project_id: "caveman-repo:1", text: "for this project", mode: "queue" });
    roundTrip(Methods["chief.get"].result, { workspace: { ...workspace, kind: "chief" }, chief: profile, availability: "ready", board: { items: [{ ...item, chief_id: "w-chief-2" }], change_sets: [] }, model: profile.model });
    roundTrip(Methods["chief.list"].params, {});
    roundTrip(Methods["chief.list"].result, { chiefs: [{ ...profile, home: true }, profile] });
    roundTrip(Methods["chief.create"].params, { request_id: "r5", name: "Flint", avatar: { character: "dino", tone: "light" } });
    roundTrip(Methods["chief.create"].params, { request_id: "r5" });
    roundTrip(Methods["chief.create"].result, { chief: profile });
    roundTrip(Methods["chief.update"].params, { request_id: "r6", chief_id: "w-chief-2", name: "Flint Stone", avatar: { character: "elder", tone: "medium-dark" }, model: null, access: "review", project_ids: [], soul: "" });
    roundTrip(Methods["chief.update"].params, { request_id: "r6", chief_id: "w-chief-2", model: { engine: "claude-agent", model: "claude-sonnet-5", account_id: "claude-2" } });
    roundTrip(Methods["chief.update"].params, { request_id: "r6", chief_id: "w-chief-2", access: null });
    roundTrip(Methods["chief.update"].result, { chief: profile });
    roundTrip(Methods["chief.remove"].params, { request_id: "r7", chief_id: "w-chief-2" });
    roundTrip(Methods["chief.remove"].result, {});
    roundTrip(Methods["chief.capture"].params, { request_id: "r1", chief_id: "w-chief-2", text: "check the release notes", mode: "queue" });
    roundTrip(Notifications["chief.list.updated"], { chiefs: [profile] });
    // Calls with any Chief: the call names its Chief, and a ring back the Chief whose item rang.
    roundTrip(Methods["chief.voice.start"].params, { request_id: "r8", device: "iPhone", chief_id: "w-chief-2" });
    roundTrip(Methods["chief.voice.start"].params, { request_id: "r8", device: "iPhone", answer: "ci1" });
    const call = { id: "vc1", state: "live", engine: "deepgram", started_at: at, live_at: at, device: "iPhone", muted: false, about_item_id: "ci1", chief_id: "w-chief-2" };
    roundTrip(VoiceCall, call);
    roundTrip(Notifications["chief.voice.updated"], call);
    roundTrip(Notifications["chief.voice.ringing"], { item_id: "ci1", title: "Release notes", state: "review", line: "Release notes is ready for you to look at.", chief_id: "w-chief-2" });
    roundTrip(Notifications["chief.voice.ringing"], { item_id: "ci1", title: "Release notes", state: "done", line: "Release notes is done." });
    roundTrip(Methods["chief.items.update"].params, { request_id: "r2", item_id: "ci1", pinned: true, not_before: null, state: "dropped" });
    roundTrip(Methods["chief.items.reorder"].params, { request_id: "r3", item_id: "ci1", before_item_id: null });
    roundTrip(Methods["chief.start"].params, { request_id: "r4", item_ids: ["ci1", "ci2"] });
    roundTrip(Methods["workspace.list"].params, { include_chief: true });
    roundTrip(Settings, {
      default_engine: "caveman",
      default_computer_id: "c1",
      engines: {},
      theme: "dark",
      notifications: { needs_input: true, turn_done: true },
      chief_max_concurrent: 4,
      chief_daily_cap_usd: 12.5,
      chief_ask_above_chats: 3,
      chief_capture_shortcut: "Control+Alt+Space",
      chief_rules: "Start small chores without asking.\n\n## Crew rules\nRun the tests before you report.",
    });
    const row = { key: "chief", label: "Chief", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, measured_usd: null, saved_usd: null, saved_usd_partial: false, saved_tokens: 0, basis: "none", bucket: "chief" };
    roundTrip(Methods["spend.summary"].result, { rows: [row], saved_usd: null, saved_usd_partial: false, saved_tokens: 0, verified_usd: null });
    const bad = (schema: Schema.Codec<unknown, unknown>, value: unknown) => expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow();
    bad(Methods["chief.capture"].params, { request_id: "r1", text: "", mode: "decide" });
    bad(Methods["chief.capture"].params, { request_id: "r1", text: "  ", mode: "decide", attachments: [] });
    // An image alone is a note.
    roundTrip(Methods["chief.capture"].params, { request_id: "r1", text: "", mode: "decide", attachments: [{ type: "image", name: "shot.png", mime_type: "image/png", data: "aGk=" }] });
    bad(Methods["chief.capture"].params, { request_id: "r1", text: "x", mode: "now" });
    bad(Methods["chief.start"].params, { request_id: "r4", item_ids: [] });
    roundTrip(ChiefAvatar, { character: "petrock", tone: "medium" });
    bad(ChiefAvatar, { character: "wizard", tone: "medium" });
    bad(ChiefAvatar, { character: "custom:Not Allowed", tone: "medium" });
    bad(ChiefAvatar, { character: "caveman", tone: "green" });
    bad(Methods["chief.create"].params, { request_id: "r5", name: "" });
    bad(Methods["chief.update"].params, { request_id: "r6", soul: "no chief named" });
    bad(Methods["chief.update"].params, { request_id: "r6", chief_id: "w-chief-2", access: "everything" });
    bad(Methods["chief.remove"].params, { request_id: "r7" });
    // access is always there: a permission, or null.
    const { access: _access, ...noAccess } = profile;
    bad(ChiefProfile, noAccess);
    // Starting is chief.start, never an edit.
    bad(Methods["chief.items.update"].params, { request_id: "r2", item_id: "ci1", state: "started" });
    // 0 is no limit (the default); past 20 is refused.
    const base = { default_engine: "caveman", default_computer_id: "c1", engines: {}, theme: "dark", notifications: { needs_input: true, turn_done: true } };
    bad(Settings, { ...base, chief_max_concurrent: 21 });
    expect(Schema.decodeUnknownSync(Settings)({ ...base, chief_max_concurrent: 0 })).toMatchObject({ chief_max_concurrent: 0 });
  });

  test("a delegated agent's runner: on subagent.started, its workspace, and the role pins", () => {
    const runner = {
      engine: "codex",
      instance_id: "codex-account-ab12",
      account_tag: "WK",
      model: "gpt-6.1-sol",
      effort: "high",
      pick: { by: "auto", kind: "review", options: 7 },
    };
    roundTrip(SessionEvent, { session_id: "s1", cursor: 4, at, type: "subagent.started", payload: { title: "Review the diff", agent: "codex", workspace_id: "w2", runner } });
    roundTrip(Workspace, { ...workspace, id: "w2", parent_workspace_id: "w1", runner });
    roundTrip(Workspace, { ...workspace, runner: { engine: "claude-agent", instance_id: "claudeAgent", model: "claude-sonnet-5-5", pick: { by: "default", kind: "implementation", fallback: "cloud_unlinked" } } });
    roundTrip(Workspace, { ...workspace, runner: { engine: "acp:gemini", instance_id: "gemini", model: "gemini-3-pro", pick: { by: "lead" } } });
    const settings = { default_engine: "caveman", default_computer_id: "c1", engines: {}, theme: "dark", notifications: { needs_input: true, turn_done: true } };
    roundTrip(Settings, {
      ...settings,
      subagent_default_model: "auto",
      subagent_role_pins: { review: { engine: "codex", instance_id: "codex", model: "gpt-6.1-sol", effort: "high" }, research: null },
    });
    const bad = (schema: Schema.Codec<unknown, unknown>, value: unknown) => expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow();
    bad(Workspace, { ...workspace, runner: { ...runner, pick: { by: "router" } } });
    bad(Workspace, { ...workspace, runner: { ...runner, pick: { by: "auto", fallback: "offline" } } });
    bad(Workspace, { ...workspace, runner: { ...runner, account_tag: "toolong" } });
    bad(Workspace, { ...workspace, runner: { ...runner, pick: { by: "auto", options: -1 } } });
    // The Snooze menu's own choices: waits and local times, up to 8.
    roundTrip(Settings, { ...settings, inbox_snooze_options: [{ kind: "after", minutes: 90 }, { kind: "at", day: "friday", time: "16:30" }] });
    roundTrip(Settings, { ...settings, inbox_snooze_options: [] });
    bad(Settings, { ...settings, inbox_snooze_options: [{ kind: "after", minutes: 0 }] });
    bad(Settings, { ...settings, inbox_snooze_options: [{ kind: "after", minutes: 30 * 24 * 60 + 1 }] });
    bad(Settings, { ...settings, inbox_snooze_options: [{ kind: "at", day: "someday", time: "09:00" }] });
    bad(Settings, { ...settings, inbox_snooze_options: [{ kind: "at", day: "today", time: "24:00" }] });
    bad(Settings, { ...settings, inbox_snooze_options: Array.from({ length: 9 }, (_, i) => ({ kind: "after", minutes: i + 1 })) });
  });

  test("a turn may choose another harness but a started turn must always name its engine", () => {
    const params = { request_id: "switch-1", session_id: "s1", kind: "followup", input: { text: "continue here" }, options: { engine: "codex", model: "gpt-6.1-sol" } };
    roundTrip(Methods["turn.submit"].params, params);
    roundTrip(Methods["turn.prewarm"].params, { request_id: "warm-1", session_id: "s1", options: params.options });
    expect(() => Schema.decodeUnknownSync(SessionEvent)({ session_id: "s1", cursor: 1, at, type: "turn.started", payload: { model: "gpt-6.1-sol" } })).toThrow();
    expect(() => Schema.decodeUnknownSync(Methods["turn.submit"].params)({ ...params, options: { engine: "not-a-harness" } })).toThrow();
  });

  test("rejects what the contract forbids", () => {
    const bad = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
      expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow();
    bad(Session, { ...session, head: -1 });
    bad(Session, { ...session, engine: "claude-code" });
    bad(Methods["turn.submit"].params, { session_id: "s1", kind: "steer", input: { text: "x" } });
    bad(Methods["turn.submit"].params, {
      request_id: "r1",
      session_id: "s1",
      kind: "now",
      input: { text: "x" },
    });
    bad(SessionEvent, { session_id: "s1", cursor: 1, at, type: "message.delta", payload: {} });
    // Caveman Code has no plan mode.
    bad(Methods["turn.submit"].params, { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "x" }, options: { mode: "plan" } });
    bad(SessionEvent, { session_id: "s1", cursor: 1, at, type: "ask.user", payload: { kind: "question", round: 0, questions: [] } });
    // Which providers the Caveman engine takes is the runtime's registry (engine.providers), not the schema's.
    bad(Methods["engine.account.add"].params, { request_id: "r3", engine: "caveman", provider: "mistral", key: "" });
    bad(Methods["engine.account.add"].params, { request_id: "r3", engine: "codex", key: "" });
    bad(Methods["mail.wait"].result, {
      messages: [{ ...mail, authority: "lead" }],
      finished: [],
      timed_out: false,
    });
  });

  test("paths stay inside the worktree and refs are never options", () => {
    const bad = (method: MethodName, params: object) =>
      expect(() => Schema.decodeUnknownSync(Methods[method].params)({ workspace_id: "w1", ...params })).toThrow();
    for (const path of ["/Users/me/.claude/.credentials.json", "../../.codex/auth.json", "a/../../b", "..", ""]) {
      bad("fs.read", { path });
      bad("fs.diff", { paths: [path] });
      bad("git.commit", { request_id: "r1", message: "m", paths: [path] });
      bad("term.open", { request_id: "r1", cols: 80, rows: 24, cwd: path });
    }
    for (const ref of ["--output=/Users/me/.zshrc", "-p", "main..evil", "HEAD:secret", "a b"]) {
      bad("fs.read", { path: "a.go", ref });
      bad("fs.diff", { from: ref });
      bad("fs.diff", { to: ref });
      bad("workspace.create", { request_id: "r1", repo: { path: "/r" }, base_ref: ref });
      bad("workspace.create", { request_id: "r1", repo: { path: "/r" }, branch: ref });
    }
    // A checkpoint id as checkpoint.created carries it reads and diffs; the runtime resolves it, so git never sees its colons.
    const checkpoint = "checkpoint:scope:checkpoint-scope%3Athread%3Acaveman%253A57aa42c1-05f8-4373-a885-4ae3640394c8%3Aname%3Aroot:name:1";
    roundTrip(Methods["fs.diff"].params, { workspace_id: "w1", from: checkpoint, to: checkpoint });
    roundTrip(Methods["fs.read"].params, { workspace_id: "w1", path: "a.go", ref: checkpoint });
    for (const ref of ["checkpoint:a..b", "checkpoint:a b", "checkpoint:", "HEAD:checkpoint:x"]) {
      bad("fs.read", { path: "a.go", ref });
      bad("fs.diff", { from: ref });
    }
    // Only reads take a checkpoint id: a workspace starts from a git ref.
    bad("workspace.create", { request_id: "r1", repo: { path: "/r" }, base_ref: checkpoint });
    const panel = (entry: string) =>
      Schema.decodeUnknownSync(PanelContribution)({ id: "p", title: "P", placement: "settings", entry });
    expect(panel("https://plugins.example.com/panel.html").entry).toBeTruthy();
    expect(panel("panel/index.html").entry).toBeTruthy();
    for (const entry of ["javascript:alert(1)", "data:text/html,x", "http://x.dev", "/etc/passwd", "../x"]) {
      expect(() => panel(entry)).toThrow();
    }
  });
});

test("error codes are distinct and in the server range", () => {
  const codes = Object.values(ErrorCodes);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) expect(code <= -32000 && code >= -32099).toBe(true);
});

test("exactly the state-changing methods carry request_id", () => {
  const notMutating = (Object.keys(Methods) as MethodName[]).filter((m) => !isMutating(m));
  expect(notMutating.sort()).toEqual(
    [
      "runtime.hello",
      "workspace.list",
      "workspace.get",
      "session.attach",
      "direct.offer",
      "direct.candidate",
      "session.detach",
      "session.move.check",
      "session.move.held",
      "fs.diff",
      "fs.read",
      "media.read",
      "fs.list",
      "fs.search",
      "chat.search",
      "chat.find",
      "editor.list",
      "companion.list",
      "actions.list",
      "computer.screencast",
      "workspace.servers",
      "term.list",
      "term.attach",
      "term.detach",
      "tool.watch",
      "tool.unwatch",
      "suggestion.watch",
      "suggestion.unwatch",
      "tool.diff",
      "git.status",
      "keybindings.get",
      "memory.status",
      "memory.list",
      "memory.history",
      "browser.screencast",
      "browser.snapshot",
      "browser.readFile",
      "htmlRender.read",
      "attachment.read",
      "mail.wait",
      "engine.list",
      "engine.commands",
      "engine.providers",
      "web.keys.status",
      "secret_provider.list",
      "environment.get",
      "environment.draft",
      "environment.build.get",
      "environment.build.log",
      "environment.ci",
      "environment.list",
      "environment.versions",
      "environment.proposals",
      "settings.get",
      "agent.types",
      "setup.scan",
      "cloud.status",
      "cloud.lid.summary",
      "cloud.computers",
      "account.get",
      // A report is prepared, described and listed without changing anything; only send and delete do.
      "bug_report.prepare",
      "bug_report.describe",
      "bug_report.list",
      "account.gifts",
      "plugin.list",
      "mcp.list",
      "mcp.import_scan",
      "mcp.tools",
      "mcp.skipped",
      "connector.list",
    "device.agents",
    "device.awake",
    "device.hello",
    "device.list",
      "automation.list",
      "automation.deliveries",
      "automation.check",
      "automation.explain",
      "automation.templates",
      "automation.file_read",
      "automation.runs",
      "automation.run_get",
      "automation.cloud_runs",
      "automation.cloud_list",
      "agent.published",
      "skill.list",
      "skill.read",
      "rule.list",
      "rule.read",
      "plugin.read",
      "marketplace.list",
      "import.scan",
      "cloud.access_log",
      "cloud.client_token",
      "cloud.holdings",
      "cloud.profile.status",
      "queue.list",
      "repo.list",
      "project.list",
      "project.branches",
      "project.discover",
      "project.logo.candidates",
      "project.logo.read",
      "github.status",
      "github.issues",
      "git.installed",
      "secret.list",
      "secret.env_files",
      "message.caveman_version",
      "workspace.digest",
      "outside_agent.become",
      "outside_agent.list",
      "spend.summary",
      // Its `ack` only drops what the caller already delivered: asking again changes nothing.
      "telemetry.turns",
      "computer.access",
      "chief.get",
      "chief.list",
      "chief.items.list",
      "chief.change_sets.list",
      // What a Chief has put in the sidebar; only chief.view.dismiss changes it.
      "chief.view.get",
      "pr.list",
      "pr.get",
      "pr.diff",
      "pr.discussion",
      "pr.guide",
      "pr.file",
      "pr.symbol",
    ].sort(),
  );
});

test("session.move carries the signature of the device that asked, which a target Mac checks, or none", () => {
  const params = Methods["session.move"].params;
  const move = { request_id: "r1", session_id: "s1", to: { computer_id: "c2" } };
  roundTrip(params, move);
  roundTrip(params, { ...move, device: { device_id: "d1", at, signature: "c2lnbmVk" } });
  for (const device of [{ device_id: "d1", at }, { at, signature: "x" }, { device_id: 1, at, signature: "x" }, "d1"])
    expect(() => Schema.decodeUnknownSync(params)({ ...move, device })).toThrow();
});

test("committed JSON Schema matches the Effect schemas (run `pnpm schema` to update)", () => {
  expect(readFileSync(schemaPath, "utf8")).toBe(buildJsonSchema());
});
