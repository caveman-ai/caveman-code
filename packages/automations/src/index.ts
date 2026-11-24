// @caveman-app/automations: the automation file format. Schema, parser with
// line-numbered errors, check, explain, templates and the JSON Schema. Runs
// nothing, imports no node modules: the runtime, the web editor and the CLI
// all use it.
export * from "./format.ts";
export * from "./rules.ts";
export * from "./diagnostics.ts";
export { parseAutomation, parseAgentFile, AGENT_ROLES, type AgentInfo, type AgentMcpServer, type AgentRole, type AgentSource, type CustomToolDecl, type ParsedAgent } from "./parse.ts";
export { checkProject, automationPath, AUTOMATION_DIRS, AGENTS_DIR, type LoadedAutomation, type ProjectCheck, type Scope, type Target } from "./check.ts";
export { explain, renderExplain, scheduleWords, triggerWords, triggerKinds, type EnvSnapshot, type Explanation, type ExplainRow, type ExplainStep } from "./explain.ts";
export { templates, templateSummary, chipsOf, TEMPLATE_CATEGORIES, type Template, type TemplateCategory, type TemplateStep, type TemplateSummary } from "./templates.ts";
export { automationJsonSchema, buildAutomationJsonSchema } from "./jsonSchema.ts";
