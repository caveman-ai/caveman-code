import type { Client } from "@caveman-app/session-protocol";
import { afterEach, expect, test, vi } from "vitest";
import { WorkingSet } from "../src/keepAwake.ts";
import { runtimeClient, type Endpoint } from "../src/runtimeClient.ts";

/** A stand-in Session Protocol client: records what main asks and lets the test send notifications and hellos. */
function fakeClient(answer: (method: string) => Promise<unknown>) {
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const hellos = new Set<() => void>();
  const client = {
    calls: [] as Array<{ method: string; options: unknown }>,
    closed: false,
    call: vi.fn((method: string, _params: unknown, options: unknown) => {
      client.calls.push({ method, options });
      return answer(method);
    }),
    on: (name: string, handler: (params: unknown) => void) => {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    onHello: (listener: () => void) => {
      hellos.add(listener);
      return () => hellos.delete(listener);
    },
    close: () => {
      client.closed = true;
    },
    emit: (name: string, params: unknown) => handlers.get(name)?.forEach((h) => h(params)),
    hello: () => hellos.forEach((h) => h()),
  };
  return client;
}
type Fake = ReturnType<typeof fakeClient>;

function setup(answer: (method: string) => Promise<unknown> = async () => ({ ok: true })) {
  let endpoint: Endpoint = { url: "ws://127.0.0.1:1/", token: "a" };
  const made: Array<Fake> = [];
  const rc = runtimeClient(
    () => endpoint,
    () => {
      const c = fakeClient(answer);
      made.push(c);
      return c as unknown as Client;
    },
  );
  return { rc, made, move: (next: Endpoint) => (endpoint = next) };
}

afterEach(() => vi.useRealTimers());

test("every call shares one client while the endpoint stays", async () => {
  const { rc, made } = setup();
  await rc.call("settings.get", {}, 1_000);
  await rc.call("device.awake", {}, 1_000);
  await rc.call("workspace.list", {}, 1_000);
  expect(made).toHaveLength(1);
  expect(made[0]!.calls.map((c) => c.method)).toEqual([
    "settings.get",
    "device.awake",
    "workspace.list",
  ]);
  // A mutating call not out by the deadline is withdrawn, never sent late.
  expect(made[0]!.calls[0]!.options).toEqual({ timeoutMs: 1_000, unsentAfterMs: 1_000 });
});

test("a call fails at its deadline even when the runtime never answers", async () => {
  vi.useFakeTimers();
  const { rc } = setup(() => new Promise(() => undefined));
  const call = rc.call("device.awake", {}, 2_000);
  const failed = expect(call).rejects.toThrow("did not answer device.awake");
  await vi.advanceTimersByTimeAsync(2_000);
  await failed;
});

test("a new endpoint closes the old client and carries every handler to the new one", async () => {
  const { rc, made, move } = setup();
  const changed = vi.fn();
  const connected = vi.fn();
  rc.on("workspace.changed", changed);
  rc.onConnected(connected);
  expect(made).toHaveLength(1); // `on` opens the client, so events come before any call
  made[0]!.emit("workspace.changed", { id: "w1" });
  made[0]!.hello();
  move({ url: "ws://127.0.0.1:2/", token: "b" });
  rc.follow();
  expect(made).toHaveLength(2);
  expect(made[0]!.closed).toBe(true);
  made[1]!.emit("workspace.changed", { id: "w2" });
  made[1]!.hello();
  expect(changed.mock.calls.map(([w]) => (w as { id: string }).id)).toEqual(["w1", "w2"]);
  expect(connected).toHaveBeenCalledTimes(2);
  // The old client's handlers are gone with it.
  made[0]!.emit("workspace.changed", { id: "stale" });
  expect(changed).toHaveBeenCalledTimes(2);
});

test("unsubscribing stops a handler; close closes the client and refuses calls", async () => {
  const { rc, made } = setup();
  const changed = vi.fn();
  const off = rc.on("workspace.changed", changed);
  off();
  made[0]!.emit("workspace.changed", { id: "w1" });
  expect(changed).not.toHaveBeenCalled();
  rc.close();
  expect(made[0]!.closed).toBe(true);
  await expect(rc.call("settings.get", {}, 1_000)).rejects.toThrow("closed");
});

test("the working set changes only when a chat here starts or stops", () => {
  const set = new WorkingSet();
  const here = { kind: "this_mac" };
  expect(set.update({ id: "a", status: "idle", computer: here })).toBe(false);
  expect(set.update({ id: "a", status: "working", computer: here })).toBe(true);
  // A streamed reply's progress, a title: still working, nothing to look at.
  expect(set.update({ id: "a", status: "working", computer: here })).toBe(false);
  expect(set.update({ id: "a", status: "waiting", computer: here })).toBe(false);
  // Moved to a Cloud computer: no longer working on this Mac.
  expect(set.update({ id: "a", status: "working", computer: { kind: "cloud" } })).toBe(true);
  expect(set.update({ id: "b", status: "starting", computer: here })).toBe(true);
  set.clear();
  expect(set.update({ id: "b", status: "working", computer: here })).toBe(true);
});
