// What a place offers a chat: the agents its computer runs and their models, in the pickers' own shapes
// (board/catalog.ts). A Mac's is what that Mac lists (Session Protocol engine.list). Cloud's is what a Cloud computer
// of the person's last listed; before one has, what their plans and keys can run there, read from a Mac's list (each
// account says where it works); with neither, the agents Cloud runs, by name. Nothing is offered that the place lacks:
// the picker lists only this, and a new chat's pick settles on it, so a chat never starts on an agent that is not there.
//
// Pure: lists go in, the pickers' shapes and the words come out, so engines.test.ts pins them. Of the app, only
// types are imported.
import type { AccountConnection, EngineDescriptor } from "@caveman-app/session-protocol";

import type { CatalogEngine, CatalogModel, Level, ModelRef } from "../board/catalog";
import { ENGINE_ID } from "./start.ts";

type Agent = Pick<EngineDescriptor, "id" | "label" | "auth">;

/** The agents Cloud runs: its image carries claude and codex beside the Caveman engine (the web's routes/cloud-need.ts). */
export const CLOUD_AGENTS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "caveman", label: "Caveman" },
  { id: "claude-agent", label: "Claude Agent" },
  { id: "codex", label: "Codex" },
];
const IN_CLOUD: ReadonlySet<string> = new Set(CLOUD_AGENTS.map((a) => a.id));

/** A computer can take a chat on this agent now: it is signed in, or has a key (the web's engineReady). */
export const runsNow = (agent: Pick<Agent, "auth">): boolean =>
  agent.auth.state === "signed_in" || agent.auth.state === "api_key";

/** The agents the board can hold a chat on (start.ts ENGINE_ID): another harness's chats have no place on it yet. */
const ON_BOARD: ReadonlySet<string> = new Set(Object.values(ENGINE_ID));

/** Menus say "Claude Agent", never "Claude Code", whatever a computer calls it. */
const nameOf = (agent: Pick<Agent, "id" | "label">) =>
  agent.id === "claude-agent" ? "Claude Agent" : agent.label.trim() || agent.id;

const LEVELS: ReadonlySet<string> = new Set<Level>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
]);

