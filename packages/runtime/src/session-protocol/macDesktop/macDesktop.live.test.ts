// Computer use on this Mac with the real agent-desktop (run only with CAVEMAN_LIVE_COMPUTER_USE=1, on a Mac where
// the app that started the test — Caveman Code, a terminal — is allowed under Accessibility and Screen Recording):
// Calculator, in the background, through the same MacDesktop service the `desktop` tool calls. The person's approval
// is answered here as the card would be. Calculator is quit at the end only if it wasn't running before.
//
//   CAVEMAN_LIVE_COMPUTER_USE=1 AGENT_DESKTOP_BIN=<dir>/bin/agent-desktop vitest run src/session-protocol/macDesktop/macDesktop.live.test.ts
//
// (node scripts/agentDesktopBinary.ts <dir> installs the pinned binary.) CAVEMAN_LIVE_COMPUTER_USE_OUT names a
// directory for the screenshot and a frame, to look at afterwards.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type NotificationParams, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { loadTranscript, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../testHarness.ts";
import { findAgentDesktop } from "./cli.ts";
import { layerWith, MacDesktop } from "./service.ts";

const live = process.env.CAVEMAN_LIVE_COMPUTER_USE === "1";
const out = process.env.CAVEMAN_LIVE_COMPUTER_USE_OUT;

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let desktop: MacDesktop["Service"];
const wasRunning = live && execFileSync("/usr/bin/lsappinfo", ["info", "-only", "name", "Calculator"], { encoding: "utf8" }).includes('"Calculator"');

beforeAll(async () => {
  if (!live) return;
  root = tempRoot("sp-mac-live-");
  const binary = findAgentDesktop();
  if (binary === undefined) throw new Error("no agent-desktop: set AGENT_DESKTOP_BIN");
  let captured: MacDesktop["Service"] | undefined;
  const provide = Layer.effect(
    MacDesktop,
    Effect.gen(function* () {
      return (captured = yield* MacDesktop);
    }),
  ).pipe(Layer.provide(layerWith(binary)));
  runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide });
  client = connect(runtime.url, runtime.token);
  desktop = captured!;
}, 120_000);
afterAll(async () => {
  if (!live) return;
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test.skipIf(!live)("Calculator in the background: launch, 7 + 5 =, read 12, a screenshot, frames with the pointer", { timeout: 180_000 }, async () => {
  const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  const thread = `caveman:${w.id}`;
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const frames: Array<NotificationParams<"computer.frame">> = [];
  const pointers: Array<NotificationParams<"computer.pointer">> = [];
  client.on("computer.frame", (f) => f.workspace_id === w.id && frames.push(f));
  client.on("computer.pointer", (p) => p.workspace_id === w.id && pointers.push(p));
  await client.call("computer.screencast", { workspace_id: w.id, enabled: true });
  const use = async (call: Parameters<MacDesktop["Service"]["use"]>[1]) => {
    const result = await Effect.runPromise(desktop.use(thread, call).pipe(Effect.result));
    if (result._tag === "Failure") throw new Error(`${JSON.stringify(call)}: ${result.failure.message}`);
    return result.success;
  };
  // The person allows Calculator in this chat, as the card would.
  const approve = (async () => {
    await until(() => events.some((e) => e.type === "ask.user"), 60_000);
    const ask = events.find((e): e is Extract<SessionEvent, { type: "ask.user" }> => e.type === "ask.user")!;
    await client.call("ask.respond", { request_id: "a", session_id: w.session_id, ask_id: ask.item_id!, response: { kind: "approval", option_id: "chat" } });
  })();

  await use({ app: "Calculator", command: "launch" });
  await approve;
  await use({ app: "Calculator", command: "wait", args: { event: "window-opened", timeout: 10_000 } }).catch(() => undefined);
  const looked = await use({ app: "Calculator", command: "snapshot" });
  console.log(looked.text.split("\n").slice(0, 40).join("\n"));
  const ref = (label: string) => {
    const line = looked.text.split("\n").find((l) => new RegExp(`button "${label}"`, "i").test(l));
    return /@[A-Za-z0-9_-]+:e\d+/.exec(line ?? "")?.[0];
  };
  const keys = ["All Clear", "7", "Add", "5", "Equals"].map((label) => ref(label) ?? (label === "All Clear" ? ref("Clear") : undefined));
  if (keys.slice(1).some((k) => k === undefined)) throw new Error(`no Calculator buttons in:\n${looked.text}`);
  await use({ app: "Calculator", steps: keys.filter((k): k is string => k !== undefined).map((ref_id) => ({ command: "click", args: { ref_id } })) });
  const after = await use({ app: "Calculator", command: "snapshot", args: { interactive_only: false } });
  expect(after.text).toMatch(/\b12\b/);

  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "calculator-snapshot.txt"), `${looked.text}\n\n--- after 7 + 5 =\n${after.text}\n`);
  }
  // Screenshots and frames need Screen Recording too, which macOS applies once the app that holds it restarts.
  const access = await client.call("computer.access", {});
  console.log(`permissions: accessibility ${access.accessibility}, screen recording ${access.screen_recording}`);
  if (access.screen_recording === "granted") {
    const shot = await use({ app: "Calculator", command: "screenshot" });
    expect(shot.screenshot?.mimeType).toBe("image/png");
    await until(() => frames.length > 0 && pointers.length > 0, 20_000);
    expect(frames.at(-1)!.mime_type).toBe("image/jpeg");
    if (out) {
      fs.writeFileSync(path.join(out, "calculator-screenshot.png"), shot.screenshot!.data);
      fs.writeFileSync(path.join(out, "calculator-frame.jpg"), Buffer.from(frames.at(-1)!.data, "base64"));
      fs.appendFileSync(path.join(out, "calculator-snapshot.txt"), `\npointer: ${JSON.stringify(pointers.at(-1))}\n`);
    }
  }
  if (!wasRunning) await use({ app: "Calculator", command: "close-app" });
});
