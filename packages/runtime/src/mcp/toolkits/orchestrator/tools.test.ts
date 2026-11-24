// ), apps/server/src/mcp/toolkits/orchestrator/tools.test.ts @ ab3a3cd1.
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  OrchestratorToolkit,
  ScheduleTaskTool,
  ThreadUpdateTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("asks Claude Agent to load request_secret up front, and only that tool", () => {
    // Claude Agent defers MCP tools behind ToolSearch; an agent that never loads it asks in chat.
    const alwaysLoad = Object.values(OrchestratorToolkit.tools)
      .map((tool) => [tool.name, Context.getOption(tool.annotations, Tool.Meta)] as const)
      .filter(([, meta]) => meta._tag === "Some")
      .map(([name, meta]) => [name, meta._tag === "Some" ? meta.value : undefined]);
    assert.deepEqual(alwaysLoad, [["request_secret", { "anthropic/alwaysLoad": true }]]);
    assert.include(DelegateTaskTool.description ?? "", "No secrets in `task`");
  });

  it("directs subagent requests to delegation instead of ordinary threads", () => {
    // Review rounds, native subagents and polling are routed in the system text, not here.
    assert.include(DelegateTaskTool.description ?? "", "Start one child agent with only `task`");
    assert.include(DelegateTaskTool.description ?? "", "leave `target` out unless a specific model is needed");
    assert.include(DelegateTaskTool.description ?? "", "Keep `taskId`");
    assert.include(DelegateTaskTool.description ?? "", "children sharing a checkout overwrite each other");
    assert.include(CreateThreadsTool.description ?? "", "Not delegation");
    assert.include(
      OrchestratorToolkit.tools.thread_send.description ?? "",
      "A send to a finished child thread starts a fresh task",
    );
    assert.include(
      OrchestratorToolkit.tools.task_cancel.description ?? "",
      "including later runs in its child thread",
    );
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Default 'async'");
    assert.include(timeoutText, "does not cancel the child");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    // schedule is optional now (an update may leave it out), so its union sits under the null branch.
    const schedule = schema.properties?.schedule?.anyOf?.[0] as
      | { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }
      | undefined;
    assert.isString(schedule?.description);
    assert.isAtLeast(schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "`schedule` is an object, not text");
    assert.include(ScheduleTaskTool.description ?? "", "next run time");
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "clientRequestId",
    ]);
    assert.include(ThreadUpdateTool.description ?? "", "Workspace and branch cannot change here");
  });
});
