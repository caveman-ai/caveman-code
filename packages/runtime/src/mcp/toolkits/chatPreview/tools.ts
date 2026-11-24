// register_preview: a chat that built something a person can open in a browser says how to serve it from its own
// checkout. The runtime keeps it on the chat (Workspace.preview); the person's Open preview chip, in the chat's Chief's
// message and on its board, serves it on the chat's port and opens it (session-protocol/previewHandlers.ts). On the
// shared /mcp, so Claude Agent, Codex and the Caveman engine all see it. Runs nothing itself.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { ChatPreviews } from "../../../session-protocol/previewHandlers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

export const RegisterPreviewTool = Tool.make("register_preview", {
  description:
    "After work a person can try in a browser (a web app, a page), register how to serve it from this checkout, so they open it with one click from their Chief and the board. Runs nothing now. The command must serve on {port} (or $PORT) and keep running: `pnpm vite --port {port} --strictPort`, `pnpm dev -p {port}`. Call again to change it.",
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
      description: "One line, run from the checkout's root, serving on {port}.",
    }),
    path: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
      description: "What to open, from /: /settings. Default /.",
    }),
    port: Schema.optional(Schema.Number).annotate({
      description: "Only when the command can't be told a port: the one it always uses.",
    }),
  }),
  success: Schema.Struct({
    registered: Schema.Boolean,
    port: Schema.Number,
    url: Schema.String,
    note: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ChatPreviews,
  ],
})
  .annotate(Tool.Title, "Register a preview")
  .annotate(Tool.Destructive, false);

export const ChatPreviewToolkit = Toolkit.make(RegisterPreviewTool);

export const layer = McpToolAccess.toLayer(ChatPreviewToolkit, {
  register_preview: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const previews = yield* ChatPreviews;
      const registered = yield* previews
        .register(scope.thread!.threadId as string, input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
      return {
        registered: true,
        port: registered.port,
        url: registered.url,
        note: "The person opens it from the chat's Open preview chip; the runtime starts it then and stops it when idle. Still end your answer with screenshots.",
      };
    }),
  ),
});
