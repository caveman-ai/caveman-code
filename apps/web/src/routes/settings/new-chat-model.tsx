import type { EngineDescriptor, Project, Settings } from "@caveman-app/session-protocol";
import { ModelPicker } from "@caveman-app/ui/components/model-picker";
import { turnModel, withModelSources } from "../../components/Composer.tsx";
import { engineReady } from "../../state/engines.ts";
import { PICKER } from "./rows.tsx";

/** The engines a new chat can start on, each with a model to pick: one New chats row each. */
export const newChatEngines = (engines: ReadonlyArray<EngineDescriptor>): EngineDescriptor[] => engines.filter((e) => engineReady(e) && e.models.length > 0);

/**
 * Settings > General's model for `engine`, what a new chat starts on there without a project's own (turnModel); in
 * `project`, the default it gives way to where Auto can't run there.
 */
export const settingModel = (engine: EngineDescriptor, settings: Settings | null, project?: Project) =>
  turnModel(engine, { setting: settings?.engines[engine.id]?.model, here: project?.engine_default_models?.[engine.id] });

/**
 * One engine's model for new chats: the composer's picker on that engine's models alone, Auto first where offered.
 * With `inherit` (a project), a first row follows Settings > General. With `start` (Settings > General), its slider and
 * bolt set where that model starts (Settings.model_defaults), as the composer's dotted level does.
 */
export function NewChatModelPicker({ engine, value, onChange, inherit, start, ariaLabel }: {
  engine: EngineDescriptor;
  value: string | undefined;
  onChange: (model: string | null) => void;
  inherit?: { readonly label: string; readonly selected: boolean };
  start?: { readonly effort?: string | undefined; readonly speed?: string | undefined; readonly onChange: (next: { effort?: string | undefined; speed?: string | undefined }) => void };
  ariaLabel: string;
}) {
  return (
    <ModelPicker
      engines={withModelSources([engine])}
      value={value ? { engine: engine.id, model: value } : null}
      onChange={(r) => onChange(r.model)}
      favorites={[]}
      {...(start
        ? {
            effort: start.effort,
            onEffortChange: (effort: string) => start.onChange({ effort, speed: start.speed }),
            speed: start.speed,
            onSpeedChange: (speed: string) => start.onChange({ effort: start.effort, speed }),
          }
        : {})}
      {...(inherit
        ? {
            auto: { label: inherit.label, description: "Follows Settings > General", selected: inherit.selected, onPick: () => onChange(null) },
            ...(inherit.selected ? { trigger: <span className="truncate">{inherit.label}</span> } : {}),
          }
        : {})}
      ariaLabel={ariaLabel}
      className={PICKER}
    />
  );
}
