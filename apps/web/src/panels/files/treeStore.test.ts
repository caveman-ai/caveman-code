import type { Client } from "@caveman-app/session-protocol/client";
import { expect, test, vi } from "vitest";
import { TreeStore } from "./treeStore.ts";

const snapshot = (store: TreeStore) => store.getSnapshot();

const listing = (path: string) => ({ entries: [{ name: "file.ts", path: path ? `${path}/file.ts` : "file.ts", type: "file" }], truncated: false });

test("React reads only published snapshots while listing bursts remain available to tree operations", async () => {
  vi.useFakeTimers();
  try {
    const store = new TreeStore("burst");
    store.reset({ call: async (_method: string, { path }: { path: string }) => listing(path) } as unknown as Client);
    const initial = snapshot(store);
    const notified = vi.fn();
    store.subscribe(notified);
    await store.load("");
    expect(store.state.listings.has("")).toBe(true);
    expect(snapshot(store)).toBe(initial);
    expect(initial.listings.size).toBe(0);
    expect(notified).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(16);
    const published = snapshot(store);
    expect(published).not.toBe(initial);
    expect(published.listings.has("")).toBe(true);
    expect(notified).toHaveBeenCalledTimes(1);

    await store.load("src");
    expect(snapshot(store)).toBe(published);
    expect(published.listings.has("src")).toBe(false);
    expect(published.loading.size).toBe(0);
    // An immediate user action flushes pending listings along with its own state.
    store.setQuery("file");
    expect(snapshot(store).query).toBe("file");
    expect(snapshot(store).listings.has("src")).toBe(true);
    expect(published.listings.has("src")).toBe(false);
    await vi.advanceTimersByTimeAsync(16);
    expect(notified).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("loading and error snapshots stay immutable through a failed listing and retry", async () => {
  vi.useFakeTimers();
  try {
    let reject: (reason: Error) => void = () => {};
    let fail = true;
    const store = new TreeStore("retry");
    store.reset({ call: () => fail ? new Promise((_resolve, no) => { reject = no; }) : Promise.resolve(listing("")) } as unknown as Client);
    const pending = store.load("");
    await vi.advanceTimersByTimeAsync(16);
    const loading = snapshot(store);
    expect(loading.loading.has("")).toBe(true);
    reject(new Error("Listing failed"));
    await pending;
    expect(snapshot(store)).toBe(loading);
    expect(loading.loading.has("")).toBe(true);
    expect(loading.errors.size).toBe(0);

    await vi.advanceTimersByTimeAsync(16);
    const failed = snapshot(store);
    expect(failed.loading.size).toBe(0);
    expect(failed.errors.get("")).toBe("Listing failed");
    fail = false;
    await store.load("");
    expect(snapshot(store)).toBe(failed);
    expect(failed.errors.get("")).toBe("Listing failed");
    await vi.advanceTimersByTimeAsync(16);
    expect(snapshot(store).listings.has("")).toBe(true);
    expect(snapshot(store).errors.size).toBe(0);
    expect(failed.errors.get("")).toBe("Listing failed");
    expect(loading.loading.has("")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

/** A client whose fs.list calls wait until the test settles them, in order. */
function manualClient() {
  const calls: Array<{ path: string; settle: (paths?: ReadonlyArray<string>) => Promise<void> }> = [];
  let active = 0;
  let peak = 0;
  const client = {
    call: (_method: string, { path }: { path: string }) => {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        calls.push({
          path,
          settle: async (paths = []) => {
            active--;
            resolve({ entries: paths.map((p) => ({ name: p, path: p, type: p.startsWith("folder") ? "dir" : "file" })), truncated: false });
            // Let the store's continuations (its finally, a queued follow-up) run.
            for (let i = 0; i < 5; i++) await Promise.resolve();
          },
        });
      });
    },
  } as unknown as Client;
  return { client, calls, peak: () => peak, resetPeak: () => (peak = active) };
}

test("twenty overlapping refreshes list the folder three times: the first, the one in flight, one last (T3's #18421)", async () => {
  const fake = manualClient();
  const store = new TreeStore("coalesce");
  store.reset(fake.client);
  void store.load("");
  await fake.calls[0]!.settle(["a.ts"]);
  for (let i = 0; i < 20; i++) store.refresh();
  for (let i = 1; i < fake.calls.length; i++) await fake.calls[i]!.settle(["a.ts"]);
  expect(fake.calls).toHaveLength(3);
});

test("a refresh during the follow-up listing queues one more, and the last listing wins", async () => {
  const fake = manualClient();
  const store = new TreeStore("follow-up");
  store.reset(fake.client);
  void store.load("");
  store.refresh();
  await fake.calls[0]!.settle(["old.ts"]);
  expect(fake.calls).toHaveLength(2);
  store.refresh();
  store.refresh();
  await fake.calls[1]!.settle(["old.ts"]);
  expect(fake.calls).toHaveLength(3);
  await fake.calls[2]!.settle(["latest.ts"]);
  expect(store.state.listings.get("")?.entries.map((e) => e.path)).toEqual(["latest.ts"]);
  expect(store.state.loading.size).toBe(0);
});

test("callers share the follow-up and wait for the final listing", async () => {
  const fake = manualClient();
  const store = new TreeStore("shared");
  store.reset(fake.client);
  void store.load("");
  let done = false;
  const first = store.load("", true);
  const second = store.load("", true);
  expect(second).toBe(first);
  void first.then(() => (done = true));
  await fake.calls[0]!.settle();
  expect(done).toBe(false);
  await fake.calls[1]!.settle();
  expect(done).toBe(true);
});

test("refreshes keep the four-listing bound across folders", async () => {
  const fake = manualClient();
  const store = new TreeStore("bound");
  store.reset(fake.client);
  void store.load("");
  const folders = Array.from({ length: 8 }, (_, i) => `folder-${i}`);
  await fake.calls[0]!.settle(folders);
  for (const f of folders) store.setExpanded(f, true);
  fake.resetPeak();
  for (let i = 0; i < 3; i++) store.refresh();
  for (let i = 1; i < fake.calls.length; i++) await fake.calls[i]!.settle();
  expect(fake.peak()).toBeLessThanOrEqual(4);
});

test("a reset drops a queued follow-up for the old connection", async () => {
  const fake = manualClient();
  const store = new TreeStore("reset");
  store.reset(fake.client);
  void store.load("");
  store.refresh();
  const fresh = manualClient();
  store.reset(fresh.client);
  await fake.calls[0]!.settle(["stale.ts"]);
  expect(fake.calls).toHaveLength(1);
  expect(store.state.listings.has("")).toBe(false);
});
