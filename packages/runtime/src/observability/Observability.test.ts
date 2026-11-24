import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as Observability from "./Observability.ts";

const MB = 1024 * 1024;

const layer = Observability.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "caveman-observability-test-" }),
      ResourceAttribution.layer,
      // OTLP export is off in the test config; the layer still names its client.
      FetchHttpClient.layer,
    ),
  ),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("Observability", (it) => {
  it.effect("records how much a span grew the heap on the runtime's spans", () =>
    Effect.gen(function* () {
      let retained: Array<Array<number>> = [];
      const span = yield* Effect.gen(function* () {
        // About 64 MB of small arrays: on the V8 heap, unlike typed arrays' buffers.
        retained = Array.from({ length: 1024 }, (_, index) =>
          Array.from({ length: 8 * 1024 }, () => index),
        );
        return yield* Effect.currentSpan;
      }).pipe(Effect.withSpan("test.allocates"));
      const growth = span.attributes.get("memory.heap_growth_bytes");
      assert.isNumber(growth);
      // Well above the 8 MB attribution floor, with room for a collection during the span.
      assert.isAtLeast(growth as number, 16 * MB);
      assert.lengthOf(retained, 1024);
    }),
  );
});
