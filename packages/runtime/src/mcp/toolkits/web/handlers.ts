// web_search and web_fetch read for the calling thread: its caps, its links (web/provenance.ts) and its spend row
// are the thread's. Only a credential with the `web` capability reaches them (a Caveman-engine session's).
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";

import { WebTools, type WebToolRefusal } from "../../../web/WebTools.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WebToolkit } from "./tools.ts";

const callerThread = McpInvocationContext.requireMcpCapability("web").pipe(
  Effect.mapError((error) => new OrchestratorMcpFailure({ code: "capability_denied", message: error.message })),
  Effect.map((scope) => scope.thread!.threadId as string),
);
const failure = (refusal: WebToolRefusal) => new OrchestratorMcpFailure({ code: refusal.code, message: refusal.message });

export const layer = McpToolAccess.toLayer(WebToolkit, {
  web_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const web = yield* WebTools;
      return { text: yield* web.search(yield* callerThread, input).pipe(Effect.mapError(failure)) };
    }),
  ),
  web_fetch: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const web = yield* WebTools;
      return { text: yield* web.fetch(yield* callerThread, input).pipe(Effect.mapError(failure)) };
    }),
  ),
});
