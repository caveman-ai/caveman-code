// Settings > Subagents, as words: kept apart from the page so tests read them without a browser.
import type { Settings, SubagentRole, TaskKind } from "@caveman-app/session-protocol";
import type { ModelRole } from "@caveman-app/ui/components/model-picker";
import { TASK_KINDS as KINDS } from "@caveman-app/ui/components/runner-badge";
import { sectionOf } from "../../state/runner.ts";

/** The roles a lead names in delegate_task, in Settings > Subagents' order. */
export const ROLES: ReadonlyArray<{ role: SubagentRole; label: string; description: string }> = [
  { role: "implementation", label: "Implementation", description: "Builds one part of the task" },
  { role: "research", label: "Research", description: "Reads, searches and reports back" },
  { role: "review", label: "Review", description: "Checks a diff against the task" },
  { role: "design", label: "Design", description: "Interfaces and product work" },
  { role: "test", label: "Tests", description: "Writes and runs tests" },
  { role: "general", label: "General", description: "Anything else" },
];

/** The task classifier's kinds, in Settings > Subagents' order (runner-badge's TASK_KINDS). */
export const TASK_KINDS = KINDS as ReadonlyArray<{
  readonly kind: TaskKind;
  readonly label: string;
  readonly description: string;
}>;

/** A pin picker's accessible name: whose model it picks, then what it is set to ("Model for review agents: Auto"). */
export function pinLabel(
  role: string,
  pinned: string | null,
  fallback: string,
  noun = "agents",
): string {
  return `Model for ${role.toLowerCase()} ${noun}: ${pinned ?? fallback}`;
}

/**
 * The model picker's role tags: each pinned role, then each pinned task kind, on its model's row, in the section the
 * pin's login has (loginEngines, chatPickerEngines). `except` leaves out the role or kind a Settings > Subagents picker
 * is choosing for.
 */
export function pinnedRoles(
  engines: Parameters<typeof sectionOf>[0],
  pins: Settings["subagent_role_pins"],
  except?: SubagentRole | TaskKind,
  taskPins?: Settings["subagent_task_pins"],
): ModelRole[] {
  const tag = (
    key: string,
    label: string,
    pin:
      | { readonly engine: string; readonly instance_id: string; readonly model: string }
      | null
      | undefined,
  ) =>
    pin && key !== except
      ? [{ model: { engine: sectionOf(engines, pin), model: pin.model }, label }]
      : [];
  return [
    ...ROLES.flatMap(({ role, label }) => tag(role, label, pins?.[role])),
    ...TASK_KINDS.flatMap(({ kind, label }) => tag(kind, label, taskPins?.[kind])),
  ];
}

type Pin = NonNullable<NonNullable<Settings["subagent_role_pins"]>[SubagentRole]>;

/**
 * A saved pin with its effort or Prefer/Always changed, and nothing else: the login it names stays, signed in or not.
 */
export function amendPin(
  pin: Pin,
  change: { readonly effort?: string; readonly always?: boolean },
): Pin {
  const { effort: _effort, always: _always, ...base } = pin;
  const effort = change.effort ?? pin.effort;
  const always = change.always ?? pin.always === true;
  return { ...base, ...(effort ? { effort } : {}), ...(always ? { always: true } : {}) };
}
