// environment_build acts as the calling thread, which must be a setup chat's (environments.ts refuses others).
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";

import { SetupChats, type SetupChatError } from "../../../session-protocol/environments.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SetupToolkit } from "./tools.ts";

const callerThread = McpInvocationContext.McpInvocationContext.pipe(Effect.map((scope) => scope.thread!.threadId as string));
const failure = (error: SetupChatError) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(SetupToolkit, {
  environment_build: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const chats = yield* SetupChats;
      const result = yield* chats.build(yield* callerThread, input).pipe(Effect.mapError(failure));
      return { ...result, steps: [...result.steps], gaps: [...result.gaps] };
    }),
  ),
});