/** Whose key a Caveman engine model runs on, from its id ("anthropic/claude-opus-5-5"): the quiet heading over it. */
const SOURCES: Readonly<Record<string, string>> = {
  caveman: "Caveman credits",
  anthropic: "Anthropic",
  openai: "OpenAI",
  chatgpt: "ChatGPT",
  copilot: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  supergrok: "SuperGrok",
  xai: "xAI",
  google: "Google",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  moonshotai: "Moonshot",
  openrouter: "OpenRouter",
  zai: "Z.ai",
};
function sourceOf(engine: string, model: string): string | undefined {
  if (engine !== "caveman" || !model.includes("/")) return undefined;
  const first = model.slice(0, model.indexOf("/"));
  return SOURCES[first] ?? `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
}

function shapeOf(
  engine: EngineDescriptor,
  keep: (model: EngineDescriptor["models"][number]) => boolean = () => true,
): CatalogEngine {
  const models = engine.models.filter(keep).map((m): CatalogModel => {
    const efforts = m.efforts.filter((l): l is Level => LEVELS.has(l));
    const source = sourceOf(engine.id, m.id);
    return {
      id: m.id,
      label: m.label.trim() || m.id,
      efforts,
      ...(m.default_effort !== undefined && LEVELS.has(m.default_effort)
        ? { defaultEffort: m.default_effort as Level }
        : {}),
      ...(m.speeds?.length ? { speeds: m.speeds } : {}),
      ...(m.legacy ? { legacy: true } : {}),
      ...(m.description ? { description: m.description } : {}),
      ...(source ? { source } : {}),
    };
  });
  return {
    id: engine.id,
    label: nameOf(engine),
    // An agent that names no model runs its own default: one row, by the agent's name.
    models: models.length > 0 ? models : [byName(nameOf(engine))],
    ...(engine.default_model !== undefined && models.some((m) => m.id === engine.default_model)
      ? { defaultModel: engine.default_model }
      : {}),
  };
}

/** An agent's own default model, as a row: the agent's name, and no id (the computer picks). */
const byName = (label: string): CatalogModel => ({ id: "", label, efforts: [] });

const listed = new WeakMap<ReadonlyArray<EngineDescriptor>, readonly CatalogEngine[]>();
/** What a computer offers, from what it listed: the agents it can run now, each with its models. Kept per list. */
export function catalogOf(engines: ReadonlyArray<EngineDescriptor>): readonly CatalogEngine[] {
  const had = listed.get(engines);
  if (had) return had;
  const made = engines.filter((e) => runsNow(e) && ON_BOARD.has(e.id)).map((e) => shapeOf(e));
  listed.set(engines, made);
  return made;
}

// ---------------------------------------------------------------- Cloud, read from a Mac's list

export interface CloudNeed {
  /**
   * unsupported: the agent does not run in Cloud. connect: no plan or key of it works there yet. reconnect: its plan's
   * sign-in ended. admin_off: the admin turned its plans off and no key is there instead.
   */
  readonly kind: "unsupported" | "connect" | "reconnect" | "admin_off";
  readonly line: string;
}

const PLAN: Readonly<Record<string, { readonly plan: string; readonly key: string }>> = {
  "claude-agent": { plan: "Claude", key: "an Anthropic key" },
  codex: { plan: "ChatGPT", key: "an OpenAI key" },
};

type Standing = "off" | "ended" | "works";
/** Where a plan or key kept by Caveman stands for a chat in Cloud: one used up works again by itself at its reset. */
function standing(connection: AccountConnection, now: number): Standing {
  if (connection.off) return "off";
  const ends = connection.expires_at === undefined ? Number.NaN : Date.parse(connection.expires_at);
  return connection.status === "expired" || connection.status === "revoked" || ends <= now
    ? "ended"
    : "works";
}
const isPlan = (connection: AccountConnection) =>
  connection.kind === "claude_plan" || connection.kind === "chatgpt_plan";

/**
 * What a chat in Cloud on this agent still needs, read from a Mac's list of it; null when a chat there runs. The
 * web's sentences, in the same cases (routes/cloud-need.ts cloudStartNeed): only Claude Agent and Codex are asked
 * about, and only where plans connect once for every computer (auth.everywhere); the Caveman engine runs in Cloud on
 * the Caveman plan.
 */
export function cloudNeed(agent: Agent | undefined, now: number): CloudNeed | null {
  if (agent === undefined) return null;
  if (!IN_CLOUD.has(agent.id))
    return {
      kind: "unsupported",
      line: `${nameOf(agent)} doesn't run in Cloud. Pick Claude Agent, Codex or Caveman.`,
    };
  const words = PLAN[agent.id];
  if (words === undefined || agent.auth.everywhere === undefined) return null;
  const kept = agent.auth.accounts.flatMap((a) =>
    (a.where === "everywhere" || a.where === "cloud") && a.connection
      ? [{ is: standing(a.connection, now), plan: isPlan(a.connection) }]
      : [],
  );
  if (kept.some((k) => k.is === "works")) return null;
  if (kept.some((k) => k.is === "ended" && k.plan))
    return { kind: "reconnect", line: `Your ${words.plan} sign-in expired.` };
  if (agent.auth.everywhere === "off" || kept.some((k) => k.is === "off"))
    return {
      kind: "admin_off",
      line: `Your admin turned ${words.plan} plans off. Add ${words.key}, or run this chat on your Mac.`,
    };
  return { kind: "connect", line: `${words.plan} isn't connected for Cloud.` };
}

/** Where a phone sends someone for what only a Mac can do (shell/settings/models-model.ts says the same). */
const ON_MAC = "Connect it on your Mac (Settings > Models & keys).";

/** An agent Cloud runs that is not offered there: which, and why in one sentence, with where it is put right. */
export interface Missing {
  readonly engine: string;
  readonly line: string;
}

export interface CloudOffer {
  readonly engines: readonly CatalogEngine[];
  readonly missing: readonly Missing[];
}

