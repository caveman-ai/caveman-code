// Grill mode's tools. McpHttpServer serves them on their own endpoint
// (/mcp/grill), which adapters attach only while a session is in grill mode,
// so an engine in default mode never sees their schemas.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Grill } from "../../../session-protocol/grill.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ThreadManagementService.ThreadManagementService, Grill];

const Question = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "The decision, as a short question." }),
  body: Schema.String.annotate({ description: "Markdown under the title: context, trade-offs, what each option means." }),
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String.check(Schema.isMinLength(1)),
      description: Schema.optional(Schema.String),
    }),
  )
    .check(Schema.isMinLength(2), Schema.isMaxLength(5))
    .annotate({ description: "2 to 5 answers to choose from. The user may also answer in their own words." }),
  recommended: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "Index into options of the answer you recommend." }),
  multi_select: Schema.optional(Schema.Boolean).annotate({
    description: "True when the options are not exclusive: the user may pick several, and the answer lists every one, joined with \", \".",
  }),
});

export const GrillRoundTool = Tool.make("grill_round", {
  description:
    "Grill mode: ask the user one round of questions (the whole frontier: every decision whose prerequisites are settled) and wait for their answers, however long they take. Returns each answer (the chosen option's label, or labels for a multi_select question, and the user's own words) and whether it was your recommendation.",
  parameters: Schema.Struct({ questions: Schema.Array(Question).check(Schema.isMinLength(1)) }),
  success: Schema.Struct({
    answers: Schema.Array(Schema.Struct({ title: Schema.String, answer: Schema.String, took_recommendation: Schema.Boolean })),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Grill round")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const GrillFinishTool = Tool.make("grill_finish", {
  description:
    "Grill mode: call once every question is settled and you have written the decisions doc. Then stop; do not start building.",
  parameters: Schema.Struct({
    doc_path: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "The decisions doc, relative to the repo root." }),
    summary: Schema.String.annotate({ description: "Two or three lines: what was decided." }),
  }),
  success: Schema.Struct({ ok: Schema.Literal(true), doc_path: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Finish grilling")
  .annotate(Tool.Destructive, false);

export const GrillToolkit = Toolkit.make(GrillRoundTool, GrillFinishTool);
