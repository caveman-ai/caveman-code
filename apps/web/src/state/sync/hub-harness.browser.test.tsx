import { expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";
import { mountApp } from "../../../test/app.tsx";
import { exchange, runtimeFixture, workspace } from "../../../test/fixtures.ts";
import { SyncHub } from "./hub.ts";
import { indexedDbKv, LOCAL_SCOPE, scopedKv } from "./kv.ts";
import { TranscriptCache } from "./transcript-cache.ts";

test("the app harness drains an accepted append before another connection clears the next fixture", async () => {
  const anotherConnection = indexedDbKv("caveman-sync");
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const stopBegan = Promise.withResolvers<void>();
  let hub: SyncHub | undefined;
  let writing: Promise<void> | undefined;
  let probe: Promise<boolean> | undefined;
  let armed = false;
  let holdAppend = false;
  let startedEmpty = false;

  // onTestFinished runs in reverse registration order: mountApp's real teardown runs before this next-fixture clear.
  onTestFinished(async () => {
    try {
      if (!writing || !probe) return;
      await anotherConnection.clear("");
      await writing;
      const cache = new TranscriptCache(scopedKv(anotherConnection, LOCAL_SCOPE));
      expect(
        await cache.load("s-ws-1"),
        "old transcript must not return after the next fixture cleared it",
      ).toBeNull();
      expect(await probe, "harness must retain its container while shutdown drains").toBe(true);
    } finally {
      released.resolve();
      await writing?.catch(() => undefined);
      await anotherConnection.clear("");
      vi.restoreAllMocks();
    }
  });

  const openFeed = SyncHub.prototype.openFeed;
  vi.spyOn(SyncHub.prototype, "openFeed").mockImplementation(function (this: SyncHub, ...args) {
    hub = this;
    return openFeed.apply(this, args);
  });
  const stop = SyncHub.prototype.stop;
  vi.spyOn(SyncHub.prototype, "stop").mockImplementation(function (this: SyncHub) {
    const stopping = stop.call(this);
    if (armed && this === hub) stopBegan.resolve();
    return stopping;
  });
  const append = TranscriptCache.prototype.append;
  vi.spyOn(TranscriptCache.prototype, "append").mockImplementation(function (
    this: TranscriptCache,
    ...args
  ) {
    if (holdAppend && !writing && hub && this === hub.cache) {
      const store = hub.store();
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (key) => {
        const value = await get(key);
        if (key === "tx/index") {
          // The first accepted append holds its empty-index read, keeping the entire old transcript in flight.
          startedEmpty = !value || !("s-ws-1" in (value as object));
          entered.resolve();
          await released.promise;
        }
        return value;
      });
      writing = append.apply(this, args);
      return writing;
    }
    return append.apply(this, args);
  });

  const { peer } = await mountApp(
    "/w/ws-1",
    runtimeFixture({
      workspaces: [workspace("ws-1")],
      events: { "ws-1": exchange("t1", "Old fixture question", "Old fixture answer") },
    }),
  );
  await expect
    .element(page.getByRole("log").getByText("Old fixture answer", { exact: true }))
    .toBeVisible();
  onTestFinished(() => {
    if (!probe) released.resolve();
  });
  // Hold a cache refill only after startup is ready, so startup itself never depends on releasing the test gate.
  const journal = peer.journalOf("ws-1");
  await hub!.cache.forget(journal.session.id);
  holdAppend = true;
  void hub!.cache.append(journal.session.id, 1, journal.events);
  await entered.promise;
  expect(startedEmpty).toBe(true);
  armed = true;
  probe = (async () => {
    await stopBegan.promise;
    // Let synchronous React cleanup and promise continuations run; the append remains blocked by its explicit gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retained = document.getElementById("root")?.isConnected === true;
    released.resolve();
    return retained;
  })();
  // Returning invokes mountApp's actual root.unmount + awaited shutdown, followed by the observer above.
});
