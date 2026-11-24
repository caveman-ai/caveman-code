// memory_sql (docs/memory.md "How agents meet it"): this user's long-term
// memory, read-only, on a per-session copy in the memory sandbox.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MEMORY_SQL_DESCRIPTION } from "../../../memory/MemorySandbox.ts";

export const MemorySqlTool = Tool.make("memory_sql", {
  description: MEMORY_SQL_DESCRIPTION,
  parameters: Schema.Struct({
    sql: Schema.String.check(Schema.isMinLength(1)),
    params: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))),
  }),
  success: Schema.Struct({ output: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const MemoryToolkit = Toolkit.make(MemorySqlTool);
