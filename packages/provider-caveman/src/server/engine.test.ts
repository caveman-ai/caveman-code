import * as harness from "@caveman-ai/harness";
import * as plugins from "@caveman-ai/agent/plugins";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { cavemanEngine, loadCavemanEngine } from "./engine.ts";
import { loadHarness } from "./harness.ts";

it("imports the engine once, as the very modules a static import gets, the harness shared with the adapter's", async () => {
  const first = loadCavemanEngine();
  assert.strictEqual(loadCavemanEngine(), first);
  const engine = await first;
  assert.strictEqual(engine.harness, harness);
  assert.strictEqual(engine.harness, await loadHarness());
  assert.strictEqual(engine.plugins, plugins);
  assert.strictEqual(await Effect.runPromise(cavemanEngine), engine);
});
