// `caveman-runtime agent exec` on a real stack: the built command (bin.ts) spawned as Cloud's worker and the Agent SDK
// spawn it, the Caveman harness its engine, against a loopback model endpoint that speaks the real wires
// (fakeModel.testkit.ts). What the engine put on the wire is read from the endpoint's own record of the request bodies.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { startGitLane, startSandboxFake } from "@caveman-ai/harness/testing";

import { startFakeGate, type FakeGate, type GateCall, type GateTool } from "./fakeGate.testkit.ts";
import { lastText, startFakeModel, turnRequests, type FakeModel, type FakeReply, type FakeRequest } from "./fakeModel.testkit.ts";
import { environmentOf } from "../testUtils/processEnvironment.ts";
import { parseExecFlags, UsageError } from "./flags.ts";
import { resolveExecModel } from "./model.ts";
import { readSandboxFile, readSandboxSecrets } from "./sandboxFile.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const KEY = "sk-exec-test-0123456789abcdefSECRET";

interface Event {
  readonly seq: number;
  readonly type: string;
  readonly created_at: string;
  readonly data: Record<string, unknown>;
}

interface Run {
  readonly code: number;
  readonly events: ReadonlyArray<Event>;
  readonly stderr: string;
  /** From spawn to the first session.status line. */
  readonly firstStatusMs: number | undefined;
}

const models: Array<FakeModel> = [];
const gates: Array<FakeGate> = [];
afterEach(async () => {
  await Promise.all([...models.splice(0), ...gates.splice(0)].map((server) => server.close()));
});

async function model(script: (request: FakeRequest, n: number) => FakeReply) {
  const started = await startFakeModel(script);
  models.push(started);
  return started;
}

/** A temp directory with these files (paths relative to it). */
function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-exec-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const agentFile = (front: string, body: string) => `---\n${front.trim()}\n---\n${body}\n`;

