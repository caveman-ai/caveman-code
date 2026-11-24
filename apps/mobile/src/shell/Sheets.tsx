// The pickers the chrome opens, each the desktop's own: the model picker (from the model's chip), where a new chat runs
// (project and computer), and Add a project. Their bodies live in pickers/; these hold them in a sheet and speak the
// board's terms. Each is a medium sheet (Sheet.tsx): glass floating 8pt in, the X at its top left and its name
// centred, riding up on the keyboard when its search is typed in. The model sheet's Edit, at its head's right, is
// where favorites are starred and arranged. What one leads to (Add a project from Where, Settings' models from the
// model's "Connect models") is pushed over it on the same frame, and a pick there comes back to it. The composer opens
// its own + menu (composer/menus.tsx); Settings is in SettingsSheet.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { boardEngine, type CatalogEngine, type Choices, findEntry, modelKey, modelName, pickEffort, SCRIPTED, speedLabel, STANDARD, startOf, useChoices } from "../board/catalog";
import { deviceByLabel, type Effort, type Engine, ENGINE_NAME } from "../board/model";
import { effortLabel, harnessId } from "../components/ui/EngineLogo";
import { type Offer, settlePick } from "../live/engines";
import { useOffer, wantOffer } from "../live/link";
import { isLive } from "../live/seams";
import { haptic } from "../motion";
import { type AddFrom, AddProject, tabFor } from "./pickers/AddProject";
import { ModelPicker } from "./pickers/ModelPicker";
import { Done, Label } from "./pickers/parts";
import { type WhereFocus, WherePicker } from "./pickers/WherePicker";
import { Sheet } from "./Sheet";
import { setChiefPick, useOwnChiefPick } from "./chiefPicks";
import { focusBox, inStack, useUi } from "./ui";

export { Done, Label };

/**
 * What a chat runs on: the harness, the model by name, its effort and, where the model has one, a faster speed. A new
 * chat holds one in the bar; a started chat holds its own, so a pick in its picker applies to it alone.
 */
export interface Pick {
  engine: Engine;
  model: string;
  effort: Effort;
  speed?: string;
}

/** What a new chat starts on: Home's top row (Settings > General's default), at that model's own start. */
export function useDefaultPick(): Pick {
  const { defaultModel, starts } = useChoices();
  const entry = findEntry(defaultModel.engine, defaultModel.model);
  const engine = boardEngine(defaultModel.engine);
  if (entry && engine) {
    const start = startOf(entry, starts);
    return { engine, model: entry.model.label, effort: start.effort ?? "medium", speed: start.speed };
  }
  // A model the scripted catalog does not list: one the person made their default on a computer of their own.
  if (engine && isLive()) {
    const start = starts[modelKey(defaultModel)];
    return { engine, model: defaultModel.model, effort: (start?.effort as Effort | undefined) ?? "medium", ...(start?.speed ? { speed: start.speed } : {}) };
  }
  return { engine: "caveman", model: "Auto", effort: "medium" };
}

/** What a picker lists, and what it says where there is nothing to list (live/engines.ts Offer). */
export type Listed = Offer;
const SCRIPTED_LIST: Listed = { engines: SCRIPTED, line: null, missing: [] };

/**
 * What the pickers list for a chat (`chat`), or for a new chat on the place its box names: on the person's own board
 * what that place runs, so nothing is offered that its computer lacks; the scripted catalog otherwise. Its computer
 * is reached for it where that asks nobody anything; `asked` (the picker is open) reaches a Mac even the first time.
 */
export function useListed(chat: string | null, asked = false): Listed {
  const live = isLive();
  const computer = useUi((s) => s.where.computer);
  const device = chat === null ? deviceByLabel(computer)?.id : undefined;
  const offer = useOffer(chat, device);
  useEffect(() => {
    if (live) wantOffer(chat, device, asked);
  }, [live, chat, device, asked]);
  return live ? offer : SCRIPTED_LIST;
}

/**
 * A pick as a place takes it: the agent and model wanted where the place lists them, else that agent's own default
 * there, else the first agent it does run (live/engines.ts settlePick), at an effort and speed the model has. As it
 * is on the scripted board, and while the place has listed nothing.
 */
export function settledOn(pick: Pick, listed: Listed, starts: Choices["starts"]): Pick {
  if (listed === SCRIPTED_LIST || listed.engines.length === 0) return pick;
  const ref = settlePick(listed.engines, { engine: harnessId(pick.engine), model: pick.model });
  const engine = ref ? boardEngine(ref.engine) : undefined;
  const entry = ref ? findEntry(ref.engine, ref.model, listed.engines) : undefined;
  if (!ref || !engine || !entry) return pick;
  const start = startOf(entry, starts);
  const same = engine === pick.engine && (entry.model.id === pick.model || entry.model.label === pick.model);
  const effort = (same ? pickEffort(entry.model.efforts, pick.effort, start.effort) : start.effort) ?? pick.effort;
  const speed = same && pick.speed && (pick.speed === STANDARD || entry.model.speeds?.includes(pick.speed)) ? pick.speed : start.speed;
  return { engine, model: ref.model, effort, speed };
}