const derived = new WeakMap<ReadonlyArray<EngineDescriptor>, CloudOffer>();
/**
 * What Cloud would run for this person, read from one of their Macs' lists, for a chat no Cloud computer has listed
 * for yet: each agent Cloud runs that the Mac knows and that needs nothing more there, with the Mac's models for it.
 * Auto is the Mac's own router: a Cloud computer does not run it for Claude Agent or Codex.
 */
export function cloudFromMac(mac: ReadonlyArray<EngineDescriptor>, now: number): CloudOffer {
  const had = derived.get(mac);
  if (had) return had;
  const engines: CatalogEngine[] = [];
  const missing: Missing[] = [];
  for (const { id, label } of CLOUD_AGENTS) {
    const agent = mac.find((e) => e.id === id);
    if (id === "caveman") {
      // The Caveman engine runs in Cloud on the Caveman plan, whatever this Mac has set up: with its models where
      // the Mac runs it, else by name.
      engines.push(
        agent && runsNow(agent) ? shapeOf(agent) : { id, label, models: [byName(label)] },
      );
      continue;
    }
    if (!agent) continue;
    const need = cloudNeed(agent, now);
    // From before plans connected once (no `everywhere`), an agent runs there only as it runs here.
    if (need === null && (agent.auth.everywhere !== undefined || runsNow(agent)))
      engines.push(shapeOf(agent, (m) => m.id !== "auto"));
    else if (need)
      missing.push({
        engine: id,
        line:
          need.kind === "connect" || need.kind === "reconnect"
            ? `${need.line} ${ON_MAC}`
            : need.line,
      });
  }
  const made = { engines, missing };
  derived.set(mac, made);
  return made;
}

/** The agents Cloud runs, each by its name alone: what is offered while no computer of the person's has listed any. */
export const CLOUD_BY_NAME: readonly CatalogEngine[] = CLOUD_AGENTS.map((a) => ({
  id: a.id,
  label: a.label,
  models: [byName(a.label)],
}));

// ---------------------------------------------------------------- what a picker lists

/** What the pickers list for a chat or for a new chat's place, with what to say where there is nothing to list. */
export interface Offer {
  readonly engines: readonly CatalogEngine[];
  /** In the list's place while it is empty: what it waits for, or what to do and where. */
  readonly line: string | null;
  /** Under the list: why an agent Cloud runs is not in it, one sentence each. */
  readonly missing: readonly Missing[];
  /** The place has answered and runs no agent now: `line` says where one is set up, and a chip names no model. */
  readonly none?: true;
}

/** A chat's place, or a new chat's, with what is known of what it runs. */
export type Spot =
  | {
      readonly kind: "mac";
      readonly name: string;
      /** What this Mac last said it runs; undefined: it has not said since the app started. */
      readonly listed: ReadonlyArray<EngineDescriptor> | undefined;
      readonly is: "running" | "asleep" | "offline";
      /** This phone waits to be let in on it (with the code its dialog shows), or was refused. */
      readonly allow?: { readonly state: "waiting" | "refused"; readonly code: string } | undefined;
    }
  | {
      readonly kind: "cloud";
      /** What a Cloud computer of the person's last said it runs: the chat's own where it has one, else any. */
      readonly listed: ReadonlyArray<EngineDescriptor> | undefined;
      /** What one of their Macs last said: their plans and keys, each with where it works. */
      readonly mac: ReadonlyArray<EngineDescriptor> | undefined;
    };

const NO_ENGINES: readonly CatalogEngine[] = [];
const NO_LINES: readonly Missing[] = [];
export const LOADING = "Loading…";
const checking = (engines: ReadonlyArray<EngineDescriptor>) =>
  engines.some((e) => e.auth.state === "checking");

/** What a chip says in a model's place where its place runs no agent: the picker under it says where one is set up. */
export const NO_AGENT = "No agent";

/** What a place with no agent to run a chat on says, and where one is set up: a phone sets up none. */
export const noAgentLine = (where: { readonly name: string; readonly cloud: boolean }): string =>
  where.cloud
    ? `No agent is connected for Cloud yet. ${ON_MAC.replace("Connect it", "Connect one")}`
    : `No agent is set up on ${where.name} yet. Set one up there (Settings > Models & keys).`;