/** Spawns the command; `onEvent` may answer on stdin (and close it). */
function exec(
  args: ReadonlyArray<string>,
  options: { readonly env?: Record<string, string | undefined>; readonly onEvent?: (event: Event, stdin: NodeJS.WritableStream, pid: number) => void; readonly stdin?: string } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries({ ...process.env, ...options.env })) if (value !== undefined) env[name] = value;
    const started = performance.now();
    const child = spawn(process.execPath, [BIN, "agent", "exec", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    const events: Array<Event> = [];
    let firstStatusMs: number | undefined;
    let out = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      let at: number;
      while ((at = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, at);
        out = out.slice(at + 1);
        const event = JSON.parse(line) as Event;
        if (event.type === "session.status" && firstStatusMs === undefined) firstStatusMs = performance.now() - started;
        events.push(event);
        options.onEvent?.(event, child.stdin, child.pid ?? 0);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, events, stderr, firstStatusMs }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

const types = (run: Run) => run.events.map((e) => e.type);
const statuses = (run: Run) => run.events.filter((e) => e.type === "session.status").map((e) => `${e.data.status}/${e.data.stop_reason}`);
const env = (fake: FakeModel, extra: Record<string, string> = {}) => ({ CAVEMAN_MODEL_BASE_URL: `${fake.url}/v1`, CAVEMAN_MODEL_API_KEY: KEY, ...extra });

const BILLING = agentFile(
  `
name: billing
computer: none
tools:
  - type: custom
    name: lookup_invoice
    description: Find an invoice by id
    input_schema: { type: object, properties: { id: { type: string } }, required: [id] }
`,
  "You answer billing questions. Look invoices up with lookup_invoice before you answer.",
);

describe("flags", () => {
  const base = ["--cwd", "/tmp", "--agent", "a", "--task-file", "t.md", "--events", "-"];
  it("takes C5's flags, the SDK's additions, and refuses the rest with a usage error", () => {
    expect(parseExecFlags([...base, "--model", "fast", "--max-seconds=60", "--max-cost-usd", "0.5", "--input", "-"])).toEqual({
      cwd: "/tmp", agent: "a", taskFile: "t.md", events: "-", input: "-", model: "fast", maxSeconds: 60, maxCostUsd: 0.5, access: "full",
    });
    expect(parseExecFlags(["--cwd", "/tmp", "--agent-file", "x.md", "--task-file", "-", "--events", "out.jsonl", "--access", "auto"])).toMatchObject({ agentFile: "x.md", taskFile: "-", access: "auto" });
    expect(parseExecFlags(["--help"])).toBe("help");
    expect(parseExecFlags([...base, "--sandbox-file", "sandbox.json"])).toMatchObject({ sandboxFile: "sandbox.json" });
    for (const [argv, why] of [
      [["--agent", "a", "--task-file", "t", "--events", "-"], /--cwd is required/],
      [[...base, "--agent-file", "x.md"], /exactly one of --agent and --agent-file/],
      [["--cwd", "/tmp", "--task-file", "t", "--events", "-"], /exactly one of --agent and --agent-file/],
      [["--cwd", "/tmp", "--agent", "a", "--task-file", "-", "--events", "-", "--input", "-"], /--input - already takes/],
      [[...base, "--input", "file.jsonl"], /--input takes -/],
      [[...base, "--max-seconds", "0"], /positive number/],
      [[...base, "--max-cost-usd", "lots"], /positive number/],
      [[...base, "--access", "yolo"], /full, auto or ask/],
      [[...base, "--frobnicate", "1"], /unknown flag --frobnicate/],
      [["--cwd", "/tmp", "--agent", "../etc/passwd", "--task-file", "t", "--events", "-"], /not an agent name/],
      [[...base, "--model"], /--model needs a value/],
      [[...base, "--sandbox-file", " "], /--sandbox-file needs a value/],
    ] as const) {
      expect(() => parseExecFlags(argv)).toThrow(UsageError);
      expect(() => parseExecFlags(argv)).toThrow(why);
    }
  });
});

describe("model classes", () => {
  it("resolve in the runtime's class table within the endpoint's family; an unknown family takes ids only", () => {
    const fast = resolveExecModel("fast", "anthropic");
    expect(fast).toMatchObject({ model: expect.stringMatching(/^anthropic\/claude-haiku/) });
    expect(resolveExecModel("frontier", "anthropic")).toMatchObject({ model: expect.stringMatching(/^anthropic\/claude-opus/) });
    expect(resolveExecModel("base", "openai")).toMatchObject({ model: expect.stringMatching(/^openai\/gpt-.*astra/) });
    expect(resolveExecModel("auto", "anthropic")).toEqual({ model: "anthropic/claude-sonnet-5-5" });
    expect(resolveExecModel(undefined, "openai")).toEqual({ model: "openai/gpt-6.1-sol" });
    expect(resolveExecModel("anthropic/claude-opus-5", undefined)).toEqual({ model: "anthropic/claude-opus-5" });
    expect(resolveExecModel("fast", undefined)).toMatchObject({ error: expect.stringMatching(/CAVEMAN_MODEL_PROVIDER/) });
  });
});

describe("agent exec", () => {
  it("runs a general agent (computer: none) whose custom tool is answered over stdin, and ends when stdin does", async () => {
    const fake = await model((request, n) =>
      n === 0 ? { tools: [{ name: "lookup_invoice", args: { id: "4411" } }] } : { text: `Charged twice per ${lastText(request.body).slice(0, 60)}` },
    );
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Customer 4411 says they were charged twice" });
    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
      env: env(fake),
      onEvent: (event, stdin) => {
        if (event.type === "requires_action") stdin.write(`${JSON.stringify({ type: "user.tool_result", ask_id: event.data.ask_id, content: '{"charges":[12,12]}' })}\n`);
        if (event.type === "session.status" && event.data.status === "idle") stdin.end();
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(types(run)).toEqual([
      "user.message", "session.status", "session.usage", "agent.tool_use", "requires_action", "session.status", "session.status",
      "agent.tool_result", "agent.message", "session.usage", "session.status", "session.status",
    ]);
    expect(run.events.map((e) => e.seq)).toEqual(run.events.map((_, i) => i + 1));
    expect(run.events[1]!.data).toEqual({ status: "running", stop_reason: null, model: "gpt-test" });
    expect(run.events.find((e) => e.type === "requires_action")!.data).toMatchObject({ kind: "tool", name: "lookup_invoice", input: { id: "4411" } });
    expect(run.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: false, output: '{"charges":[12,12]}' });
    expect(statuses(run).slice(-2)).toEqual(["idle/end_turn", "terminated/end_turn"]);
    // The general shape: its own instructions are the whole system prompt, its tools exactly its declared ones.
    const first = turnRequests(fake)[0]!.body as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> };
    expect(first.messages[0]!.role).toBe("system");
    expect(String(first.messages[0]!.content)).toBe("You answer billing questions. Look invoices up with lookup_invoice before you answer.");
    expect(first.tools.map((t) => t.function.name)).toEqual(["lookup_invoice"]);
    expect(lastText(first as never)).toContain("Customer 4411 says they were charged twice");
    expect(lastText(turnRequests(fake)[1]!.body)).toContain('{"charges":[12,12]}');
    // The key never reaches the events.
    expect(JSON.stringify(run.events)).not.toContain(KEY);
  });

  it("a custom tool's input past 64 KiB reaches the caller whole, so its handler acts on what the agent sent", async () => {
    const content = "a".repeat(70 * 1024);
    const fake = await model((_request, n) => (n === 0 ? { tools: [{ name: "save_file", args: { path: "notes.md", content } }] } : { text: "Saved." }));
    const writer = agentFile(
      `
name: writer
computer: none
tools:
  - type: custom
    name: save_file
    description: Save a file
    input_schema: { type: object, properties: { path: { type: string }, content: { type: string } }, required: [path, content] }
`,
      "You save what you are given with save_file.",
    );
    const dir = workspace({ ".caveman/agents/writer.md": writer, "task.md": "Save a long file." });
    const run = await exec(["--cwd", dir, "--agent", "writer", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
      env: env(fake),
      onEvent: (event, stdin) => {
        if (event.type === "requires_action") stdin.write(`${JSON.stringify({ type: "user.tool_result", ask_id: event.data.ask_id, content: "saved" })}\n`);
        if (event.type === "session.status" && event.data.status === "idle") stdin.end();
      },
    });
    expect(run.code, run.stderr).toBe(0);
    const ask = run.events.find((e) => e.type === "requires_action")!.data;
    const input = ask.input as { path?: string; content?: string } | string;
    expect({ input: typeof input === "string" ? `a string of ${input.length}` : { path: input.path, content: input.content?.length }, truncated: ask.truncated ?? false }).toEqual({
      input: { path: "notes.md", content: content.length },
      truncated: false,
    });
  });

  it("a coding agent edits a file in place; its custom tools are the client server's, declared beside the coding tools", async () => {
    const fake = await model((request, n) => {
      if (n === 0) return { tools: [{ name: "write", args: { path: "hello.txt", content: "hello from the agent\n" } }] };
      return { text: "Wrote hello.txt." };
    });
    const dir = workspace({
      ".caveman/agents/builder.md": agentFile("name: builder\ncomputer: full\ntools:\n  - type: custom\n    name: finish\n    description: End with a result\n    input_schema: { type: object, properties: { summary: { type: string } } }", "You build things."),
      "task.md": "Write hello.txt",
    });
    const run = await exec(["--cwd", dir, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe("hello from the agent\n");
    expect(run.events.find((e) => e.type === "agent.tool_use")!.data).toMatchObject({ name: "write_file" });
    const first = turnRequests(fake)[0]!.body as { messages: Array<{ content: unknown }>; tools: Array<{ function: { name: string } }> };
    // The loadout an OpenAI-compatible model runs on (Claude Code's compact surface), the custom tools the client server's.
    const names = first.tools.map((t) => t.function.name);
    expect(names).toEqual(["bash", "edit", "read", "wait", "write", "client__finish"]);
    expect(String(first.messages[0]!.content)).toMatch(/^You are a coding agent/);
    // The agent's file reaches the engine as before: a header on the first message (after the harness's env block), the task after it.
    expect(lastText(first as never)).toMatch(/^<env>\ncwd: [^\n]+\n(os: [^\n]+\n)?(shell: [^\n]+\n)?<\/env>\n\nYou are the builder agent\.\n\nYou build things\.\n\n---\n\nWrite hello\.txt$/);
  });

  it("finish ends the run at once with the caller's result (C5), in either shape", async () => {
    for (const computer of ["none", "full"] as const) {
      const fake = await model(() => ({ tools: [{ name: computer === "none" ? "finish" : "client__finish", args: { outcome: "changed", commit: "abc" } }] }));
      const dir = workspace({
        ".caveman/agents/engineer.md": `---\n{"name": "engineer", "computer": "${computer}", "model": "anthropic/claude-opus-5", "tools": [{"type": "custom", "name": "finish", "description": "End this session with its result.", "input_schema": {"type": "object", "properties": {"outcome": {"type": "string"}, "commit": {"type": "string"}}}}]}\n---\nFix the bug, then call finish.\n`,
        "task.md": "Fix it",
      });
      const run = await exec(["--cwd", dir, "--agent", "engineer", "--task-file", "task.md", "--events", "-"], { env: env(fake) });
      expect(run.code, run.stderr).toBe(0);
      const finish = run.events.find((e) => e.type === "requires_action")!;
      expect(finish.data).toMatchObject({ kind: "tool", name: "finish", input: { outcome: "changed", commit: "abc" } });
      expect(run.events.at(-1)!.data).toEqual({ status: "terminated", stop_reason: "end_turn" });
      expect(run.events.slice(run.events.indexOf(finish) + 1).map((e) => e.type)).toEqual(["session.status", "session.status"]);
      expect(turnRequests(fake)).toHaveLength(1);
      // The model id goes as given to an endpoint of unknown family (Cloud's gateway, the broker).
      expect(turnRequests(fake)[0]!.body.model).toBe("anthropic/claude-opus-5");
    }
  });

  it("without --input a custom tool returns an error to the model and an approval is refused", async () => {
    const fake = await model((request, n) =>
      n === 0 ? { tools: [{ name: "lookup_invoice", args: { id: "1" } }] } : n === 1 ? { tools: [{ name: "bash", args: { command: "echo should-not-run" } }] } : { text: "done" },
    );
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Look 1 up" });
    const general = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake) });
    expect(general.code, general.stderr).toBe(0);
    expect(types(general)).not.toContain("requires_action");
    expect(general.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: true, output: expect.stringContaining("without an input channel") });

    const coding = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), "task.md": "Say hi" });
    const fake2 = await model((_, n) => (n === 0 ? { tools: [{ name: "bash", args: { command: "echo should-not-run" } }] } : { text: "done" }));
    const refused = await exec(["--cwd", coding, "--agent", "ops", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--access", "auto"], { env: env(fake2) });
    expect(refused.code, refused.stderr).toBe(0);
    expect(types(refused)).not.toContain("requires_action");
    expect(refused.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: true, output: expect.stringContaining("cave_tool_denied:no_one_to_ask") });
    expect(lastText(turnRequests(fake2)[1]!.body)).not.toContain("should-not-run\n");
  });

  it("asks for approval over stdin (--access auto): allow runs the command, deny declines it with the caller's note", async () => {
    const fake = await model((request, n) =>
      n === 0 ? { tools: [{ name: "bash", args: { command: "echo approved-run" } }] } : n === 1 ? { tools: [{ name: "bash", args: { command: "echo denied-run" } }] } : { text: `done: ${lastText(request.body).slice(0, 80)}` },
    );
    const dir = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), "task.md": "Run two commands" });
    let approvals = 0;
    const run = await exec(["--cwd", dir, "--agent", "ops", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test", "--access", "auto"], {
      env: env(fake),
      onEvent: (event, stdin) => {
        if (event.type === "requires_action" && event.data.kind === "approval") {
          const allow = approvals++ === 0;
          stdin.write(`${JSON.stringify({ type: "user.approval", ask_id: event.data.ask_id, decision: allow ? "allow" : "deny", ...(allow ? {} : { message: "Not that one." }) })}\n`);
        }
        if (event.type === "session.status" && event.data.status === "idle") stdin.end();
      },
    });
    expect(run.code, run.stderr).toBe(0);
    const asks = run.events.filter((e) => e.type === "requires_action");
    expect(asks.map((e) => [e.data.kind, e.data.name, e.data.question])).toEqual([
      ["approval", "bash", "Run echo approved-run"],
      ["approval", "bash", "Run echo denied-run"],
    ]);
    const results = run.events.filter((e) => e.type === "agent.tool_result").map((e) => e.data);
    expect(results[0]).toMatchObject({ is_error: false, output: expect.stringContaining("approved-run") });
    expect(results[1]).toMatchObject({ is_error: true, output: expect.stringContaining("cave_tool_denied:declined") });
    // The note with the denial reached the agent as the caller's message.
    expect(run.events.filter((e) => e.type === "user.message").map((e) => e.data.text)).toContain("Not that one.");
  });

  it("stdin steers: an interrupt stops the turn without ending the session, a message starts the next, a bad line is skipped", async () => {
    // The interrupt goes once the first turn's model call has arrived, and that call answers only once the turn is seen
    // stopped: on a loaded machine a stop on a timer could land before the call (the second turn then took its reply)
    // or after its reply.
    let called!: () => void;
    const inFlight = new Promise<void>((resolve) => (called = resolve));
    let stopped!: () => void;
    const turnStopped = new Promise<void>((resolve) => (stopped = resolve));
    const fake = await model((request, n) => {
      if (n > 0) return { text: `reply to: ${lastText(request.body)}` };
      called();
      return { text: "slow", until: turnStopped };
    });
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "First question" });
    let interrupted = false;
    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
      env: env(fake),
      onEvent: (event, stdin) => {
        if (event.type === "session.status" && event.data.status === "running" && !interrupted) {
          interrupted = true;
          // Once the turn's model call is out: a message steered in, which the Stop right behind it drops before the
          // agent reads it.
          void inFlight.then(() => stdin.write(`${JSON.stringify({ type: "user.message", text: "Never mind", input_id: "in_9" })}\nthis is not json\n{"type":"user.interrupt"}\n`));
        }
        if (event.type === "session.status" && event.data.stop_reason === "interrupted") {
          stopped();
          stdin.write(`${JSON.stringify({ type: "user.message", text: "Second question" })}\n`);
        }
        if (event.type === "session.status" && event.data.stop_reason === "end_turn" && event.data.status === "idle") stdin.end();
        if (event.type === "user.answer") stdin.end();
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.events.filter((e) => e.type === "session.error").map((e) => e.data)).toEqual([
      { code: "input_invalid", message: expect.stringContaining("not JSON") },
      { code: "message_refused", message: "The turn was stopped before the agent read this message.", input_id: "in_9" },
    ]);
    expect(statuses(run)).toEqual(["running/null", "idle/interrupted", "running/null", "idle/end_turn", "terminated/end_turn"]);
    // The stop cut a model call short; its reply, sent after the stop, is never said.
    expect(turnRequests(fake).map((request) => lastText(request.body))).toEqual([expect.stringContaining("First question"), "Second question"]);
    expect(run.events.filter((e) => e.type === "agent.message").map((e) => e.data.text)).toEqual(["reply to: Second question"]);
  });

  it("says which input each message on stdin was: steered into the running turn, starting the next, or dropped by a Stop", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => (asked = resolve));
    const fake = await model((request, n) => {
      if (n === 0) asked();
      return n === 0 ? { text: "first", until: held } : { text: `reply to: ${lastText(request.body)}` };
    });
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "First question" });
    const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
    let idles = 0;
    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
      env: env(fake),
      onEvent: (event, stdin) => {
        // While the task's turn waits on the model: a message, then a bad line whose refusal says exec read the message.
        if (event.type === "session.status" && event.data.status === "running" && idles === 0) {
          void requested.then(() => stdin.write(`${line({ type: "user.message", text: "Also check 4412", input_id: "in_1" })}not json\n`));
        }
        if (event.type === "session.error" && event.data.code === "input_invalid") release();
        if (event.type === "session.status" && event.data.status === "idle" && ++idles === 1) stdin.write(line({ type: "user.message", text: "Second question", input_id: "in_2" }));
        // A Stop with the next message while no turn runs, and the input's end: the message never runs.
        if (event.type === "session.status" && event.data.status === "idle" && idles === 2) stdin.end(line({ type: "user.message", text: "Third", input_id: "in_3" }) + line({ type: "user.interrupt" }));
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(statuses(run)).toEqual(["running/null", "idle/end_turn", "running/null", "idle/end_turn", "terminated/end_turn"]);
    expect(run.events.filter((e) => e.type === "user.message").map((e) => e.data)).toEqual([
      { text: "First question", origin: "api" },
      { text: "Also check 4412", origin: "api", input_id: "in_1" },
      { text: "Second question", origin: "api", input_id: "in_2" },
    ]);
    // The steered message is the task's turn's; the next one opened its own.
    const at = (input: string) => run.events.findIndex((e) => e.type === "user.message" && e.data.input_id === input);
    const firstIdle = run.events.findIndex((e) => e.type === "session.status" && e.data.status === "idle");
    expect(at("in_1")).toBeLessThan(firstIdle);
    expect(at("in_2")).toBeGreaterThan(firstIdle);
    expect(run.events.filter((e) => e.type === "session.error" && e.data.input_id !== undefined).map((e) => e.data)).toEqual([
      { code: "message_refused", message: "A Stop came before this message ran.", input_id: "in_3" },
    ]);
    expect(turnRequests(fake).map((request) => lastText(request.body))).toEqual([expect.stringContaining("First question"), "Also check 4412", "Second question"]);
  });

  it("a message while a turn runs steers it, said once as the caller's; the next turn goes on in the same conversation", async () => {
    const fake = await model((request, n) =>
      n === 0 ? { tools: [{ name: "bash", args: { command: "sleep 1; echo slept" } }] } : { text: `heard: ${lastText(request.body).slice(0, 40)}` },
    );
    const dir = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), "task.md": "Run the slow check" });
    let idle = 0;
    const run = await exec(["--cwd", dir, "--agent", "ops", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
      env: env(fake),
      onEvent: (event, stdin) => {
        if (event.type === "agent.tool_use") stdin.write(`${JSON.stringify({ type: "user.message", text: "Also say hi" })}\n`);
        if (event.type === "session.status" && event.data.status === "idle" && idle++ === 0) stdin.write(`${JSON.stringify({ type: "user.message", text: "And now?" })}\n`);
        else if (event.type === "session.status" && event.data.status === "idle") stdin.end();
      },
    });
    expect(run.code, run.stderr).toBe(0);
    // The steer rode the running turn: its next request carries it after the command's result.
    const requests = turnRequests(fake);
    expect(requests).toHaveLength(3);
    expect(lastText(requests[1]!.body)).toBe("Also say hi");
    expect(run.events.filter((e) => e.type === "user.message").map((e) => e.data.text)).toEqual(["Run the slow check", "Also say hi", "And now?"]);
    expect(statuses(run)).toEqual(["running/null", "idle/end_turn", "running/null", "idle/end_turn", "terminated/end_turn"]);
    // The second turn is the same conversation: the task, the command, the steer and the reply before it.
    const second = JSON.stringify(requests[2]!.body.messages);
    for (const said of ["Run the slow check", "slept", "Also say hi", "heard: Also say hi"]) expect(second).toContain(said);
    expect(lastText(requests[2]!.body)).toBe("And now?");
  });

  it("removes CAVEMAN_MODEL_BASE_URL and CAVEMAN_MODEL_API_KEY from every command the agent runs", async () => {
    // The same bash on every platform: /bin/sh, and Git for Windows' bash on Windows.
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "bash", args: { command: "env; echo exit-$?" } }] } : { text: "done" }));
    const dir = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), "task.md": "Print the environment" });
    const run = await exec(["--cwd", dir, "--agent", "ops", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake, { CANARY_VISIBLE: "canary-ok" }) });
    expect(run.code, run.stderr).toBe(0);
    const output = String(run.events.find((e) => e.type === "agent.tool_result")!.data.output);
    expect(output).toContain("exit-0");
    expect(output).not.toContain("CAVEMAN_MODEL_");
    expect(output).not.toContain(KEY);
    // Commands get the allowlisted environment (PATH, HOME, ...), never this process's whole one.
    expect(output).not.toContain("canary-ok");
    // And what the model was sent of it.
    for (const request of fake.requests) expect(request.raw).not.toContain(KEY);
  });

  it("runs the bash a model writes on every platform: an export, a chain, a quoted expansion, a pipe into tr", async () => {
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "bash", args: { command: 'export A=1 && echo "$A" | tr 1 2' } }] } : { text: "done" }));
    const dir = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), "task.md": "Run it" });
    const run = await exec(["--cwd", dir, "--agent", "ops", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    expect(run.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: false, output: "exit 0\n2" });
  });

  it("a general agent declares its own MCP servers' tools, by name, and the servers never see the model key", async () => {
    // A stdio MCP server: newline-delimited JSON-RPC, one tool that says what its environment holds.
    const server = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
      rl.on("line", (line) => {
        const { id, method, params } = JSON.parse(line);
        if (id === undefined) return;
        if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "orders", version: "1" } } });
        if (method === "tools/list") return send({ id, result: { tools: [{ name: "order_status", description: "An order's status", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] } });
        if (method === "tools/call") {
          const leaked = Object.keys(process.env).filter((k) => k.startsWith("CAVEMAN_MODEL_") || process.env[k] === ${JSON.stringify(KEY)});
          return send({ id, result: { content: [{ type: "text", text: "shipped; greeting=" + process.env.GREETING + "; leaked=" + leaked.join(",") }] } });
        }
        send({ id, result: {} });
      });`;
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "orders__order_status", args: { id: "9" } }] } : { text: "Order 9 shipped." }));
    const dir = workspace({
      "orders.cjs": server,
      ".caveman/agents/support.md": agentFile(
        `name: support\ncomputer: none\nmcpServers:\n  orders:\n    command: ${JSON.stringify(process.execPath)}\n    args: [orders.cjs]\n    env: { GREETING: "\${EXEC_TEST_GREETING}" }`,
        "You answer order questions.",
      ),
      "task.md": "Where is order 9?",
    });
    // Its cwd: stdio servers start in the home directory unless they say, never the workspace.
    const file = path.join(dir, ".caveman/agents/support.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("args: [orders.cjs]", `args: [${JSON.stringify(path.join(dir, "orders.cjs"))}]`));
    const run = await exec(["--cwd", dir, "--agent", "support", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake, { EXEC_TEST_GREETING: "hello" }) });
    expect(run.code, run.stderr).toBe(0);
    const names = (turnRequests(fake)[0]!.body as { tools: Array<{ function: { name: string } }> }).tools.map((t) => t.function.name);
    expect(names).toEqual(["orders__order_status"]);
    // The caller sees it by the name approvals and the app give MCP tools.
    expect(run.events.find((e) => e.type === "agent.tool_use")!.data).toMatchObject({ name: "mcp__orders__order_status", input: { id: "9" } });
    expect(run.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: false, output: "shipped; greeting=hello; leaked=" });
  });

  it("writes to an --events file, and stops at --max-cost-usd (exit 3) and --max-seconds (exit 4) with budget_reached", async () => {
    const fake = await model(() => ({ text: "expensive", usage: { input: 2_000_000, output: 1_000 } }));
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Spend" });
    // Relative to --cwd, like --task-file.
    const file = path.join(dir, "events.jsonl");
    const budget = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "events.jsonl", "--model", "anthropic/claude-haiku-4-5", "--max-cost-usd", "0.01"], { env: env(fake) });
    expect(budget.code, budget.stderr).toBe(3);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Event);
    expect(lines.find((e) => e.type === "session.usage")!.data.cost_usd).toBeGreaterThan(0.01);
    expect(lines.find((e) => e.type === "session.error")!.data).toMatchObject({ code: "budget_exceeded" });
    expect(lines.at(-1)!.data).toEqual({ status: "terminated", stop_reason: "budget_reached" });

    const slow = await model(() => ({ text: "late", delayMs: 10_000 }));
    const time = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--max-seconds", "1"], { env: env(slow) });
    expect(time.code, time.stderr).toBe(4);
    expect(time.events.find((e) => e.type === "session.error")!.data).toMatchObject({ code: "time_limit" });
    expect(time.events.at(-1)!.data).toEqual({ status: "terminated", stop_reason: "budget_reached" });
  });

  it("takes the key from CAVEMAN_MODEL_API_KEY_FILE, deletes the file, and keeps the key out of its environment as ps reads it", async () => {
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Hi" });
    const seen: Array<string> = [];
    /** Reads the exec process's environment once its turn runs; the turn's model answers only after. */
    const reading = () => {
      let read!: () => void;
      const until = new Promise<void>((resolve) => (read = resolve));
      const onEvent = (event: Event, _: NodeJS.WritableStream, pid: number) => {
        if (event.type !== "session.status" || event.data.status !== "running") return;
        try {
          seen.push(environmentOf(pid));
        } catch (error) {
          seen.push(`unreadable: ${String(error)}`);
        } finally {
          read();
        }
      };
      return { until, onEvent };
    };
    // A variable the runtime leaves alone: the method read this process's environment.
    const canary = { EXEC_TEST_CANARY: "visible-to-ps" };
    // The method sees a key given in the environment (C5's way, which stays visible for the process's life)... On
    // Windows it reads the environment as it is now, which the runtime's delete rewrote (SetEnvironmentVariableW): a
    // key given there is gone from it as soon as the runtime takes it, so only the canary shows the read worked.
    const envRead = reading();
    const viaEnv = await model(() => ({ text: "ok", until: envRead.until }));
    const envRun = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(viaEnv, canary), onEvent: envRead.onEvent });
    expect(envRun.code, envRun.stderr).toBe(0);
    expect(seen[0]).toContain(canary.EXEC_TEST_CANARY);
    if (process.platform !== "win32") expect(seen[0]).toContain(KEY);
    // ...and finds none given in a file, which is gone once read; the endpoint still gets it.
    const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "exec-key-")), "key");
    fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    const fileRead = reading();
    const viaFile = await model(() => ({ text: "ok", until: fileRead.until }));
    const fileRun = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], {
      env: { CAVEMAN_MODEL_BASE_URL: `${viaFile.url}/v1`, CAVEMAN_MODEL_API_KEY_FILE: keyFile, ...canary },
      onEvent: fileRead.onEvent,
    });
    expect(fileRun.code, fileRun.stderr).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain(canary.EXEC_TEST_CANARY);
    expect(seen[1]).not.toContain(KEY);
    expect(seen[1]).not.toContain("CAVEMAN_MODEL_API_KEY=");
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(turnRequests(viaFile)[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    // An empty or missing file is a usage error that says what to do.
    fs.writeFileSync(keyFile, "\n");
    const empty = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-"], { env: { CAVEMAN_MODEL_BASE_URL: `${viaFile.url}/v1`, CAVEMAN_MODEL_API_KEY_FILE: keyFile } });
    expect(empty.code).toBe(2);
    expect(empty.events[0]!.data).toMatchObject({ code: "usage", message: expect.stringContaining("is empty") });
    const gone = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-"], { env: { CAVEMAN_MODEL_BASE_URL: `${viaFile.url}/v1`, CAVEMAN_MODEL_API_KEY_FILE: keyFile } });
    expect(gone.code).toBe(2);
    expect(gone.events[0]!.data).toMatchObject({ code: "usage", message: expect.stringContaining("cannot be read (ENOENT)") });
  });

  it("never says the key on stderr either", async () => {
    const fake = await model(() => ({ text: "ok" }));
    // Servers whose failure carries the key, each a notice on stderr: one whose command names it (on Windows the spawn
    // goes through cmd.exe, whose error does not repeat the command), and one that says it on its own stderr and exits.
    const says = ["-e", "process.stderr.write(process.argv[1] + '\\n'); process.exit(1)", KEY].map((arg) => JSON.stringify(arg)).join(", ");
    const servers = `  orders: { command: "/nonexistent/${KEY}" }\n  echoes: { command: ${JSON.stringify(process.execPath)}, args: [${says}] }`;
    const dir = workspace({ ".caveman/agents/leaky.md": agentFile(`name: leaky\ncomputer: none\nmcpServers:\n${servers}`, "x"), "task.md": "Hi" });
    const run = await exec(["--cwd", dir, "--agent", "leaky", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("MCP server orders");
    expect(run.stderr).toContain("MCP server echoes");
    // On Windows both servers fail as "MCP connection closed", with neither the command nor the server's stderr in it, so
    // there is nothing there to redact; the key still must not show.
    if (process.platform !== "win32") expect(run.stderr).toContain("[redacted]");
    expect(run.stderr).not.toContain(KEY);
  });

  it("stdin ending while an approval or a custom tool waits refuses it at once and ends with terminated, exit 0", async () => {
    for (const [agent, call] of [
      ["ops", { name: "bash", args: { command: "echo hi" } }],
      ["billing", { name: "lookup_invoice", args: { id: "1" } }],
    ] as const) {
      const fake = await model((_, n) => (n === 0 ? { tools: [call] } : { text: "done" }));
      const dir = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), ".caveman/agents/billing.md": BILLING, "task.md": "go" });
      const started = Date.now();
      const run = await exec(["--cwd", dir, "--agent", agent, "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test", "--access", "auto"], {
        env: env(fake),
        onEvent: (event, stdin) => event.type === "requires_action" && stdin.end(),
      });
      expect(run.code, run.stderr).toBe(0);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(run.events.find((e) => e.type === "requires_action")).toBeDefined();
      expect(run.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: true });
      expect(statuses(run).at(-1)).toBe("terminated/end_turn");
    }
    // Ended before anything asked: an ask is refused without being said.
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "bash", args: { command: "echo hi" } }] } : { text: "done" }));
    const dir = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), "task.md": "go" });
    const closed = await exec(["--cwd", dir, "--agent", "ops", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test", "--access", "auto"], { env: env(fake), stdin: "" });
    expect(closed.code, closed.stderr).toBe(0);
    expect(types(closed)).not.toContain("requires_action");
    expect(closed.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: true, output: expect.stringContaining("cave_tool_denied:no_one_to_ask") });
    expect(statuses(closed).at(-1)).toBe("terminated/end_turn");
  });

  it("computer: readonly may not edit, and its commands ask: refused without --input, asked with it", async () => {
    const script = (_: FakeRequest, n: number): FakeReply =>
      n === 0 ? { tools: [{ name: "write", args: { path: "a.txt", content: "x" } }] } : n === 1 ? { tools: [{ name: "bash", args: { command: "echo pwned > a.txt; echo wrote" } }] } : { text: "done" };
    const files = { ".caveman/agents/ro.md": agentFile("name: ro\ncomputer: readonly", "Look only."), "task.md": "go" };
    const dir = workspace(files);
    const refused = await exec(["--cwd", dir, "--agent", "ro", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(await model(script)) });
    expect(refused.code, refused.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
    expect(refused.events.filter((e) => e.type === "agent.tool_result").map((e) => e.data.output)).toEqual(["cave_tool_denied:readonly_computer", "cave_tool_denied:readonly_computer"]);

    const asked = workspace(files);
    const run = await exec(["--cwd", asked, "--agent", "ro", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
      env: env(await model(script)),
      onEvent: (event, stdin) => {
        if (event.type === "requires_action") stdin.write(`${JSON.stringify({ type: "user.approval", ask_id: event.data.ask_id, decision: "deny" })}\n`);
        if (event.type === "session.status" && event.data.status === "idle") stdin.end();
      },
    });
    expect(run.code, run.stderr).toBe(0);
    // The edit is refused outright; the command asks (even under --access full) and the caller said no.
    expect(run.events.filter((e) => e.type === "requires_action").map((e) => [e.data.kind, e.data.name])).toEqual([["approval", "bash"]]);
    expect(fs.existsSync(path.join(asked, "a.txt"))).toBe(false);
  });

  it("a stop is never lost at a turn's start: an interrupt with the next message, a signal as a turn starts, a limit while idle", async () => {
    // An interrupt that arrives with the message it should stop: no second turn reaches the model.
    const quick = await model((request) => ({ text: `reply to: ${lastText(request.body)}` }));
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "First" });
    let sent = false;
    const dropped = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
      env: env(quick),
      onEvent: (event, stdin) => {
        if (event.type === "session.status" && event.data.status === "idle" && !sent) {
          sent = true;
          stdin.write(`${JSON.stringify({ type: "user.message", text: "Second" })}\n${JSON.stringify({ type: "user.interrupt" })}\n`);
          setTimeout(() => stdin.end(), 500);
        }
      },
    });
    expect(dropped.code, dropped.stderr).toBe(0);
    expect(turnRequests(quick)).toHaveLength(1);
    expect(statuses(dropped)).toEqual(["running/null", "idle/end_turn", "terminated/end_turn"]);

    // SIGTERM as the next turn starts: the turn stops at once rather than running out its slow model call. Windows has
    // no signals: process.kill there is TerminateProcess, which runs no handler, so no stop can be said on the way out.
    if (process.platform !== "win32") {
      const slow = await model((_, n) => (n === 0 ? { text: "first" } : { text: "late", delayMs: 15_000 }));
      let signaled = 0;
      const started = Date.now();
      const signal = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
        env: env(slow),
        onEvent: (event, stdin, pid) => {
          if (event.type === "session.status" && event.data.status === "idle" && signaled === 0) stdin.write(`${JSON.stringify({ type: "user.message", text: "Second" })}\n`);
          if (event.type === "user.message" && event.data.text === "Second" && signaled++ === 0) process.kill(pid, "SIGTERM");
        },
      });
      expect(signal.code, signal.stderr).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(statuses(signal).at(-1)).toBe("terminated/interrupted");
    }

    // The time limit while idle ends it without a turn that never ran.
    const idle = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test", "--max-seconds", "2"], { env: env(quick) });
    expect(idle.code, idle.stderr).toBe(4);
    expect(statuses(idle)).toEqual(["running/null", "idle/end_turn", "terminated/budget_reached"]);
  });

  it("exits 1 on a model error and 2 on usage: no endpoint, a bad agent file, a class on an endpoint of unknown family", async () => {
    const broken = await model(() => ({ status: 401 }));
    const dir = workspace({
      ".caveman/agents/billing.md": BILLING,
      ".caveman/agents/bad.md": agentFile("name: bad\ntools:\n  - type: custom\n    name: mcp__orders", "x"),
      ".caveman/agents/clash.md": agentFile("name: clash\ncomputer: none\nmcpServers:\n  caveman-web: { command: node }", "x"),
      ".caveman/agents/client.md": agentFile("name: client\nmcpServers:\n  client: { type: http, url: 'http://127.0.0.1:1/mcp' }", "x"),
      "task.md": "Hi",
    });
    const failed = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(broken) });
    expect(failed.code, failed.stderr).toBe(1);
    expect(failed.events.find((e) => e.type === "session.error")).toBeDefined();
    expect(failed.events.at(-1)!.data).toEqual({ status: "terminated", stop_reason: "error" });

    const base = ["--cwd", dir, "--task-file", "task.md", "--events", "-"];
    const noEndpoint = await exec([...base, "--agent", "billing"], { env: { CAVEMAN_MODEL_BASE_URL: undefined, CAVEMAN_MODEL_API_KEY: undefined } });
    expect(noEndpoint.code).toBe(2);
    expect(noEndpoint.events[0]!.data).toMatchObject({ code: "usage", message: expect.stringContaining("CAVEMAN_MODEL_BASE_URL") });
    const bad = await exec([...base, "--agent", "bad"], { env: env(broken) });
    expect(bad.code).toBe(2);
    expect(bad.events[0]!.data).toMatchObject({ code: "agent_invalid", message: expect.stringContaining("starts with mcp__") });
    // exec's own server names (its custom tools' `client`, the app's caveman-code and caveman*) are not an agent's to take.
    for (const name of ["clash", "client"]) {
      const clash = await exec([...base, "--agent", name], { env: env(broken) });
      expect(clash.code, name).toBe(2);
      expect(clash.events[0]!.data).toMatchObject({ code: "agent_invalid", message: expect.stringContaining("rename it") });
    }
    const missing = await exec([...base, "--agent", "nobody"], { env: env(broken) });
    expect(missing.code).toBe(2);
    expect(missing.events[0]!.data).toMatchObject({ code: "agent_invalid" });
    const klass = await exec([...base, "--agent", "billing", "--model", "fast"], { env: env(broken) });
    expect(klass.code).toBe(2);
    expect(klass.events[0]!.data).toMatchObject({ code: "model_invalid", message: expect.stringContaining("CAVEMAN_MODEL_PROVIDER") });
    const usage = await exec(["--agent", "billing"], { env: env(broken) });
    expect(usage.code).toBe(2);
    expect(usage.events).toEqual([]);
    expect(usage.stderr).toContain("--cwd is required");
  });

  it("an inline agent (--agent-file) on an Anthropic Messages endpoint, a class resolved within its family, echoed on the first status", async () => {
    const fake = await model(() => ({ text: "Hello." }));
    const dir = workspace({ "inline.md": agentFile("name: greeter\ncomputer: none", "You greet people."), "task.md": "Say hello" });
    const run = await exec(["--cwd", dir, "--agent-file", "inline.md", "--task-file", "task.md", "--events", "-", "--model", "fast"], {
      env: { CAVEMAN_MODEL_BASE_URL: fake.url, CAVEMAN_MODEL_API_KEY: KEY, CAVEMAN_MODEL_PROVIDER: "anthropic" },
    });
    expect(run.code, run.stderr).toBe(0);
    const status = run.events.find((e) => e.type === "session.status")!;
    expect(status.data.model).toMatch(/^anthropic\/claude-haiku/);
    const request = turnRequests(fake)[0]!;
    expect(new URL(request.path, fake.url).pathname).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(JSON.stringify(request.body.system)).toContain("You greet people.");
  });

  it("measures cold start: spawn to the first session.status", async () => {
    const fake = await model(() => ({ text: "ok" }));
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Hi" });
    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    console.info(`agent exec cold start: ${Math.round(run.firstStatusMs ?? -1)} ms to the first session.status`);
    expect(run.firstStatusMs).toBeLessThan(5_000);
  });
});

describe("agent exec on a Caveman sandbox (--sandbox-file, tier linux on the pool)", () => {
  /** Caveman Cloud's sandbox-file examples/sandbox-file.json, byte for byte: the file the pool writes. */
  const FIXTURE = fileURLToPath(new URL("./fixtures/sandbox-file.json", import.meta.url));
  const example = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, string>;
  const sandboxes: Array<{ readonly close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((box) => box.close()));
  });
  /**
   * A fake Caveman Cloud (the harness's, `@caveman-ai/harness/testing`) that takes the endpoint's key, as the session's,
   * running its computers' commands on this host with `remote` standing for their /workspace.
   */
  const cloud = async (remote: string, host?: string) => {
    const box = await startSandboxFake(KEY, { workspace: remote, ...(host === undefined ? {} : { host }) });
    sandboxes.push(box);
    return box;
  };
  /** The example, pointed at the fake: its session id, the fake's origin for the API and the relay. */
  const fileFor = (box: { readonly url: string }, computerId?: string) =>
    JSON.stringify({ session_id: example.session_id, api_url: box.url, relay_url: box.url, ...(computerId === undefined ? {} : { computer_id: computerId }) });
  const BUILDER = agentFile("name: builder\ncomputer: full", "You build things.");

  it("reads the pool's file as Caveman Cloud's example has it", () => {
    expect(readSandboxFile(FIXTURE)).toEqual({ sessionId: example.session_id, apiURL: example.api_url, relayURL: example.relay_url, computerId: example.computer_id });
  });

  it("reads the pool's file with a repository as Caveman Cloud's second example has it", () => {
    // Caveman Cloud's sandbox-file examples/sandbox-file-repository.json, byte for byte.
    const file = fileURLToPath(new URL("./fixtures/sandbox-file-repository.json", import.meta.url));
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string> & { repository: Record<string, string> };
    expect(readSandboxFile(file)).toEqual({
      sessionId: raw.session_id,
      apiURL: raw.api_url,
      relayURL: raw.relay_url,
      computerId: raw.computer_id,
      repository: { owner: raw.repository.owner, name: raw.repository.name, baseBranch: raw.repository.base_branch, gitURL: raw.repository.git_url },
    });
    expect(raw.repository).toEqual({ owner: "acme", name: "web", base_branch: "main", git_url: "http://172.16.0.1:47483/git/v1/acme/web.git" });
  });

  it("a coding agent's bash runs on the sandbox made at its first tool call, with the build's files; made and released come before terminated", async () => {
    const remote = workspace({});
    const box = await cloud(remote);
    let madeBeforeTheModel = -1;
    const fake = await model((request, n) => {
      if (n === 0) {
        madeBeforeTheModel = box.state.creates.length;
        return { tools: [{ name: "bash", args: { command: "echo on-the-sandbox > made.txt; pwd; env" } }] };
      }
      return { text: "Done." };
    });
    const dir = workspace({ ".caveman/agents/builder.md": BUILDER, "task.md": "Make a file", "sandbox.json": fileFor(box) });
    const run = await exec(["--cwd", dir, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--sandbox-file", "sandbox.json"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    expect(madeBeforeTheModel, "no computer before a tool needs one").toBe(0);
    // A create with no shape (control-api decides it), keyed by the session.
    expect(box.state.creates).toEqual([{ body: {}, idempotencyKey: `session-${example.session_id}` }]);
    expect(box.state.errors).toEqual([]);
    // The build's files are in the sandbox's /workspace (agent exec's own task and sandbox files are not), and the
    // command ran there, not in --cwd, its environment without the key (the sink would say [redacted]).
    expect(fs.readFileSync(path.join(remote, ".caveman/agents/builder.md"), "utf8")).toBe(BUILDER);
    expect(fs.readdirSync(remote).sort()).toEqual([".caveman", "made.txt"]);
    expect(fs.readFileSync(path.join(remote, "made.txt"), "utf8")).toBe("on-the-sandbox\n");
    expect(fs.existsSync(path.join(dir, "made.txt"))).toBe(false);
    const output = String(run.events.find((e) => e.type === "agent.tool_result")!.data.output);
    expect(output).toContain(remote);
    expect(output).toContain("HARNESS_PROC=");
    expect(output).not.toContain("[redacted]");
    const said = run.events.filter((e) => e.type === "session.sandbox");
    expect(said.map((e) => e.data.action)).toEqual(["made", "released"]);
    expect(said[0]!.data).toMatchObject({ computer_id: expect.stringMatching(/^cc_/), size: expect.any(String), ready_ms: expect.any(Number) });
    expect(run.events.indexOf(said[1]!)).toBeLessThan(run.events.length - 1);
    expect(run.events.at(-1)!.data).toEqual({ status: "terminated", stop_reason: "end_turn" });
  });

  it("the session's repository is cloned through the host's git lane on its base branch, and a push by its GitHub URL lands on caveman/*", async () => {
    const lane = await startGitLane();
    sandboxes.push(lane);
    await lane.makeRepository("acme", "shop", { "README.md": "# shop\n" }, "develop");
    const remote = workspace({});
    const box = await cloud(remote, lane.url);
    const fake = await model((request, n) =>
      n === 0
        ? { tools: [{ name: "bash", args: { command: "cat BRANCH README.md && git checkout -q -b caveman/agent && echo done > done.txt && git add done.txt && git -c user.name=agent -c user.email=agent@example.com commit -q -m agent && git push -q https://github.com/acme/shop.git caveman/agent 2>&1 && git status --porcelain" } }] }
        : { text: "Done." },
    );
    const file = JSON.stringify({ ...JSON.parse(fileFor(box)), repository: { owner: "acme", name: "shop", base_branch: "develop", git_url: "http://172.16.0.1:47483/git/v1/acme/shop.git" } });
    const dir = workspace({ ".caveman/agents/builder.md": BUILDER, "task.md": "Ship it", "sandbox.json": file });
    const run = await exec(["--cwd", dir, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--sandbox-file", "sandbox.json"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    const result = run.events.find((e) => e.type === "agent.tool_result")!.data;
    // The base branch's files, the push through the lane, and the build's file kept out of git (status is empty).
    expect(String(result.output)).toMatch(/^exit 0\ndevelop\n# shop\n?$/);
    expect(await lane.branches("acme", "shop")).toMatchObject({ "caveman/agent": "agent", develop: "on develop" });
    expect(fs.readFileSync(path.join(remote, ".caveman/agents/builder.md"), "utf8")).toBe(BUILDER);
    expect(readSandboxFile(path.join(dir, "sandbox.json"))).toMatchObject({ repository: { owner: "acme", name: "shop", baseBranch: "develop", gitURL: "http://172.16.0.1:47483/git/v1/acme/shop.git" } });
  });

  /** Caveman Cloud's sandbox-file examples/secrets-file.json, byte for byte: CAVEMAN_SANDBOX_SECRETS_FILE's. */
  const SECRETS_FIXTURE = fileURLToPath(new URL("./fixtures/secrets-file.json", import.meta.url));
  const exampleSecrets = (JSON.parse(fs.readFileSync(SECRETS_FIXTURE, "utf8")) as { secrets: Array<{ name: string; value: string }> }).secrets;
  /** Every file under dir whose bytes hold `text`. */
  const filesHolding = (dir: string, text: string): Array<string> =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return filesHolding(file, text);
      return entry.isFile() && fs.readFileSync(file).includes(text) ? [file] : [];
    });

  it("reads the pool's secrets file as Caveman Cloud's example has it", () => {
    expect(exampleSecrets.map((secret) => secret.name)).toEqual(["STRIPE_API_KEY", "WAREHOUSE_TOKEN"]);
    expect(readSandboxSecrets(SECRETS_FIXTURE)).toEqual(exampleSecrets);
  });

  it("a build's secrets are in each command's environment on the sandbox, redacted from every event and stderr line, in no file there, and gone from a later session's commands", async () => {
    // The pool's file: the example's two, and one whose value reads otherwise inside a JSON string (Cloud's pool test's).
    const secrets = [...exampleSecrets, { name: "QUOTED_VALUE", value: `quote"d${exampleSecrets[0]!.value}` }];
    const secretDir = workspace({ "secrets.json": `${JSON.stringify({ secrets })}\n` });
    const secretsFile = path.join(secretDir, "secrets.json");
    fs.chmodSync(secretsFile, 0o600);
    const remote = workspace({});
    const box = await cloud(remote);
    const show = 'printf "%s\\n" "${STRIPE_API_KEY-unset}" "${WAREHOUSE_TOKEN-unset}" "${QUOTED_VALUE-unset}"';
    let onDiskAtFirstTurn: boolean | undefined;
    const fake = await model((request, n) => {
      if (n === 0) onDiskAtFirstTurn = fs.existsSync(secretsFile);
      return n === 0 ? { tools: [{ name: "bash", args: { command: show } }] } : n === 1 ? { tools: [{ name: "bash", args: { command: `sleep 0.2; ${show}` } }] } : { text: "Done." };
    });
    const dir = workspace({ ".caveman/agents/builder.md": BUILDER, "task.md": "Use the keys", "sandbox.json": fileFor(box) });
    const run = await exec(["--cwd", dir, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--sandbox-file", "sandbox.json"], {
      env: env(fake, { CAVEMAN_SANDBOX_SECRETS_FILE: secretsFile }),
    });
    expect(run.code, run.stderr).toBe(0);
    // Each command saw them: the model read them in both results (the agent's own transcript; Cloud's gateway, not the log).
    const results = turnRequests(fake).slice(1, 3).map((request) => lastText(request.body));
    for (const result of results) expect(result).toContain(secrets.map((secret) => secret.value).join("\n"));
    // Every event says [redacted] where a value was, the value as it is and as JSON escapes it in none.
    const outputs = run.events.filter((e) => e.type === "agent.tool_result").map((e) => String(e.data.output));
    expect(outputs).toHaveLength(2);
    for (const output of outputs) expect(output).toMatch(/\[redacted\]\n\[redacted\]\n\[redacted\]/);
    const said = JSON.stringify(run.events) + run.stderr;
    for (const { value } of secrets) {
      expect(said).not.toContain(value);
      expect(said).not.toContain(JSON.stringify(value).slice(1, -1));
      expect(filesHolding(remote, value), "a file in the computer").toEqual([]);
      expect(filesHolding(box.home, value), "a file in the computer's home").toEqual([]);
    }
    // Read once and deleted at start, before the first turn; the build's files in the computer are --cwd's alone.
    expect(onDiskAtFirstTurn).toBe(false);
    expect(fs.existsSync(secretsFile)).toBe(false);
    expect(fs.readdirSync(remote)).toEqual([".caveman"]);
    // The next session of the same computer, without them: its commands never see them.
    const computer = String(run.events.find((e) => e.type === "session.sandbox" && e.data.action === "made")!.data.computer_id);
    const next = await model((request, n) => (n === 0 ? { tools: [{ name: "bash", args: { command: show } }] } : { text: "Done." }));
    const again = workspace({ ".caveman/agents/builder.md": BUILDER, "task.md": "Look", "sandbox.json": fileFor(box, computer) });
    const later = await exec(["--cwd", again, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--sandbox-file", "sandbox.json"], { env: env(next) });
    expect(later.code, later.stderr).toBe(0);
    expect(String(later.events.find((e) => e.type === "agent.tool_result")!.data.output)).toMatch(/unset\nunset\nunset/);
  });

  it("refuses a secrets file it cannot use, and one without --sandbox-file, never saying a value", async () => {
    const fake = await model(() => ({ text: "never" }));
    const value = exampleSecrets[0]!.value;
    const files = workspace({
      "notjson.json": `{"secrets":[{"name":"STRIPE_API_KEY","value":"${value}"}`,
      "reserved.json": JSON.stringify({ secrets: [{ name: "LD_PRELOAD", value }] }),
      "lower.json": JSON.stringify({ secrets: [{ name: "stripe_key", value }] }),
      "short.json": JSON.stringify({ secrets: [{ name: "PIN", value: "1234" }] }),
      "twice.json": JSON.stringify({ secrets: [{ name: "STRIPE_API_KEY", value }, { name: "STRIPE_API_KEY", value }] }),
      "extra.json": JSON.stringify({ secrets: [{ name: "STRIPE_API_KEY", value, scope: "org" }] }),
      "other.json": JSON.stringify({ secrets: [], env: {} }),
      "example.json": fs.readFileSync(SECRETS_FIXTURE, "utf8"),
      "locked/secrets.json": fs.readFileSync(SECRETS_FIXTURE, "utf8"),
    });
    // A file agent exec cannot delete (its folder is not writable): it does not start. Root deletes it anyway, and
    // Windows keeps no folder write bits, so a read-only folder there does not stop a delete.
    fs.chmodSync(path.join(files, "locked"), 0o500);
    const root = process.getuid?.() === 0 || process.platform === "win32";
    const dir = workspace({ ".caveman/agents/builder.md": BUILDER, "task.md": "Hi", "sandbox.json": JSON.stringify({ session_id: "ses_1", api_url: "https://app.caveman.so", relay_url: "https://app.caveman.so" }) });
    const base = ["--cwd", dir, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"];
    for (const [file, sandbox, why] of [
      ["missing.json", true, /CAVEMAN_SANDBOX_SECRETS_FILE .*missing\.json: ENOENT/],
      ["notjson.json", true, /notjson\.json is not JSON/],
      ["reserved.json", true, /secret 1's name is not an environment variable NAME/],
      ["lower.json", true, /secret 1's name is not an environment variable NAME/],
      ["short.json", true, /PIN's value is not 8 bytes to 64 KiB/],
      ["twice.json", true, /names STRIPE_API_KEY twice/],
      ["extra.json", true, /is \{"secrets": \[\{"name", "value"\}\]\}/],
      ["other.json", true, /is \{"secrets": \[\{"name", "value"\}\]\}/],
      ["example.json", false, /CAVEMAN_SANDBOX_SECRETS_FILE holds a build's secrets .* it goes with --sandbox-file/],
      ...(root ? [] : ([["locked/secrets.json", true, /locked\/secrets\.json could not be deleted once read \(EACCES\)/]] as const)),
    ] as const) {
      const run = await exec([...base, ...(sandbox ? ["--sandbox-file", "sandbox.json"] : [])], { env: env(fake, { CAVEMAN_SANDBOX_SECRETS_FILE: path.resolve(files, file) }) });
      expect(run.code, file).toBe(2);
      expect(run.events[0]!.data, file).toMatchObject({ code: "usage", message: expect.stringMatching(why) });
      expect(JSON.stringify(run.events) + run.stderr, file).not.toContain(value);
      // Each file read is deleted before it is checked: a refused one too.
      if (file !== "missing.json" && file !== "locked/secrets.json") expect(fs.existsSync(path.join(files, file)), file).toBe(false);
    }
    fs.chmodSync(path.join(files, "locked"), 0o700);
    expect(turnRequests(fake)).toHaveLength(0);
  });

  it("the session's computer named in the file is attached: none made, no files written", async () => {
    const remote = workspace({});
    const box = await cloud(remote);
    const computer = box.makeComputer();
    const fake = await model((request, n) => (n === 0 ? { tools: [{ name: "bash", args: { command: "ls -A" } }] } : { text: "Done." }));
    const dir = workspace({ ".caveman/agents/builder.md": BUILDER, "task.md": "Look", "sandbox.json": fileFor(box, computer.id) });
    const run = await exec(["--cwd", dir, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--sandbox-file", "sandbox.json"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    expect(box.state.creates).toEqual([]);
    expect(fs.readdirSync(remote)).toEqual([]);
    expect(run.events.filter((e) => e.type === "session.sandbox").map((e) => [e.data.action, e.data.computer_id])).toEqual([["attached", computer.id], ["released", computer.id]]);
  });

  it("an agent that calls no tool makes no computer and says nothing of one", async () => {
    const box = await cloud(workspace({}));
    const fake = await model(() => ({ text: "Nothing to run." }));
    const dir = workspace({ ".caveman/agents/builder.md": BUILDER, "task.md": "Say hi", "sandbox.json": fileFor(box) });
    const run = await exec(["--cwd", dir, "--agent", "builder", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--sandbox-file", "sandbox.json"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    expect(box.state.requests).toEqual([]);
    expect(types(run)).not.toContain("session.sandbox");
  });

  it("refuses a sandbox file it cannot use, a general agent, and a stdio MCP server that would start beside the harness", async () => {
    const fake = await model(() => ({ text: "never" }));
    const good = { session_id: "ses_1", api_url: "https://app.caveman.so", relay_url: "https://app.caveman.so" };
    const dir = workspace({
      ".caveman/agents/builder.md": BUILDER,
      ".caveman/agents/billing.md": BILLING,
      ".caveman/agents/local.md": agentFile("name: local\ncomputer: full\nmcpServers:\n  files: { command: node, args: [server.js] }", "x"),
      "task.md": "Hi",
      "good.json": JSON.stringify(good),
      "shaped.json": JSON.stringify({ ...good, size: "2cpu-4gb", network: "none" }),
      "norelay.json": JSON.stringify({ session_id: "ses_1", api_url: "https://app.caveman.so" }),
      "plain.json": JSON.stringify({ ...good, api_url: "http://app.caveman.so" }),
      "nosession.json": JSON.stringify({ api_url: good.api_url, relay_url: good.relay_url }),
      "badrepo.json": JSON.stringify({ ...good, repository: { owner: "acme", name: "shop", base_branch: "--upload-pack=x", git_url: "http://172.16.0.1:47483/git/v1/acme/shop.git" } }),
      "fileurl.json": JSON.stringify({ ...good, repository: { owner: "acme", name: "shop", git_url: "file:///srv/shop.git" } }),
      "nourl.json": JSON.stringify({ ...good, repository: { owner: "acme", name: "shop" } }),
    });
    const base = ["--cwd", dir, "--task-file", "task.md", "--events", "-", "--model", "gpt-test"];
    for (const [agent, file, code, why] of [
      ["builder", "missing.json", "usage", /missing\.json: ENOENT/],
      ["builder", "shaped.json", "usage", /has size, network; it takes session_id, api_url, relay_url, computer_id/],
      ["builder", "norelay.json", "usage", /relay_url is an origin/],
      ["builder", "plain.json", "usage", /api_url is an origin/],
      ["builder", "nosession.json", "usage", /session_id is 1 to 192/],
      ["builder", "badrepo.json", "usage", /repository is \{owner, name, base_branch\?, git_url\}/],
      ["builder", "fileurl.json", "usage", /git_url an http\(s\) URL without credentials/],
      ["builder", "nourl.json", "usage", /repository is \{owner, name, base_branch\?, git_url\}/],
      ["billing", "good.json", "agent_invalid", /this agent says computer: none/],
      ["local", "good.json", "agent_invalid", /MCP server files would start a process beside the harness/],
    ] as const) {
      const run = await exec([...base, "--agent", agent, "--sandbox-file", file], { env: env(fake) });
      expect(run.code, `${agent} ${file}`).toBe(2);
      expect(run.events[0]!.data, `${agent} ${file}`).toMatchObject({ code, message: expect.stringMatching(why) });
    }
    expect(turnRequests(fake)).toHaveLength(0);
  });
});

describe("without CAVEMAN_CONNECTORS_URL", () => {
  // Recorded on the commit before connectors (9b336968e), with what differs per run in placeholders: the env block
  // (the workspace's path and the os), the events' times and the provider's call ids. Without the variable not one byte
  // of a session changes. The coding request is long (the loadout's whole prompt): its sha256.
  const GENERAL_REQUEST =
    '{"model":"gpt-test","messages":[{"role":"system","content":"You answer billing questions. Look invoices up with lookup_invoice before you answer."},{"role":"user","content":[{"type":"text","text":"<env/>\\n\\nCustomer 4411 was charged twice"}]}],"stream":true,"stream_options":{"include_usage":true},"store":false,"max_completion_tokens":16384,"tools":[{"type":"function","function":{"name":"lookup_invoice","description":"Find an invoice by id","parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}]}';
  const CODING_REQUEST_SHA256 = "b0e764e0937f361249d727b86f233f1307a3c3061140e863d2222ea24a82a842";
  const EVENTS =
    '[{"seq":1,"type":"user.message","created_at":"<at>","data":{"text":"Customer 4411 was charged twice","origin":"api"}},{"seq":2,"type":"session.status","created_at":"<at>","data":{"status":"running","stop_reason":null,"model":"gpt-test"}},{"seq":3,"type":"session.usage","created_at":"<at>","data":{"input_tokens":100,"output_tokens":10,"cache_read_tokens":0,"cost_usd":0}},{"seq":4,"type":"agent.tool_use","created_at":"<at>","data":{"id":"call_<id>","name":"lookup_invoice","input":{"id":"4411"}}},{"seq":5,"type":"agent.tool_result","created_at":"<at>","data":{"tool_use_id":"call_<id>","is_error":true,"output":"Nobody can answer lookup_invoice in this session: it runs without an input channel (agent exec without --input -)."}},{"seq":6,"type":"agent.message","created_at":"<at>","data":{"text":"Done."}},{"seq":7,"type":"session.usage","created_at":"<at>","data":{"input_tokens":200,"output_tokens":20,"cache_read_tokens":0,"cost_usd":0}},{"seq":8,"type":"session.status","created_at":"<at>","data":{"status":"idle","stop_reason":"end_turn"}},{"seq":9,"type":"session.status","created_at":"<at>","data":{"status":"terminated","stop_reason":"end_turn"}}]';

  it("an agent's first model request, its events and its stderr are byte for byte what they were before connectors", async () => {
    for (const computer of ["none", "full"] as const) {
      const fake = await model((_, n) => (n === 0 ? { tools: [{ name: computer === "none" ? "lookup_invoice" : "client__lookup_invoice", args: { id: "4411" } }] } : { text: "Done." }));
      const dir = workspace({ ".caveman/agents/billing.md": BILLING.replace("computer: none", `computer: ${computer}`), "task.md": "Customer 4411 was charged twice" });
      const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: { ...env(fake), CAVEMAN_CONNECTORS_URL: undefined } });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      const request = turnRequests(fake)[0]!.raw.replace(/<env>.*?<\/env>/g, "<env/>");
      if (computer === "none") expect(request).toBe(GENERAL_REQUEST);
      else expect(createHash("sha256").update(request).digest("hex")).toBe(CODING_REQUEST_SHA256);
      const events = JSON.stringify(run.events).replace(/"created_at":"[^"]+"/g, '"created_at":"<at>"').replace(/call_\d+_\d+/g, "call_<id>");
      expect(events).toBe(EVENTS);
    }
  });
});

// ------------------------------------------------------------ connectors

/** Linear's card: a read, a write; then GitHub's read. Out of name order, so a sort would show. */
const CARD: ReadonlyArray<GateTool> = [
  { connector: "linear", tool: "list_issues", effect: "read" },
  { connector: "linear", tool: "create_comment", effect: "write" },
  { connector: "github", tool: "get_repo", effect: "read" },
];

async function gate(options: Omit<Parameters<typeof startFakeGate>[0], "card"> & { readonly card?: ReadonlyArray<GateTool> } = {}) {
  const started = await startFakeGate({ card: CARD, ...options });
  gates.push(started);
  return started;
}

/**
 * A stdio MCP server with one tool that says what its config's `${CAVEMAN_CONNECTORS_URL}` resolved to (agent exec
 * resolves `${VAR}` from its own environment) and which CAVEMAN_ variables and which key its environment holds.
 */
const ORDERS_SERVER = `
  const rl = require("node:readline").createInterface({ input: process.stdin });
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
  rl.on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    if (method === "initialize") return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "orders", version: "1" } } });
    if (method === "tools/list") return send({ id, result: { tools: [{ name: "order_status", description: "An order's status", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] } });
    if (method === "tools/call") {
      const leaked = Object.keys(process.env).filter((k) => k.startsWith("CAVEMAN_") || process.env[k] === ${JSON.stringify(KEY)});
      return send({ id, result: { content: [{ type: "text", text: "shipped; gate=" + (process.env.GATE ?? "") + "; leaked=" + leaked.join(",") }] } });
    }
    send({ id, result: {} });
  });`;

/** The key in an owner-only file, as Cloud's pool hands it over. */
function keyFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "exec-key-")), "key");
  fs.writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
  return file;
}

const toolNamesOf = (request: FakeRequest) => (request.body as { tools?: Array<{ function: { name: string } }> }).tools?.map((t) => t.function.name) ?? [];

describe("connectors through Cloud's gate (CAVEMAN_CONNECTORS_URL)", () => {
  it("a general agent declares its custom tools, the gate's in the card's order, then its own servers'; a call reaches the gate with the model key and its answer the model", async () => {
    const connectors = await gate();
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "linear__list_issues", args: { team: "core" } }] } : n === 1 ? { tools: [{ name: "orders__order_status", args: { id: "9" } }] } : { text: "Done." }));
    const dir = workspace({
      "orders.cjs": ORDERS_SERVER,
      ".caveman/agents/support.md": agentFile(
        `name: support\ncomputer: none\ntools:\n  - type: custom\n    name: lookup_invoice\n    description: Find an invoice by id\n    input_schema: { type: object, properties: { id: { type: string } } }\nmcpServers:\n  orders:\n    command: ${JSON.stringify(process.execPath)}\n    args: [ORDERS]\n    env: { GATE: "\${CAVEMAN_CONNECTORS_URL}" }`,
        "You answer support questions.",
      ),
      "task.md": "What is open for core, and where is order 9?",
    });
    const file = path.join(dir, ".caveman/agents/support.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("[ORDERS]", `[${JSON.stringify(path.join(dir, "orders.cjs"))}]`));
    const run = await exec(["--cwd", dir, "--agent", "support", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], {
      env: { CAVEMAN_MODEL_BASE_URL: `${fake.url}/v1`, CAVEMAN_MODEL_API_KEY: undefined, CAVEMAN_MODEL_API_KEY_FILE: keyFile(), CAVEMAN_CONNECTORS_URL: connectors.url },
    });
    expect(run.code, run.stderr).toBe(0);
    // Custom, the gate's in the card's order, the agent's own server's: one list, read once.
    expect(toolNamesOf(turnRequests(fake)[0]!)).toEqual(["lookup_invoice", "linear__list_issues", "linear__create_comment", "github__get_repo", "orders__order_status"]);
    for (const request of turnRequests(fake)) expect(toolNamesOf(request)).toEqual(toolNamesOf(turnRequests(fake)[0]!));
    expect(connectors.lists).toHaveLength(1);
    // The bearer is the model key the command read from its file.
    expect(connectors.lists[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(connectors.calls.map((call) => [call.name, call.arguments, call.headers.authorization])).toEqual([["linear__list_issues", { team: "core" }, `Bearer ${KEY}`]]);
    expect(lastText(turnRequests(fake)[1]!.body)).toBe("ran list_issues");
    // Told under its flat name, the name Cloud matches against the deployment's card.
    const use = run.events.find((e) => e.type === "agent.tool_use")!;
    expect(use.data).toMatchObject({ name: "linear__list_issues", input: { team: "core" } });
    expect(run.events.find((e) => e.type === "agent.tool_result" && e.data.tool_use_id === use.data.id)!.data).toMatchObject({ is_error: false, output: "ran list_issues" });
    // The agent's own server works beside the gate. The variable left exec's environment before anything started: its
    // config's ${CAVEMAN_CONNECTORS_URL} resolves to nothing, and its environment holds neither the address nor the key.
    expect(run.events.filter((e) => e.type === "agent.tool_result").at(-1)!.data).toMatchObject({ is_error: false, output: "shipped; gate=; leaked=" });
    expect(JSON.stringify(run.events)).not.toContain(KEY);
    expect(run.stderr).not.toContain(KEY);
  });

  it("a refusal reaches the model as the gate wrote it, and the turn goes on", async () => {
    const line = "not_granted: linear.create_comment is not one of this agent's tools. On linear it has: list_issues.";
    const connectors = await gate({ answer: (call) => (call.name === "linear__create_comment" ? { text: line, isError: true } : { text: "ran" }) });
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "linear__create_comment", args: { team: "core" } }] } : { text: "I may not comment there." }));
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Comment on the issue" });
    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake, { CAVEMAN_CONNECTORS_URL: connectors.url }) });
    expect(run.code, run.stderr).toBe(0);
    expect(connectors.calls).toHaveLength(1);
    expect(lastText(turnRequests(fake)[1]!.body)).toBe(line);
    expect(run.events.find((e) => e.type === "agent.tool_result")!.data).toMatchObject({ is_error: true, output: line });
    expect(run.events.filter((e) => e.type === "agent.message").map((e) => e.data.text)).toEqual(["I may not comment there."]);
    expect(statuses(run)).toEqual(["running/null", "idle/end_turn", "terminated/end_turn"]);
  });

  it("a write leaves only once its tool.started is in the events file: the gate reads the file as the call arrives", async () => {
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Comment, then list" });
    const file = path.join(dir, "events.jsonl");
    const seen: Array<{ readonly name: string; readonly at: number; readonly lines: ReadonlyArray<Event> }> = [];
    const readAt = (call: GateCall) =>
      seen.push({ name: call.name, at: call.at, lines: fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Event) });
    const connectors = await gate({ onCall: readAt });
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "linear__create_comment", args: { team: "core" } }] } : { text: "Commented." }));
    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "events.jsonl", "--model", "gpt-test"], { env: env(fake, { CAVEMAN_CONNECTORS_URL: connectors.url }) });
    expect(run.code, run.stderr).toBe(0);
    const events = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Event);
    const use = events.find((e) => e.type === "agent.tool_use")!;
    expect(use.data).toMatchObject({ name: "linear__create_comment" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.at).toBeGreaterThan(0);
    // At the moment the call arrived the file already held its start, and not yet its result.
    expect(seen[0]!.lines.find((e) => e.type === "agent.tool_use")).toEqual(use);
    expect(seen[0]!.lines.some((e) => e.type === "agent.tool_result")).toBe(false);
  });

  it("--access auto with nobody to ask: a gate tool that reads runs, one that writes is refused as other asks are; with someone to ask it asks under its flat name", async () => {
    const both = { tools: [{ name: "linear__list_issues", args: { team: "core" } }, { name: "linear__create_comment", args: { team: "core" } }] };
    const connectors = await gate();
    const fake = await model((_, n) => (n === 0 ? both : { text: "done" }));
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "List, then comment" });
    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--access", "auto"], { env: env(fake, { CAVEMAN_CONNECTORS_URL: connectors.url }) });
    expect(run.code, run.stderr).toBe(0);
    expect(types(run)).not.toContain("requires_action");
    const result = (name: string) => {
      const use = run.events.find((e) => e.type === "agent.tool_use" && e.data.name === name)!;
      return run.events.find((e) => e.type === "agent.tool_result" && e.data.tool_use_id === use.data.id)!.data;
    };
    expect(result("linear__list_issues")).toMatchObject({ is_error: false, output: "ran list_issues" });
    expect(result("linear__create_comment")).toMatchObject({ is_error: true, output: "cave_tool_denied:no_one_to_ask" });
    expect(connectors.calls.map((call) => call.name)).toEqual(["linear__list_issues"]);

    const asked = await gate();
    const fake2 = await model((_, n) => (n === 0 ? both : { text: "done" }));
    const withInput = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test", "--access", "auto"], {
      env: env(fake2, { CAVEMAN_CONNECTORS_URL: asked.url }),
      onEvent: (event, stdin) => {
        if (event.type === "requires_action") stdin.write(`${JSON.stringify({ type: "user.approval", ask_id: event.data.ask_id, decision: "deny" })}\n`);
        if (event.type === "session.status" && event.data.status === "idle") stdin.end();
      },
    });
    expect(withInput.code, withInput.stderr).toBe(0);
    expect(withInput.events.filter((e) => e.type === "requires_action").map((e) => [e.data.kind, e.data.name, e.data.question])).toEqual([["approval", "linear__create_comment", "Use linear__create_comment"]]);
    expect(asked.calls.map((call) => call.name)).toEqual(["linear__list_issues"]);
  });

  it("a malformed CAVEMAN_CONNECTORS_URL is a usage refusal (exit 2), a gate that refuses the key at open ends the start (exit 1); neither says the key", async () => {
    const fake = await model(() => ({ text: "never" }));
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Hi" });
    const args = ["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"];
    for (const [value, said] of [
      ["http://relay.example/relay/v1/sessions/x/mcp", "CAVEMAN_CONNECTORS_URL must be an https URL (http only on loopback: 127.0.0.1, localhost or [::1])"],
      [`https://user:${KEY}@relay.example/mcp`, "CAVEMAN_CONNECTORS_URL must not carry credentials; the session's model key is its bearer"],
      ["not a url", "CAVEMAN_CONNECTORS_URL is not a URL"],
      ["", "CAVEMAN_CONNECTORS_URL is empty; set it to the session's connector endpoint, or unset it"],
    ] as const) {
      const run = await exec(args, { env: env(fake, { CAVEMAN_CONNECTORS_URL: value }) });
      expect(run.code, value).toBe(2);
      expect(run.events.map((e) => e.type)).toEqual(["session.error", "session.status"]);
      expect(run.events[0]!.data).toEqual({ code: "usage", message: said });
      expect(run.events[1]!.data).toEqual({ status: "terminated", stop_reason: "error" });
      expect(run.stderr).toContain(said);
      expect(run.stderr + JSON.stringify(run.events)).not.toContain(KEY);
    }

    const refusing = await gate({ listStatus: 401 });
    const run = await exec(args, { env: env(fake, { CAVEMAN_CONNECTORS_URL: refusing.url }) });
    expect(run.code, run.stderr).toBe(1);
    expect(run.events[0]!.data).toEqual({ code: "connectors_unavailable", message: "the agent's connectors could not be read: Cloud's connector gate refused this session's key (HTTP 401)." });
    expect(run.events.at(-1)!.data).toEqual({ status: "terminated", stop_reason: "error", model: "gpt-test" });
    expect(refusing.lists.map((list) => list.headers.authorization)).toEqual([`Bearer ${KEY}`]);
    expect(turnRequests(fake)).toHaveLength(0);
    expect(run.stderr + JSON.stringify(run.events)).not.toContain(KEY);
  });

  it("no command the agent runs sees CAVEMAN_CONNECTORS_URL; a coding agent reaches the gate's tools from a program", async () => {
    const connectors = await gate();
    const fake = await model((_, n) => (n === 0 ? { tools: [{ name: "bash", args: { command: "env; echo exit-$?" } }] } : { text: "done" }));
    const dir = workspace({ ".caveman/agents/ops.md": agentFile("name: ops\ncomputer: full", "You run commands."), "task.md": "Print the environment" });
    const run = await exec(["--cwd", dir, "--agent", "ops", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake, { CAVEMAN_CONNECTORS_URL: connectors.url }) });
    expect(run.code, run.stderr).toBe(0);
    const output = String(run.events.find((e) => e.type === "agent.tool_result")!.data.output);
    expect(output).toContain("exit-0");
    expect(output).not.toContain("CAVEMAN_CONNECTORS_URL");
    expect(output).not.toContain(connectors.url);
    expect(toolNamesOf(turnRequests(fake)[0]!)).toEqual(["bash", "edit", "program", "read", "wait", "write"]);
    expect(turnRequests(fake)[0]!.raw).toContain("linear__list_issues({team?: string})");
  });
});

