import * as React from "react";
import { Icon, Add01Icon, ArrowDown01Icon, DragDropVerticalIcon, Home01Icon, StarIcon, Tick02Icon } from "../icons/huge";
import { cn } from "../lib/cn";
import { isComposing } from "../lib/ime";
import { touchScreen } from "../lib/touch";
import { BrandMark, type BrandName } from "../icons/brand";
import { engineIcon } from "../icons/names";
import { PixelIcon } from "../icons/PixelIcon";
import { EngineLogo, engineBrand } from "./runner-badge";
import { EffortSlider, EffortWord, effortLabel, effortTier, pickEffort, stepLevel } from "./effort";
import { SpeedMark, SpeedToggle, speedLabel, STANDARD_SPEED } from "./speed";
import { factsSummary, ModelCard, ModelGlance } from "./model-card";
import { modelFacts, runAt, type ModelRun } from "../lib/model-facts";
import { fadeEdges, Keycap } from "./menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/*
 * The model picker (STYLE.md 11; "absurdly clean"). Search across the top, then a rail
 * of harness logos beside one list of models, each row its vendor's mark, the model's name and its smarts and
 * cost at a glance (model-card.tsx). It opens on Home: the person's models in their own order, the default new chats
 * start on first and tagged Default; a row's grip (or ⌥↑/⌥↓) moves it, and the row on top becomes the default.
 * A harness's tile lists all of its models under quiet headings: its logins, or the Caveman engine's
 * keys. Older models wait under "More models"; search finds every model in every harness. Favorites carry ⌘1..⌘9. The effort slider sits at the foot; the trigger names model and effort.
 * A model with a faster tier has a bolt at the foot's end (speed.tsx), and the trigger shows it while it is on. Where the
 * chat runs elsewhere than where its model starts, the level's word is dotted, and a click makes the chat's effort and
 * speed that start.
 * No account tags, no second lines. Keyboard first: type to search, ↑/↓, ←/→ for effort, Enter, Esc, ⌘1..⌘9.
 *
 * Shapes are structural so this kit needs no protocol dependency; Session Protocol's EngineDescriptor fits
 * PickerEngine as is.
 */

export type PickerModel = {
  readonly id: string;
  readonly label: string;
  readonly efforts: readonly string[];
  readonly default_effort?: string;
  /** Speeds past standard (Session Protocol's model `speeds`): a bolt at the foot. */
  readonly speeds?: readonly string[];
  readonly default_speed?: string;
  readonly legacy?: boolean;
  readonly description?: string;
  /** The connected credential slot, independent of the harness running it. */
  readonly source?: { readonly id: string; readonly label: string };
};
export type PickerEngine = {
  readonly id: string;
  readonly label: string;
  readonly models: readonly PickerModel[];
  /** A quiet tooltip on its rows: what this route means (a Claude plan: Claude models only, plan limits). */
  readonly hint?: string;
  /** The harness whose logo it wears, when `id` names one of its logins (a picker that lists each login). */
  readonly harness?: string;
  /** That login's name: the heading over its models, where its harness has several. */
  readonly account?: string;
  /** Its models cannot be picked here yet: they are listed greyed, over why and the way to them (PickerLock). */
  readonly locked?: PickerLock | undefined;
};
/**
 * Why an engine's models cannot be picked yet, and what gets them ("Connect Claude", "Unlock"): a browser window
 * lists what a plan or a sign-in would add instead of hiding it. `title` says it in a few words; `line` only where
 * the engine has no model to list and the words stand alone.
 */
export type PickerLock = { readonly title: string; readonly line?: string | undefined; readonly action?: { readonly label: string; readonly run: () => void } | undefined };

/** The Caveman engine's connections (provider-caveman providers.ts ids): each one's name and, where it has one, its vendor's mark. */
const PROVIDERS: Readonly<Record<string, { readonly name: string; readonly brand?: BrandName }>> = {
  anthropic: { name: "Anthropic", brand: "claude" },
  openai: { name: "OpenAI", brand: "openai" },
  chatgpt: { name: "ChatGPT", brand: "openai" },
  azure: { name: "Azure OpenAI", brand: "openai" },
  google: { name: "Google", brand: "gemini" },
  "google-vertex": { name: "Google Vertex AI", brand: "gemini" },
  xai: { name: "xAI", brand: "xai" },
  deepseek: { name: "DeepSeek", brand: "deepseek" },
  mistral: { name: "Mistral", brand: "mistral" },
  moonshot: { name: "Moonshot", brand: "moonshot" },
  moonshotai: { name: "Moonshot", brand: "moonshot" },
  "kimi-coding": { name: "Kimi Code", brand: "moonshot" },
  groq: { name: "Groq", brand: "groq" },
  "github-copilot": { name: "GitHub Copilot", brand: "github" },
  caveman: { name: "Caveman credits" },
};
// A further key of a provider is its own slot (`openai~2`): the same vendor.
const provider = (slot: string) => {
  const base = slot.split("~")[0]!;
  return Object.hasOwn(PROVIDERS, base) ? PROVIDERS[base] : undefined;
};

/** A connection's name where its account gives none: "OpenAI 2" for `openai~2`, the slot itself when unknown. */
export function providerName(slot: string): string {
  const n = slot.split("~")[1];
  return provider(slot) ? `${provider(slot)!.name}${n ? ` ${n}` : ""}` : slot;
}

/**
 * The vendor whose model this is, for its mark: Claude Agent runs Claude, Codex OpenAI, Cursor its own;
 * a Caveman engine model is `provider/model` (credits `caveman/provider/model`, a gateway `external tools/vendor/model`):
 * the first slot with a mark.
 */
export function modelVendor(engine: string, model: string): BrandName | undefined {
  if (engine !== "caveman") return engineBrand(engine);
  return model.split("/").slice(0, -1).map((slot) => provider(slot)?.brand).find(Boolean);
}

/** The vendor's mark where we know it, else the engine's pixel tile: in the picker, on Models & keys and in a chat's header. */
export function VendorMark({ engine, model = "", size = 14 }: { engine: string; model?: string; size?: number }) {
  const vendor = modelVendor(engine, model);
  return vendor ? <BrandMark name={vendor} size={size} /> : <PixelIcon name={engineIcon(engine)} className="shrink-0" />;
}

/** A row's name beside its vendor's mark, which already says whose it is: "Opus 5.5" for "Claude Opus 5.5". */
export function nameBesideMark(label: string, vendor: BrandName | undefined): string {
  return vendor === "claude" ? label.replace(/^Claude\s+/, "") : label;
}

