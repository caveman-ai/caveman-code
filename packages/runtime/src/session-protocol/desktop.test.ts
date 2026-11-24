// The desktop: how actions and a person's input become xdotool lines, and, with
// CAVEMAN_TEST_DESKTOP_TOOLS=<host:port> (a tools exec channel in a computer image
// with Xvfb, xdotool, ImageMagick and Chrome), a real run: a Chrome window on the
// desktop, clicked and typed into through the `computer` MCP tool, read back by its title.
// CAVEMAN_TEST_DESKTOP_SCREENS=<dir> keeps the screenshots.
import * as fs from "node:fs";
import * as path from "node:path";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import { McpSchema, McpServer } from "effect/ai";
import { describe, expect, test } from "vitest";

import { toolsRun } from "../cloudLink/tools.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import { actionLines, Desktop, inputLines, layerFor, quote } from "./desktop.ts";
import { desktopLongTitle, desktopWindowTitled, openDesktopTestWindow, until } from "./testHarness.ts";

describe("desktop commands", () => {
  test("quote keeps any text one shell word and refuses line breaks", () => {
    expect(quote("it's")).toBe(`'it'\\''s'`);
    expect(() => quote("a\nb")).toThrow();
  });

  test("actions become xdotool chains in screenshot pixels", () => {
    expect(actionLines({ action: "left_click", coordinate: [10, 20] })).toEqual({
      lines: [`'xdotool' 'mousemove' '10' '20' 'click' '--repeat' '1' '--delay' '80' '1'`],
      pointer: { x: 10, y: 20, phase: "click" },
    });
    expect(actionLines({ action: "double_click" }).lines[0]).toBe(`'xdotool' 'click' '--repeat' '2' '--delay' '80' '1'`);
    expect(actionLines({ action: "scroll", coordinate: [5, 5], scroll_direction: "down", scroll_amount: 2 }).lines[0]).toContain(`'click' '--repeat' '2' '5'`);
    expect(actionLines({ action: "key", text: "ctrl+s  Return" }).lines[0]).toBe(`'xdotool' 'key' '--clearmodifiers' '--delay' '50' 'ctrl+s' 'Return'`);
    expect(actionLines({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] }).lines[0]).toContain(`'mousedown' '1' 'sleep' '0.1' 'mousemove' '3' '4'`);
    // Typed text reaches xdotool as a file, so a line break or quote in it is just text.
    expect(actionLines({ action: "type", text: "a'b\nc" }).lines[0]).toBe(
      `printf %s '${Buffer.from("a'b\nc").toString("base64")}' | base64 -d | timeout 15 xdotool type --delay 12 --file -`,
    );
    expect(actionLines({ action: "screenshot" }).lines).toEqual([]);
  });

  test("key takes keysym chords only: no xdotool command, quote or flag gets through", () => {
    for (const text of ["Return exec sh -c 'id'", "Return EXEC id", "type hi", "a sleep", "--window 1 a", "ctrl+", "a;b", "$(id)", "Help", "   "]) {
      expect(() => actionLines({ action: "key", text }), text).toThrow(/keysym names/);
    }
    expect(actionLines({ action: "key", text: "ctrl+shift+t F5 KP_Enter" }).lines[0]).toBe(`'xdotool' 'key' '--clearmodifiers' '--delay' '50' 'ctrl+shift+t' 'F5' 'KP_Enter'`);
  });

  test("long text types in lines short enough for the command timeout, whole characters each", () => {
    const text = `${"é".repeat(49)}🙂${"x".repeat(2950)}`;
    const lines = actionLines({ action: "type", text }).lines;
    expect(lines).toHaveLength(60);
    const typed = lines.map((line) => Buffer.from(/printf %s '([^']+)'/.exec(line)![1]!, "base64").toString());
    expect(typed.join("")).toBe(text);
    expect(typed[0]!.endsWith("🙂")).toBe(true);
  });

  test("bad action input says what is wrong", () => {
    expect(() => actionLines({ action: "left_click", coordinate: [1280, 0] })).toThrow(/on the 1280x800 screen/);
    expect(() => actionLines({ action: "mouse_move" })).toThrow(/needs coordinate/);
    expect(() => actionLines({ action: "type" })).toThrow(/needs text/);
    expect(() => actionLines({ action: "scroll" })).toThrow(/needs scroll_direction/);
  });

  test("a person's input: pointer, wheel, typed characters and chords", () => {
    expect(
      inputLines([
        { type: "pointer", action: "move", x: 10.4, y: 20.6, modifiers: 0 },
        { type: "pointer", action: "down", x: 10, y: 20, button: "left", modifiers: 8 },
        { type: "pointer", action: "up", x: 12, y: 22, button: "left", modifiers: 0 },
        { type: "wheel", x: 1, y: 1, dx: 0, dy: -120, modifiers: 0 },
      ]),
    ).toEqual([
      `'xdotool' 'mousemove' '10' '21' 'mousemove' '10' '20' 'keydown' 'shift' 'mousedown' '1' 'keyup' 'shift' 'mousemove' '12' '22' 'mouseup' '1' 'mousemove' '1' '1' 'click' '--repeat' '2' '4'`,
    ]);
    const typed = inputLines([
      { type: "key", action: "down", key: "Shift", code: "ShiftLeft", modifiers: 8 },
      { type: "key", action: "down", key: "H", code: "KeyH", modifiers: 8 },
      { type: "key", action: "up", key: "H", code: "KeyH", modifiers: 8 },
      { type: "key", action: "down", key: "Enter", code: "Enter", modifiers: 0 },
      { type: "key", action: "down", key: "c", code: "KeyC", modifiers: 2 },
      { type: "key", action: "down", key: "/", code: "Slash", modifiers: 2 },
      { type: "text", text: "pasted" },
    ]);
    expect(typed).toEqual([
      `printf %s '${Buffer.from("H").toString("base64")}' | base64 -d | timeout 15 xdotool type --delay 12 --file -`,
      `'xdotool' 'key' '--clearmodifiers' 'Return' 'key' '--clearmodifiers' 'ctrl+c' 'key' '--clearmodifiers' 'ctrl+slash'`,
      `printf %s '${Buffer.from("pasted").toString("base64")}' | base64 -d | timeout 15 xdotool type --delay 12 --file -`,
    ]);
  });

  test("off a Cloud computer there is no desktop", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const desktop = yield* Desktop;
        return { available: yield* desktop.available, start: yield* Effect.flip(desktop.start) };
      }).pipe(Effect.provide(layerFor(undefined))),
    );
    expect(result.available).toBe(false);
    expect(result.start.reason).toBe("unsupported");
  });
});