/** Whether a computer is still finding out what it is signed in to, with nothing to offer meanwhile. */
export const stillChecking = (engines: ReadonlyArray<EngineDescriptor>): boolean =>
  checking(engines) && catalogOf(engines).length === 0;

/**
 * What a picker lists for a place. A Mac's is what that Mac last said it runs. Cloud's is what a Cloud computer of
 * the person's last said, else what one of their Macs says their plans and keys run there, else the agents Cloud
 * runs, by name. Nothing is listed that the place may lack; while nothing is known, a line says what the list waits
 * for. `spot` null: no place is picked (`loading`: the person's computers have not been listed yet).
 */
export function offerOf(spot: Spot | null, now: number, loading = false): Offer {
  if (!spot)
    return {
      engines: NO_ENGINES,
      line: loading ? LOADING : "No place can take a chat now.",
      missing: NO_LINES,
    };
  if (spot.kind === "mac") {
    if (spot.listed) {
      const engines = catalogOf(spot.listed);
      if (engines.length > 0) return { engines, line: null, missing: NO_LINES };
      return checking(spot.listed)
        ? { engines, line: LOADING, missing: NO_LINES }
        : {
            engines,
            line: noAgentLine({ name: spot.name, cloud: false }),
            missing: NO_LINES,
            none: true,
          };
    }
    // This phone waits to be let in: what to do on the Mac, with the code to check.
    if (spot.allow?.state === "waiting")
      return {
        engines: NO_ENGINES,
        line: `On ${spot.name}, choose Allow when it shows this code: ${spot.allow.code}`,
        missing: NO_LINES,
      };
    if (spot.allow?.state === "refused")
      return {
        engines: NO_ENGINES,
        line: `Allow this phone on ${spot.name} (Settings > General).`,
        missing: NO_LINES,
      };
    return {
      engines: NO_ENGINES,
      line:
        spot.is === "running"
          ? LOADING
          : `Its models show when ${spot.name} ${spot.is === "offline" ? "is back online" : "wakes"}.`,
      missing: NO_LINES,
    };
  }
  const read = spot.mac ? cloudFromMac(spot.mac, now) : undefined;
  const missing = read && read.missing.length > 0 ? read.missing : NO_LINES;
  if (spot.listed) {
    const engines = catalogOf(spot.listed);
    // Its own word wins: an agent it runs is never also said to be missing.
    const absent = missing.filter((m) => !engines.some((e) => e.id === m.engine));
    const lacks = absent.length === missing.length ? missing : absent;
    if (engines.length > 0) return { engines, line: null, missing: lacks };
    return checking(spot.listed)
      ? { engines, line: LOADING, missing: lacks }
      : { engines, line: noAgentLine({ name: "Cloud", cloud: true }), missing: lacks, none: true };
  }
  return { engines: read ? read.engines : CLOUD_BY_NAME, line: null, missing };
}

// ---------------------------------------------------------------- a pick, settled on a place

/** The order agents are tried in when the one wanted is not there (the web's firstReadyEngine). */
const FIRST = ["caveman", "claude-agent", "codex"];

/** The model an agent starts on when none is named: its own default, else its first current model, else its first. */
const startModel = (engine: CatalogEngine) =>
  engine.models.find((m) => m.id === engine.defaultModel) ??
  engine.models.find((m) => !m.legacy) ??
  engine.models[0];

/**
 * The pick a chat starts on at a place: the one wanted where the place offers it (its model by id or by name), else
 * that agent on its own default model, else the first agent the place does offer. Null: the place offers none.
 */
export function settlePick(
  offer: readonly CatalogEngine[],
  wanted: ModelRef | null,
): ModelRef | null {
  const own = wanted ? offer.find((e) => e.id === wanted.engine) : undefined;
  const engine = own ?? FIRST.flatMap((id) => offer.find((e) => e.id === id) ?? [])[0] ?? offer[0];
  if (!engine) return null;
  const model =
    (own && wanted
      ? (engine.models.find((m) => m.id === wanted.model) ??
        engine.models.find((m) => m.label === wanted.model))
      : undefined) ?? startModel(engine);
  return model ? { engine: engine.id, model: model.id } : null;
}