/**
 * What a new chat starts on, on the place its box names: the person's own pick (`picked`), else Settings' default,
 * as that place takes it. `listed`: what that place offers, for the chip and the picker.
 */
export function useNewPick(asked = false): { pick: Pick; picked: boolean; listed: Listed } {
  const fallback = useDefaultPick();
  const own = useUi((s) => s.pick);
  const { starts } = useChoices();
  const listed = useListed(null, asked);
  const wanted = own ?? fallback;
  const pick = useMemo(() => settledOn(wanted, listed, starts), [wanted.engine, wanted.model, wanted.effort, wanted.speed, listed, starts]);
  return { pick, picked: own !== null, listed };
}

/** What a Chief starts its chats on: its own pick once made (chiefPicks.ts), else what a new chat starts on. */
export function useChiefPick(id: string | undefined): Pick {
  const fallback = useDefaultPick();
  const newPick = useUi((s) => s.pick) ?? fallback;
  return useOwnChiefPick(id) ?? newPick;
}

/**
 * A started chat's own pick: its harness and model, at the effort and speed it last ran at, else where its model
 * starts. A chat that doesn't say its effort yet (the board's fixtures) runs at its model's start, never at the new
 * chat's pick, so effort never leaks from one chat to another.
 */
export function useChatPick(chat: { engine: Engine; model: string; effort?: Effort; speed?: string } | undefined, engines?: readonly CatalogEngine[]): Pick | undefined {
  const { starts } = useChoices();
  if (!chat) return undefined;
  const entry = findEntry(harnessId(chat.engine), chat.model, engines);
  const start = entry ? startOf(entry, starts) : undefined;
  return { engine: chat.engine, model: chat.model, effort: chat.effort ?? start?.effort ?? "medium", speed: chat.speed ?? start?.speed };
}

/**
 * The picker's trigger for a pick, as the desktop's composer draws it (model-picker.tsx): the model's vendor mark and
 * name, its effort word where it has a choice of levels, and the bolt while a faster speed is on, which stays however
 * narrow the bar: it changes what the chat costs. Spread it into `ModelName`; `accessibilityLabel` is the desktop's
 * "Model: Opus 5.5, Claude Agent, High effort, Fast".
 */
export function triggerOf(pick: Pick, engines?: readonly CatalogEngine[]): { engine: string; model: string; label: string; effort?: string; fast?: "fast" | "fastest"; accessibilityLabel: string } {
  const harness = harnessId(pick.engine);
  // On the person's own board, the model as the chat's place lists it; else, and for a name alone, the catalog's.
  const entry = (engines && engines.length > 0 ? findEntry(harness, pick.model, engines) : undefined) ?? findEntry(harness, pick.model);
  const effort = entry && entry.model.efforts.length > 1 && (entry.model.efforts as readonly string[]).includes(pick.effort) ? pick.effort : undefined;
  const speeds = entry?.model.speeds ?? [];
  const pace = pick.speed && pick.speed !== STANDARD && speeds.includes(pick.speed) ? pick.speed : undefined;
  const fast = pace ? (speeds.length > 1 && speeds.indexOf(pace) === speeds.length - 1 ? "fastest" : "fast") : undefined;
  // A chat on a real computer holds its engine's own id for the model ("anthropic/claude-haiku-4-5"): never shown raw.
  // One that names no model runs its agent's own: the agent's name stands for it.
  const label = entry?.model.label ?? (modelName(pick.model, harness) || ENGINE_NAME[pick.engine]);
  // An agent that stands for its own default model is named once.
  const said = [`Model: ${label}`, label === ENGINE_NAME[pick.engine] ? null : ENGINE_NAME[pick.engine], effort && `${effortLabel(effort)} effort`, pace && speedLabel(pace)].filter(Boolean).join(", ");
  return { engine: harness, model: entry?.model.id ?? pick.model, label, effort, fast, accessibilityLabel: said };
}

/**
 * The model picker in a sheet, on `value`: a new chat's pick, or a started chat's own. A pick closes it, as the
 * desktop's popover closes, and starts the model where it starts (its saved effort and speed, else its own default);
 * effort and speed stay open to slide and tap. Every change hands back the whole pick, harness included: any harness
 * that is ready can take a chat's next turn without leaving it (the desktop's Composer.tsx). `engineFixed` keeps the
 * picker to one harness's models: Settings' model for new chats on that engine.
 */