describe("one prefix per agent version", () => {
  /** System text and tools, in their order, of a session's first request: the bytes every later session can read from cache. */
  const prefix = (fake: FakeModel) => {
    const body = turnRequests(fake)[0]!.body as { messages?: Array<{ role: string }>; system?: unknown; tools?: unknown };
    return JSON.stringify({ system: body.system ?? body.messages?.filter((m) => m.role === "system"), tools: body.tools });
  };

  // A general agent's prefix is one per agent version anywhere. A coding agent's is the loadout's, one per model
  // anywhere: the harness names the workspace in the first message's env block, never in the system text.
  for (const [shape, computer] of [
    ["general", "none"],
    ["coding", "full"],
  ] as const) {
    it(`sessions of one ${shape} agent send the same system and tools, byte for byte, the task after them`, async () => {
      const file = agentFile(
        `name: billing\ncomputer: ${computer}\ntools:\n  - type: custom\n    name: lookup_invoice\n    description: Find an invoice\n    input_schema: { type: object, properties: { id: { type: string } } }\n  - type: custom\n    name: refund\n    description: Refund a charge\n    input_schema: { type: object, properties: { id: { type: string } } }`,
        "You answer billing questions.",
      );
      const here = workspace({ ".caveman/agents/billing.md": file });
      const elsewhere = workspace({ ".caveman/agents/billing.md": file });
      const prefixes: Array<string> = [];
      const firstMessages: Array<string> = [];
      for (const [dir, task] of [
        [here, "Customer 4411 was charged twice"],
        [here, "Where is my refund for order 9?"],
        [elsewhere, "Cancel my plan"],
      ] as const) {
        const fake = await model(() => ({ text: "ok" }));
        fs.writeFileSync(path.join(dir, "task.md"), task);
        const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], { env: env(fake) });
        expect(run.code, run.stderr).toBe(0);
        prefixes.push(prefix(fake));
        firstMessages.push(lastText(turnRequests(fake)[0]!.body));
      }
      expect(prefixes[1]).toBe(prefixes[0]);
      expect(new Set(firstMessages).size).toBe(3);
      expect(prefixes[0]).not.toContain("4411");
      // A prefix is JSON: a path in it is as JSON writes it (a Windows path's backslashes doubled).
      const inJson = (text: string) => JSON.stringify(text).slice(1, -1);
      expect(prefixes[2]).toBe(prefixes[0]);
      expect(prefixes[0]).not.toContain(inJson(here));
      expect(prefixes[2]).not.toContain(inJson(elsewhere));
    });
  }

  // The plan's bar: the SDK's prefix-stability test, ported, with the gate's tools in the prefix.
  it("with connectors: two sessions against one gate send the same system and tools, and a session's second turn the same tools as its first", async () => {
    const connectors = await gate();
    const prefixes: Array<string> = [];
    for (const [dir, task] of [
      [workspace({ ".caveman/agents/billing.md": BILLING }), "Customer 4411 was charged twice"],
      [workspace({ ".caveman/agents/billing.md": BILLING }), "Cancel my plan"],
    ] as const) {
      fs.writeFileSync(path.join(dir, "task.md"), task);
      const fake = await model((request) => ({ text: `reply to: ${lastText(request.body).slice(-20)}` }));
      let idle = 0;
      const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--input", "-", "--model", "gpt-test"], {
        env: env(fake, { CAVEMAN_CONNECTORS_URL: connectors.url }),
        onEvent: (event, stdin) => {
          if (event.type !== "session.status" || event.data.status !== "idle") return;
          if (idle++ === 0) stdin.write(`${JSON.stringify({ type: "user.message", text: "And the second invoice?" })}\n`);
          else stdin.end();
        },
      });
      expect(run.code, run.stderr).toBe(0);
      const requests = turnRequests(fake);
      expect(requests).toHaveLength(2);
      prefixes.push(prefix(fake));
      expect(JSON.stringify(requests[1]!.body.tools)).toBe(JSON.stringify(requests[0]!.body.tools));
      const system = (request: FakeRequest) => JSON.stringify((request.body.messages as Array<unknown>)[0]);
      expect(system(requests[1]!)).toBe(system(requests[0]!));
    }
    expect(prefixes[1]).toBe(prefixes[0]);
    expect(prefixes[0]).toContain('"name":"linear__list_issues"');
    expect(prefixes[0]).not.toContain("4411");
    expect(connectors.lists).toHaveLength(2);
  });
});

