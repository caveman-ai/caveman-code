// Automation tools for any chat agent: it writes .caveman/ files with its own edit tools, then checks,
// explains and runs them here (docs/ §14). Checks read the caller's own checkout (its worktree),
// so an unsaved-to-git file the agent just wrote is what gets checked. A run starts threads, so an agent
// another agent started may not start one (delegationPolicy.ts), as with scheduled tasks, and it works unattended,
// so only a full-access caller may.
//
// Every engine carries these definitions on every request (B19): one line each, parameters described only
// where the name does not say it, and text results (the format is in the skill, behind automation_templates).
import {
  explain,
  renderDiagnostics,
  renderExplain,
  templates,
  triggerWords,
  type Diagnostic,
  type LoadedAutomation,
  type ProjectCheck,
  type Scope,
} from "@caveman-app/automations";
import { OrchestratorMcpFailure, ProjectId } from "@caveman-app/protocol";
import { Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { splitProjectRef } from "../../../automations/drafts.ts";
import { makeEnvReader } from "../../../automations/env.ts";
import { AutomationProjects, blockingErrors } from "../../../automations/files.ts";
import { AutomationRunner } from "../../../automations/services.ts";
import { automationsSkill } from "../../../automations/skill.ts";
import { AutomationTriggers, ulid } from "../../../automations/triggers.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ThreadManagementService.ThreadManagementService];

/** Omitted inside a Caveman Code thread, which means its own checkout. */
const ProjectParam = Schema.optionalKey(Schema.String);
const ScopeParam = Schema.optionalKey(Schema.Literals(["me", "project"]));
const NameParam = Schema.String.annotate({ description: "File name without .yaml." });
const Text = Schema.Struct({ text: Schema.String });

export const AutomationCheckTool = Tool.make("automation_check", {
  description: "List and check this checkout's .caveman automations and agents. files: unsaved text by path.",
  parameters: Schema.Struct({ projectId: ProjectParam, files: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String }))) }),
  success: Text,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Check automations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AutomationExplainTool = Tool.make("automation_explain", {
  description: "What an automation will do here, step by step; show it as the automation card.",
  parameters: Schema.Struct({ name: NameParam, step: Schema.optionalKey(Schema.String), scope: ScopeParam, projectId: ProjectParam }),
  success: Text,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Explain an automation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AutomationRunTool = Tool.make("automation_run", {
  description: "Run an automation now from this checkout. Outputs wait for the person unless apply; apply only when asked.",
  parameters: Schema.Struct({
    name: NameParam,
    scope: ScopeParam,
    inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    subject: Schema.optionalKey(Schema.String.annotate({ description: "github:owner/repo#n" })),
    apply: Schema.optionalKey(Schema.Boolean),
    projectId: ProjectParam,
  }),
  success: Text,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run an automation")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const AutomationTemplatesTool = Tool.make("automation_templates", {
  description: "Start here to write an automation: no id gives the guide and templates, an id that template's files.",
  parameters: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ guide: Schema.optionalKey(Schema.String), text: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Title, "Automation templates")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AUTOMATION_TOOLS = [AutomationCheckTool, AutomationExplainTool, AutomationRunTool, AutomationTemplatesTool] as const;
/** The automation tools alone, for their tests; the orchestrator toolkit serves them. */
export const AutomationToolkit = Toolkit.make(...AUTOMATION_TOOLS);

// ------------------------------------------------------------------ handlers

const failure = (code: OrchestratorMcpFailure["code"], message: string) => new OrchestratorMcpFailure({ code, message });

/** The checkout and project the caller means: its thread's worktree (else its project's root), or the project it names. */
const target = (projectId: string | undefined) =>
  Effect.gen(function* () {
    const files = yield* Effect.serviceOption(AutomationProjects);
    if (Option.isNone(files)) return yield* failure("capability_denied", "This runtime does not serve automation files; update Caveman Code.");
    const { caller } = yield* loadCaller();
    const project = projectId ?? caller?.projectId;
    if (project === undefined) return yield* failure("target_required", "Pass projectId: this MCP client is not running inside a Caveman Code thread.");
    const root =
      projectId === undefined && caller?.worktreePath ? caller.worktreePath : yield* files.value.rootOf(ProjectId.make(project)).pipe(Effect.mapError((e) => failure("invalid_request", e.message)));
    return { files: files.value, projectId: project as string, root };
  });

const pick = (automations: ReadonlyArray<LoadedAutomation>, name: string, scope: Scope | undefined, diagnostics: ReadonlyArray<Diagnostic>) => {
  const matches = automations.filter((a) => a.name === name && (scope === undefined || a.scope === scope));
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  if (matches.length > 1) return Effect.fail(failure("invalid_request", `Both a Me and a Project automation are named ${name}; pass scope.`));
  const broken = diagnostics.some((d) => d.severity === "error" && d.path.endsWith(`/${name}.yaml`));
  const names = automations.map((a) => a.name);
  return Effect.fail(
    failure(
      "invalid_request",
      broken
        ? `${name} has errors and does not load; call automation_check and fix them.`
        : `No automation ${name}${names.length > 0 ? `; there is ${names.join(", ")}` : "; write .caveman/automations/<name>.yaml first"}.`,
    ),
  );
};

/** The automations that load, one line each, then the files that do not: what automation_check's text starts with. */
export function listText(check: ProjectCheck): string {
  const rows = check.automations.map((a) => {
    const problems = check.diagnostics.filter((d) => d.path === a.path).length;
    return `${a.name} (${a.scope === "me" ? "Me" : "Project"}${problems > 0 ? `, ${problems} problem${problems === 1 ? "" : "s"}` : ""}): ${triggerWords(a.file).join(" · ")}${a.file.description ? `. ${a.file.description}` : ""}`;
  });
  const broken = [...new Set(check.diagnostics.filter((d) => d.severity === "error" && d.path.endsWith(".yaml") && !check.automations.some((a) => a.path === d.path)).map((d) => d.path))];
  return [rows.length === 0 ? "No automations load in this checkout." : `Automations:\n${rows.join("\n")}`, ...(broken.length > 0 ? [`Not loaded: ${broken.join(", ")}.`] : [])].join("\n");
}

export const automationCheck = (input: { readonly projectId?: string; readonly files?: ReadonlyArray<{ readonly path: string; readonly text: string }> }) =>
  Effect.gen(function* () {
    const { files, root } = yield* target(input.projectId);
    const env = yield* (yield* makeEnvReader)((yield* files.branch(root)).workflow ? "github-actions" : "code");
    const check = yield* files.check(root, input.files, env);
    return { text: `${listText(check)}\n\n${check.diagnostics.length > 0 ? renderDiagnostics(check.diagnostics) : "No problems."}` };
  });

export const automationExplain = (input: { readonly name: string; readonly step?: string; readonly scope?: Scope; readonly projectId?: string }) =>
  Effect.gen(function* () {
    const { files, root } = yield* target(input.projectId);
    const env = yield* (yield* makeEnvReader)((yield* files.branch(root)).workflow ? "github-actions" : "code");
    const check = yield* files.check(root, undefined, env);
    const automation = yield* pick(check.automations, input.name, input.scope, check.diagnostics);
    if (input.step !== undefined && automation.file.steps[input.step] === undefined) {
      return yield* failure("invalid_request", `${input.name} has no step ${input.step}; its steps are ${Object.keys(automation.file.steps).join(", ")}.`);
    }
    return { text: renderExplain(explain({ automation, agents: check.agents, env, ...(input.step !== undefined ? { step: input.step } : {}) })) };
  });

export const automationRun = (input: {
  readonly name: string;
  readonly scope?: Scope;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly subject?: string;
  readonly apply?: boolean;
  readonly projectId?: string;
}) =>
  Effect.gen(function* () {
    const { files, projectId, root } = yield* target(input.projectId);
    const check = yield* files.check(root);
    const automation = yield* pick(check.automations, input.name, input.scope, check.diagnostics);
    const { revision, check: atRevision } = yield* files.revisionAt(root, automation.name, automation.scope, "working_tree");
    if (revision === undefined) return yield* failure("invalid_request", `${input.name} does not load; call automation_check.`);
    const errors = blockingErrors(atRevision, revision.automation);
    if (errors.length > 0) {
      return yield* failure("invalid_request", `${input.name} has ${errors.length === 1 ? "an error" : `${errors.length} errors`} and cannot run: ${errors[0]!.path}:${errors[0]!.line}:${errors[0]!.column} ${errors[0]!.message}`);
    }
    const declared = revision.automation.file.inputs ?? {};
    const given: Record<string, string> = { ...input.inputs };
    for (const [key, spec] of Object.entries(declared)) {
      if (given[key] === undefined && spec.default !== undefined) given[key] = spec.default;
      if (given[key] === undefined && spec.required === true) return yield* failure("invalid_request", `${input.name} needs the input ${key}${spec.description ? ` (${spec.description})` : ""}; pass it in inputs.`);
    }
    const extra = Object.keys(given).find((key) => !(key in declared));
    if (extra !== undefined) return yield* failure("invalid_request", `${input.name} has no input ${extra}; its inputs are ${Object.keys(declared).join(", ") || "none"}.`);
    const runner = yield* Effect.serviceOption(AutomationRunner);
    if (Option.isNone(runner)) return yield* failure("capability_denied", "This runtime cannot run automations yet; update Caveman Code.");
    // A subject is fetched like a trigger's (F-6); without the triggers service only a run about nothing can start.
    const triggers = yield* Effect.serviceOption(AutomationTriggers);
    const trigger = Option.isSome(triggers)
      ? yield* triggers.value.manualTrigger({ root, automation: revision.automation, subject: input.subject }).pipe(Effect.mapError((e) => failure("invalid_request", e.message)))
      : input.subject === undefined
        ? { kind: "manual" as const, subject: `manual:${ulid()}`, trusted: true, receivedAt: new Date().toISOString() }
        : yield* failure("capability_denied", "This runtime cannot run an automation on an issue; update Caveman Code.");
    // A draft ref (`<project>@<branch>`) runs under the project itself, as automation.run does.
    const result = yield* runner.value.admit({ projectId: splitProjectRef(projectId).projectId, revision, trigger, inputs: given, apply: input.apply ?? false });
    if ("refused" in result) return yield* failure("orchestration_error", result.message);
    const outputs = Object.keys(revision.automation.file.outputs ?? {}).length > 0;
    return {
      text: `Started run ${result.runId} of ${input.name}${"subjectTitle" in trigger && trigger.subjectTitle ? ` on ${trigger.subject} (${trigger.subjectTitle})` : ""}.${outputs ? (input.apply === true ? " Its outputs are written when it ends." : " Its outputs wait for the person to apply them from the run.") : ""} It shows on the Automations page.`,
    };
  });

export const automationTemplates = (input: { readonly id?: string }) =>
  Effect.gen(function* () {
    if (input.id === undefined) {
      return {
        // The skill without its frontmatter: what to write and how to check it, on every engine.
        guide: automationsSkill().replace(/^---\n[\s\S]*?\n---\n+/, ""),
        text: `Templates (automation_templates { id } for the files):\n${templates.map((t) => `${t.id} (${t.scope === "me" ? "Me" : "Project"}): ${t.summary}`).join("\n")}`,
      };
    }
    const template = templates.find((t) => t.id === input.id);
    if (template === undefined) return yield* failure("invalid_request", `No template ${input.id}; call automation_templates without id for the list.`);
    return { text: `Write these files with your edit tools, adapt them, then call automation_check.\n\n${template.files.map((f) => `${f.path}:\n${f.text}`).join("\n")}` };
  });

/**
 * A run works unattended: its steps start with the project's permissions for new chats, and its commands and outputs
 * never ask. None of that can be held to a narrower caller's modes, so, as with running a scheduled task now, only a
 * full-access caller starts one.
 */
const automationRunAtFullAccess = (input: Parameters<typeof automationRun>[0], started: McpToolAccess.StartedModes) =>
  started.runtimeMode === "full-access"
    ? automationRun(input)
    : Effect.fail(
        failure(
          "runtime_mode_escalation_denied",
          `A run works unattended, so only a full-access caller may start one; this one runs ${started.runtimeMode}. Ask the person to run it from the Automations page.`,
        ),
      );

/** Who may call each: reads for anyone; a run starts threads, which an agent another agent started may not (delegationPolicy.ts). */
export const automationHandlers = {
  automation_check: McpToolAccess.reads(automationCheck),
  automation_explain: McpToolAccess.reads(automationExplain),
  automation_run: McpToolAccess.startsThreads(() => ({}), automationRunAtFullAccess),
  automation_templates: McpToolAccess.reads(automationTemplates),
} satisfies McpToolAccess.Handlers<typeof AutomationToolkit.tools>;
