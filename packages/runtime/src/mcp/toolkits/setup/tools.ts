// A setup chat's one tool (session-protocol/environments.ts). McpHttpServer serves it on its own endpoint
// (/mcp/setup), which the Caveman adapter attaches only to setup chats' threads, so no other chat sees it. Every
// other chat gets propose_setup_change (propose.ts) on the shared /mcp.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { SetupChats } from "../../../session-protocol/environments.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const SETUP_MCP_SERVER = "caveman-setup";
export const SETUP_MCP_PATH = "/mcp/setup";
export const setupMcpEndpoint = (runtimeEndpoint: string) => `${runtimeEndpoint.replace(/\/+$/, "")}/setup`;
/** A test build can take most of the setup chat's 20 minutes. */
export const SETUP_TOOL_TIMEOUT_MS = 25 * 60_000;

const Step = Schema.Struct({ name: Schema.String, status: Schema.String, seconds: Schema.optional(Schema.Number) });

export const EnvironmentBuildTool = Tool.make("environment_build", {
  description:
    "Runs a test build of this repo's Cloud setup on a fresh Cloud computer and waits for it (minutes): clone, services, [system] packages, [setup].run, [setup].check, snapshot, and a check on a computer restored from the snapshot. Returns each step, the failure (kind, step, message), checks that failed (gaps) and the end of the log. propose true with a summary: when it passes, the person sees it as a change to review and publishes or discards it; nothing is saved until they do. A file that doesn't parse costs no build.",
  parameters: Schema.Struct({
    config: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "The whole .caveman/computer.toml text to build." }),
    propose: Schema.Boolean.annotate({ description: "Propose it to the person for review when the build passes. False for a try." }),
    summary: Schema.optional(Schema.String.check(Schema.isMaxLength(400))).annotate({
      description: "With propose true: two short lines the person reads, saying what you changed and why.",
    }),
  }),
  success: Schema.Struct({
    status: Schema.String,
    steps: Schema.Array(Step),
    failure: Schema.NullOr(Schema.Struct({ kind: Schema.String, step: Schema.String, message: Schema.String })),
    gaps: Schema.Array(Schema.String),
    log_tail: Schema.String,
    proposed: Schema.Boolean,
    builds_left: Schema.Number,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, ThreadManagementService.ThreadManagementService, SetupChats],
})
  .annotate(Tool.Title, "Cloud test build")
  .annotate(Tool.Destructive, false);

export const SetupToolkit = Toolkit.make(EnvironmentBuildTool);
