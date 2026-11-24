// Live command output on the Session Protocol: tool.watch streams a running command's output (the runtime's
// CommandOutputHub) to the connection as tool.live frames, secret values masked, until it settles or
// tool.unwatch; a row that is not a command of the chat is refused.
import * as fs from "node:fs";

import { OrchestrationV2CommandOutputError, type OrchestrationV2CommandOutputFrame } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { CommandOutputHub, type CommandOutputTarget } from "../orchestration-v2/CommandOutputHub.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

// This checks the project's six-character held tail. A random egress token can independently hold `d\r\n`, making
// the composite tail nine characters and outside the short-tail rule. Pin an unrelated token to isolate this case.
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return {
    ...crypto,
    randomBytes: (size: number, callback?: (error: Error | null, buffer: Buffer) => void) =>
      callback === undefined ? (size === 32 ? Buffer.alloc(32, 0x11) : crypto.randomBytes(size)) : crypto.randomBytes(size, callback),
  };
});

/** The hub stand-in: each subscription is a queue the test writes frames into. */
const watched = new Map<string, { target: CommandOutputTarget; frames: Queue.Queue<OrchestrationV2CommandOutputFrame> }>();
const layerHub = Layer.mock(CommandOutputHub)({
  append: () => Effect.void,
  finish: () => Effect.void,
  subscribe: (target) =>
    target.itemId === "not-a-command"
      ? Stream.fail(new OrchestrationV2CommandOutputError({ threadId: target.threadId, message: "No such command." }))
      : Stream.unwrap(
          Effect.gen(function* () {
            const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
            watched.set(target.itemId, { target, frames });
            return Stream.fromQueue(frames).pipe(Stream.takeUntil((frame) => !frame.running));
          }),
        ),
});
const offer = (itemId: string, frame: OrchestrationV2CommandOutputFrame) => Effect.runPromise(Queue.offer(watched.get(itemId)!.frames, frame));

const root = tempRoot("sp-live-output-");
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: layerHub });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a running command's output streams to the row that watches it, masked, until it settles", async () => {
  const SECRET = "lv-5Tq8Wm2Rk7Zp4Xn9";
  const repo = makeRepo(root, { "README.md": "live\n" });
  await client.call("secret.set", { request_id: "lo-s", repo: { path: repo }, secrets: [{ name: "DEPLOY_TOKEN", value: SECRET }] });
  const w = await createReady(client, { request_id: "lo-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const live: Array<{ item_id: string; kind: string; text: string; running: boolean }> = [];
  client.on("tool.live", (p) => live.push(p));

  // The answer waits for the first frame: the row starts from the command's tail so far.
  const watching = client.call("tool.watch", { workspace_id: w.id, item_id: "cmd-1" });
  await until(() => watched.has("cmd-1"));
  expect(watched.get("cmd-1")!.target).toEqual({ threadId: `caveman:${w.id}`, itemId: "cmd-1" });
  await offer("cmd-1", { kind: "replace", text: "1\r\n", truncated: false, running: true });
  await watching;
  await offer("cmd-1", { kind: "append", text: "2\r\n", truncated: false, running: true });
  await offer("cmd-1", { kind: "append", text: `token ${SECRET}\r\n`, truncated: false, running: true });
  await offer("cmd-1", { kind: "replace", text: "1\r\n2\r\nall done\r\n", truncated: false, running: false });
  await until(() => live.some((f) => !f.running));
  // The scrubber may hold back a tail that could begin a value until the next frame: what counts is the
  // row's text, frames applied in order.
  const screen = (frames: typeof live) => frames.reduce((text, f) => (f.kind === "replace" ? f.text : text + f.text), "");
  expect(live.every((f) => f.item_id === "cmd-1")).toBe(true);
  expect(live[0]!.kind).toBe("replace");
  expect(live.some((f) => f.text.includes(SECRET))).toBe(false);
  expect(screen(live.slice(0, -1)).startsWith("1\r\n2\r\ntoken [secret:DEPLOY_TOKEN]")).toBe(true);
  expect(live.slice(0, -1).every((f) => f.running)).toBe(true);
  expect(live.at(-1)).toMatchObject({ kind: "replace", text: "1\r\n2\r\nall done\r\n", running: false });

  // What could begin a value waits for the next output, but not past a pause: a command that prints and then works
  // quietly shows its line now. Long enough to be a value's start, it stays held, and its end masks it.
  const quiet = client.call("tool.watch", { workspace_id: w.id, item_id: "cmd-3" });
  await until(() => watched.has("cmd-3"));
  await offer("cmd-3", { kind: "replace", text: "build\r\nlv-5Tq", truncated: false, running: true });
  await quiet;
  const row3 = () => live.filter((f) => f.item_id === "cmd-3");
  await until(() => screen(row3()) === "build\r\nlv-5Tq");
  expect(row3()[0]!.text).toBe("build\r\n");
  await offer("cmd-3", { kind: "append", text: "\r\nlv-5Tq8Wm", truncated: false, running: true });
  await new Promise((r) => setTimeout(r, 200));
  expect(screen(row3())).toBe("build\r\nlv-5Tq\r\n");
  await offer("cmd-3", { kind: "append", text: "", truncated: false, running: false });
  await until(() => row3().some((f) => !f.running));
  expect(screen(row3())).toBe("build\r\nlv-5Tq\r\n[secret]");

  // Unwatched (the row scrolled away), nothing more comes.
  const second = client.call("tool.watch", { workspace_id: w.id, item_id: "cmd-2" });
  await until(() => watched.has("cmd-2"));
  await offer("cmd-2", { kind: "replace", text: "a\r\n", truncated: false, running: true });
  await second;
  await client.call("tool.unwatch", { workspace_id: w.id, item_id: "cmd-2" });
  const before = live.length;
  await offer("cmd-2", { kind: "append", text: "b\r\n", truncated: false, running: true }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 200));
  expect(live.length).toBe(before);

  // A row that is not a command of this chat is refused.
  await expect(client.call("tool.watch", { workspace_id: w.id, item_id: "not-a-command" })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
});
