// computer.* over the Session Protocol. Without a desktop (This Mac) every call
// says unsupported. With CAVEMAN_TEST_DESKTOP_TOOLS=<host:port> (a tools exec
// channel with Xvfb, xdotool and ImageMagick), a real desktop: watching it shows
// nothing until someone uses it, Take over starts it and streams frames about
// five a second, input lands in a Chrome window, the agent's action reaches the viewer as
// its own screenshot and a pointer, and a dropped connection hands it back.
// Every window hears when the agent acts there (a fake desktop is enough).
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type NotificationParams, type SessionEvent, type SocketFactory } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { afterAll, expect, test } from "vitest";

import { ACTIVE_NOTICE_MS } from "./browser.ts";
import { Desktop, layerFor, type DesktopChange } from "./desktop.ts";
import { createReady, desktopWindowTitled, loadTranscript, makeConfig, makeRepo, MODEL, openDesktopTestWindow, startRuntime, tempRoot, until } from "./testHarness.ts";

const socket = process.env.CAVEMAN_TEST_DESKTOP_TOOLS;
const screens = process.env.CAVEMAN_TEST_DESKTOP_SCREENS;
const root = tempRoot("sp-computer-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );

test("without a desktop, computer.* is unsupported", { timeout: 120_000 }, async () => {
  const runtime = await startRuntime(await makeConfig(), await loadTranscript());
  const client = connect(runtime.url, runtime.token);
  try {
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    expect(await reason(client.call("computer.screencast", { workspace_id: w.id, enabled: true }))).toBe("unsupported");
    expect(await reason(client.call("computer.control", { request_id: "c", workspace_id: w.id, controller: "user" }))).toBe("unsupported");
  } finally {
    client.close();
    await runtime.close();
  }
});

test("every window hears the agent acting on the desktop: reveal once per start, active at most every few seconds", { timeout: 120_000 }, async () => {
  // A desktop that only reports the agent's actions: what a window that never opened the Computer tab hears.
  const changes = await Effect.runPromise(PubSub.unbounded<DesktopChange>());
  const shot = { mimeType: "image/png" as const, data: Buffer.from([0x89]), width: 1280, height: 800 };
  const desktop = Desktop.of({
    available: Effect.succeed(true),
    running: () => true,
    start: Effect.void,
    capture: () => Effect.succeed(shot),
    act: () => Effect.succeed({}),
    input: () => Effect.void,
    holder: () => undefined,
    hold: () => Effect.void,
    changes,
  });
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide: Layer.succeed(Desktop, desktop) });
  const client = connect(runtime.url, runtime.token);
  try {
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const heard: Array<NotificationParams<"computer.state">> = [];
    client.on("computer.state", (s) => heard.push(s));
    const act = () => Effect.runPromise(PubSub.publish(changes, { type: "acted", threadId: `caveman:${w.id}`, shot }));

    await act();
    await until(() => heard.length === 1);
    expect(heard[0]).toEqual({ workspace_id: w.id, controller: "agent", width: 1280, height: 800, active: true, reveal: true });
    // A burst of actions is one notice; another agent's thread is not this workspace.
    await act();
    await act();
    await Effect.runPromise(PubSub.publish(changes, { type: "acted", threadId: "caveman:other", shot }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(heard).toHaveLength(1);
    // Past the throttle, the next action is told again, without reveal.
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_NOTICE_MS));
    await act();
    await until(() => heard.length === 2);
    expect(heard[1]).toEqual({ workspace_id: w.id, controller: "agent", width: 1280, height: 800, active: true });
  } finally {
    client.close();
    await runtime.close();
  }
});

