// The desktop tool acts as the calling thread while its run is live: its chat is the one the person is asked in.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";

import type { DesktopError } from "../../../session-protocol/desktop.ts";
import { MacDesktop } from "../../../session-protocol/macDesktop/service.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DesktopToolkit } from "./tools.ts";

const failure = (error: DesktopError) =>
  new OrchestratorMcpFailure({ code: error.reason === "invalid_params" ? "invalid_request" : "orchestration_error", message: error.message });

export const layer = McpToolAccess.toLayer(DesktopToolkit, {
  desktop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const desktop = yield* MacDesktop;
      const answer = yield* desktop.use(scope.thread!.threadId, input).pipe(Effect.mapError(failure));
      return {
        text: answer.text,
        ...(answer.app ? { app: answer.app } : {}),
        ...(answer.screenshot
          ? { screenshot: { mimeType: "image/png" as const, data: answer.screenshot.data.toString("base64"), width: answer.screenshot.width, height: answer.screenshot.height } }
          : {}),
      };
    }),
  ),
});