describe("code tier, --output-schema, durable park (CAVEMAN_PARK_FILE), and --resume", () => {
  it("computer: code exposes program + direct connector tools without shell/file tools and rejects --sandbox-file", async () => {
    const connectors = await gate();
    const fake = await model((_, n) =>
      n === 0
        ? { tools: [{ name: "program", args: { code: 'const r = await tools.linear__list_issues({ team: "OPS" }); print(r);' } }] }
        : { text: "Checked OPS issues." },
    );
    const dir = workspace({
      ".caveman/agents/analyst.md": agentFile("name: analyst\ncomputer: code", "You analyze issues via tools."),
      "task.md": "Check OPS issues",
      "sandbox.json": JSON.stringify({ session_id: "ses_1", api_url: "https://app.caveman.so", relay_url: "https://relay.caveman.so" }),
    });
    const bad = await exec(["--cwd", dir, "--agent", "analyst", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--sandbox-file", "sandbox.json"], { env: env(fake) });
    expect(bad.code).toBe(2);
    expect(bad.events[0]!.data).toMatchObject({ code: "agent_invalid", message: expect.stringMatching(/computer: code/) });

    const run = await exec(["--cwd", dir, "--agent", "analyst", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], {
      env: env(fake, { CAVEMAN_CONNECTORS_URL: connectors.url }),
    });
    expect(run.code, run.stderr).toBe(0);
    const names = toolNamesOf(turnRequests(fake)[0]!);
    expect(names).toEqual(["program", "linear__list_issues", "linear__create_comment", "github__get_repo"]);
    expect(connectors.calls.map((c) => [c.name, c.arguments])).toEqual([["linear__list_issues", { team: "OPS" }]]);
    expect(run.events.find((e) => e.type === "agent.message")?.data).toEqual({ text: "Checked OPS issues." });
  });

  it("--output-schema injects the JSON Schema requirement and rejects invalid schema files", async () => {
    const fake = await model(() => ({ text: '{"ok":true}' }));
    const dir = workspace({
      ".caveman/agents/billing.md": BILLING,
      "task.md": "Return status JSON",
      "schema.json": JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }),
      "bad.json": "[1, 2, 3]",
    });
    const invalid = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--output-schema", "bad.json"], { env: env(fake) });
    expect(invalid.code).toBe(2);
    expect(invalid.events[0]!.data).toMatchObject({ code: "usage", message: expect.stringMatching(/JSON Schema object/) });

    const run = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--output-schema", "schema.json"], { env: env(fake) });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.stringify((turnRequests(fake)[0]!.body.messages as Array<{ content: string }>)[0]!.content)).toContain('\\"required\\":[\\"ok\\"]');
    expect(run.events.find((e) => e.type === "agent.message")?.data).toEqual({ text: '{"ok":true}' });
  });

  it("CAVEMAN_PARK_FILE parks on a custom tool wait with exit 5 and --resume continues from the saved checkpoint", async () => {
    const fake1 = await model(() => ({ tools: [{ name: "lookup_invoice", args: { id: "4411" } }] }));
    const dir = workspace({ ".caveman/agents/billing.md": BILLING, "task.md": "Check invoice 4411" });
    const parkFile = path.join(dir, "park.json");
    const parkedRun = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test"], {
      env: env(fake1, { CAVEMAN_PARK_FILE: parkFile }),
    });
    expect(parkedRun.code, parkedRun.stderr).toBe(5);
    expect(parkedRun.events.some((e) => e.type === "requires_action" && e.data.kind === "tool" && e.data.name === "lookup_invoice")).toBe(true);
    expect(parkedRun.events.some((e) => e.type === "session.status" && e.data.status === "terminated")).toBe(false);

    const parked = JSON.parse(fs.readFileSync(parkFile, "utf8")) as {
      state: string;
      stop_reason: string;
      checkpoint_seq: number;
      checkpoint: { version: number; messages: Array<unknown> };
      waits: Array<{ kind: string; ask_id: string }>;
    };
    expect(parked.state).toBe("waiting");
    expect(parked.stop_reason).toBe("requires_action");
    expect(parked.checkpoint_seq).toBeGreaterThan(0);
    expect(parked.checkpoint.version).toBe(1);
    expect(parked.checkpoint.messages.length).toBeGreaterThan(0);
    expect(parked.waits).toHaveLength(1);
    expect(parked.waits[0]!.kind).toBe("caller_tool");

    const resumeFile = path.join(dir, "resume.json");
    fs.writeFileSync(
      resumeFile,
      JSON.stringify({
        resume_count: 1,
        checkpoint_seq: parked.checkpoint_seq,
        checkpoint: parked.checkpoint,
        resolved_waits: [{ ask_id: parked.waits[0]!.ask_id, content: "Invoice 4411: $50 paid twice" }],
        pending_messages: ["Please refund the duplicate charge."],
      }),
    );
    const fake2 = await model(() => ({ text: "Refunded $50 for invoice 4411." }));
    const resumedRun = await exec(["--cwd", dir, "--agent", "billing", "--task-file", "task.md", "--events", "-", "--model", "gpt-test", "--resume", resumeFile], {
      env: env(fake2),
    });
    expect(resumedRun.code, resumedRun.stderr).toBe(0);
    expect(turnRequests(fake2)[0]!.raw).toContain("Check invoice 4411");
    expect(turnRequests(fake2)[0]!.raw).toContain("Invoice 4411: $50 paid twice");
    expect(turnRequests(fake2)[0]!.raw).toContain("Please refund the duplicate charge.");
    expect(resumedRun.events.find((e) => e.type === "agent.message")?.data).toEqual({ text: "Refunded $50 for invoice 4411." });
  });
});
