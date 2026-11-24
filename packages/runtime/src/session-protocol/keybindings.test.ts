// keybindings.*: the app's own shortcuts (Settings > Keyboard) through upstream
// keybindings.json service, defaults until the user changes one.
import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { connect } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ServerConfig from "../config.ts";
import * as Keybindings from "../keybindings.ts";
import { makeConfig, startRuntime } from "./testHarness.ts";

let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  config = await makeConfig();
  const keybindings = Keybindings.layer.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(ServerConfig.ServerConfig, config), NodeServices.layer)));
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: keybindings });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
});

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );
const keyOf = (list: ReadonlyArray<{ command: string; key: string }>, command: string) => list.find((k) => k.command === command)?.key;

test("lists the app's commands with their defaults and none of T3's", async () => {
  const { keybindings } = await client.call("keybindings.get", {});
  expect(keyOf(keybindings, "app.terminal")).toBe("ctrl+`");
  expect(keyOf(keybindings, "app.splitRight")).toBe("mod+d");
  // The window's tabs: ⌘T opens one, ⌃⇥ / ⌃⇧⇥ step, ⌘⇧T brings one back (⌘1..⌘9 are fixed, not here).
  expect(keyOf(keybindings, "app.newTab")).toBe("mod+t");
  expect(keyOf(keybindings, "app.nextTab")).toBe("ctrl+tab");
  expect(keyOf(keybindings, "app.previousTab")).toBe("ctrl+shift+tab");
  expect(keyOf(keybindings, "app.reopenTab")).toBe("mod+shift+t");
  expect(keyOf(keybindings, "app.shortcuts")).toBe("?");
  // The chat's own: find, and the composer's model and permissions pickers.
  expect(keyOf(keybindings, "app.findInChat")).toBe("mod+f");
  expect(keyOf(keybindings, "app.pickModel")).toBe("mod+shift+m");
  expect(keyOf(keybindings, "app.pickPermissions")).toBe("mod+shift+a");
  expect(keybindings.every((k) => k.command.startsWith("app."))).toBe(true);
});

test("Next speed (app.toggleSpeed) is listed, keeps its chord from other commands, rebinds and resets", async () => {
  const set = (command: string, key: string | null, id: string) => client.call("keybindings.set", { request_id: id, command, key });
  const message = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { message?: string }) => error.message);
  expect(keyOf((await client.call("keybindings.get", {})).keybindings, "app.toggleSpeed")).toBe("mod+shift+f");
  expect(await message(set("app.pickModel", "mod+shift+f", "t1"))).toBe("mod+shift+f already runs app.toggleSpeed");
  expect(keyOf((await set("app.toggleSpeed", "mod+alt+s", "t2")).keybindings, "app.toggleSpeed")).toBe("mod+alt+s");
  expect(keyOf((await set("app.toggleSpeed", null, "t3")).keybindings, "app.toggleSpeed")).toBe("mod+shift+f");
});

test("set rebinds, refuses a key in use or no key at all, and null puts the default back", async () => {
  const set = (command: string, key: string | null, id: string) => client.call("keybindings.set", { request_id: id, command, key });
  expect(keyOf((await set("app.terminal", "Mod+J", "k1")).keybindings, "app.terminal")).toBe("mod+j");
  expect(keyOf((await set("app.terminal", "mod+shift+j", "k2")).keybindings, "app.terminal")).toBe("mod+shift+j");
  expect(fs.readFileSync(config.keybindingsConfigPath, "utf8")).toContain('"mod+shift+j"');
  expect(await failure(set("app.changes", "mod+k", "k3"))).toBe("invalid_params");
  expect(await failure(set("terminal.toggle", "mod+y", "k4"))).toBe("invalid_params");
  expect(await failure(set("app.changes", "mod+shift", "k5"))).toBe("invalid_params");
  expect(keyOf((await set("app.terminal", null, "k6")).keybindings, "app.terminal")).toBe("ctrl+`");
  expect(keyOf((await client.call("keybindings.get", {})).keybindings, "app.terminal")).toBe("ctrl+`");
});

test("set refuses a chord the app keeps for itself: the tabs, sending, editing, the desktop menu", async () => {
  const set = (command: string, key: string, id: string) => client.call("keybindings.set", { request_id: id, command, key });
  const message = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { message?: string }) => error.message);
  // mod+1 goes to the first tab, mod+9 to the last; they used to be taken without a word.
  expect(await failure(set("app.search", "mod+1", "r1"))).toBe("invalid_params");
  expect(await message(set("app.search", "mod+1", "r2"))).toContain("goes to tab 1");
  expect(await message(set("app.search", "mod+9", "r2a"))).toContain("goes to the last tab");
  expect(await failure(set("app.search", "Mod+C", "r3"))).toBe("invalid_params");
  expect(await failure(set("app.search", "mod+enter", "r4"))).toBe("invalid_params");
  expect(await failure(set("app.search", "mod+n", "r5"))).toBe("invalid_params");
  // The send keys as "Send with ⌘Enter" moves them.
  expect(await failure(set("app.search", "mod+alt+enter", "r5a"))).toBe("invalid_params");
  expect(await failure(set("app.search", "shift+mod+enter", "r5b"))).toBe("invalid_params");
  // Nothing was stored, and a free chord still binds.
  expect(keyOf((await client.call("keybindings.get", {})).keybindings, "app.search")).toBe("mod+k");
  expect(keyOf((await set("app.search", "mod+shift+k", "r6")).keybindings, "app.search")).toBe("mod+shift+k");
  expect(keyOf((await client.call("keybindings.set", { request_id: "r7", command: "app.search", key: null })).keybindings, "app.search")).toBe("mod+k");
});
