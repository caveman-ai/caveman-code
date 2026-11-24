import type { AgentTypeInfo, Settings, SubagentRole, TaskKind } from "@caveman-app/session-protocol";
import { findModel, ModelPicker } from "@caveman-app/ui/components/model-picker";
import { amendPin, pinLabel, pinnedRoles, ROLES, TASK_KINDS } from "./agents-model.ts";
import { RunnerBadge } from "@caveman-app/ui/components/runner-badge";
import { Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import { withModelSources } from "../../components/Composer.tsx";
import { BarButton } from "../../panels/chrome.tsx";
import { engineReady } from "../../state/engines.ts";
import { instanceOf, loginEngines, runnerFor, sectionOf } from "../../state/runner.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Switch } from "@caveman-app/ui/components/switch";
import { useEffect, useState } from "react";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { CONTROL, NumberInput, PICKER, Segmented, SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";

const SOURCE: Record<AgentTypeInfo["source"], string> = {
  builtin: "Built in",
  user: "~/.caveman/agents",
  plugin: "Plugin",
  project: "Project",
};

/** Settings > Subagents: what agents an engine delegates to may do, which model they start on, and the agent types it can name. */
export function AgentsSettings() {
  const { client } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const projects = useRuntimeSelector((v) => v.projects);
  const save = useSaveSettings();
  const [types, setTypes] = useState<ReadonlyArray<AgentTypeInfo> | null>(null);
  // A project's own types (and which built-ins they shadow) show for the project picked here.
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = (projects.find((p) => p.id === picked) ?? projects[0])?.id;
  useEffect(() => {
    if (!client) return;
    client.call("agent.types", projectId === undefined ? {} : { project_id: projectId }).then(
      (r) => setTypes(r.types),
      () => setTypes([]),
    );
  }, [client, projectId]);
  return (
    <>
      <SettingsCard title="Limits">
        <SettingRow id="subagent-depth" label="How deep agents nest" description="2 lets an agent's own agents delegate once more.">
          <NumberInput id="subagent-depth" value={settings?.subagent_max_depth ?? 2} min={1} max={8} onCommit={(subagent_max_depth) => void save({ subagent_max_depth })} />
        </SettingRow>
        <SettingRow id="subagent-concurrent" label="Agents working at once" description="Per chat, counting every level; past it, an agent waits.">
          <NumberInput id="subagent-concurrent" value={settings?.subagent_max_concurrent ?? 8} min={1} max={64} onCommit={(subagent_max_concurrent) => void save({ subagent_max_concurrent })} />
        </SettingRow>
        <SettingRow
          id="subagent-ceiling"
          label="Token ceiling per chat"
          description="Past it, no new agents start. 0 is no ceiling."
        >
          <NumberInput
            id="subagent-ceiling"
            value={settings?.subagent_tree_token_ceiling ?? 5_000_000}
            min={0}
            max={1_000_000_000}
            step={500_000}
            onCommit={(subagent_tree_token_ceiling) => void save({ subagent_tree_token_ceiling })}
          />
        </SettingRow>
        <SettingRow label="Model for a new agent" description="When neither the lead nor a pin picks one. Auto needs a Caveman plan or credits.">
          <Segmented
            label="Model for a new agent"
            value={settings?.subagent_default_model === "auto-by-role" ? "inherit" : (settings?.subagent_default_model ?? "auto")}
            options={[
              { value: "auto", label: "Auto" },
              { value: "inherit", label: "Same as the chat" },
            ]}
            onChange={(subagent_default_model) => void save({ subagent_default_model })}
          />
        </SettingRow>
      </SettingsCard>
      <PinCards />
      <SettingsCard
        title="Agent types"
        description={
          <>
            Agent files in <code className="font-mono text-[12px]">~/.caveman/agents</code>, or a repo&apos;s <code className="font-mono text-[12px]">.caveman/agents</code> or{" "}
            <code className="font-mono text-[12px]">.claude/agents</code>. Their tool lists are advice, not enforced.
          </>
        }
      >
        {projectId !== undefined && projects.length > 1 ? (
          <SettingRow label="Repository">
            <Select value={projectId} onValueChange={setPicked}>
              <SelectTrigger aria-label="Project" className={CONTROL}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        ) : null}
        {types === null ? (
          <SettingRow label="Loading…" />
        ) : types.length === 0 ? (
          <SettingRow label="No agent types yet" description="Add an agent file and it shows up here." />
        ) : (
          types.map((t) => (
            <SettingRow key={t.name} label={<span className="font-mono">{t.name}</span>} description={t.description || undefined}>
              <div className="text-right text-[12px] leading-[18px] text-muted-foreground">
                <div>{SOURCE[t.source]}</div>
                {t.model ? <div className="font-mono">{t.model}</div> : null}
              </div>
            </SettingRow>
          ))
        )}
      </SettingsCard>
    </>
  );
}

const UNPINNED = { auto: "Auto", "auto-by-role": "Same as the chat", inherit: "Same as the chat" } as const;

type PinField = "subagent_role_pins" | "subagent_task_pins";
type Pin = NonNullable<NonNullable<Settings["subagent_role_pins"]>[SubagentRole]>;

/**
 * A harness login, model and effort per task kind and per role, or the default above. A role the lead names comes
 * first, then the kind the classifier reads the brief as, then General. Prefer lets the lead's own pick win; Always
 * runs the pin even then. Each login is its own section in the picker, under its tag.
 */
function PinCards() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  return (
    <>
      <SettingsCard title="By kind of task" description="Read on this computer from each task's words. Used when the lead names no role.">
        <SettingRow id="new-chat-by-task" label="New chats too" description="A chat started from New chat runs on its first message's kind.">
          <Switch id="new-chat-by-task" disabled={!settings} checked={settings?.new_chat_by_task === true} onCheckedChange={(on) => void save({ new_chat_by_task: on })} />
        </SettingRow>
        <PinRows field="subagent_task_pins" rows={TASK_KINDS.map(({ kind, label, description }) => ({ key: kind, label, description }))} noun="tasks" />
      </SettingsCard>
      <SettingsCard title="By role" description="When the lead names a role. Prefer lets the lead's own pick win; Always doesn't.">
        <PinRows field="subagent_role_pins" rows={ROLES.map(({ role, label, description }) => ({ key: role, label, description }))} noun="agents" />
      </SettingsCard>
    </>
  );
}

function PinRows({ field, rows, noun }: { field: PinField; rows: ReadonlyArray<{ key: SubagentRole | TaskKind; label: string; description: string }>; noun: string }) {
  const all = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const engines = all.filter(engineReady);
  // Harnesses first, so the picker opens on one; the Caveman engine's models last.
  const sections = loginEngines(withModelSources(engines)).sort((a, b) => Number(a.id === "caveman") - Number(b.id === "caveman"));
  const pins = (settings?.[field] ?? {}) as Readonly<Record<string, Pin | null | undefined>>;
  const fallback = UNPINNED[settings?.subagent_default_model ?? "auto"];
  return rows.map(({ key, label, description }) => {
    const pin = pins[key] ?? null;
    const value = pin ? { engine: sectionOf(engines, pin), model: pin.model } : null;
    const hit = findModel(sections, value);
    const runner = pin ? runnerFor(engines, { engine: pin.engine, runner: { engine: pin.engine, instance_id: pin.instance_id, model: pin.model, ...(pin.effort ? { effort: pin.effort } : {}), pick: { by: "user" } } }) : null;
    const set = (next: { engine: string; model: string; effort?: string | undefined; always?: boolean } | null) => {
      const at = next ? instanceOf(engines, next.engine) : null;
      const pinned = at && next ? { ...at, model: next.model, ...(next.effort ? { effort: next.effort } : {}), ...(next.always ? { always: true } : {}) } : null;
      void save({ [field]: { [key]: pinned } });
    };
    // Effort and Prefer/Always change the saved pin as it is (amendPin), never through `engines`, which leaves a
    // signed-out login out.
    const amend = (change: { effort?: string; always?: boolean }) => pin && void save({ [field]: { [key]: amendPin(pin, change) } });
    return (
      <SettingRow key={key} label={label} description={description}>
        <span className="flex items-center gap-2">
          {/* How a pin stands against the lead's own pick: only a pinned row has a say. */}
          {pin ? (
            <Segmented
              label={`When the lead picks another model for ${label.toLowerCase()} ${noun}`}
              value={pin.always ? "always" : "prefer"}
              options={[
                { value: "prefer", label: "Prefer" },
                { value: "always", label: "Always" },
              ]}
              onChange={(next) => amend({ always: next === "always" })}
            />
          ) : null}
          <span className="flex items-center gap-1">
            {/* Unpin leads, so every picker ends on the card's edge whether or not its row is pinned. */}
            {pin ? (
              <BarButton label={`Unpin ${label.toLowerCase()} ${noun}`} onClick={() => set(null)}>
                <Icon icon={Cancel01Icon} />
              </BarButton>
            ) : null}
            <ModelPicker
              engines={sections}
              value={value}
              onChange={(r) => set({ engine: r.engine, model: r.model, effort: sections.find((e) => e.id === r.engine)?.models.find((m) => m.id === r.model)?.default_effort, always: pin?.always === true })}
              // Its sections are logins, not the composer's engines: favorites stay out of it.
              favorites={[]}
              // The other rows' pins, so a model already working for one says so.
              roles={pinnedRoles(engines, settings?.subagent_role_pins, key, settings?.subagent_task_pins)}
              effort={pin?.effort ?? hit?.model.default_effort}
              onEffortChange={(effort) => amend({ effort })}
              auto={{
                label: fallback,
                description: fallback === "Auto" ? "Caveman picks a harness and model for this kind of work" : "Follows Model for a new agent",
                selected: pin === null,
                onPick: () => set(null),
              }}
              trigger={runner ? <RunnerBadge runner={runner} className="min-w-0 text-foreground" /> : <span className="truncate">{fallback}</span>}
              // Fourteen pickers share this page: each says whose model it is, and what it is set to.
              ariaLabel={pinLabel(field === "subagent_role_pins" ? key : label, hit ? `${hit.model.label}, ${hit.engine.label}` : null, fallback, noun)}
              className={PICKER}
            />
          </span>
        </span>
      </SettingRow>
    );
  });
}
