// Grill tools act as the calling thread while its run is live: a round is
// asked in that thread's session (session-protocol/grill.ts).
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";

import { Grill, type GrillError } from "../../../session-protocol/grill.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GrillToolkit } from "./tools.ts";

const callerThread = McpInvocationContext.McpInvocationContext.pipe(Effect.map((scope) => scope.thread!.threadId as string));
const failure = (error: GrillError) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(GrillToolkit, {
  grill_round: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const grill = yield* Grill;
      const answers = yield* grill.round(yield* callerThread, input.questions).pipe(Effect.mapError(failure));
      return { answers: [...answers] };
    }),
  ),
  grill_finish: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const grill = yield* Grill;
      const { doc_path } = yield* grill.finish(yield* callerThread, input).pipe(Effect.mapError(failure));
      return { ok: true as const, doc_path };
    }),
  ),
});
