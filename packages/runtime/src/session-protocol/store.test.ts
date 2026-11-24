// SessionStore's receipts (server.ts once): every mutating call records one, and remote control records one per
// animation frame (browser.input, computer.input), so recording a receipt must not slow down as live ones pile up.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as Store from "./store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-store-"));
// The database as the daemon opens it.
const runtime = ManagedRuntime.make(
  Store.layer.pipe(
    Layer.provide(Layer.succeed(ProjectSecrets, {} as never)),
    Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(dir, "state.sqlite"))),
    Layer.provide(NodeServices.layer),
  ) as Layer.Layer<Store.SessionStore>,
);
let store!: Store.SessionStore["Service"];
const run = <A>(effect: Effect.Effect<A, never, Store.SessionStore>) => runtime.runPromise(effect);

beforeAll(async () => {
  store = await run(Effect.service(Store.SessionStore));
});
afterAll(async () => {
  await runtime.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A device derives the same id before this runtime has made the chat (apps/web state/sync/message-id.ts, whose
// test pins the same value): the two may never come to differ.
test("the workspace id of a chat Cloud placed here is the one a device already opened it under", () => {
  expect(Store.placedWorkspaceId("0195A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B")).toBe(
    "dacebe5f-f933-4d69-abb0-bd3245cac8a4",
  );
  expect(Store.placedWorkspaceId("0195a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe(
    "dacebe5f-f933-4d69-abb0-bd3245cac8a4",
  );
});

describe("receipts", () => {
  test("recording a receipt sweeps expired ones through an index, not a scan of every live receipt", async () => {
    // The sweep putReceipt runs before each insert.
    const plan = await run(
      store.sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN DELETE FROM caveman_sp_receipts WHERE expires_at <= ${Date.now()}`.pipe(
        Effect.orDie,
      ),
    );
    expect(plan.map((step) => step.detail)).toEqual([
      expect.stringMatching(/^SEARCH caveman_sp_receipts USING (COVERING )?INDEX /),
    ]);
  });

  test("a receipt answers its request until it expires, and the next one recorded sweeps it away", async () => {
    // Recorded already past its lifetime.
    await run(
      store.putReceipt(
        "local",
        "browser.input",
        "r-short",
        { paramsHash: "h1", result: { ok: 1 } },
        -1,
      ),
    );
    await run(
      store.putReceipt(
        "local",
        "turn.submit",
        "r-long",
        { paramsHash: "h2", result: { ok: 2 } },
        60_000,
      ),
    );
    expect(await run(store.getReceipt("local", "browser.input", "r-short"))).toBeUndefined();
    expect(await run(store.getReceipt("local", "turn.submit", "r-long"))).toEqual({
      paramsHash: "h2",
      result: { ok: 2 },
    });
    await run(
      store.putReceipt(
        "local",
        "browser.input",
        "r-next",
        { paramsHash: "h3", result: null },
        60_000,
      ),
    );
    const left = await run(
      store.sql<{
        request_id: string;
      }>`SELECT request_id FROM caveman_sp_receipts ORDER BY request_id`.pipe(Effect.orDie),
    );
    expect(left.map((row) => row.request_id)).toEqual(["r-long", "r-next"]);
  });
});
