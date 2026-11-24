// Computer use on a Mac (service.ts) on the real runtime, with a stand-in for agent-desktop that answers as it does
// and logs every call: the person is asked once per app in the chat (an approval card), Always allow is kept in
// Settings and Deny holds for the chat, blocked apps are never asked for, refs must come from this chat's snapshot of
// that app, a person's Take over pauses the agent, and the Computer tab streams the app's window. The real binary on a
// real Mac is exercised by scripts/computer-use-live.ts, which needs Caveman Code allowed in System Settings.
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type NotificationParams, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { loadTranscript, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../testHarness.ts";
import { blockedReason, resolveApp, sameApp } from "./apps.ts";
import { batchResults, outline, resultText } from "./commands.ts";
import { layerWith, MacDesktop } from "./service.ts";

describe("what the agent reads", () => {
  test("a snapshot is an outline with refs, states and values, bounds only when asked", () => {
    const tree = {
      role: "window",
      name: "Untitled",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      children: [
        { role: "textfield", name: "Body", value: "hello\nworld", ref_id: "@s1:e1", states: ["focused"], bounds: { x: 10, y: 10, width: 200, height: 20 } },
        { role: "button", name: "Save", ref_id: "@s1:e2", states: ["disabled"] },
        { role: "group", children_count: 12, ref_id: "@s1:e3", subtree_truncated: true },
      ],
    };
    expect(outline(tree, false)).toBe(['window "Untitled"', '  textfield "Body" = "hello world" @s1:e1 [focused]', '  button "Save" @s1:e2 [disabled]', "  group @s1:e3 +12 inside …cut"].join("\n"));
    expect(outline(tree, true)).toContain("@s1:e1 [focused] @(10,10 200x20)");
    const text = resultText("snapshot", { ok: true, data: { snapshot_id: "s1", app: "TextEdit", window: { id: "w-1", title: "Untitled" }, ref_count: 3, complete: false, tree } }, false);
    expect(text.split("\n")[0]).toBe('snapshot s1 · TextEdit · window w-1 "Untitled" · 3 refs');
    expect(text).toContain("incomplete: raise timeout_ms or drill in with root");
  });

  test("errors say their code, kind and whether a retry is safe; a batch's validation failure names its step", () => {
    const envelope = {
      ok: false,
      command: "batch",
      error: { code: "STALE_REF", message: "Batch entry 1 ('click') failed validation: gone", details: { kind: "saved_ref_absent", batch_index: 1, batch_command: "click" }, disposition: { retry: "safe" } },
    };
    const [result] = batchResults(envelope);
    expect(result!.command).toBe("click (step 2)");
    expect(resultText("click", result!, false)).toBe("STALE_REF (saved_ref_absent): gone retry: safe.");
  });

  test("terminals, password managers, Caveman Code and security prompts are blocked under any of their names", async () => {
    expect(blockedReason({ name: "Terminal" })).toMatch(/runs commands/);
    expect(blockedReason({ name: "x", bundleId: "COM.GOOGLECODE.ITERM2" })).toMatch(/runs commands/);
    expect(blockedReason({ name: "x", executable: "wezterm-gui" })).toMatch(/runs commands/);
    expect(blockedReason({ name: "1Password" })).toMatch(/passwords/);
    expect(blockedReason({ name: "Caveman Code", bundleId: "so.caveman.code" })).toMatch(/Caveman Code itself/);
    expect(blockedReason({ name: "x", bundleId: "com.apple.SecurityAgent" })).toMatch(/security prompts/);
    expect(blockedReason({ name: "Safari", bundleId: "com.apple.Safari" })).toBeUndefined();
    expect(await resolveApp("clipboard")).toEqual({ name: "Clipboard", pseudo: true });
    expect(sameApp({ name: "Safari", bundleId: "com.apple.Safari" }, { name: "safari" })).toBe(true);
    expect(sameApp({ name: "Safari", bundleId: "com.apple.Safari" }, { name: "Safari", bundleId: "com.example.other" })).toBe(false);
  });
});

// A 2x2 PNG: what the stand-in's screenshot writes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";

/** agent-desktop as far as the runtime uses it: one envelope per call, every argv logged. */
const standIn = (dir: string) => {
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "agent-desktop");
  fs.writeFileSync(
    bin,
    // (the stand-in's directory stands in for __DIR__ below)
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify({ version: "2.6", ...o }) + "\\n");
const rest = argv.filter((a, i) => !(a.startsWith("--") && ["--session", "--agent-id"].includes(a)) && !["--session", "--agent-id"].includes(argv[i - 1]));
const cmd = rest[0];
const screenOff = fs.existsSync(${JSON.stringify(path.join("__DIR__", "screen-off"))});
if (cmd === "permissions") out({ ok: true, command: "permissions", data: { accessibility: { state: "granted" }, screen_recording: { state: screenOff ? "denied" : "granted" } } });
else if (cmd === "screenshot" && screenOff) out({ ok: false, command: "screenshot", error: { code: "PERM_DENIED", message: "Screen Recording permission not granted", disposition: { delivery: "not_delivered", retry: "safe" } } });
else if (cmd === "version") out({ ok: true, command: "version", data: { version: "9.9.9-test" } });
else if (cmd === "session") out({ ok: true, command: "session", data: { session_id: "run-test" } });
else if (cmd === "cursor-overlay") out({ ok: true, command: "cursor-overlay", data: { rendered: true } });
else if (cmd === "screenshot") { fs.writeFileSync(rest[rest.length - 1], Buffer.from(${JSON.stringify(PNG)}, "base64")); out({ ok: true, command: "screenshot", data: { path: rest[rest.length - 1] } }); }
else if (cmd === "batch") {
  const entries = JSON.parse(rest[1]);
  const results = entries.map((e, index) => {
    if (e.command === "snapshot") return { command: "snapshot", ok: true, index, execution: "completed", data: { snapshot_id: "s1", app: e.args.app, window: { id: "w-7", title: "Doc" }, ref_count: 2, complete: true,
      tree: { role: "window", name: "Doc", bounds: { x: 100, y: 100, width: 400, height: 200 }, children: [
        { role: "textfield", name: "Body", ref_id: "@s1:e1", bounds: { x: 110, y: 110, width: 100, height: 20 } },
        { role: "button", name: "Save", ref_id: "@s1:e2", bounds: { x: 400, y: 250, width: 40, height: 20 } } ] } } };
    return { command: e.command, ok: true, index, execution: "completed", data: { action: e.command, disposition: { delivery: "delivered_verified", retry: "unsafe" } } };
  });
  out({ ok: true, command: "batch", data: { completed_entries: results.length, results } });
}
else out({ ok: false, command: cmd ?? "?", error: { code: "INVALID_ARGS", message: "stand-in: " + cmd, disposition: { delivery: "not_delivered", retry: "safe" } } });
`.replaceAll("__DIR__", dir),
  );
  fs.chmodSync(bin, 0o755);
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Array<string>)
      : [];
  return { bin, calls };
};

describe("on the runtime", () => {
  let root: string;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  let desktop: MacDesktop["Service"];
  let fake: ReturnType<typeof standIn>;

  beforeAll(async () => {
    root = tempRoot("sp-mac-desktop-");
    fake = standIn(root);
    let captured: MacDesktop["Service"] | undefined;
    // The route's own MacDesktop, held by the test as well.
    const provide = Layer.effect(
      MacDesktop,
      Effect.gen(function* () {
        const service = yield* MacDesktop;
        captured = service;
        return service;
      }),
    ).pipe(Layer.provide(layerWith({ bin: fake.bin })));
    runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide });
    client = connect(runtime.url, runtime.token);
    desktop = captured!;
  }, 120_000);
  afterAll(async () => {
    client.close();
    await runtime?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const chat = async () => {
    const w = await client.call("workspace.create", { request_id: `w-${Math.random()}`, repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    const asks = () => events.filter((e): e is Extract<SessionEvent, { type: "ask.user" }> => e.type === "ask.user");
    return { w, thread: `caveman:${w.id}`, events, asks };
  };
  const use = (thread: string, call: Parameters<MacDesktop["Service"]["use"]>[1]) => Effect.runPromise(desktop.use(thread, call).pipe(Effect.result));
  const answer = async (sessionId: string, askId: string, option: string) => client.call("ask.respond", { request_id: `r-${askId}`, session_id: sessionId, ask_id: askId, response: { kind: "approval", option_id: option } });

  test("an app asks once in the chat; its snapshot is an outline; a ref acts without asking again", { timeout: 60_000 }, async () => {
    const { w, thread, asks } = await chat();
    const snapshot = use(thread, { app: "TextEdit", command: "snapshot" });
    await until(() => asks().length === 1);
    const ask = asks()[0]!;
    expect(ask.item_id).toMatch(/^computer:/);
    expect(ask.payload).toMatchObject({ kind: "approval", title: "Allow Claude Agent to use TextEdit?" });
    expect(ask.payload.kind === "approval" && ask.payload.options.map((o) => o.id)).toEqual(["always", "chat", "deny"]);
    await answer(w.session_id, ask.item_id!, "chat");
    const done = await snapshot;
    expect(done._tag).toBe("Success");
    if (done._tag !== "Success") return;
    expect(done.success.app).toBe("TextEdit");
    expect(done.success.text).toContain('button "Save" @s1:e2');
    // The runtime asks for the outline the cheap way, and always for bounds (the pointer), never physical input.
    const batch = fake.calls().find((argv) => argv.includes("batch"))!;
    expect(batch).not.toContain("--headed");
    expect(batch.slice(0, 4)).toEqual(["--session", "run-test", "--agent-id", `c${w.id.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64)]);
    expect(JSON.parse(batch[batch.indexOf("batch") + 1]!)).toEqual([{ command: "snapshot", args: { app: "TextEdit", interactive_only: true, compact: true, include_bounds: true } }]);
    // A ref of that snapshot needs no app and no second ask.
    const click = await use(thread, { command: "click", args: { ref_id: "@s1:e2" } });
    expect(click._tag).toBe("Success");
    expect(asks()).toHaveLength(1);
    // A ref nobody snapshotted, or from another app, is refused before anything runs.
    const stale = await use(thread, { command: "click", args: { ref_id: "@s9:e1" } });
    expect(stale._tag === "Failure" && stale.failure.message).toMatch(/not from a snapshot this chat took/);
    const crossed = await use(thread, { app: "Notes", command: "click", args: { ref_id: "@s1:e2" } });
    expect(crossed._tag === "Failure" && crossed.failure.message).toMatch(/is in TextEdit, not Notes/);
  });

  test("blocked apps are never asked for; Deny holds for the chat; Always allow holds everywhere and is in Settings", { timeout: 60_000 }, async () => {
    const one = await chat();
    const terminal = await use(one.thread, { app: "Terminal", command: "snapshot" });
    expect(terminal._tag === "Failure" && terminal.failure.message).toMatch(/never available to agents/);
    expect(one.asks()).toHaveLength(0);

    const denied = use(one.thread, { app: "Calculator", command: "snapshot" });
    await until(() => one.asks().length === 1);
    await answer(one.w.session_id, one.asks()[0]!.item_id!, "deny");
    const result = await denied;
    expect(result._tag === "Failure" && result.failure.message).toMatch(/did not allow Calculator/);
    const again = await use(one.thread, { app: "Calculator", command: "snapshot" });
    expect(again._tag === "Failure" && again.failure.message).toMatch(/did not allow Calculator in this chat/);
    expect(one.asks()).toHaveLength(1);

    const always = use(one.thread, { app: "Preview", command: "snapshot" });
    await until(() => one.asks().length === 2);
    await answer(one.w.session_id, one.asks()[1]!.item_id!, "always");
    expect((await always)._tag).toBe("Success");
    const settings = await client.call("settings.get", {});
    expect(settings.computer_use_apps?.map((app) => app.name)).toContain("Preview");
    const two = await chat();
    expect((await use(two.thread, { app: "Preview", command: "snapshot" }))._tag).toBe("Success");
    expect(two.asks()).toHaveLength(0);
  });

  // Frames are the window's PNG made JPEG by /usr/bin/sips (cli.ts), which only macOS has; the feature is offered
  // only there (service.ts `offered`). Elsewhere no frame can come, so this runs on a Mac only.
  test.skipIf(process.platform !== "darwin")("the Computer tab streams the chat's app; Take over pauses its agent; hand back resumes", { timeout: 60_000 }, async () => {
    const { w, thread, asks } = await chat();
    const frames: Array<NotificationParams<"computer.frame">> = [];
    const states: Array<NotificationParams<"computer.state">> = [];
    client.on("computer.frame", (f) => f.workspace_id === w.id && frames.push(f));
    client.on("computer.state", (s) => s.workspace_id === w.id && states.push(s));
    try {
      await client.call("computer.screencast", { workspace_id: w.id, enabled: true });
      await until(() => states.length > 0);
      expect(states[0]).toMatchObject({ controller: "none", width: 0, height: 0 });

      const snapshot = use(thread, { app: "Chess", command: "snapshot" });
      await until(() => asks().length === 1);
      await answer(w.session_id, asks()[0]!.item_id!, "chat");
      await snapshot;
      await use(thread, { command: "click", args: { ref_id: "@s1:e2" } });
      // A JPEG of the app's window (the stand-in's PNG through sips), the state naming the app.
      await until(() => frames.length > 0);
      expect(frames[0]!.mime_type).toBe("image/jpeg");
      await until(() => states.some((s) => s.app?.name === "Chess" && s.controller === "agent"));
      // The pointer arrives in frame pixels; the stand-in's window lies 100 pt from the screen's corner.
      const pointers: Array<NotificationParams<"computer.pointer">> = [];
      client.on("computer.pointer", (p) => p.workspace_id === w.id && pointers.push(p));
      await use(thread, { command: "click", args: { ref_id: "@s1:e2" } });
      await until(() => pointers.length > 0);
      expect(pointers[0]).toMatchObject({ phase: "click", x: 2, y: 2 });

      expect(await client.call("computer.control", { request_id: "c1", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
      // Taking over brings the app's window forward for the person.
      expect(fake.calls().some((argv) => argv[0] === "focus-window" && argv[2] === "w-7")).toBe(true);
      const paused = await use(thread, { command: "click", args: { ref_id: "@s1:e2" } });
      expect(paused._tag === "Failure" && paused.failure.reason).toBe("user_in_control");
      await expect(client.call("computer.input", { request_id: "i1", workspace_id: w.id, events: [{ type: "text", text: "x" }] })).rejects.toMatchObject({ error: { data: { reason: "unsupported" } } });
      await client.call("computer.control", { request_id: "c2", workspace_id: w.id, controller: "agent" });
      expect((await use(thread, { command: "click", args: { ref_id: "@s1:e2" } }))._tag).toBe("Success");

      const access = await client.call("computer.access", {});
      expect(access).toMatchObject({ supported: true, accessibility: "granted", screen_recording: "granted", version: "9.9.9-test" });
      expect(access.blocked.length).toBeGreaterThan(3);
    } finally {
      await client.call("computer.screencast", { workspace_id: w.id, enabled: false });
    }
  });

  test("another chat can't act in an app a chat is using; computer use off refuses", { timeout: 60_000 }, async () => {
    const one = await chat();
    const two = await chat();
    const first = use(one.thread, { app: "Stickies", command: "snapshot" });
    await until(() => one.asks().length === 1);
    await answer(one.w.session_id, one.asks()[0]!.item_id!, "chat");
    await first;
    expect((await use(one.thread, { command: "click", args: { ref_id: "@s1:e2" } }))._tag).toBe("Success");
    // Refused before the person is asked: the app can't be this chat's now anyway.
    const held = await use(two.thread, { app: "Stickies", command: "press", args: { combo: "cmd+s" } });
    expect(held._tag === "Failure" && held.failure.message).toMatch(/in use by another chat/);
    expect(two.asks()).toHaveLength(0);
    // Looking is fine.
    const look = use(two.thread, { app: "Stickies", command: "snapshot" });
    await until(() => two.asks().length === 1);
    await answer(two.w.session_id, two.asks()[0]!.item_id!, "chat");
    expect((await look)._tag).toBe("Success");

    await client.call("settings.set", { request_id: "off", settings: { computer_use: false } });
    const off = await use(one.thread, { app: "Stickies", command: "snapshot" });
    expect(off._tag === "Failure" && off.failure.message).toMatch(/turned computer use off/);
    await client.call("settings.set", { request_id: "on", settings: { computer_use: true } });
  });

  test("Screen Recording macOS won't report until Caveman Code reopens: I added it, and later screenshots don't ask again", { timeout: 60_000 }, async () => {
    const { w, thread, asks } = await chat();
    const look = use(thread, { app: "Maps", command: "snapshot" });
    await until(() => asks().length === 1);
    await answer(w.session_id, asks()[0]!.item_id!, "chat");
    await look;
    fs.writeFileSync(path.join(root, "screen-off"), "");
    try {
      // The capture is refused, and the next screenshot asks the person to allow it.
      const first = await use(thread, { app: "Maps", command: "screenshot" });
      expect(first._tag === "Failure" && first.failure.message).toMatch(/PERM_DENIED/);
      const second = use(thread, { app: "Maps", command: "screenshot" });
      await until(() => asks().length === 2);
      expect(asks()[1]!.payload).toMatchObject({ title: "Let Claude Agent see app windows on this Mac?" });
      await answer(w.session_id, asks()[1]!.item_id!, "open");
      await until(() => asks().length === 3);
      const waiting = asks()[2]!;
      expect(waiting.payload).toMatchObject({ title: "Waiting for Screen Recording" });
      expect(waiting.payload.kind === "approval" && waiting.payload.options.map((o) => o.label)).toEqual(["I added it", "Cancel"]);
      await answer(w.session_id, waiting.item_id!, "added");
      const added = await second;
      expect(added._tag === "Failure" && added.failure.message).toMatch(/applies it once Caveman Code reopens/);
      const third = await use(thread, { app: "Maps", command: "screenshot" });
      expect(third._tag === "Failure" && third.failure.message).toMatch(/applies it once Caveman Code reopens/);
      expect(asks()).toHaveLength(3);
    } finally {
      fs.rmSync(path.join(root, "screen-off"), { force: true });
    }
    // Once macOS reports it (Caveman Code reopened), screenshots work again.
    const shot = await use(thread, { app: "Maps", command: "screenshot" });
    expect(shot._tag === "Success" && shot.success.screenshot?.mimeType).toBe("image/png");
  });

  test("the waiting card answers itself the moment macOS reports the permission", { timeout: 60_000 }, async () => {
    const { w, thread, events, asks } = await chat();
    const look = use(thread, { app: "Photo Booth", command: "snapshot" });
    await until(() => asks().length === 1);
    await answer(w.session_id, asks()[0]!.item_id!, "chat");
    await look;
    fs.writeFileSync(path.join(root, "screen-off"), "");
    await use(thread, { app: "Photo Booth", command: "screenshot" });
    const shot = use(thread, { app: "Photo Booth", command: "screenshot" });
    await until(() => asks().length === 2);
    await answer(w.session_id, asks()[1]!.item_id!, "open");
    await until(() => asks().length === 3);
    fs.rmSync(path.join(root, "screen-off"), { force: true });
    const done = await shot;
    expect(done._tag).toBe("Success");
    const settled = events.find((e) => e.type === "ask.resolved" && e.item_id === asks()[2]!.item_id);
    expect(settled).toMatchObject({ payload: { outcome: "answered", response: { kind: "approval", option_id: "added" } } });
  });
});