export function ModelSheet({ open, onClose, value: given, onChange: give, engineFixed, onManageModels, listed = SCRIPTED_LIST }: { open: boolean; onClose: () => void; value: Pick; onChange: (next: Pick) => void; engineFixed?: boolean; onManageModels?: () => void; /** What it lists: the chat's place's own on the person's board; absent, the scripted catalog. */ listed?: Listed }) {
  const choices = useChoices();
  // On the person's own board a pick holds the model's id, as its place lists it; the script's holds its name.
  const byId = listed !== SCRIPTED_LIST;
  // The shell's sheet opened for a Chief (`openModel("chief:<id>")`, its chat bar's chip) sets what that Chief starts
  // its chats on, whatever its host hands in; the id is kept while the sheet closes, so its body doesn't change on the
  // way down.
  const asked = useUi((s) => (inStack(s, "model") && s.modelFor?.startsWith("chief:") ? s.modelFor.slice("chief:".length) : null));
  const kept = useRef<string | null>(null);
  if (open) kept.current = engineFixed ? null : asked;
  const chiefId = kept.current;
  const chiefPick = useChiefPick(chiefId ?? undefined);
  const value = chiefId ? chiefPick : given;
  const onChange = chiefId ? (next: Pick) => setChiefPick(chiefId, next) : give;
  const harness = harnessId(value.engine);
  // Arranging favorites waits behind Edit, at the head's right; it is put away each time the sheet goes.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Model"
      // The head draws the Edit itself, so its glass stays put while its word changes, and as the sheet leads on.
      action={
        engineFixed || listed.engines.length === 0
          ? undefined
          : {
              label: editing ? "Done" : "Edit",
              accessibilityLabel: editing ? "Done arranging favorites" : "Edit favorites",
              onPress: () => {
                haptic.tick();
                setEditing((e) => !e);
              },
            }
      }
    >
      <ModelPicker
        editing={editing}
        engines={listed.engines}
        line={listed.line}
        missing={listed.missing.map((m) => m.line)}
        current={{ engine: harness, model: value.model }}
        effort={value.effort}
        speed={value.speed}
        only={engineFixed ? harness : undefined}
        // Settings' models are pushed over the picker, which waits under them.
        onManageModels={onManageModels}
        onPick={(ref) => {
          const engine = boardEngine(ref.engine);
          const entry = findEntry(ref.engine, ref.model, listed.engines);
          if (!engine || !entry) return;
          const start = startOf(entry, choices.starts);
          onChange({ engine, model: byId ? entry.model.id : entry.model.label, effort: start.effort ?? value.effort, speed: start.speed });
          onClose();
        }}
        onEffort={(level) => onChange({ ...value, effort: level })}
        onSpeed={(speed) => onChange({ ...value, speed })}
      />
    </Sheet>
  );
}

/**
 * Where a new chat runs: its project, and your Mac, another computer or a Cloud computer, each by its name. "Add a
 * project…" under the projects opens the dialog with what was typed. It leads with what was tapped to open it (ui.ts openWhere): the projects, or the computers. A pick is the
 * answer: the sheet goes and the box it was opened from has the keyboard again (ui.ts focusBox).
 */
export function WhereSheet({ open, onClose, repo, computer, onChange, onAddProject, focus }: { open: boolean; onClose: () => void; repo: string; computer: string; onChange: (next: { repo: string; computer: string }) => void; onAddProject?: (query: string) => void; focus?: WhereFocus }) {
  const asked = useUi((s) => s.whereFocus);
  // Kept while the sheet closes, so its body doesn't swap halves on the way down.
  const kept = useRef<WhereFocus>("repo");
  if (open) kept.current = focus ?? asked ?? "repo";
  const lead = kept.current;
  return (
    <Sheet open={open} onClose={onClose} title="Runs on">
      <View style={{ flexShrink: 1 }}>
        <WherePicker
          focus={lead}
          repo={repo}
          computer={computer}
          onChange={(next) => {
            onChange(next);
            onClose();
            focusBox();
          }}
          // Add a project is pushed over this sheet, and a project added there comes back to it, picked.
          onAddProject={onAddProject}
        />
      </View>
    </Sheet>
  );
}

/**
 * Add a project, opened on the tab it was asked for, or the one what the Where sheet's search held belongs on (a link
 * on GitHub's, a path on your Mac's), with that search in its field.
 */
export function AddProjectSheet({ open, onClose, from = "folder", query = "", onAdded }: { open: boolean; onClose: () => void; from?: AddFrom; query?: string; onAdded: (name: string) => void }) {
  const [tab, setTab] = useState<AddFrom>(() => tabFor(from, query));
  useEffect(() => {
    if (open) setTab(tabFor(from, query));
  }, [open, from, query]);
  return (
    <Sheet open={open} onClose={onClose} title="Add a project">
      <AddProject
        // Handed a search, its field starts with it.
        key={query}
        from={tab}
        onFrom={setTab}
        initial={query}
        onAdded={(name) => {
          onAdded(name);
          onClose();
        }}
      />
    </Sheet>
  );
}
