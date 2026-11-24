/**
 * The templates gallery: small, complete automations a person can create in
 * one click. Each is a folder in `templates/`, compiled into
 * `templates.generated.ts`. Chips come from the files, never typed by hand.
 *
 * @module templates
 */
import type { SourceFile } from "./diagnostics.ts";
import { computerOf, budgetOf, hostOf, type AutomationFile, type Host } from "./format.ts";
import { parseAutomation } from "./parse.ts";
import { TEMPLATE_SOURCES } from "./templates.generated.ts";

export const TEMPLATE_CATEGORIES = ["Review", "Issues and PRs", "Monitoring", "Chores and reports"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface TemplateStep {
  readonly name: string;
  readonly agent?: string;
  readonly model?: string;
  readonly computer: string;
}

/** A template as the gallery lists it, without file bodies (`automation.templates`). */
export interface TemplateSummary {
  readonly id: string;
  readonly title: string;
  readonly category: TemplateCategory;
  readonly summary: string;
  /** From the triggers: GitHub, Schedule, Webhook, Slack, Linear, Jira. */
  readonly chips: ReadonlyArray<string>;
  readonly scope: "me" | "project";
  /** Where its triggers fire: This Mac, or Caveman Cloud once applied. */
  readonly host: Host;
  /** The files Create writes, repo-relative. */
  readonly paths: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<TemplateStep>;
  /** The run budget in dollars, when the file sets one. */
  readonly budget?: number;
}

export interface Template extends Omit<TemplateSummary, "paths"> {
  /** The automation first, then its agents. */
  readonly files: ReadonlyArray<SourceFile>;
}

export const chipsOf = (file: AutomationFile): string[] => [
  ...(file.on?.github !== undefined ? ["GitHub"] : []),
  ...(file.on?.schedule !== undefined ? ["Schedule"] : []),
  ...(file.on?.webhook !== undefined ? ["Webhook"] : []),
  ...(file.on?.slack !== undefined || Object.keys(file.outputs ?? {}).includes("slack.message") ? ["Slack"] : []),
  ...(file.on?.linear !== undefined ? ["Linear"] : []),
  ...(file.on?.jira !== undefined ? ["Jira"] : []),
];

export const templates: ReadonlyArray<Template> = TEMPLATE_SOURCES.map((source) => {
  const parsed = parseAutomation(source.files[0]);
  if (parsed.file === undefined) throw new Error(`template ${source.id} does not parse; run its tests`);
  const file = parsed.file;
  const usd = budgetOf(file.budget)?.usd;
  return {
    id: source.id,
    title: source.title,
    category: source.category,
    summary: source.summary,
    chips: chipsOf(file),
    scope: source.scope,
    host: hostOf(file),
    steps: Object.entries(file.steps).map(([name, step]) => ({
      name,
      ...(step.agent !== undefined ? { agent: step.agent } : {}),
      ...(step.model !== undefined ? { model: step.model } : {}),
      computer: computerOf(step),
    })),
    ...(usd !== undefined ? { budget: usd } : {}),
    files: source.files,
  };
});

export const templateSummary = ({ files, ...rest }: Template): TemplateSummary => ({ ...rest, paths: files.map((f) => f.path) });