const socket = process.env.CAVEMAN_TEST_DESKTOP_TOOLS;
const screens = process.env.CAVEMAN_TEST_DESKTOP_SCREENS;
if (!socket) console.warn("BLOCKED: no real desktop; set CAVEMAN_TEST_DESKTOP_TOOLS=<host:port> to a tools exec channel with Xvfb, xdotool and ImageMagick");

const save = (name: string, data: Buffer) => {
  if (!screens) return;
  fs.mkdirSync(screens, { recursive: true });
  fs.writeFileSync(path.join(screens, name), data);
};

const invocation = {
  environmentId: EnvironmentId.make("environment-desktop-test"),
  requestNamespace: "provider-session-desktop-test",
  thread: { threadId: ThreadId.make("thread-desktop-test"), providerSessionId: "provider-session-desktop-test", providerInstanceId: ProviderInstanceId.make("codex") },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "desktop-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop-test", version: "1.0.0" } },
  getClient: Effect.die("unused"),
});

/** The screen and its windows outlive a runtime: each run starts from none. */
const clearDesktop = () => toolsRun(socket!, "/", ["sh", "-c", "pkill -f '[d]esktop-test-chrome'; kill $(pidof Xvfb) $(pidof openbox) 2>/dev/null; sleep 1; true"]);