// Control belongs to the connection that took it, and a dropped connection hands it back. A Take over whose answer was
// lost with its socket is resent, with its request_id, on the next one: it must take the desktop there.
test("a Take over resent after its connection dropped takes the desktop for the new connection", { timeout: 120_000 }, async () => {
  const changes = await Effect.runPromise(PubSub.unbounded<DesktopChange>());
  const shot = { mimeType: "image/png" as const, data: Buffer.from([0x89]), width: 1280, height: 800 };
  let holder: string | undefined;
  const holds: Array<"taken" | "released"> = [];
  const desktop = Desktop.of({
    available: Effect.succeed(true),
    running: () => true,
    start: Effect.void,
    capture: () => Effect.succeed(shot),
    act: () => Effect.succeed({}),
    input: () => Effect.void,
    holder: () => holder,
    hold: (id) =>
      Effect.sync(() => {
        holds.push(id === undefined ? "released" : "taken");
        holder = id;
      }),
    changes,
  });
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide: Layer.succeed(Desktop, desktop) });
  // The first socket closes as computer.control's answer reaches it: the runtime took over, the client never heard.
  let sockets = 0;
  const blip: SocketFactory = (url, bearer) => {
    const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(bearer).toString("base64url")}`]);
    const drops = ++sockets === 1;
    let control: unknown;
    return {
      get readyState() {
        return ws.readyState;
      },
      send(frame: string) {
        const message = JSON.parse(frame) as { id?: unknown; method?: string };
        if (message.method === "computer.control") control = message.id;
        ws.send(frame);
      },
      close: (code?: number, why?: string) => ws.close(code, why),
      set onopen(fn: WebSocket["onopen"]) {
        ws.onopen = fn;
      },
      set onerror(fn: WebSocket["onerror"]) {
        ws.onerror = fn;
      },
      set onclose(fn: WebSocket["onclose"]) {
        ws.onclose = fn;
      },
      set onmessage(fn: WebSocket["onmessage"]) {
        ws.onmessage = (event) => {
          if (drops && control !== undefined && (JSON.parse(String(event.data)) as { id?: unknown }).id === control) return ws.close();
          fn?.call(ws, event);
        };
      },
    } as unknown as WebSocket;
  };
  const client = connect(runtime.url, runtime.token, undefined, { socket: blip });
  try {
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    expect(await client.call("computer.control", { request_id: "take", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
    expect(sockets).toBe(2);
    // The person was told they drive, so their typing lands.
    expect(await reason(client.call("computer.input", { request_id: "type", workspace_id: w.id, events: [{ type: "text", text: "x" }] }))).toBe("ok");
    expect(holds).toEqual(["taken", "released", "taken"]);
  } finally {
    client.close();
    await runtime.close();
  }
});

// A Take over waits in its chat's lane behind the call before it (here a first Take over while the desktop starts,
// which takes seconds on a Cloud computer) and still runs after its window closed: handlers outlive their socket.
test("a Take over that ran after its window closed hands the desktop back: the agent and other windows may use it", { timeout: 120_000 }, async () => {
  const changes = await Effect.runPromise(PubSub.unbounded<DesktopChange>());
  const shot = { mimeType: "image/png" as const, data: Buffer.from([0x89]), width: 1280, height: 800 };
  let holder: string | undefined;
  const holds: Array<"taken" | "released"> = [];
  let starts = 0;
  let started!: () => void;
  const starting = new Promise<void>((resolve) => (started = resolve));
  const desktop = Desktop.of({
    available: Effect.succeed(true),
    running: () => starts > 0,
    start: Effect.suspend(() => (++starts === 1 ? Effect.promise(() => starting) : Effect.void)),
    capture: () => Effect.succeed(shot),
    act: () => Effect.succeed({}),
    input: () => Effect.void,
    holder: () => holder,
    hold: (id) =>
      Effect.sync(() => {
        holds.push(id === undefined ? "released" : "taken");
        holder = id;
      }),
    changes,
  });
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide: Layer.succeed(Desktop, desktop) });
  // The closing window's frames, as they go on the wire.
  const sent: Array<string> = [];
  const watched: SocketFactory = (url, bearer) => {
    const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(bearer).toString("base64url")}`]);
    const send = ws.send.bind(ws);
    ws.send = (frame: string) => {
      sent.push((JSON.parse(frame) as { params?: { request_id?: string } }).params?.request_id ?? "");
      send(frame);
    };
    return ws;
  };
  const closing = connect(runtime.url, runtime.token, undefined, { socket: watched });
  const other = connect(runtime.url, runtime.token);
  try {
    const w = await closing.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const take = (request_id: string) => closing.call("computer.control", { request_id, workspace_id: w.id, controller: "user" }).catch(() => undefined);
    void take("take");
    await until(() => starts === 1);
    // A second click while the desktop starts, then the window closes: closing hands back what the first click took.
    void take("take again");
    await until(() => sent.includes("take again"));
    closing.close();
    await until(() => holds.length === 2);
    expect(holds).toEqual(["taken", "released"]);
    started();
    // The second Take over runs now: it either went on to start the desktop for the closed window, or handed it back.
    await until(() => starts === 2 || holds.length === 4);
    expect(holder).toBeUndefined();
    expect(await reason(other.call("computer.control", { request_id: "take here", workspace_id: w.id, controller: "user" }))).toBe("ok");
  } finally {
    closing.close();
    other.close();
    await runtime.close();
  }
});