export type ModelRef = { engine: string; model: string };
/** An agent role pinned to a model (Settings > Agents): a grey tag on its row, wherever it is listed. */
export type ModelRole = { readonly model: ModelRef; readonly label: string };

/** Settings.favorite_models entries are "<engine>/<model>"; engine ids have no slash, model ids may. */
export const modelKey = (r: ModelRef): string => `${r.engine}/${r.model}`;
export function parseModelKey(key: string): ModelRef | null {
  const i = key.indexOf("/");
  return i > 0 && i < key.length - 1 ? { engine: key.slice(0, i), model: key.slice(i + 1) } : null;
}

type Entry = { engine: PickerEngine; model: PickerModel };
const entryKey = (e: Entry) => modelKey({ engine: e.engine.id, model: e.model.id });
const harnessOf = (engine: PickerEngine) => engine.harness ?? engine.id;

export function findModel(engines: readonly PickerEngine[], ref: ModelRef | null): Entry | null {
  const engine = ref ? engines.find((e) => e.id === ref.engine) : undefined;
  const model = engine?.models.find((m) => m.id === ref?.model);
  return engine && model ? { engine, model } : null;
}

/** Favorites that exist among these engines, in the user's order. The first nine answer ⌘1..⌘9. */
export function resolveFavorites(engines: readonly PickerEngine[], favorites: readonly string[]): Entry[] {
  return favorites.flatMap((key) => {
    const hit = findModel(engines, parseModelKey(key));
    return hit ? [hit] : [];
  });
}

/** ⌘n: the n-th favorite (1-based) among these engines, or null. */
export function favoriteAt(engines: readonly PickerEngine[], favorites: readonly string[], n: number): ModelRef | null {
  const hit = n >= 1 && n <= 9 ? resolveFavorites(engines, favorites)[n - 1] : undefined;
  return hit ? { engine: hit.engine.id, model: hit.model.id } : null;
}

/** Digit 1..9 of a ⌘/Ctrl shortcut, or null. */
export function favoriteShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): number | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  return /^[1-9]$/.test(e.key) ? Number(e.key) : null;
}

