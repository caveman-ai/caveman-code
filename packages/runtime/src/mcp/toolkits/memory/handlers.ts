// memory_sql runs as the calling thread: its copy holds what that session may see.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Memory } from "../../../memory/MemoryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MemoryToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  memory_sql: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* Effect.serviceOption(Memory);
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = scope.thread?.threadId;
      if (Option.isNone(memory) || threadId === undefined) return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: "Memory is not available here." });
      const output = yield* memory.value
        .query(threadId, input.sql, input.params ?? [])
        .pipe(Effect.mapError((error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })));
      return { output };
    }),
  ),
});