test.skipIf(!socket)("watch, take over, drive and hand back a real desktop", { timeout: 240_000 }, async () => {
  // One desktop, shared with the runtime, so the test can act as the agent's computer tool does.
  const scope = await Effect.runPromise(Scope.make());
  const desktop = Context.get(await Effect.runPromise(Layer.buildWithScope(layerFor(socket), scope)), Desktop);
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide: Layer.succeed(Desktop, desktop) });
  const client = connect(runtime.url, runtime.token);
  const other = connect(runtime.url, runtime.token);
  try {
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const states: Array<NotificationParams<"computer.state">> = [];
    const frames: Array<NotificationParams<"computer.frame">> = [];
    const pointers: Array<NotificationParams<"computer.pointer">> = [];
    client.on("computer.state", (s) => states.push(s));
    client.on("computer.frame", (f) => frames.push(f));
    client.on("computer.pointer", (p) => pointers.push(p));
    // A window that never opened the Computer tab hears only that the agent is on the desktop (its quiet tab).
    const heard: Array<NotificationParams<"computer.state">> = [];
    other.on("computer.state", (s) => heard.push(s));
    other.on("computer.frame", () => {
      throw new Error("frames went to a window that isn't watching");
    });
    const last = () => states.at(-1)!;

    // Watching a desktop nothing has used: its state, no frames, and nothing started.
    expect(await client.call("computer.screencast", { workspace_id: w.id, enabled: true, max_fps: 30 })).toEqual({});
    await until(() => states.length > 0);
    expect(last()).toEqual({ workspace_id: w.id, controller: "none", width: 0, height: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(frames).toHaveLength(0);
    expect(await reason(client.call("computer.input", { request_id: "i0", workspace_id: w.id, events: [{ type: "text", text: "x" }] }))).toBe("invalid_state");

    // Take over starts it; frames come about five a second while a person drives.
    expect(await client.call("computer.control", { request_id: "c1", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
    await until(() => last().controller === "user" && last().width === 1280);
    await until(() => frames.length > 0, 20_000);
    expect(frames[0]).toMatchObject({ workspace_id: w.id, mime_type: "image/jpeg", width: 1280, height: 800 });
    expect(Buffer.from(frames[0]!.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // A window on the desktop, then the person's clicks and typing land in it.
    await openDesktopTestWindow(socket!);
    await client.call("computer.input", {
      request_id: "i1",
      workspace_id: w.id,
      events: [
        { type: "pointer", action: "move", x: 300, y: 200, modifiers: 0 },
        { type: "pointer", action: "down", x: 300, y: 200, button: "left", modifiers: 0 },
        { type: "pointer", action: "up", x: 300, y: 200, button: "left", modifiers: 0 },
        ...[..."hi"].flatMap((key) => [
          { type: "key" as const, action: "down" as const, key, code: `Key${key.toUpperCase()}`, modifiers: 0 },
          { type: "key" as const, action: "up" as const, key, code: `Key${key.toUpperCase()}`, modifiers: 0 },
        ]),
        { type: "text", text: " there" },
      ],
    });
    await until(() => desktopWindowTitled(socket!, "hi there"), 10_000);
    // Frames come while the screen changes, no faster than about five a second.
    const start = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(frames.length - start).toBeLessThanOrEqual(11);
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (screens) {
      fs.mkdirSync(screens, { recursive: true });
      fs.writeFileSync(path.join(screens, "computer-person-frame.jpg"), Buffer.from(frames.at(-1)!.data, "base64"));
    }

    // Another window can't take it while this one holds it; the agent may only look.
    expect(await reason(other.call("computer.control", { request_id: "c2", workspace_id: w.id, controller: "user" }))).toBe("user_in_control");
    expect(await reason(other.call("computer.input", { request_id: "i2", workspace_id: w.id, events: [{ type: "text", text: "x" }] }))).toBe("user_in_control");

    // Hand back: the agent drives. Its action reaches the viewer at once as its own screenshot, with its pointer.
    expect(await client.call("computer.control", { request_id: "c3", workspace_id: w.id, controller: "agent" })).toEqual({ controller: "agent" });
    await until(() => last().controller === "agent");
    const before = frames.length;
    await Effect.runPromise(desktop.act(`caveman:${w.id}`, { action: "left_click", coordinate: [320, 240] }));
    await until(() => frames.slice(before).some((f) => f.mime_type === "image/png"));
    expect(pointers.at(-1)).toMatchObject({ workspace_id: w.id, x: 320, y: 240, phase: "click" });
    await until(() => heard.some((s) => s.workspace_id === w.id && s.controller === "agent"));

    // Taking over from the other window, then dropping it, hands the desktop back.
    expect(await other.call("computer.control", { request_id: "c4", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
    await until(() => last().controller === "user");
    other.close();
    await until(() => last().controller === "agent");

    // Stopping the screencast stops the frames.
    await client.call("computer.screencast", { workspace_id: w.id, enabled: false });
    const stopped = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(frames.length).toBe(stopped);
  } finally {
    client.close();
    other.close();
    await runtime.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

// Take over on a Cloud desktop nothing has started yet starts it first (up to 30 s). The person, seeing the agent
// misbehave, presses Stop meanwhile: it is the chat's next call on that connection and must stop the turn now. Typing
// sent behind the Take over still lands after it.
test("Stop answers and ends the turn while a Take over is still starting the desktop", { timeout: 120_000 }, async () => {
  const changes = await Effect.runPromise(PubSub.unbounded<DesktopChange>());
  const shot = { mimeType: "image/png" as const, data: Buffer.from([0x89]), width: 1280, height: 800 };
  let holder: string | undefined;
  let starting = false;
  let up!: () => void;
  const started = new Promise<void>((resolve) => (up = resolve));
  const desktop = Desktop.of({
    available: Effect.succeed(true),
    running: () => false,
    start: Effect.suspend(() => ((starting = true), Effect.promise(() => started))),
    capture: () => Effect.succeed(shot),
    act: () => Effect.succeed({}),
    input: () => Effect.void,
    holder: () => holder,
    hold: (id) => Effect.sync(() => void (holder = id)),
    changes,
  });
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: Layer.succeed(Desktop, desktop) });
  const client = connect(runtime.url, runtime.token);
  try {
    const w = await createReady(client, { request_id: "w", repo: { path: makeRepo(root, { "README.md": "stop\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    const { turn_id } = await client.call("turn.submit", { request_id: "slow", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: keep working" } });
    await until(() => events.some((e) => e.type === "turn.started" && e.turn_id === turn_id), 30_000);

    const answered: Array<string> = [];
    const takeOver = client.call("computer.control", { request_id: "take", workspace_id: w.id, controller: "user" }).then(
      () => void answered.push("take over"),
      () => void answered.push("take over refused"),
    );
    const typed = client.call("computer.input", { request_id: "type", workspace_id: w.id, events: [{ type: "text", text: "x" }] }).then(
      () => void answered.push("typing"),
      () => void answered.push("typing refused"),
    );
    await until(() => starting, 10_000);
    const stop = client.call("turn.interrupt", { request_id: "stop", session_id: w.session_id }).then(
      () => "answered",
      () => "refused",
    );
    const stopped = await Promise.race([stop, new Promise<string>((resolve) => setTimeout(() => resolve("waiting behind the take over"), 10_000))]);
    const turnEnded = await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === turn_id), 10_000).then(
      () => true,
      () => false,
    );
    const answeredWhileStarting = [...answered];
    up();
    expect({ stopped, turnEnded, answeredWhileStarting }).toEqual({ stopped: "answered", turnEnded: true, answeredWhileStarting: [] });
    await Promise.all([takeOver, typed]);
    expect(answered).toEqual(["take over", "typing"]);
  } finally {
    up();
    client.close();
    await runtime.close();
  }
});

test.skipIf(!socket)("watch, take over, drive and hand back a real desktop", { timeout: 240_000 }, async () => {
  // One desktop, shared with the runtime, so the test can act as the agent's computer tool does.
  const scope = await Effect.runPromise(Scope.make());
  const desktop = Context.get(await Effect.runPromise(Layer.buildWithScope(layerFor(socket), scope)), Desktop);
  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide: Layer.succeed(Desktop, desktop) });
  const client = connect(runtime.url, runtime.token);
  const other = connect(runtime.url, runtime.token);
  try {
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
    const states: Array<NotificationParams<"computer.state">> = [];
    const frames: Array<NotificationParams<"computer.frame">> = [];
    const pointers: Array<NotificationParams<"computer.pointer">> = [];
    client.on("computer.state", (s) => states.push(s));
    client.on("computer.frame", (f) => frames.push(f));
    client.on("computer.pointer", (p) => pointers.push(p));
    // A window that never opened the Computer tab hears only that the agent is on the desktop (its quiet tab).
    const heard: Array<NotificationParams<"computer.state">> = [];
    other.on("computer.state", (s) => heard.push(s));
    other.on("computer.frame", () => {
      throw new Error("frames went to a window that isn't watching");
    });
    const last = () => states.at(-1)!;

    // Watching a desktop nothing has used: its state, no frames, and nothing started.
    expect(await client.call("computer.screencast", { workspace_id: w.id, enabled: true, max_fps: 30 })).toEqual({});
    await until(() => states.length > 0);
    expect(last()).toEqual({ workspace_id: w.id, controller: "none", width: 0, height: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(frames).toHaveLength(0);
    expect(await reason(client.call("computer.input", { request_id: "i0", workspace_id: w.id, events: [{ type: "text", text: "x" }] }))).toBe("invalid_state");

    // Take over starts it; frames come about five a second while a person drives.
    expect(await client.call("computer.control", { request_id: "c1", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
    await until(() => last().controller === "user" && last().width === 1280);
    await until(() => frames.length > 0, 20_000);
    expect(frames[0]).toMatchObject({ workspace_id: w.id, mime_type: "image/jpeg", width: 1280, height: 800 });
    expect(Buffer.from(frames[0]!.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // A window on the desktop, then the person's clicks and typing land in it.
    await openDesktopTestWindow(socket!);
    await client.call("computer.input", {
      request_id: "i1",
      workspace_id: w.id,
      events: [
        { type: "pointer", action: "move", x: 300, y: 200, modifiers: 0 },
        { type: "pointer", action: "down", x: 300, y: 200, button: "left", modifiers: 0 },
        { type: "pointer", action: "up", x: 300, y: 200, button: "left", modifiers: 0 },
        ...[..."hi"].flatMap((key) => [
          { type: "key" as const, action: "down" as const, key, code: `Key${key.toUpperCase()}`, modifiers: 0 },
          { type: "key" as const, action: "up" as const, key, code: `Key${key.toUpperCase()}`, modifiers: 0 },
        ]),
        { type: "text", text: " there" },
      ],
    });
    await until(() => desktopWindowTitled(socket!, "hi there"), 10_000);
    // Frames come while the screen changes, no faster than about five a second.
    const start = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(frames.length - start).toBeLessThanOrEqual(11);
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (screens) {
      fs.mkdirSync(screens, { recursive: true });
      fs.writeFileSync(path.join(screens, "computer-person-frame.jpg"), Buffer.from(frames.at(-1)!.data, "base64"));
    }

    // Another window can't take it while this one holds it; the agent may only look.
    expect(await reason(other.call("computer.control", { request_id: "c2", workspace_id: w.id, controller: "user" }))).toBe("user_in_control");
    expect(await reason(other.call("computer.input", { request_id: "i2", workspace_id: w.id, events: [{ type: "text", text: "x" }] }))).toBe("user_in_control");

    // Hand back: the agent drives. Its action reaches the viewer at once as its own screenshot, with its pointer.
    expect(await client.call("computer.control", { request_id: "c3", workspace_id: w.id, controller: "agent" })).toEqual({ controller: "agent" });
    await until(() => last().controller === "agent");
    const before = frames.length;
    await Effect.runPromise(desktop.act(`caveman:${w.id}`, { action: "left_click", coordinate: [320, 240] }));
    await until(() => frames.slice(before).some((f) => f.mime_type === "image/png"));
    expect(pointers.at(-1)).toMatchObject({ workspace_id: w.id, x: 320, y: 240, phase: "click" });
    await until(() => heard.some((s) => s.workspace_id === w.id && s.controller === "agent"));

    // Taking over from the other window, then dropping it, hands the desktop back.
    expect(await other.call("computer.control", { request_id: "c4", workspace_id: w.id, controller: "user" })).toEqual({ controller: "user" });
    await until(() => last().controller === "user");
    other.close();
    await until(() => last().controller === "agent");

    // Stopping the screencast stops the frames.
    await client.call("computer.screencast", { workspace_id: w.id, enabled: false });
    const stopped = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(frames.length).toBe(stopped);
  } finally {
    client.close();
    other.close();
    await runtime.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
