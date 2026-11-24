// propose_setup_change (docs/ D9): any engine's chat in a project with a GitHub
// remote records a change to the repo's Cloud setup it found missing; the person applies it (the setup chat takes it
// as its ask, and they review what it builds) or dismisses it. On the shared /mcp, so Claude Agent, Codex and the
// Caveman engine all see it; environments.ts refuses a chat outside such a project and the setup chat itself.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { SetupChats } from "../../../session-protocol/environments.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

export const ProposeSetupChangeTool = Tool.make("propose_setup_change", {
  description:
    "Propose a change to this repo's Cloud computer setup (.caveman/computer.toml) when work showed something missing: a toolchain or version, a system library, a service (postgres, redis, mysql), an env var, a setup or check command. The person can hand it to the repo's setup chat, which test-builds it for their review. Changes nothing itself. Once per missing piece; GitHub repos only.",
  parameters: Schema.Struct({
    summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).annotate({ description: "What to change, in one line: \"Install libvips (sharp needs it)\"." }),
    why: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).annotate({ description: "What failed without it, with the command and its error." }),
  }),
  success: Schema.Struct({ proposed: Schema.Boolean, id: Schema.String, note: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, ThreadManagementService.ThreadManagementService, SetupChats],
})
  .annotate(Tool.Title, "Propose a Cloud setup change")
  .annotate(Tool.Destructive, false);

export const ProposeToolkit = Toolkit.make(ProposeSetupChangeTool);

export const layer = McpToolAccess.toLayer(ProposeToolkit, {
  propose_setup_change: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const chats = yield* SetupChats;
      const { id } = yield* chats
        .propose(scope.thread!.threadId as string, input)
        .pipe(Effect.mapError((error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })));
      return { proposed: true, id, note: "The person sees it in this chat and in Settings, Environments. Carry on with the task." };
    }),
  ),
});
