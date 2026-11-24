// ), apps/server/src/mcp/advertisedJsonSchema.test.ts @ ed44f251d8.
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";

it("drops JSON noise, merges tagged unions, and keeps null that was declared", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      // Indistinguishable from `optional(String)` in JSON, so its null is dropped too.
      cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { anyOf: [{ type: "string" }, { type: "null" }] },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      cursor: { type: "string" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["url", "number"] },
              url: { type: "string" },
              number: { type: "integer" },
            },
            required: ["kind"],
          },
          { type: "null" },
        ],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("offers agents the null that moves a queued run to the end or clears a project field", () => {
  const nullable = (tool: Tool.Any, names: ReadonlyArray<string>) => {
    const { properties } = advertisedJsonSchema(tool) as {
      readonly properties: Record<string, { readonly anyOf?: ReadonlyArray<{ type?: unknown }> }>;
    };
    return Object.fromEntries(
      names.map((name) => [
        name,
        properties[name]?.anyOf?.some((branch) => branch.type === "null") ?? false,
      ]),
    );
  };

  expect(nullable(ThreadToolkit.tools.queue, ["beforeRunId"])).toEqual({ beforeRunId: true });
  expect(
    nullable(ProjectToolkit.tools.project_update, [
      "defaultModelSelection",
      "projectIcon",
      "faviconPath",
      "defaultThreadEnvMode",
    ]),
  ).toEqual({
    defaultModelSelection: true,
    projectIcon: true,
    faviconPath: true,
    defaultThreadEnvMode: true,
  });
});