test.skipIf(!socket)("the computer tool drives a Chrome window on a real desktop", { timeout: 600_000 }, async () => {
  await clearDesktop();
  const scope = await Effect.runPromise(Scope.make());
  const layer = McpHttpServer.layerComputerToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(layerFor(socket)),
  );
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const server = Context.get(context, McpServer.McpServer);
  const desktop = Context.get(context, Desktop);
  const call = (args: Record<string, unknown>) =>
    Effect.runPromise(
      server.callTool({ name: "computer", arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      ),
    );
  const image = (result: McpSchema.CallToolResult) => {
    const block = result.content.find((c) => c.type === "image") as { data: Uint8Array; mimeType: string } | undefined;
    expect(block?.mimeType).toBe("image/png");
    return Buffer.from(block!.data);
  };
  try {
    expect(await Effect.runPromise(desktop.available)).toBe(true);
    // The first call starts the desktop: an empty 1280x800 screen.
    const first = await call({ action: "screenshot" });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ action: "screenshot", screenshot: { mimeType: "image/png", width: 1280, height: 800 } });
    const empty = image(first);
    expect(empty.subarray(1, 4).toString()).toBe("PNG");
    expect(empty.readUInt32BE(16)).toBe(1280);
    expect(empty.readUInt32BE(20)).toBe(800);
    save("desktop-1-started.png", empty);

    // The agent opens a window from its shell (DISPLAY=:99), as the tool's description says: Chrome, a text field.
    await openDesktopTestWindow(socket!);
    const clicked = await call({ action: "left_click", coordinate: [300, 200] });
    expect(clicked.isError).toBe(false);
    save("desktop-2-window.png", image(clicked));
    const typed = await call({ action: "type", text: "desktop ok" });
    expect(typed.isError).toBe(false);
    save("desktop-3-typed.png", image(typed));
    await until(() => desktopWindowTitled(socket!, "desktop ok"), 10_000);
    const keyed = await call({ action: "key", text: "ctrl+a BackSpace" });
    expect(keyed.isError).toBe(false);
    await until(() => desktopWindowTitled(socket!, "Desktop test"), 10_000);
    await call({ action: "type", text: "desktop ok" });

    const where = await call({ action: "cursor_position" });
    expect(where.structuredContent).toEqual({ action: "cursor_position", x: 300, y: 200 });
    expect(where.content.some((c) => c.type === "image")).toBe(false);

    const bad = await call({ action: "left_click", coordinate: [5000, 1] });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("on the 1280x800 screen");

    // A person takes over: the agent may look, not act.
    await Effect.runPromise(desktop.hold("connection-1"));
    const refused = await call({ action: "left_click", coordinate: [10, 10] });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("A person took over the desktop");
    expect((await call({ action: "screenshot" })).isError).toBe(false);
    // Their own input lands in the focused field: End, then typing (computer.test.ts clicks first).
    await Effect.runPromise(
      desktop.input([
        { type: "key", action: "down", key: "End", code: "End", modifiers: 0 },
        { type: "text", text: " and a person" },
      ]),
    );
    await until(() => desktopWindowTitled(socket!, "desktop ok and a person"), 10_000);
    save("desktop-4-person.png", (await Effect.runPromise(desktop.capture("png"))).data);
    await Effect.runPromise(desktop.hold(undefined));

    // Long text types whole, a line at a time, with the desktop up throughout.
    const long = "abcdefghij".repeat(300);
    expect((await call({ action: "key", text: "ctrl+a BackSpace" })).isError).toBe(false);
    const longTyped = await call({ action: "type", text: long });
    expect(longTyped.isError, JSON.stringify(longTyped.content).slice(0, 500)).toBe(false);
    expect(desktop.running()).toBe(true);
    await until(() => desktopWindowTitled(socket!, desktopLongTitle(long)), 20_000);
    save("desktop-5-long-text.png", image(longTyped));
    // A key that would start an xdotool command is refused before anything runs.
    const exec = await call({ action: "key", text: "Return exec touch /tmp/desktop-key-exec" });
    expect(exec.isError).toBe(true);
    expect(JSON.stringify(exec.content)).toContain("keysym names");
    expect((await toolsRun(socket!, "/", ["test", "-e", "/tmp/desktop-key-exec"])).code).not.toBe(0);

    // The shell ending (as a hung command ends it) leaves the screen and its windows: the next action finds them.
    await toolsRun(socket!, "/", ["sh", "-c", "kill -s TERM -$(pgrep -f 'IFS= read -r [l]ine')"]);
    await until(() => !desktop.running(), 10_000);
    expect((await call({ action: "screenshot" })).isError).toBe(false);
    expect(await desktopWindowTitled(socket!, desktopLongTitle(long))).toBe(true);

    // The X server dies (a crash, out of memory): the next action gets a fresh desktop, not a stuck one.
    await toolsRun(socket!, "/", ["sh", "-c", "kill $(pidof Xvfb)"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const again = await call({ action: "screenshot" });
    expect(again.isError).toBe(false);
    expect(desktop.running()).toBe(true);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  // Closing the scope (the runtime stopping) leaves the screen for the next runtime; the computer sleeping ends it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await toolsRun(socket!, "/", ["sh", "-c", "DISPLAY=:99 xdotool getdisplaygeometry"]);
  expect(after.code).toBe(0);
  await clearDesktop();
});
