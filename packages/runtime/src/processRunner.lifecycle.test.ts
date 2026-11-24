import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "./processRunner.ts";

const layer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

// A real child must observe EOF even when the caller has no input to send.
// Empty and nonempty payloads also exercise the writable stream's close path.
for (const stdin of [undefined, "", "input payload"]) {
  it.live(`closes child stdin after ${stdin === undefined ? "omitted input" : JSON.stringify(stdin)}`, () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: process.execPath,
        args: ["-e", `
          let input = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", chunk => { input += chunk; });
          process.stdin.on("end", () => { process.stdout.write(JSON.stringify(input)); });
        `],
        ...(stdin === undefined ? {} : { stdin }),
        timeout: "2 seconds",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(JSON.stringify(stdin ?? ""));
      expect(result.timedOut).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
}
