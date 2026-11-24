// The computer tool acts as the calling thread while its run is live.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Builders } from "../../../session-protocol/builders.ts";
import { Desktop, type DesktopError } from "../../../session-protocol/desktop.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerToolkit } from "./tools.ts";

const failure = (error: DesktopError) =>
  new OrchestratorMcpFailure({ code: error.reason === "invalid_params" ? "invalid_request" : "orchestration_error", message: error.message });

export const layer = McpToolAccess.toLayer(ComputerToolkit, {
  computer: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      // The computer has one desktop, and it is its lead's: a builder beside it never takes it.
      const builders = yield* Effect.serviceOption(Builders);
      if (Option.isSome(builders) && (yield* builders.value.sharesComputer(scope.thread!.threadId)))
        return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: "This computer's desktop is its lead's: a builder works without it. Ask the lead if the task needs the screen." });
      const desktop = yield* Desktop;
      const done = yield* desktop.act(scope.thread!.threadId, input).pipe(Effect.mapError(failure));
      if (done.cursor) return { action: input.action, x: done.cursor.x, y: done.cursor.y };
      const shot = done.shot!;
      return {
        action: input.action,
        screenshot: { mimeType: "image/png" as const, data: shot.data.toString("base64"), width: shot.width, height: shot.height },
      };
    }),
  ),
});