/** Every search token appears in the model's label, id, provider, login or harness. */
export function matchesQuery(entry: Entry, query: string): boolean {
  const hay = `${entry.model.label} ${entry.model.id} ${entry.engine.label} ${entry.engine.account ?? ""} ${entry.model.source?.label ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export type PickerGroup = { readonly key: string; readonly title: string; readonly entries: readonly Entry[] };

/** Caveman's own models: its Auto and what Caveman credits serve (`caveman/<provider>/<model>`), never a person's own key. */
export function isCavemanModel(entry: Entry): boolean {
  return harnessOf(entry.engine) === "caveman" && !entry.model.legacy && (entry.model.id === "auto" || entry.model.id.startsWith("caveman/"));
}

/**
 * Home, one list in the person's order (`order`, Settings.home_models) with `lead`, the default new chats start on,
 * first (unless `pin` is off: a row being moved). What it holds: that default, the rows the person arranged, Caveman's
 * own models, the favorites (⌘1..⌘9), then each other harness's first two current models (its flagships, as its engine
 * orders them); the ones `order` does not name yet follow it in that order.
 */
export function homeModels(engines: readonly PickerEngine[], favs: readonly Entry[], order: readonly string[] = [], lead: ModelRef | null = null, pin = true): Entry[] {
  const caveman = engines.flatMap((engine) => engine.models.map((model) => ({ engine, model }))).filter(isCavemanModel);
  const harnesses = [...new Set(engines.map(harnessOf))].filter((h) => h !== "caveman");
  const picks = harnesses.flatMap((h) => {
    const engine = engines.find((e) => harnessOf(e) === h);
    return engine ? engine.models.filter((m) => !m.legacy && m.id !== "auto").slice(0, 2).map((model) => ({ engine, model })) : [];
  });
  const first = findModel(engines, lead);
  const arranged = order.flatMap((key) => findModel(engines, parseModelKey(key)) ?? []);
  const listed = [...(first ? [first] : []), ...arranged, ...caveman, ...favs, ...picks];
  const all = listed.filter((e, i) => listed.findIndex((o) => entryKey(o) === entryKey(e)) === i);
  const rank = (e: Entry) => (order.includes(entryKey(e)) ? order.indexOf(entryKey(e)) : order.length);
  const sorted = (list: Entry[]) => list.sort((a, b) => rank(a) - rank(b));
  return first && pin ? [first, ...sorted(all.slice(1))] : sorted(all);
}

/** `order` with `key` moved to index `to`. */
export function moveKey(order: readonly string[], key: string, to: number): string[] {
  const next = order.filter((k) => k !== key);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, key);
  return next;
}

/**
 * One harness's models under their headings, in catalog order: one group per login where it has several, one per
 * connection on the Caveman engine, else one named for the harness. `across`: a search over every harness, where
 * a heading also names its harness ("Caveman · Anthropic").
 */
export function pickerGroups(sections: readonly PickerEngine[], keep: (entry: Entry) => boolean, across = false): PickerGroup[] {
  const groups = new Map<string, { key: string; title: string; entries: Entry[] }>();
  for (const engine of sections) {
    for (const model of engine.models) {
      const entry = { engine, model };
      if (!keep(entry)) continue;
      const key = model.source ? `${engine.id}:${model.source.id}` : engine.id;
      const own = model.source?.label ?? engine.account ?? engine.label;
      const group = groups.get(key) ?? { key, title: across && own !== engine.label ? `${engine.label} · ${own}` : own, entries: [] };
      groups.set(key, group);
      group.entries.push(entry);
    }
  }
  return [...groups.values()];
}

export type ModelPickerProps = {
  engines: readonly PickerEngine[];
  value: ModelRef | null;
  onChange: (ref: ModelRef) => void;
  favorites: readonly string[];
  /** Absent: no favorites here (a picker whose sections are not the composer's, like Settings > Subagents' pins). */
  onFavoritesChange?: ((next: string[]) => void) | undefined;
  /** With both, the effort slider sits at the foot of the picker and the trigger names the level. */
  effort?: string | undefined;
  onEffortChange?: ((level: string) => void) | undefined;
  /** With both, a model with speeds gets the bolt at the foot's end, and the trigger shows it while it is on. */
  speed?: string | undefined;
  onSpeedChange?: ((speed: string) => void) | undefined;
  /** Where the current model starts (its effort and speed): marked on the slider while the chat is elsewhere. */
  start?: { readonly effort?: string | undefined; readonly speed?: string | undefined } | undefined;
  /** With `start`: while the chat is elsewhere, the level's word (dotted) makes the chat's effort and speed the model's start. */
  onSaveStart?: (() => void) | undefined;
  /** A first row that picks no model: Auto (Settings > Subagents' role pins). */
  auto?: { readonly label: string; readonly description: string; readonly selected: boolean; readonly onPick: () => void };
  /** What the trigger shows instead of the current model's mark and name. */
  trigger?: React.ReactNode;
  /** The trigger's accessible name where several pickers share a view (Settings > Subagents' role pins); default "Model: ..." / "Choose a model". */
  ariaLabel?: string;
  className?: string;
  /** Opened from outside (the composer's /model); left out, the picker keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onManageModels?: (() => void) | undefined;
  /** The model new chats start on: Home's first row, and tagged Default wherever it is listed. */
  defaultModel?: ModelRef | null | undefined;
  /** The roles delegated agents start on a model for: a grey tag on its row after Default. */
  roles?: readonly ModelRole[] | undefined;
  /** Home's order (Settings.home_models). */
  homeOrder?: readonly string[] | undefined;
  /** With it, Home's rows can be moved; it gets Home's whole order, whose first row is the new default. */
  onHomeOrderChange?: ((order: string[]) => void) | undefined;
};

/** Where the picker moves focus itself: on a touch screen the search waits for a tap, or its keyboard covers the picker. */
function focusSearch(input: React.RefObject<HTMLInputElement | null>) {
  if (!touchScreen()) input.current?.focus();
}

export function ModelPicker({ engines, value, onChange, favorites, onFavoritesChange, effort, onEffortChange, speed, onSpeedChange, start, onSaveStart, auto, trigger, ariaLabel, className, onManageModels, defaultModel, roles, homeOrder, onHomeOrderChange, ...controlled }: ModelPickerProps) {
  const [own, setOwn] = React.useState(false);
  const open = controlled.open ?? own;
  const setOpen = controlled.onOpenChange ?? setOwn;
  const current = findModel(engines, value);
  const input = React.useRef<HTMLInputElement>(null);
  const levels = current?.model.efforts ?? [];
  const level = onEffortChange && levels.length > 1 && effort && levels.includes(effort) ? effort : undefined;
  const speeds = onSpeedChange ? (current?.model.speeds ?? []) : [];
  const pace = speeds.length > 0 && speed && (speed === STANDARD_SPEED || speeds.includes(speed)) ? speed : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={engines.length === 0}
        aria-label={ariaLabel ?? (current ? `Model: ${current.model.label}, ${current.engine.label}${level ? `, ${effortLabel(level)} effort` : ""}${pace && pace !== STANDARD_SPEED ? `, ${speedLabel(pace)}` : ""}` : "Choose a model")}
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md pl-1.5 pr-1.5 text-[13px] text-foreground outline-none transition-colors duration-75",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent disabled:opacity-50",
          className,
        )}
      >
        {trigger ?? (
          <>
            {current ? <VendorMark engine={harnessOf(current.engine)} model={current.model.id} /> : null}
            <span className="truncate">{current?.model.label ?? "Choose a model"}</span>
            {/* The level in grey (red at Max, purple at Ultracode), as wide as its longest; a narrow composer drops it (panes.css). */}
            {level ? (
              <span data-compact-hide="" className="contents">
                <EffortWord levels={levels} value={level} className={cn("shrink-0", effortTier(level) === "base" && "text-muted-foreground")} />
              </span>
            ) : null}
            {/* A faster speed stays on the chip however narrow the composer: it changes what the chat costs. */}
            <SpeedMark speeds={speeds} speed={pace} />
          </>
        )}
        <Icon icon={ArrowDown01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        alignOffset={-4}
        sideOffset={8}
        collisionPadding={12}
        // The model card hangs off the picker's side (PickerBody), so the clip is the inner frame's, not this one's.
        className="group/picker relative w-[360px] max-w-[calc(100vw-24px)] overflow-visible p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          focusSearch(input);
        }}
 // Escape while an input method composes in the search cancels the composition, not the picker (upstream #23493).
        // Radix hears Escape on the document before the search field does, so it is stopped here.
        onEscapeKeyDown={(e) => {
          if (isComposing(e)) e.preventDefault();
        }}
      >
        <PickerBody
          engines={engines}
          current={current}
          effort={effort}
          onEffortChange={level ? onEffortChange : undefined}
          speed={pace}
          onSpeedChange={pace ? onSpeedChange : undefined}
          start={start}
          onSaveStart={onSaveStart}
          favorites={favorites}
          onFavoritesChange={onFavoritesChange}
          inputRef={input}
          defaultModel={findModel(engines, defaultModel ?? null)}
          roles={roles ?? NO_ROLES}
          homeOrder={homeOrder ?? NO_ORDER}
          onHomeOrderChange={onHomeOrderChange}
          auto={auto ? { ...auto, onPick: () => { auto.onPick(); setOpen(false); } } : undefined}
          onManageModels={onManageModels ? () => { setOpen(false); onManageModels(); } : undefined}
          // A lock's button leaves the picker for where it leads (a sign-in, the plans).
          onAct={(run) => {
            setOpen(false);
            run();
          }}
          onPick={(ref) => {
            onChange(ref);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const HOME = "home";
const NO_ORDER: readonly string[] = [];
const NO_ROLES: readonly ModelRole[] = [];
const NO_LABELS: readonly string[] = [];
const AND = new Intl.ListFormat("en", { type: "conjunction" });
/** A row's height (h-8): a dragged row moves one place per row it is carried. */
const ROW = 32;

type Item =
  | { kind: "heading"; key: string; title: string }
  /** `mixed`: a list across harnesses with no heading per harness (Home), so its rows wear the harness's logo. */
  | { kind: "model"; key: string; entry: Entry; row: number; older: boolean; mixed?: boolean }
  | { kind: "more"; key: string; count: number; open: boolean; row: number };
type Row = Exclude<Item, { kind: "heading" }>;
type View = {
  engines: readonly PickerEngine[];
  harnesses: ReadonlyArray<{ id: string }>;
  favs: readonly Entry[];
  section: string;
  query: string;
  moreOf: string | null;
  order: readonly string[];
  lead: Entry | null;
  /** Off while a row is moved: the default goes where it is carried. */
  pin: boolean;
};

/** What the list shows: a search over every harness, Home, or one harness's models with "More models" last. */
function viewItems({ engines, harnesses, favs, section, query, moreOf, order, lead, pin }: View): Item[] {
  const out: Item[] = [];
  let row = 0;
  const push = (groups: readonly PickerGroup[], older = false) => {
    for (const g of groups) {
      // Under "More models" a lone group needs no heading: the row above says what these are.
      if (!older || groups.length > 1) out.push({ kind: "heading", key: `h:${older ? "more:" : ""}${g.key}`, title: g.title });
      for (const entry of g.entries) out.push({ kind: "model", key: `${older ? "more:" : ""}${entryKey(entry)}`, entry, row: row++, older });
    }
  };
  if (query) {
    // Every harness, in rail order, under headings that name the harness.
    for (const h of harnesses) push(pickerGroups(engines.filter((e) => harnessOf(e) === h.id), (e) => matchesQuery(e, query), true));
    return out;
  }
  if (section === HOME) {
    const ref = lead && { engine: lead.engine.id, model: lead.model.id };
    for (const entry of homeModels(engines, favs, order, ref, pin)) out.push({ kind: "model", key: `home:${entryKey(entry)}`, entry, row: row++, older: false, mixed: true });
    return out;
  }
  const sections = engines.filter((e) => harnessOf(e) === section);
  push(pickerGroups(sections, (e) => !e.model.legacy));
  const count = sections.reduce((n, e) => n + e.models.filter((m) => m.legacy).length, 0);
  if (count) {
    const open = moreOf === section;
    out.push({ kind: "more", key: "more", count, open, row: row++ });
    if (open) push(pickerGroups(sections, (e) => e.model.legacy === true), true);
  }
  return out;
}

/*
 * The list's height beside the rail: its tallest section as it opens (More models closed), at most LIST_MAX. One
 * height for every section and every search, so the popover never jumps as the rail moves, and no short list
 * stands half empty. Item heights are the rows' own classes: a heading h-7, any but the first under a hairline
 * with 6px either side, a row h-8, More models h-8 with 6px over it, the list's 6px padding top and bottom.
 */
const LIST_MAX = 292;
const LIST_MIN = 148;
function itemsHeight(items: readonly Item[]): number {
  return items.reduce((h, item, i) => h + (item.kind === "heading" ? 28 + (i > 0 ? 13 : 0) : item.kind === "more" ? 38 : 32), 12);
}

function PickerBody({
  engines,
  current,
  effort,
  onEffortChange,
  speed,
  onSpeedChange,
  start,
  onSaveStart,
  favorites,
  onFavoritesChange,
  onPick,
  inputRef,
  auto,
  onManageModels,
  onAct,
  defaultModel,
  roles,
  homeOrder,
  onHomeOrderChange,
}: {
  engines: readonly PickerEngine[];
  current: Entry | null;
  /** The chat's effort; every row's glance reads any other model at it where it offers it (pickEffort). */
  effort: string | undefined;
  /** Absent: no slider (one level, or a picker that sets no effort). */
  onEffortChange: ((level: string) => void) | undefined;
  /** The chat's speed, set where the current model has speeds. */
  speed: string | undefined;
  /** Absent: no bolt (no speeds, or a picker that sets none). */
  onSpeedChange: ((speed: string) => void) | undefined;
  start: ModelPickerProps["start"];
  onSaveStart: (() => void) | undefined;
  favorites: readonly string[];
  onFavoritesChange: ((next: string[]) => void) | undefined;
  onPick: (ref: ModelRef) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  auto: ModelPickerProps["auto"];
  onManageModels: (() => void) | undefined;
  /** Runs a lock's action. */
  onAct: (run: () => void) => void;
  defaultModel: Entry | null;
  roles: readonly ModelRole[];
  homeOrder: readonly string[];
  onHomeOrderChange: ((order: string[]) => void) | undefined;
}) {
  const uid = React.useId();
  const favs = onFavoritesChange ? resolveFavorites(engines, favorites) : [];
  const favIndex = new Map(favs.map((f, i) => [entryKey(f), i]));
  const rolesOf = new Map<string, string[]>();
  for (const r of roles) rolesOf.set(modelKey(r.model), [...(rolesOf.get(modelKey(r.model)) ?? []), r.label]);
  // One rail tile per harness, in the order the engines come: a harness with several logins is one tile, its logins headings.
  const harnesses = [...new Map(engines.map((e) => [harnessOf(e), e.label])).entries()].map(([id, label]) => ({ id, label, locked: engines.every((e) => harnessOf(e) !== id || e.locked !== undefined) }));
  // Home leads where the picker is the composer's (it has favorites); a pin's picker (Settings) lists harnesses only.
  const tiles = onFavoritesChange ? [{ id: HOME, label: "Home", locked: false }, ...harnesses] : harnesses;
  const railed = tiles.length > 1;

  // Open on Home when the current model is there (or none is chosen), else where it lives, older models showing if
  // it is one of them.
  const [section, setSection] = React.useState<string>(() => {
    const home = onFavoritesChange && railed ? homeModels(engines, favs, homeOrder, defaultModel && { engine: defaultModel.engine.id, model: defaultModel.model.id }) : null;
    const inHome = home && current && home.some((e) => entryKey(e) === entryKey(current));
    return home && (inHome || !current) ? HOME : current ? harnessOf(current.engine) : (harnesses[0]?.id ?? HOME);
  });
  const [moreOf, setMoreOf] = React.useState<string | null>(() => (current?.model.legacy ? harnessOf(current.engine) : null));
  const [query, setQuery] = React.useState("");
  // A section the rail moves to fades in; the one the picker opens on is simply there.
  const [moved, setMoved] = React.useState(false);
  const q = query.trim();

  // A Home row being moved: Home's order as it opened, where the row is now and how far the pointer carried it. The
  // default leads Home only while nothing is moving, so any row can be carried to the top.
  const [drag, setDrag] = React.useState<{ key: string; start: string[]; from: number; to: number; y0: number; s0: number; dy: number } | null>(null);
  const order = drag ? moveKey(drag.start, drag.key, drag.to) : homeOrder;
  // Keyed by value: the order and the default arrive as fresh objects on every render.
  const items = React.useMemo(
    () => viewItems({ engines, harnesses, favs, section, query: q, moreOf, order, lead: defaultModel, pin: !drag }),
    [q, section, moreOf, engines, favorites, order.join("\n"), defaultModel && entryKey(defaultModel), drag !== null],
  );
  // Measured once per catalog: favorites change it only by a row, and a star must not move the popover's edge. Keyed by
  // what shapes the sections, not by the array, which callers build afresh on every render.
  const catalog = JSON.stringify(engines.map((e) => [e.id, harnessOf(e), e.models.map((m) => [m.id, m.legacy === true, m.source?.id])]));
  const listHeight = React.useMemo(
    () => Math.min(LIST_MAX, Math.max(LIST_MIN, ...tiles.map((t) => itemsHeight(viewItems({ engines, harnesses, favs, section: t.id, query: "", moreOf: null, order, lead: defaultModel, pin: true }))))),
    [catalog],
  );
  const rows = items.filter((i): i is Row => i.kind !== "heading");

  const isCurrent = (r: Row | undefined) => r?.kind === "model" && current !== null && r.entry.engine.id === current.engine.id && r.entry.model.id === current.model.id;
  // Null follows the view: a search's first match, else the current model where it is listed, else the top.
  const [activeRaw, setActive] = React.useState<number | null>(null);
  const active = Math.min(activeRaw ?? (q ? 0 : Math.max(0, rows.findIndex(isCurrent))), Math.max(0, rows.length - 1));
  // The current model starts in view.
  const fromKeys = React.useRef(true);
  const list = React.useRef<HTMLDivElement>(null);
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const effortOf = (model: PickerModel) => pickEffort(model.efforts, effort, model.default_effort);

  // The model card beside the picker: the active row's, once the pointer or the arrow keys rest on the list for a
  // beat (a sweep on the way to a click shows nothing); then it follows the active row. It hangs on the side with room.
  const [peek, setPeek] = React.useState(false);
  const [cardSide, setCardSide] = React.useState<"left" | "right" | null>(null);
  const peekTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => () => clearTimeout(peekTimer.current), []);
  const peekSoon = () => {
    clearTimeout(peekTimer.current);
    if (!peek) peekTimer.current = setTimeout(() => setPeek(true), 450);
  };
  const unpeek = () => {
    clearTimeout(peekTimer.current);
    setPeek(false);
  };
  React.useLayoutEffect(() => {
    const r = peek ? root.current?.getBoundingClientRect() : undefined;
    if (r) setCardSide(window.innerWidth - r.right >= CARD_ROOM ? "right" : r.left >= CARD_ROOM ? "left" : null);
  }, [peek]);
  const carded = peek && cardSide ? rows[active] : undefined;
  const card = carded?.kind === "model" ? carded : undefined;

  const showSection = (s: string) => {
    unpeek();
    setQuery("");
    setActive(null);
    setMoved(true);
    setSection(s);
    if (current?.model.legacy && harnessOf(current.engine) === s) setMoreOf(s);
    fromKeys.current = true;
    focusSearch(inputRef);
  };

  // Opening "More models" scrolls it to the top of the list, so the older models it shows come into view.
  const reveal = React.useRef(false);
  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "more") {
      reveal.current = !row.open;
      setMoreOf(row.open ? null : section);
    }
    // A greyed row picks nothing: what gets it is the button under its list.
    else if (!row.entry.engine.locked) onPick({ engine: row.entry.engine.id, model: row.entry.model.id });
  };

  const toggleFavorite = (entry: Entry) => {
    const key = entryKey(entry);
    const starred = favorites.includes(key);
    onFavoritesChange?.(starred ? favorites.filter((k) => k !== key) : [...favorites, key]);
    // An arranged row stays on Home until it is unstarred; the default stays first (and on Home) whatever happens.
    if (starred && onHomeOrderChange && homeOrder.includes(key) && key !== (defaultModel && entryKey(defaultModel))) {
      const lead = defaultModel && { engine: defaultModel.engine.id, model: defaultModel.model.id };
      onHomeOrderChange(homeModels(engines, favs, homeOrder, lead).map(entryKey).filter((k) => k !== key));
    }
  };

  // Moving Home's rows: by a row's grip, or ⌥↑/⌥↓ on the active one. A move saves Home's whole order at once.
  const movable = onHomeOrderChange && section === HOME && !q ? onHomeOrderChange : undefined;
  const homeKeys = () => rows.flatMap((r) => (r.kind === "model" ? [entryKey(r.entry)] : []));
  const dragRef = React.useRef(drag);
  dragRef.current = drag;
  // A picker closed mid-move (Esc) lets go of the window's listeners and saves nothing.
  const dropDrag = React.useRef<(() => void) | undefined>(undefined);
  React.useEffect(() => () => dropDrag.current?.(), []);
  const startDrag = (e: React.PointerEvent, entry: Entry) => {
    if (!movable || e.button !== 0 || !list.current) return;
    // Focus stays in the search field, and no text selects under the pointer.
    e.preventDefault();
    unpeek();
    const start = homeKeys();
    const from = start.indexOf(entryKey(entry));
    setActive(from);
    setDrag({ key: entryKey(entry), start, from, to: from, y0: e.clientY, s0: list.current.scrollTop, dy: 0 });
    // The window's, not the grip's: the row moves in the list as it is carried, which would end a pointer capture.
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      const el = list.current;
      if (!d || !el) return;
      const box = el.getBoundingClientRect();
      if (ev.clientY < box.top + ROW) el.scrollTop -= 8;
      else if (ev.clientY > box.bottom - ROW) el.scrollTop += 8;
      const dy = ev.clientY - d.y0 + (el.scrollTop - d.s0);
      const to = Math.max(0, Math.min(d.start.length - 1, d.from + Math.round(dy / ROW)));
      setActive(to);
      setDrag({ ...d, to, dy });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      dropDrag.current = undefined;
    };
    const end = (ev: PointerEvent) => {
      stop();
      const d = dragRef.current;
      setDrag(null);
      if (d && ev.type === "pointerup" && d.to !== d.from) movable(moveKey(d.start, d.key, d.to));
    };
    dropDrag.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  // Keep the keyboard's row in view; a mouse sweep never scrolls the list under the pointer.
  React.useLayoutEffect(() => {
    const more = reveal.current ? rows.find((r) => r.kind === "more") : undefined;
    reveal.current = false;
    const el = more && document.getElementById(optionId(more.row));
    if (el && list.current) list.current.scrollTo({ top: el.offsetTop - 6, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    else if (fromKeys.current) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    fromKeys.current = false;
    fadeEdges(list.current);
  }, [active, items]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = favoriteShortcut(e);
    if (n !== null) {
      e.preventDefault();
      const ref = favoriteAt(engines, favorites, n);
      if (ref && !findModel(engines, ref)?.engine.locked) onPick(ref);
      return;
    }
    if (isComposing(e)) return;
    const len = rows.length;
    if (movable && e.altKey && !drag && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const row = rows[active];
      const to = active + (e.key === "ArrowDown" ? 1 : -1);
      if (row?.kind !== "model" || to < 0 || to >= len) return;
      fromKeys.current = true;
      setActive(to);
      movable(moveKey(homeKeys(), entryKey(row.entry), to));
      return;
    }
    const go = (i: number) => {
      fromKeys.current = true;
      peekSoon();
      setActive(i);
    };
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (len) go((active + (e.key === "ArrowDown" ? 1 : -1) + len) % len);
        return;
      case "Home":
      case "End":
        if (q || !len) return;
        e.preventDefault();
        go(e.key === "Home" ? 0 : len - 1);
        return;
      case "Enter":
        e.preventDefault();
        activate(active);
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        // With nothing typed the caret has nowhere to go: the arrows move the effort instead.
        if (query || !onEffortChange || !current) return;
        e.preventDefault();
        const next = stepLevel(current.model.efforts, effort, e.key === "ArrowRight" ? 1 : -1);
        if (next && next !== effort) onEffortChange(next);
        return;
      }
    }
  };

  const harnessLabel = harnesses.find((h) => h.id === section)?.label;
  const sectionLock = engines.find((e) => harnessOf(e) === section && e.locked)?.locked;
  const act = (action: PickerLock["action"]) => action && { label: action.label, run: () => onAct(action.run) };
  // Why the greyed rows in view cannot be picked, and the way to them: the active row's, else the first greyed one's.
  const lockOf = (r: Row | undefined) => (r?.kind === "model" ? r.entry.engine.locked : undefined);
  const lock = lockOf(rows[active]) ?? lockOf(rows.find((r) => lockOf(r) !== undefined));
  const empty =
    rows.length > 0 ? null : !q && sectionLock ? (
      <EmptyRows title={sectionLock.title} line={sectionLock.line} action={act(sectionLock.action)} />
    ) : q ? (
      <EmptyRows title={`No model matches “${q}”.`} />
    ) : section === HOME ? (
      <EmptyRows title="Star a model to keep it here" line={<>The first nine answer <Keycap>⌘1</Keycap> to <Keycap>⌘9</Keycap> in the composer.</>} action={onManageModels ? { label: "Connect models", run: onManageModels } : undefined} />
    ) : section === "caveman" ? (
      <EmptyRows title="No models connected yet" line="A Claude API key, ChatGPT sign-in or another provider works here." action={onManageModels ? { label: "Connect models", run: onManageModels } : undefined} />
    ) : (
      <EmptyRows title={`${harnessLabel ?? "This engine"} reports no models.`} />
    );

  return (
    // At most the window's room beside the trigger: in a short window the list gives way and scrolls, and the search and
 // the effort line stay on screen (upstream #29017).
    <div ref={root} className="flex max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden rounded-[inherit]">
      {auto ? (
        <button
          type="button"
          aria-pressed={auto.selected}
          onClick={auto.onPick}
          className="flex h-12 w-full shrink-0 items-center gap-3 border-b border-border px-4 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[13px] leading-5 text-foreground">
              {auto.label}
              {auto.selected ? <Icon icon={Tick02Icon} className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} /> : null}
            </span>
            <span className="block truncate text-[12px] leading-4 text-muted-foreground">{auto.description}</span>
          </span>
        </button>
      ) : null}
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(null);
          if (list.current) list.current.scrollTop = 0;
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded
        aria-controls={`${uid}-list`}
        aria-activedescendant={rows[active] ? optionId(active) : undefined}
        aria-autocomplete="list"
        aria-label="Search models"
        placeholder="Search models"
        spellCheck={false}
        autoComplete="off"
        className="block h-11 w-full shrink-0 border-b border-border bg-transparent px-3.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="flex min-h-0" style={railed ? { height: listHeight } : { maxHeight: LIST_MAX }}>
        {railed ? <Rail tiles={tiles} active={q ? null : section} onSelect={showSection} onConnect={onManageModels} /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
        <div
          // Keyed by section: the rail's next section starts at its top and fades in as one (STYLE.md 8, a view).
          key={section}
          ref={list}
          id={`${uid}-list`}
          role="listbox"
          aria-label={q ? "Matching models" : section === HOME ? "Home" : `${harnessLabel ?? ""} models`}
          onScroll={(e) => fadeEdges(e.currentTarget)}
          onPointerMove={drag ? undefined : peekSoon}
          onPointerLeave={unpeek}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-1.5",
            moved && "animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none",
            drag && "cursor-grabbing select-none [&_*]:cursor-grabbing",
          )}
        >
          {empty ??
            items.map((item, i) => {
              if (item.kind === "heading") {
 // A hairline between sections, as native list draws them.
                return (
                  <div key={item.key} role="presentation">
                    {i > 0 ? <div className="mx-2.5 my-1.5 h-px bg-border" /> : null}
                    <div className="h-7 truncate px-2.5 pb-1 pt-2 text-[12px] leading-4 text-muted-foreground">{item.title}</div>
                  </div>
                );
              }
              if (item.kind === "more") {
                return (
                  <div
                    key={item.key}
                    id={optionId(item.row)}
                    role="option"
                    aria-selected={false}
                    aria-expanded={item.open}
                    data-active={item.row === active}
                    onPointerMove={() => item.row !== active && setActive(item.row)}
                    onClick={() => activate(item.row)}
                    className="mt-1.5 flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground"
                  >
                    More models
                    <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{item.count}</span>
                    <Icon icon={ArrowDown01Icon} className={cn("ml-auto size-3.5 transition-transform duration-150 ease-snap", item.open && "rotate-180")} />
                  </div>
                );
              }
              const key = entryKey(item.entry);
              const favorite = favIndex.get(key);
              const mixed = item.mixed === true;
              const carried = drag?.key === key && mixed;
              const markModel = mixed ? "" : item.entry.model.id;
              return (
                <ModelRow
                  key={item.key}
                  id={optionId(item.row)}
                  entry={item.entry}
                  // Home's other models mix harnesses, so their rows wear the harness's logo; elsewhere a heading says whose they are.
                  mark={<VendorMark engine={harnessOf(item.entry.engine)} model={markModel} />}
                  name={nameBesideMark(item.entry.model.label, modelVendor(harnessOf(item.entry.engine), markModel))}
                  active={item.row === active}
                  selected={isCurrent(item)}
                  favorite={favorite}
                  shortcut={mixed && favorite !== undefined && favorite < 9 ? `⌘${favorite + 1}` : undefined}
                  isDefault={defaultModel !== null && key === entryKey(defaultModel)}
                  roles={rolesOf.get(key) ?? NO_LABELS}
                  onGrip={movable && mixed ? (e) => startDrag(e, item.entry) : undefined}
                  // The carried row rides under the pointer between the places it takes.
                  carried={carried && drag ? drag.dy - (drag.to - drag.from) * ROW : undefined}
                  effort={effortOf(item.entry.model)}
                  // Older models fade in as one block when "More models" opens.
                  className={item.older ? "animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none" : undefined}
                  locked={item.entry.engine.locked !== undefined}
                  onHover={() => item.row !== active && setActive(item.row)}
                  onPick={() => activate(item.row)}
                  onStar={onFavoritesChange && !item.entry.engine.locked ? () => toggleFavorite(item.entry) : undefined}
                />
              );
            })}
        </div>
        {/* Under the list, never scrolled away: why its greyed rows cannot be picked, and the one button that leads there. */}
        {lock && !empty ? (
          <div className="flex h-11 shrink-0 items-center gap-2.5 border-t border-border pl-3.5 pr-2">
            <span className="min-w-0 flex-1 text-balance text-[12px] leading-4 text-muted-foreground">{lock.title}</span>
            {lock.action ? <LockAction action={act(lock.action)!} /> : null}
          </div>
        ) : null}
        </div>
      </div>
      {current && (onEffortChange || onSpeedChange) ? (
        <Foot
          entry={current}
          effort={onEffortChange ? effort : undefined}
          onEffortChange={onEffortChange}
          speed={onSpeedChange ? speed : undefined}
          onSpeedChange={onSpeedChange}
          start={start}
          onSaveStart={onSaveStart}
        />
      ) : null}
      {card ? (
        // Level with the picker's edge nearest its trigger; the rows already say it in words (factsSummary).
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-0 z-10 animate-in fade-in-0 duration-150 ease-snap group-data-[side=top]/picker:bottom-0 group-data-[side=top]/picker:top-auto",
            cardSide === "right" ? "left-full ml-2" : "right-full mr-2",
          )}
        >
          <ModelCard
            model={cardOf(card.entry, effortOf)}
            current={current && !isCurrent(card) ? cardOf(current, effortOf) : null}
            others={rows.flatMap((r): ModelRun[] => {
              if (r.kind !== "model" || r === card || isCurrent(r)) return [];
              const facts = modelFacts(r.entry.model.id);
              const run = facts && runAt(facts, effortOf(r.entry.model));
              return run ? [run] : [];
            })}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The card's width and its gap, with a margin to the window's edge. */
const CARD_ROOM = 240 + 8 + 12;
const cardOf = (entry: Entry, effortOf: (model: PickerModel) => string | undefined) => ({ label: entry.model.label, effort: effortOf(entry.model), facts: modelFacts(entry.model.id) });

/**
 * The picker's foot, one 44px line: the effort slider and the bolt where the model has speeds. While the chat is not
 * where its model starts, the level's word is dotted and makes it the start ("dotted if its not
 * default"); nothing is added to the line, so the track never moves.
 */
function Foot({
  entry,
  effort,
  onEffortChange,
  speed,
  onSpeedChange,
  start,
  onSaveStart,
}: {
  entry: Entry;
  effort: string | undefined;
  onEffortChange: ((level: string) => void) | undefined;
  speed: string | undefined;
  onSpeedChange: ((speed: string) => void) | undefined;
  start: ModelPickerProps["start"];
  onSaveStart: (() => void) | undefined;
}) {
  const { model } = entry;
  const speeds = model.speeds ?? [];
  const startEffort = start?.effort && model.efforts.includes(start.effort) ? start.effort : undefined;
  const startSpeed = start?.speed && (start.speed === STANDARD_SPEED || speeds.includes(start.speed)) ? start.speed : STANDARD_SPEED;
  const away = (onEffortChange !== undefined && startEffort !== undefined && effort !== startEffort) || (onSpeedChange !== undefined && speed !== startSpeed);
  const named = [onEffortChange && effort ? effortLabel(effort) : null, onSpeedChange && speed ? speedLabel(speed) : null].filter(Boolean).join(", ");
  const save = onSaveStart && away ? { label: `Make ${named} the default for ${model.label}`, onSave: onSaveStart } : undefined;
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-t border-border pl-3.5 pr-2.5">
      {onEffortChange ? (
        <EffortSlider levels={model.efforts} value={effort} start={onSaveStart ? startEffort : undefined} save={save} onChange={onEffortChange} className="min-w-0 flex-1" />
      ) : save ? (
        <button
          type="button"
          aria-label={save.label}
          title={save.label}
          onPointerDown={(e) => e.preventDefault()}
          onClick={save.onSave}
          className="mr-auto rounded-sm text-[12px] text-muted-foreground underline decoration-dotted underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Speed
        </button>
      ) : (
        <span className="flex-1 text-[12px] text-muted-foreground">Speed</span>
      )}
      {onSpeedChange ? <SpeedToggle speeds={speeds} value={speed} onChange={onSpeedChange} /> : null}
    </div>
  );
}

function ModelRow({
  id,
  entry,
  mark,
  name,
  active,
  selected,
  favorite,
  shortcut,
  isDefault,
  roles,
  onGrip,
  carried,
  effort,
  className,
  locked,
  onHover,
  onPick,
  onStar,
}: {
  id: string;
  entry: Entry;
  mark: React.ReactNode;
  /** Its name as the row shows it: without the vendor the mark already names. */
  name: string;
  active: boolean;
  selected: boolean;
  favorite: number | undefined;
  /** Its ⌘n, in the Favorites section. */
  shortcut: string | undefined;
  /** New chats start on it: a Default tag after its name. */
  isDefault: boolean;
  /** The roles delegated agents start on it for: one grey tag after Default, the first role and how many more. */
  roles: readonly string[];
  /** A Home row: a grip in front of its mark moves it. */
  onGrip: ((e: React.PointerEvent) => void) | undefined;
  /** While it is being moved: how far it sits from its place, in px. */
  carried: number | undefined;
  /** The effort it would run at if picked, for its facts in words. */
  effort: string | undefined;
  className?: string | undefined;
  /** It cannot be picked here yet (PickerLock): greyed, and a click does nothing. */
  locked: boolean;
  onHover: () => void;
  onPick: () => void;
  onStar: (() => void) | undefined;
}) {
  const starred = favorite !== undefined;
  const facts = modelFacts(entry.model.id);
  const glance = facts ? runAt(facts, effort) : undefined;
  // The name truncates before what sits at the right: the glance, the ⌘n, the star.
  const room = 10 + (glance ? 62 : 0) + (shortcut ? 34 : 0) + (onStar ? 28 : 0);
  const moving = carried !== undefined;
  return (
    <div
      role="none"
      data-active={active}
      className={cn("group/row relative", moving && "z-10 rounded-md bg-popover shadow-md", className)}
      style={moving ? { transform: `translateY(${carried}px)` } : undefined}
      onPointerMove={onHover}
    >
      {/* The active row never transitions: a fade under the arrow keys reads as lag (STYLE.md 8). */}
      <div
        id={id}
        role="option"
        aria-selected={selected}
        aria-disabled={locked || undefined}
        onClick={onPick}
        title={entry.engine.hint ?? entry.model.description}
        style={{ paddingRight: room }}
        className={cn("flex h-8 items-center gap-2.5 rounded-md", locked ? "cursor-default opacity-50" : "cursor-pointer group-data-[active=true]/row:bg-accent", onGrip ? "pl-4" : "pl-2.5")}
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">{mark}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="truncate text-[13px] text-foreground">{name}</span>
          <span className="sr-only">{entry.model.label}</span>
          {isDefault ? (
            <span
              title="New chats start on this model"
              className="shrink-0 rounded border border-[color:var(--tag-blue-border)] bg-[color:var(--tag-blue)] px-1 text-[11px] leading-4 text-[color:var(--tag-blue-ink)]"
            >
              Default
            </span>
          ) : null}
          {roles.length > 0 ? (
            <span
              title={`${AND.format(roles)} agents start on this model`}
              className="shrink-0 rounded border border-[color:var(--tag-neutral-border)] bg-[color:var(--tag-neutral)] px-1 text-[11px] leading-4 text-[color:var(--tag-neutral-ink)]"
            >
              <span aria-hidden>
                {roles[0]}
                {roles.length > 1 ? <span className="text-muted-foreground"> +{roles.length - 1}</span> : null}
              </span>
              <span className="sr-only">, for {AND.format(roles).toLowerCase()} agents</span>
            </span>
          ) : null}
        </span>
        {/* The default's tag leaves no room for a check: the trigger names the current model. */}
        {selected && !isDefault ? <Icon icon={Tick02Icon} className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} /> : null}
        {facts && glance ? <span className="sr-only">, {factsSummary(facts, effort)}</span> : null}
      </div>
      {onGrip ? (
        // A pointer's handle; keyboards move the active row with ⌥↑/⌥↓ from the search field.
        <span
          aria-hidden
          title="Drag to reorder. The top model is the default."
          onPointerDown={onGrip}
          className={cn(
            "absolute inset-y-0 left-0 grid w-4 cursor-grab touch-none place-items-center text-muted-foreground opacity-0 transition-opacity duration-75 hover:text-foreground",
            "group-hover/row:opacity-100 group-data-[active=true]/row:opacity-100",
            moving && "opacity-100",
          )}
        >
          <Icon icon={DragDropVerticalIcon} className="size-3.5" />
        </span>
      ) : null}
      <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-1">
        {/* Clicks fall through to the row: the glance and the ⌘n are part of picking it. */}
        {glance ? <ModelGlance facts={facts!} effort={effort} className={cn("mr-1.5", locked && "opacity-50")} /> : null}
        {shortcut ? <Keycap className="tabular-nums">{shortcut}</Keycap> : null}
        {onStar ? (
          <button
            type="button"
            tabIndex={active ? 0 : -1}
            aria-pressed={starred}
            aria-label={starred ? `Remove ${entry.model.label} from favorites` : `Add ${entry.model.label} to favorites`}
            // Keep focus in the search field: the star is a mouse shortcut there; Tab reaches it for keyboards.
            onPointerDown={(e) => e.preventDefault()}
            onClick={onStar}
            className={cn(
              "pointer-events-auto grid size-6 place-items-center rounded-md opacity-0 outline-none transition-[opacity,color] duration-75 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
              "group-hover/row:opacity-100 group-data-[active=true]/row:opacity-100",
              starred ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon icon={StarIcon} className={cn("size-3.5", starred && "fill-current")} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

function Rail({
  tiles,
  active,
  onSelect,
  onConnect,
}: {
  tiles: ReadonlyArray<{ id: string; label: string; locked?: boolean }>;
  /** Null while a search spans every harness: no tile is the list's. */
  active: string | null;
  onSelect: (section: string) => void;
  onConnect: (() => void) | undefined;
}) {
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());
  const pill = React.useRef<HTMLSpanElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);

  // One "here" tile that glides between sections (transform only, ease-swift). Its first placement does not move,
  // and it lets go while a search spans every harness.
  React.useLayoutEffect(() => {
    const el = pill.current;
    const btn = active ? buttons.current.get(active) : undefined;
    if (!el) return;
    el.style.opacity = btn ? "1" : "0";
    if (btn) {
      el.style.transform = `translateY(${btn.offsetTop}px)`;
      if (!el.dataset.ready) {
        btn.scrollIntoView({ block: "nearest" });
        requestAnimationFrame(() => (el.dataset.ready = ""));
      }
    }
    fadeEdges(scroller.current);
  }, [active]);

  return (
    <div className="flex w-11 shrink-0 flex-col border-r border-border">
      <div
        ref={scroller}
        role="group"
        aria-label="Harnesses"
        onScroll={(e) => fadeEdges(e.currentTarget)}
        className="relative flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <span
          ref={pill}
          aria-hidden
          className="pointer-events-none absolute left-1.5 top-0 size-8 rounded-md bg-accent opacity-0 data-[ready]:transition-[transform,opacity] data-[ready]:duration-200 data-[ready]:ease-swift motion-reduce:transition-none"
        />
        {tiles.map((t) => {
          const on = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              ref={(el) => {
                if (el) buttons.current.set(t.id, el);
                else buttons.current.delete(t.id);
              }}
              aria-label={t.label}
              aria-pressed={on}
              title={t.label}
              // Keep focus in the search field: the arrows and Enter carry on in the new section.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onSelect(t.id)}
              className={cn(
                "relative grid size-8 shrink-0 place-items-center rounded-md outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                on ? "text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {t.id === HOME ? (
                <Icon icon={Home01Icon} className="size-4" />
              ) : (
                <EngineLogo engine={t.id} size={16} className={cn("transition-opacity duration-75", t.locked ? "opacity-40" : on ? "opacity-100" : "opacity-75")} />
              )}
            </button>
          );
        })}
      </div>
      {onConnect ? (
        <button
          type="button"
          aria-label="Connect models"
          title="Connect models"
          onClick={onConnect}
          className="mx-auto mb-1.5 mt-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon icon={Add01Icon} className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** The one button a lock or an empty list offers. */
function LockAction({ action, className }: { action: { label: string; run: () => void }; className?: string }) {
  return (
    <button
      type="button"
      onClick={action.run}
      className={cn("h-7 shrink-0 rounded-md border border-border px-2.5 text-[12px] text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      {action.label}
    </button>
  );
}

function EmptyRows({ title, line, action }: { title: string; line?: React.ReactNode; action?: { label: string; run: () => void } | undefined }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <span className="text-balance text-[13px] text-foreground">{title}</span>
      {line ? <span className="text-balance text-[12px] text-muted-foreground">{line}</span> : null}
      {action ? <LockAction action={action} className="mt-2" /> : null}
    </div>
  );
}
