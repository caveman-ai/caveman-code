// The local embedder's thread ends with the runtime: once closed, nothing starts another.
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

import { makeLocalEmbedder } from "./Embedder.ts";

test("a closed embedder starts no thread: its load fails at once, and closing again is a no-op", async () => {
  const embedder = makeLocalEmbedder("/nonexistent-models-dir");
  await embedder.close();
  const loaded = await Effect.runPromise(Effect.result(embedder.load));
  expect(loaded._tag === "Failure" && loaded.failure.message).toBe("the embedder is closed");
  expect(embedder.ready()).toBe(false);
  await embedder.close();
});
