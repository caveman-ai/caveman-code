// What each of the 14 tools does (docs/ §3), over the Session Protocol as this
// outside agent. Plain promises over an AgentLink, so tests stand in for the runtime; server.ts puts it behind MCP.
// Every answer is plain text; a failure is an answer with isError that says what to do next, with a valid call.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  Attachment as AttachmentSchema,
  EngineDescriptor,
  OutsideAgentLevel,
  Project,
  TurnOptions as TurnOptionsSchema,
  Workspace,
  WorkspaceDigest,
} from "@caveman-app/session-protocol";
import { CallNotSent, CallTimeout, SessionProtocolError } from "@caveman-app/session-protocol/client";
import * as Schema from "effect/Schema";

import { COMMIT_TIMEOUT_MS } from "../git/commitTimeout.ts";
import { LinkRefused, LinkTimeout, type AgentClient, type AgentLink, type Connected } from "./connection.ts";
import { fitImage } from "./images.ts";
import {
  ACCESS_LABEL,
  LEVEL_LABEL,
  LEVEL_MEANS,
  accessCeiling,
  accessFor,
  agentName,
  defaultEngineFor,
  engineHonours,
  findEngine,
  isCodexClient,
  isConnected,
} from "./names.ts";
import {
  RASTER,
  ago,
  answerExample,
  askCard,
  askMatches,
  call,
  chatList,
  chatRef,
  clip,
  diffFiles,
  digestText,
  enginesText,
  engineLabel,
  imageRefs,
  nextFor,
  personAsk,
  personOnly,
  projectLabel,
  projectsText,
  shownByDefault,
  stateOf,
  stateWords,
  tellYourUser,
  transcriptPage,
  isUnread,
  type AskUser,
  type ChatState,
  type ImageRef,
  type Labels,
  type QuestionCard,
} from "./render.ts";
import { TOOLS, type ParamsOf, type ToolName } from "./tools.ts";
import { Tracker, type Change } from "./wait.ts";

type Attachment = typeof AttachmentSchema.Type;
type TurnOptions = typeof TurnOptionsSchema.Type;

export interface Answer {
  readonly text: string;
  /** chat_read's images view: base64 image blocks after the text. */
  readonly images?: ReadonlyArray<{ readonly mime: string; readonly data: string }>;
  readonly isError?: boolean;
}

export interface CallContext {
  /** The MCP client's clientInfo.name. */
  readonly clientName?: string | undefined;
  /** Aborts when the client cancels the call. */
  readonly signal?: AbortSignal | undefined;
}

export interface BridgeOptions {
  readonly link: AgentLink;
  /** `--name`. */
  readonly name?: string | undefined;
  /** The working folder the default project holds. */
  readonly cwd: string;
  readonly now?: () => number;
  readonly requestId?: () => string;
}

/** A tool's answer when it can't do what was asked: its text says what to do instead. */
class Refusal extends Error {
  constructor(text: string) {
    super(text);
    this.name = "Refusal";
  }
}
const refuse = (text: string): never => {
  throw new Refusal(text);
};

const EXAMPLE_CHAT = "<id or title>";
const EXAMPLES: Record<ToolName, string> = {
  chats: call("chats", { state: "working" }),
  projects: "projects {}",
  engines: "engines {}",
  chat_start: call("chat_start", { task: "Fix the failing login test" }),
  chat_send: call("chat_send", { chat: EXAMPLE_CHAT, text: "…" }),
  chat_read: call("chat_read", { chat: EXAMPLE_CHAT }),
  chat_wait: call("chat_wait", { chats: [EXAMPLE_CHAT] }),
  chat_answer: call("chat_answer", { chat: EXAMPLE_CHAT, recommended: true }),
  chat_stop: call("chat_stop", { chat: EXAMPLE_CHAT }),
  chat_diff: call("chat_diff", { chat: EXAMPLE_CHAT }),
  chat_undo: call("chat_undo", { chat: EXAMPLE_CHAT }),
  chat_organize: call("chat_organize", { chat: EXAMPLE_CHAT, action: "rename", title: "…" }),
  chat_ship: call("chat_ship", { chat: EXAMPLE_CHAT, pr: { title: "…" } }),
  project_add: call("project_add", { path: "/path/to/repo" }),
};

const DUPLICATE_MS = 2 * 60_000;
const WAIT_DEFAULT_S = 45;
const PATCH_BYTES = 24 * 1024;
const PAGE_BYTES = 64 * 1024;
const IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_IN = 10;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const firstLine = (text: string) => text.split("\n")[0]!.trim();

/** One tool call's session: the client as this agent, its level, and the reads every tool shares. */
class Turn {
  readonly bridge: Bridge;
  readonly context: CallContext;
  private readonly session: Connected;
  private labelsCache: Promise<Labels> | undefined;

  constructor(bridge: Bridge, session: Connected, context: CallContext) {
    this.bridge = bridge;
    this.session = session;
    this.context = context;
  }

  get client(): AgentClient {
    return this.session.client;
  }
  get level(): OutsideAgentLevel {
    return this.session.agent.level;
  }
  get name(): string {
    return this.session.agent.name;
  }
  get now(): number {
    return this.bridge.now();
  }
  get tracker(): Tracker {
    return this.bridge.tracker;
  }
  requestId(): string {
    return this.bridge.requestId();
  }

  /** Every chat this agent may see (the gate already drops Chief and setup chats), newest first; each one fed to chat_wait. */
  async workspaces(includeArchived = false): Promise<Array<Workspace>> {
    const { workspaces } = await this.client.call("workspace.list", includeArchived ? { include_archived: true } : {});
    for (const w of workspaces) this.tracker.observe(w);
    return workspaces.filter((w) => w.kind === undefined).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  labels(): Promise<Labels> {
    this.labelsCache ??= Promise.all([this.projects(), this.engines()]).then(([projects, engines]) => ({ projects, engines }));
    return this.labelsCache;
  }

  async projects(): Promise<ReadonlyArray<Project>> {
    return (await this.client.call("project.list", {})).projects;
  }

  async engines(): Promise<ReadonlyArray<EngineDescriptor>> {
    return (await this.client.call("engine.list", {})).engines;
  }

  /** The person's default engine (Settings), when this agent may read it. */
  defaultEngine(): Promise<string | undefined> {
    return this.bridge.defaultEngine(this.client);
  }

  async digest(id: string, transcript?: { readonly before?: number; readonly max_bytes?: number }): Promise<WorkspaceDigest> {
    const d = await this.client.call("workspace.digest", { workspace_id: id, ...(transcript ? { transcript } : {}) });
    this.tracker.observe(d.workspace);
    return d;
  }

  /** A chat by id or title (then a unique id prefix or part of a title); on a miss, chat.search's top 3. */
  async chat(ref: string): Promise<Workspace> {
    const key = ref.trim();
    if (!key) return refuse(`Name a chat by its id or title; chats {} lists them.`);
    const all = await this.workspaces(true);
    const byId = all.find((w) => w.id === key);
    if (byId) return byId;
    const lower = key.toLowerCase();
    const labels = await this.labels();
    const ambiguous = (matches: ReadonlyArray<Workspace>) =>
      refuse([`"${key}" matches ${matches.length} chats:`, ...matches.slice(0, 5).map((w) => chatRef(w, labels, this.now)), "Call again with one of these ids."].join("\n"));
    const titled = all.filter((w) => w.title.trim().toLowerCase() === lower);
    if (titled.length === 1) return titled[0]!;
    if (titled.length > 1) return ambiguous(titled);
    const prefixed = key.length >= 4 ? all.filter((w) => w.id.startsWith(key)) : [];
    if (prefixed.length === 1) return prefixed[0]!;
    const containing = all.filter((w) => w.title.toLowerCase().includes(lower));
    if (containing.length === 1) return containing[0]!;
    if (containing.length > 1) return ambiguous(containing);
    const found = await this.client.call("chat.search", { query: key.slice(0, 500), limit: 3 }).catch(() => undefined);
    const closest = (found?.chats ?? []).map((hit) => hit.workspace).filter((w) => w.kind === undefined).slice(0, 3);
    return refuse(
      closest.length
        ? [`No chat named "${key}". Closest:`, ...closest.map((w) => chatRef(w, labels, this.now)), "Call again with one of these ids."].join("\n")
        : `No chat named "${key}". chats {} lists them; chats {"query":"…"} searches their transcripts.`,
    );
  }

  /** The project holding the working folder: the deepest project path above it, else the project of a chat's worktree it is in. */
  async projectHere(projects: ReadonlyArray<Project>): Promise<Project | undefined> {
    const here = realpath(this.bridge.cwd);
    const holds = (root: string) => here === root || here.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    const project = projects.filter((p) => holds(p.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (project) return project;
    const worktree = (await this.workspaces().catch(() => [])).find((w) => w.root_path !== undefined && holds(w.root_path));
    return worktree?.project_id === undefined ? undefined : projects.find((p) => p.id === worktree.project_id);
  }

  /** A project by id, name, path or owner/name; none given: the one holding the working folder. */
  async project(ref: string | undefined): Promise<Project> {
    const projects = await this.projects();
    const list = () => projects.slice(0, 12).map((p) => `[${p.id}] ${p.name} · ${p.path}`).join("\n");
    if (ref === undefined || !ref.trim()) {
      const here = await this.projectHere(projects);
      if (here) return here;
      return refuse(
        projects.length
          ? `Your working folder (${this.bridge.cwd}) is in no Caveman Code project. Pass project, one of:\n${list()}\nOr add it: ${call("project_add", { path: this.bridge.cwd })} (Full access).`
          : `Caveman Code has no projects yet. Add one: ${call("project_add", { path: this.bridge.cwd })} (Full access), or ask your user to add it in Caveman Code.`,
      );
    }
    const key = ref.trim();
    const lower = key.toLowerCase();
    const asPath = realpath(path.resolve(this.bridge.cwd, expandHome(key)));
    const match =
      projects.find((p) => p.id === key) ??
      projects.find((p) => p.name.toLowerCase() === lower) ??
      projects.find((p) => p.path === asPath || p.path === key) ??
      projects.find((p) => p.repository?.full_name.toLowerCase() === lower || p.repository?.web_url.toLowerCase() === lower.replace(/\.git$/, "")) ??
      projects.find((p) => path.basename(p.path).toLowerCase() === lower);
    if (match) return match;
    const partial = projects.filter((p) => p.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0]!;
    return refuse(`No project "${key}". Projects:\n${list() || "(none)"}`);
  }

  /** Images in: base64 at any level; at Full access also an image file's path (10 MB at most). */
  attachments(images: ReadonlyArray<string> | undefined): Array<Attachment> {
    if (!images?.length) return [];
    if (images.length > MAX_IMAGES_IN) refuse(`At most ${MAX_IMAGES_IN} images a message.`);
    return images.map((raw, i) => {
      const n = i + 1;
      const value = raw.trim();
      let bytes: Buffer;
      let name = `image-${n}`;
      const dataUrl = /^data:image\/[\w+.-]+;base64,(.*)$/is.exec(value);
      if (dataUrl) bytes = fromBase64(dataUrl[1]!, n);
      else if (/^(\/|~[\\/]|[a-z]:[\\/]|\.{1,2}[\\/]|file:)/i.test(value)) {
        if (this.level !== "full")
          return refuse(`Image ${n} is a file path. Below Full access Caveman Code never reads your user's files for you: send it as base64 (data:image/png;base64,...).`);
        const file = realpath(path.resolve(this.bridge.cwd, expandHome(value.replace(/^file:\/\//i, ""))));
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile()) return refuse(`Image ${n}: no file at ${file}.`);
        if (stat.size > IMAGE_BYTES) return refuse(`Image ${n} (${file}) is over 10 MB.`);
        bytes = fs.readFileSync(file);
        name = path.basename(file).replace(/\.[^.]+$/, "") || name;
      } else bytes = fromBase64(value, n);
      if (bytes.length === 0) return refuse(`Image ${n} is empty.`);
      if (bytes.length > IMAGE_BYTES) return refuse(`Image ${n} is over 10 MB.`);
      const mime = sniffImage(bytes) ?? refuse(`Image ${n} isn't a PNG, JPEG, GIF or WebP image.`);
      return { type: "image", name: `${name}.${mime.slice(6).replace("jpeg", "jpg")}`, mime_type: mime, data: bytes.toString("base64") };
    });
  }
}

const expandHome = (p: string) => (p === "~" ? os.homedir() : p.replace(/^~(?=[/\\])/, os.homedir()));
const realpath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function fromBase64(value: string, n: number): Buffer {
  const clean = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return refuse(`Image ${n} is neither base64, a data URL, nor a file path.`);
  return Buffer.from(clean, "base64");
}

/** PNG, JPEG, GIF or WebP, by their bytes. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const at = (i: number, ...values: Array<number>) => values.every((v, j) => bytes[i + j] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

const isNothingToCommit = (error: unknown) =>
  error instanceof SessionProtocolError && /nothing to commit|no changes|nothing added|working tree clean/i.test(error.message);

const ASK_VERB: Record<AskUser["kind"], string> = {
  approval: "approve this",
  secret: "give this secret",
  tool: "answer this custom tool",
  question: "answer grill rounds",
};

export class Bridge {
  readonly tracker = new Tracker();
  readonly cwd: string;
  readonly now: () => number;
  readonly requestId: () => string;
  /** chat_start's duplicate guard: what each recent start's arguments made (or are making). */
  readonly starts = new Map<string, { readonly at: number; readonly chat: Promise<Workspace> }>();
  private readonly options: BridgeOptions;
  private settingsDefault: Promise<string | undefined> | undefined;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.now = options.now ?? Date.now;
    this.requestId = options.requestId ?? randomUUID;
    options.link.onWorkspace((workspace) => this.tracker.observe(workspace));
    // Each socket that becomes this agent's: what changed while it was down reaches chat_wait as transitions.
    options.link.onReady((client) => {
      this.settingsDefault = undefined;
      void client.call("workspace.list", {}).then(
        ({ workspaces }) => workspaces.forEach((w) => this.tracker.observe(w)),
        () => undefined,
      );
    });
  }

  /** The person's default engine from Settings when the gate lets an agent read it; else unknown. */
  defaultEngine(client: AgentClient): Promise<string | undefined> {
    this.settingsDefault ??= client.call("settings.get", {}, { timeoutMs: 5_000 }).then(
      (settings) => settings.default_engine,
      () => undefined,
    );
    return this.settingsDefault;
  }

  async call(tool: string, params: unknown, context: CallContext = {}): Promise<Answer> {
    const definition = TOOLS.find((t) => t.name === tool);
    if (!definition) return { text: `No tool ${tool}. The tools: ${TOOLS.map((t) => t.name).join(", ")}.`, isError: true };
    const name = definition.name;
    const decoded = Schema.decodeUnknownExit(definition.parametersSchema as Schema.Codec<unknown>)(params ?? {}, { onExcessProperty: "ignore" });
    if (decoded._tag === "Failure") {
      const why = clip(oneLine(String(decoded.cause).replace(/^SchemaError:?\s*/i, "")), 600);
      return { text: `Invalid arguments for ${name}: ${why}\nExample: ${EXAMPLES[name]}`, isError: true };
    }
    const acquired = await this.options.link.acquire(agentName(this.options.name, context.clientName));
    if (!acquired.ok) return { text: acquired.text, isError: true };
    const turn = new Turn(this, acquired.session, context);
    try {
      return await HANDLERS[name](turn, decoded.value as never);
    } catch (error) {
      return { text: errorText(error, name, turn), isError: true };
    }
  }
}

/** What went wrong, said as what to do next. */
function errorText(error: unknown, tool: ToolName, turn: Turn): string {
  if (error instanceof Refusal || error instanceof LinkRefused || error instanceof LinkTimeout) return error.message;
  if (error instanceof CallTimeout) return `Caveman Code didn't answer in time; call ${tool} again in a few seconds.`;
  if (error instanceof CallNotSent) return `Couldn't reach Caveman Code; call ${tool} again in a few seconds.`;
  if (error instanceof SessionProtocolError) {
    const message = error.message.replace(/\.$/, "");
    switch (error.error.data?.reason) {
      case "forbidden":
        return [
          `Caveman Code refused this: ${message}.`,
          `Your level is ${LEVEL_LABEL[turn.level]} (${LEVEL_MEANS[turn.level]}). Your user can change it in Caveman Code > Settings > Caveman MCP.`,
        ].join("\n");
      case "not_found":
        return `${message}. chats {} lists what exists.`;
      case "rate_limited": {
        const wait = error.error.data.retry_after_ms;
        return `${message}. Try again${wait ? ` in ${Math.ceil(wait / 1000)} s` : " shortly"}.`;
      }
      case "parked":
        return `${message}. The chat is parked (moved to another computer or asleep); your user sees where in Caveman Code.`;
      case "engine_unavailable":
        return `${message}. engines {} shows which engines are connected.`;
      case "unauthorized":
        return `Lost the connection to Caveman Code (it may have stopped or restarted); call ${tool} again in a few seconds.`;
      case "secret_in_input":
        return `${message}. Never put a credential in a message; the person stores secrets in Caveman Code.`;
      default:
        return `${message}.`;
    }
  }
  if (error instanceof Error && error.message === "client closed") return `Lost the connection to Caveman Code; call ${tool} again.`;
  return `${tool} failed: ${error instanceof Error ? error.message : String(error)}`;
}

type Handler<N extends ToolName> = (turn: Turn, params: ParamsOf<N>) => Promise<Answer>;

const HANDLERS: { readonly [N in ToolName]: Handler<N> } = {
  chats: async (turn, p) => {
    const now = turn.now;
    const labels = await turn.labels();
    const passages = new Map<string, string>();
    let chats: Array<Workspace>;
    if (p.query !== undefined && p.query.trim()) {
      const found = await turn.client.call("chat.search", { query: p.query.slice(0, 500), limit: 100 });
      chats = found.chats.map((hit) => {
        const best = hit.passages[0];
        if (best && best.kind !== "title") passages.set(hit.workspace.id, best.text);
        return hit.workspace;
      });
      chats = chats.filter((w) => w.kind === undefined && (p.archived === true || w.status !== "archived"));
    } else chats = await turn.workspaces(p.archived === true);
    chats = chats.filter((w) => w.automation === undefined);
    let scope = "";
    if (p.project !== undefined) {
      const project = await turn.project(p.project);
      const inRepo = (w: Workspace) => w.project_id === project.id || ("path" in w.repo && w.repo.path === project.path);
      chats = chats.filter(inRepo);
      scope = ` in ${project.name}`;
    }
    const state = p.state;
    const searching = p.query !== undefined && p.query.trim() !== "";
    const all = chats;
    if (state === undefined) chats = searching ? chats : chats.filter((w) => (p.archived === true && w.status === "archived") || shownByDefault(w, now));
    else if (state !== "all") chats = chats.filter((w) => stateOf(w) === state && (state !== "finished" || isUnread(w)));
    const limit = Math.min(Math.max(p.limit ?? 25, 1), 100);
    const shown = chats.slice(0, limit);
    const what = searching ? ` matching "${clip(oneLine(p.query!), 80)}"` : state && state !== "all" ? ` ${state.replace("_", " ")}` : "";
    if (shown.length === 0) {
      const hidden = state === undefined && !searching ? all.length : 0;
      return {
        text: [
          `No chats${what}${scope}.`,
          hidden ? `${hidden} finished chats the person has read are left out: ${call("chats", { state: "all" })}.` : "",
          `Start one: ${call("chat_start", { task: "…" })}`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    const counts = new Map<ChatState, number>();
    for (const w of chats) counts.set(stateOf(w), (counts.get(stateOf(w)) ?? 0) + 1);
    const summary = [...counts].map(([s, n]) => `${s.replace("_", " ")} ${n}`).join(", ");
    const lines = [`${chats.length} chat${chats.length === 1 ? "" : "s"}${what}${scope}${state === undefined && !searching ? " (finished chats the person has read are left out)" : ""}: ${summary}. Newest first:`];
    lines.push(...chatList(shown, labels, now, passages));
    if (chats.length > shown.length) lines.push(`… ${chats.length - shown.length} more: pass limit (up to 100), project, state or query.`);
    lines.push(`Next: ${call("chat_read", { chat: shown[0]!.id })} to read one.`);
    return { text: lines.join("\n") };
  },

  projects: async (turn) => {
    const [labels, defaultEngine] = await Promise.all([turn.labels(), turn.defaultEngine()]);
    const here = await turn.projectHere(labels.projects);
    return { text: projectsText(labels.projects, labels, here?.id, defaultEngine) };
  },

  engines: async (turn) => {
    const [engines, defaultEngine] = await Promise.all([turn.engines(), turn.defaultEngine()]);
    return { text: enginesText(engines, turn.level, defaultEngine) };
  },

  chat_start: async (turn, p) => {
    const access = accessFor(turn.level, turn.name, p.access);
    if (!access.ok) return refuse(access.text);
    if (!p.task.trim()) return refuse(`task is empty: say what the chat should do. Example: ${EXAMPLES.chat_start}`);
    const project = await turn.project(p.project);
    const engines = await turn.engines();
    const ceiling = accessCeiling(turn.level)!;
    const usable = () => engines.filter((e) => isConnected(e) && (turn.level === "full" || engineHonours(e, ceiling))).map((e) => `${e.label} [${e.id}]`).join(", ") || "none";
    let engine: EngineDescriptor | undefined;
    if (p.engine !== undefined) {
      engine = findEngine(engines, p.engine) ?? refuse(`No engine "${p.engine}". You can start chats on: ${usable()}. engines {} has the details.`);
      if (!isConnected(engine)) return refuse(`${engine.label} isn't connected; your user connects it in Caveman Code > Settings. You can start chats on: ${usable()}.`);
      if (turn.level !== "full" && !engineHonours(engine, ceiling))
        return refuse(`${engine.label} doesn't honour "${ceiling}" (it runs without approvals), so at your level (${LEVEL_LABEL[turn.level]}) you can't start chats on it. You can on: ${usable()}.`);
    } else {
      const preferred = await turn.defaultEngine();
      engine = turn.level === "full" && preferred === undefined ? undefined : defaultEngineFor(engines, turn.level, preferred);
      if (engine === undefined && turn.level !== "full")
        return refuse(`No connected engine honours "${ceiling}", so at your level you can't start a chat. engines {} shows them; your user connects engines in Caveman Code > Settings.`);
    }
    if (access.access !== undefined && engine !== undefined && !engineHonours(engine, access.access))
      return refuse(`${engine.label} doesn't honour access "${access.access}"; it honours ${(engine.access_modes ?? []).join(", ")}. Leave access out or pick another engine.`);
    let model: string | undefined;
    if (p.model !== undefined) {
      const known = engine?.models ?? [];
      const found = known.find((m) => m.id === p.model) ?? known.find((m) => m.label.toLowerCase() === p.model!.toLowerCase());
      if (engine && known.length && !found)
        return refuse(`${engine.label} has no model "${p.model}". Its models: ${known.filter((m) => !m.legacy).slice(0, 15).map((m) => m.id).join(", ")}.`);
      model = found?.id ?? p.model;
      if (found && p.effort !== undefined && found.efforts.length && !found.efforts.includes(p.effort))
        return refuse(`${found.id} takes effort ${found.efforts.join(", ")}, not "${p.effort}".`);
    }
    const attachments = turn.attachments(p.images);
    const options: TurnOptions = {
      ...(model !== undefined ? { model } : {}),
      ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(access.access !== undefined ? { access: access.access } : {}),
    };
    // Clients retry a slow call with a new id: the same arguments within 2 minutes get the chat already started.
    const key = createHash("sha256")
      .update(JSON.stringify([project.id, p.task, engine?.id ?? null, options, p.title ?? null, attachments.map((a) => createHash("sha256").update(a.data).digest("hex"))]))
      .digest("hex");
    const bridge = turn.bridge;
    for (const [k, start] of bridge.starts) if (turn.now - start.at > DUPLICATE_MS) bridge.starts.delete(k);
    const earlier = bridge.starts.get(key);
    if (earlier) {
      const w = await earlier.chat;
      const d = await turn.digest(w.id).catch(() => undefined);
      const labels = await turn.labels();
      return {
        text: [
          `You started this chat ${((age) => (age ? `${age} ago` : "just now"))(ago(new Date(earlier.at).toISOString(), turn.now))} with the same arguments, so this is that chat, not a new one.`,
          d ? digestText(d, { labels, now: turn.now }) : chatRef(w, labels, turn.now),
        ].join("\n"),
      };
    }
    const chat = turn.client.call("workspace.create", {
      request_id: turn.requestId(),
      repo: { path: project.path },
      ...(p.title !== undefined && p.title.trim() ? { title: p.title.trim() } : {}),
      ...(engine !== undefined ? { engine: engine.id } : {}),
      task: { text: p.task, ...(attachments.length ? { attachments } : {}) },
      ...(Object.keys(options).length ? { options } : {}),
    });
    bridge.starts.set(key, { at: turn.now, chat });
    let w: Workspace;
    try {
      w = await chat;
    } catch (error) {
      bridge.starts.delete(key);
      throw error;
    }
    turn.tracker.observe(w);
    turn.tracker.acted(w.id, "started");
    const labels = await turn.labels();
    const d = await turn.digest(w.id).catch(() => undefined);
    const ran = access.access ?? d?.options?.access;
    return {
      text: [
        `Started [${w.id}] in ${project.name} on ${engineLabel(engine?.id ?? w.engine, labels)}${ran ? `, access ${ran} (${ACCESS_LABEL[ran]})` : ""}. It works on its own; ${call("chat_wait", { chats: [w.id] })} returns when it finishes or asks something.`,
        d ? digestText(d, { labels, now: turn.now }) : chatRef(w, labels, turn.now),
      ].join("\n"),
    };
  },

  chat_send: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const attachments = turn.attachments(p.images);
    if (!p.text.trim() && attachments.length === 0) return refuse(`text is empty. Example: ${EXAMPLES.chat_send}`);
    const state = stateOf(w);
    const asking = w.status === "needs_input";
    const mode = p.mode ?? "auto";
    // A message to a chat that waits on the person is queued: it never cancels their wait.
    const kind = asking || mode === "queue" ? "queue" : mode === "steer" ? "steer" : state === "working" ? "queue" : "followup";
    const options: TurnOptions = { ...(p.model !== undefined ? { model: p.model } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}) };
    const result = await turn.client.call("turn.submit", {
      request_id: turn.requestId(),
      session_id: w.session_id,
      kind,
      input: { text: p.text, ...(attachments.length ? { attachments } : {}) },
      ...(Object.keys(options).length ? { options } : {}),
    });
    turn.tracker.acted(w.id, "messaged");
    const title = `[${w.id}] ${oneLine(w.title)}`;
    const lines = [
      result.disposition === "started"
        ? `Sent: ${title} started a turn on it.`
        : result.disposition === "steered"
          ? `Sent into the running turn of ${title}.`
          : `Queued for ${title}: it runs when the current turn ends.`,
    ];
    if (asking && mode !== "queue") {
      const prompt = w.activity?.ask?.prompt;
      lines.push(
        state === "can_answer"
          ? `It waits on a question${prompt ? ` ("${clip(oneLine(prompt), 120)}")` : ""}, so your message waits behind it. To answer it: ${call("chat_read", { chat: w.id })} shows the card, then chat_answer.`
          : `It waits for the person${prompt ? ` (${clip(oneLine(prompt), 120)})` : ""}, so your message waits behind that and doesn't cancel it. ${tellYourUserShort(w)}`,
      );
    }
    lines.push(`Next: ${call("chat_wait", { chats: [w.id] })}`);
    return { text: lines.join("\n") };
  },

  chat_read: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const view = p.view ?? "digest";
    const labels = await turn.labels();
    if (view === "digest") return { text: digestText(await turn.digest(w.id), { labels, now: turn.now }) };
    if (view === "transcript") {
      const d = await turn.digest(w.id, { ...(p.before !== undefined ? { before: p.before } : {}), max_bytes: PAGE_BYTES });
      if (!d.transcript) return refuse("This Caveman Code can't page transcripts for outside agents yet; tell your user to update it.");
      const page = transcriptPage(d.transcript.events, d.transcript.from, d.transcript.more, { chatId: w.id, limit: p.limit });
      const head = d.workspace.head;
      const range = page.from !== undefined ? `from cursor ${page.from}${p.before !== undefined ? ` to before ${p.before}` : head !== undefined ? ` to ${head}` : ""}` : "";
      if (!page.text) return { text: `[${w.id}] ${oneLine(w.title)}: nothing to show${p.before !== undefined ? ` before cursor ${p.before}` : ""}.${page.more && page.from !== undefined ? ` Earlier: ${call("chat_read", { chat: w.id, view: "transcript", before: page.from })}` : ""}` };
      return {
        text: [
          `Transcript of [${w.id}] ${oneLine(w.title)}, ${range}${p.before === undefined ? " (the newest page)" : ""}:`,
          page.text,
          page.more && page.from !== undefined ? `(earlier: ${call("chat_read", { chat: w.id, view: "transcript", before: page.from })})` : "(the start of the chat)",
        ].join("\n"),
      };
    }
    // images: the image items of the newest pages, newest first, read through media.read when they are files, each at
    // most 1568 px a side (images.ts).
    const want = Math.min(Math.max(p.limit ?? 3, 1), 8);
    const refs: Array<ImageRef> = [];
    let before = p.before;
    let pages = 0;
    let more = true;
    while (refs.length < want && more && pages < 6) {
      const d = await turn.digest(w.id, { ...(before !== undefined ? { before } : {}), max_bytes: PAGE_BYTES });
      if (!d.transcript) return refuse("This Caveman Code can't page transcripts for outside agents yet; tell your user to update it.");
      pages++;
      refs.push(...imageRefs(d.transcript.events));
      more = d.transcript.more && d.transcript.events.length > 0;
      before = d.transcript.from;
    }
    // A step's images share its cursor and `before` resumes only at a cursor, so an answer shows whole steps and the
    // next starts at the first one it left out; else images past `want` on the last page read could never be reached.
    const steps: Array<Array<ImageRef>> = [];
    for (const ref of refs) {
      const last = steps.at(-1);
      if (last !== undefined && last[0]!.cursor === ref.cursor) last.push(ref);
      else steps.push([ref]);
    }
    const images: Array<{ mime: string; data: string; label: string; cursor: number }> = [];
    let unreadable = 0;
    let tooLarge = 0;
    let resume: number | undefined;
    let leftOut: { readonly cursor: number; readonly count: number } | undefined;
    for (const step of steps) {
      const cursor = step[0]!.cursor;
      if (images.length > 0 && images.length + step.length > want) {
        resume = cursor + 1;
        break;
      }
      for (const [i, ref] of step.entries()) {
        // Only a step alone holding more than `want`.
        if (images.length >= want) {
          leftOut = { cursor, count: step.length - i };
          break;
        }
        if (ref.kind === "withheld") {
          tooLarge++;
          continue;
        }
        let bytes: Buffer | undefined;
        if (ref.kind === "inline") {
          if (ref.data.length * 0.75 > IMAGE_BYTES) {
            tooLarge++;
            continue;
          }
          bytes = Buffer.from(ref.data, "base64");
        } else {
          const read = await turn.client.call("media.read", { workspace_id: w.id, path: ref.path }).catch(() => undefined);
          if (read && RASTER.test(read.mime_type) && read.size <= IMAGE_BYTES) bytes = Buffer.from(read.data, "base64");
        }
        const mime = bytes && sniffImage(bytes);
        const fitted = bytes && mime ? fitImage(bytes, mime) : "unreadable";
        if (fitted === "unreadable") unreadable++;
        else if (fitted === "too_large") tooLarge++;
        else images.push({ ...fitted, label: ref.label, cursor });
      }
    }
    const next = resume ?? (more ? before : undefined);
    const earlier = next !== undefined ? ` Earlier: ${call("chat_read", { chat: w.id, view: "images", before: next })}` : "";
    const notShown = leftOut
      ? `(${leftOut.count} more image${leftOut.count === 1 ? "" : "s"} at cursor ${leftOut.cursor} not shown${want < 8 ? `: ${call("chat_read", { chat: w.id, view: "images", before: leftOut.cursor + 1, limit: 8 })}` : ""})`
      : undefined;
    if (images.length === 0)
      return { text: `[${w.id}] ${oneLine(w.title)} has no screenshots or attached images${p.before !== undefined ? ` before cursor ${p.before}` : " in its recent transcript"}${unreadable ? ` (${unreadable} could not be read)` : ""}${tooLarge ? ` (${tooLarge} too large to show)` : ""}.${earlier}` };
    return {
      text: [
        `[${w.id}] ${oneLine(w.title)}: ${images.length} image${images.length === 1 ? "" : "s"}, newest first:`,
        ...images.map((image, i) => `${i + 1}. ${clip(oneLine(image.label), 120)} (cursor ${image.cursor})`),
        ...(unreadable ? [`(${unreadable} more could not be read)`] : []),
        ...(tooLarge ? [`(${tooLarge} more too large to show)`] : []),
        ...(notShown ? [notShown] : []),
        ...(earlier ? [earlier.trim()] : []),
      ].join("\n"),
      images: images.map(({ mime, data }) => ({ mime, data })),
    };
  },

  chat_wait: async (turn, p) => {
    const most = isCodexClient(turn.context.clientName) ? 55 : 110;
    const asked = p.timeout_s;
    const seconds = Math.round(Math.min(Math.max(asked ?? WAIT_DEFAULT_S, 1), most));
    const clamped = asked !== undefined && Math.round(asked) !== seconds ? ` (timeout_s ${asked} is outside 1–${most} s; waited ${seconds} s)` : "";
    const ids = new Set<string>();
    if (p.chats?.length) for (const ref of p.chats) ids.add((await turn.chat(ref)).id);
    else for (const id of turn.tracker.touched) ids.add(id);
    if (ids.size === 0)
      return refuse(
        `Nothing to wait for: you haven't started, messaged or answered a chat in this session. Pass chats: ${call("chat_wait", { chats: [EXAMPLE_CHAT] })}; chats {} lists them.`,
      );
    // A fresh look first, so a change made while nothing listened is still news.
    await turn.workspaces().catch(() => undefined);
    const changes = await turn.tracker.wait(ids, seconds * 1000, turn.context.signal ? { signal: turn.context.signal } : {});
    const labels = await turn.labels();
    const lines: Array<string> = [];
    if (changes.length === 0) lines.push(`No change in ${seconds} s${clamped}.`);
    else for (const change of changes) lines.push(...(await changeLines(turn, change, labels)));
    const reported = new Set(changes.map((c) => c.chatId));
    const working: Array<string> = [];
    const person: Array<string> = [];
    for (const id of ids) {
      const w = turn.tracker.get(id);
      if (!w || reported.has(id)) continue;
      const state = stateOf(w);
      if (state === "working") working.push(`[${w.id}] ${oneLine(w.title)} · ${stateWords(w, turn.now)}`);
      else if (state === "needs_you") person.push(`[${w.id}] ${oneLine(w.title)} · ${stateWords(w, turn.now)}`);
    }
    if (working.length) lines.push(`Still working: ${working.join("; ")}.`);
    if (person.length) lines.push(`Still waiting for the person: ${person.join("; ")}.`);
    if (changes.length === 0 || working.length) lines.push(`Call ${call("chat_wait", p.chats?.length ? { chats: [...ids] } : {})} again.`);
    return { text: lines.join("\n") };
  },

  chat_answer: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const d = await turn.digest(w.id);
    const title = `[${w.id}] ${oneLine(w.title)}`;
    if (!d.ask) {
      if (p.ask_id !== undefined) return refuse(`Ask ${p.ask_id} was already answered (or ended). ${title} ${stateWords(d.workspace, turn.now, d.since)}. Next: ${nextFor(d)}`);
      return refuse(`${title} has no open question; it ${stateWords(d.workspace, turn.now, d.since)}. Next: ${nextFor(d)}`);
    }
    const { ask_id, ask } = d.ask;
    if (personOnly(ask)) return refuse(`Only the person can ${ASK_VERB[ask.kind]} (${personAsk(ask)}). ${tellYourUser(w)}`);
    const card = ask as QuestionCard;
    if (p.ask_id !== undefined && !askMatches(p.ask_id, ask_id))
      return refuse([`Ask ${p.ask_id} was already answered; ${title} now asks:`, ...askCard(ask_id, card), `Next: ${answerExample(w.id, ask_id, card)}`].join("\n"));
    const given = p.answers ?? [];
    if (given.length === 0 && p.recommended !== true)
      return refuse([`Pass answers, or recommended: true. The card:`, ...askCard(ask_id, card), `Example: ${answerExample(w.id, ask_id, card)}`].join("\n"));
    const questionFor = (ref: string | undefined) => {
      if (ref === undefined) {
        if (card.questions.length === 1) return card.questions[0]!;
        return refuse(`This card has ${card.questions.length} questions: name each answer's question (${card.questions.map((q) => q.id).join(", ")}).`);
      }
      const key = ref.trim().toLowerCase();
      return (
        card.questions.find((q) => q.id.toLowerCase() === key || q.prompt.trim().toLowerCase() === key || q.header?.trim().toLowerCase() === key) ??
        refuse(`No question "${ref}" on this card. Its questions: ${card.questions.map((q) => `${q.id} "${clip(oneLine(q.prompt), 80)}"`).join(", ")}.`)
      );
    };
    const byQuestion = new Map<string, (typeof given)[number]>();
    for (const answer of given) {
      const q = questionFor(answer.question);
      if (byQuestion.has(q.id)) return refuse(`Two answers for ${q.id}: give one per question.`);
      byQuestion.set(q.id, answer);
    }
    const summary: Array<string> = [];
    const answers = card.questions.map((q) => {
      const answer = byQuestion.get(q.id);
      const options = () => q.options.map((o) => `[${o.id}] ${oneLine(o.label)}`).join(" ");
      if (answer === undefined) {
        if (p.recommended !== true) return refuse(`Answer ${q.id} ("${clip(oneLine(q.prompt), 80)}") too, or pass recommended: true for the rest. Its options: ${options() || "words only"}.`);
        if (q.recommended === undefined) return refuse(`${q.id} ("${clip(oneLine(q.prompt), 80)}") has no recommended option: answer it yourself. Its options: ${options() || "words only"}.`);
        summary.push(`${q.id} → ${q.options.find((o) => o.id === q.recommended)?.label ?? q.recommended} (recommended)`);
        return { question_id: q.id, option_ids: [q.recommended] };
      }
      const picks = (answer.pick ?? []).map((pick) => {
        const key = pick.trim().toLowerCase();
        const option = q.options.find((o) => o.id.toLowerCase() === key) ?? q.options.find((o) => o.label.trim().toLowerCase() === key);
        return option ?? refuse(`"${pick}" isn't an option of ${q.id}. Its options: ${options() || "none (answer with text)"}.`);
      });
      if (!q.multi_select && picks.length > 1) return refuse(`${q.id} takes one pick, not ${picks.length}.`);
      const text = answer.text?.trim();
      if (text && !q.allow_text) return refuse(`${q.id} takes no words: pick from ${options()}.`);
      if (picks.length === 0 && !text) return refuse(`The answer for ${q.id} has neither a pick nor text. Its options: ${options() || "words only"}.`);
      summary.push(`${q.id} → ${[...picks.map((o) => o.label), ...(text ? [`"${clip(oneLine(text), 80)}"`] : [])].join(", ")}`);
      return { question_id: q.id, option_ids: picks.map((o) => o.id), ...(text ? { text } : {}) };
    });
    try {
      await turn.client.call("ask.respond", { request_id: turn.requestId(), session_id: w.session_id, ask_id, response: { kind: "question", answers } });
    } catch (error) {
      if (error instanceof SessionProtocolError && error.error.data?.reason === "invalid_state")
        return refuse(`Ask ${ask_id} was already answered (or ended): ${error.message}. ${call("chat_read", { chat: w.id })} shows where it stands.`);
      throw error;
    }
    turn.tracker.acted(w.id, "answered");
    return {
      text: [
        `Answered ${title}: ${summary.join("; ")}. The transcript marks it as answered by ${turn.name}, an outside agent. It carries on.`,
        `Next: ${call("chat_wait", { chats: [w.id] })}`,
      ].join("\n"),
    };
  },

  chat_stop: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const result = await turn.client.call("turn.interrupt", { request_id: turn.requestId(), session_id: w.session_id });
    const title = `[${w.id}] ${oneLine(w.title)}`;
    return {
      text: result.turn_id
        ? `Stopped ${title}'s running turn (and the agents it delegated to). Messages queued behind it wait for the next one. Next: ${call("chat_read", { chat: w.id })}`
        : `${title} had no running turn; any agents it delegated to that were still working are stopped.`,
    };
  },

  chat_diff: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const title = `[${w.id}] ${oneLine(w.title)}`;
    let file: string | undefined;
    if (p.path !== undefined) {
      file = p.path.trim().replace(/^\.\//, "");
      if (path.isAbsolute(file)) {
        const root = w.root_path;
        // Lexically: the command reads nothing of the person's for an agent to place a path.
        const relative = root ? path.relative(root, path.resolve(file)) : "..";
        if (!root || relative.startsWith("..") || path.isAbsolute(relative)) return refuse(`${p.path} is outside ${title}'s worktree${root ? ` (${root})` : ""}: pass a path inside it, relative to its root.`);
        file = relative.split(path.sep).join("/");
      }
      if (!file || file.split("/").includes("..")) return refuse(`Pass path relative to the chat's worktree root, e.g. "src/index.ts".`);
    }
    let to: string | undefined;
    let scope = p.scope === "latest_turn" ? "in the latest finished turn" : `against ${w.base_ref || "its base"}`;
    if (p.scope === "latest_turn") {
      const d = await turn.digest(w.id);
      if (d.checkpoint_id !== undefined) to = d.checkpoint_id;
      else if (file === undefined) {
        const files = d.files ?? [];
        return {
          text: files.length
            ? [`${title} · the latest finished turn changed (already kept or undone, so no patches; ${call("chat_diff", { chat: w.id })} for everything):`, ...diffFiles(files)].join("\n")
            : `${title}: the latest finished turn changed no files.`,
        };
      } else scope = `against ${w.base_ref || "its base"} (the latest turn's changes were already kept or undone)`;
    }
    const diff = await turn.client.call("fs.diff", { workspace_id: w.id, ...(to !== undefined ? { to } : {}), ...(file !== undefined ? { paths: [file] } : {}) });
    if (file !== undefined) {
      const change = diff.files.find((f) => f.path === file || f.old_path === file);
      if (!change) return { text: `No changes to ${file} ${scope}. ${call("chat_diff", { chat: w.id })} lists the changed files.` };
      const bytes = Buffer.byteLength(change.patch);
      const patch = bytes > PATCH_BYTES ? `${Buffer.from(change.patch).subarray(0, PATCH_BYTES).toString("utf8")}\n(cut at 24 KB of ${Math.round(bytes / 1024)} KB)` : change.patch;
      return { text: [`${title} · ${diffFiles([change])[0]} ${scope}:`, patch || "(binary or empty)"].join("\n") };
    }
    if (diff.files.length === 0) return { text: `${title}: no changes ${scope}.` };
    const added = diff.files.reduce((n, f) => n + f.additions, 0);
    const removed = diff.files.reduce((n, f) => n + f.deletions, 0);
    return {
      text: [
        `${title} · ${diff.files.length} file${diff.files.length === 1 ? "" : "s"} changed ${scope}, +${added} −${removed}:`,
        ...diffFiles(diff.files.slice(0, 200)),
        ...(diff.files.length > 200 ? [`… and ${diff.files.length - 200} more`] : []),
        `Next: ${call("chat_diff", { chat: w.id, ...(p.scope ? { scope: p.scope } : {}), path: diff.files[0]!.path })} for a file's patch.`,
      ].join("\n"),
    };
  },

  chat_undo: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const d = await turn.digest(w.id);
    const title = `[${w.id}] ${oneLine(w.title)}`;
    if (d.checkpoint_id === undefined) return { text: `Nothing to undo: ${title}'s latest finished turn has no changes left to put back.` };
    const result = await turn.client.call("checkpoint.undo", { request_id: turn.requestId(), session_id: w.session_id, checkpoint_id: d.checkpoint_id });
    const files = result.files;
    return {
      text: files.length
        ? `Put back ${files.length} file${files.length === 1 ? "" : "s"} in ${title}: ${files.slice(0, 20).join(", ")}${files.length > 20 ? ", …" : ""}. The transcript stays.`
        : `${title}: nothing needed putting back.`,
    };
  },

  chat_organize: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const title = `[${w.id}] ${oneLine(w.title)}`;
    switch (p.action) {
      case "rename": {
        const next = p.title?.trim();
        if (!next) return refuse(`rename needs title. Example: ${call("chat_organize", { chat: w.id, action: "rename", title: "…" })}`);
        await turn.client.call("workspace.rename", { request_id: turn.requestId(), workspace_id: w.id, title: next });
        return { text: `Renamed [${w.id}] to "${next}".` };
      }
      case "archive":
        await turn.client.call("workspace.archive", { request_id: turn.requestId(), workspace_id: w.id });
        return { text: `Archived ${title}. Your user can restore it in Caveman Code.` };
      case "mark_done":
        await turn.client.call("workspace.inbox", { request_id: turn.requestId(), workspace_id: w.id, action: { do: "done" } });
        return { text: `Marked ${title} done in the person's inbox. Its next message reopens it.` };
    }
  },

  chat_ship: async (turn, p) => {
    const w = await turn.chat(p.chat);
    const title = `[${w.id}] ${oneLine(w.title)}`;
    if (p.commit === undefined && p.pr === undefined) return refuse(`Pass commit (a message), pr ({title, body?}) or both. Example: ${call("chat_ship", { chat: w.id, pr: { title: "…" } })}`);
    if (p.pr !== undefined && !p.pr.title.trim()) return refuse("pr.title is empty.");
    const message = (p.commit ?? p.pr!.title).trim();
    if (!message) return refuse("The commit message is empty.");
    let sha: string | undefined;
    try {
      sha = (await turn.client.call("git.commit", { request_id: turn.requestId(), workspace_id: w.id, message }, { timeoutMs: COMMIT_TIMEOUT_MS })).sha;
    } catch (error) {
      if (!(p.pr !== undefined && isNothingToCommit(error))) {
        if (isNothingToCommit(error)) return refuse(`${title} has nothing to commit.`);
        throw error;
      }
    }
    const short = sha?.slice(0, 7);
    if (p.pr === undefined) return { text: `Committed ${short} in ${title}: "${firstLine(message)}". Next: ${call("chat_ship", { chat: w.id, pr: { title: "…" } })} to push and open a pull request.` };
    const pushed = await turn.client.call("git.push", { request_id: turn.requestId(), workspace_id: w.id }, { timeoutMs: 300_000 });
    const did = `${short ? `Committed ${short}, pushed` : "Pushed"} ${pushed.branch}`;
    const open = w.pull_request && (w.pull_request.state === "open" || w.pull_request.state === "draft") ? w.pull_request : undefined;
    if (open) return { text: `${did} to its pull request #${open.number}: ${open.url}` };
    const pr = await turn.client.call(
      "git.pr",
      { request_id: turn.requestId(), workspace_id: w.id, title: p.pr.title.trim(), ...(p.pr.body !== undefined ? { body: p.pr.body } : {}) },
      { timeoutMs: 300_000 },
    );
    return { text: `${did} and opened pull request #${pr.number}${pr.state === "draft" ? " (draft)" : ""}: ${pr.url}` };
  },

  project_add: async (turn, p) => {
    const given = [p.path, p.url].filter((v) => v !== undefined && v.trim() !== "");
    if (given.length !== 1) return refuse(`Pass path (a folder inside a repository on this computer) or url (a git URL or owner/name), one of them. Example: ${EXAMPLES.project_add}`);
    const where = p.path !== undefined && p.path.trim() ? { path: path.resolve(turn.bridge.cwd, expandHome(p.path.trim())) } : { url: p.url!.trim() };
    const project = await turn.client.call(
      "project.create",
      { request_id: turn.requestId(), ...where, ...(p.name !== undefined && p.name.trim() ? { name: p.name.trim() } : {}) },
      { timeoutMs: 300_000 },
    );
    return {
      text: `Added project ${project.name} [${project.id}] at ${project.path}${project.repository ? ` (${project.repository.full_name})` : ""}. Start a chat: ${call("chat_start", { project: project.name, task: "…" })}`,
    };
  },
};

const tellYourUserShort = (w: Workspace) => `Tell your user: "${oneLine(w.title) || "A chat"} waits for you in Caveman Code".`;

/** One reported change, with what the agent needs to act on it. */
async function changeLines(turn: Turn, change: Change, labels: Labels): Promise<Array<string>> {
  const w = turn.tracker.get(change.chatId);
  if (!w) return [];
  const title = `[${w.id}] ${oneLine(w.title)} (${projectLabel(w, labels)})`;
  switch (change.kind) {
    case "answered":
      return [`${title} · the person answered what it asked; it carries on.`];
    case "pr": {
      const pr = w.pull_request;
      return [`${title} · pull request #${change.pr}${pr ? ` ${pr.state}: ${pr.url}` : ""}`];
    }
    default: {
      const d = await turn.digest(w.id).catch(() => undefined);
      const now = d?.workspace ?? w;
      if (change.kind === "finished") {
        const latest = d?.latest ? `\n  Latest: ${clip(oneLine(d.latest), 600)}` : "";
        const stopped = now.activity?.last_outcome === "interrupted" ? " (stopped)" : "";
        return [`${title} · finished${stopped}.${latest}`, `  Next: ${d ? nextFor(d) : call("chat_read", { chat: w.id })}`];
      }
      if (change.kind === "failed") return [`${title} · failed${d?.error ? `: ${clip(oneLine(d.error), 400)}` : "."}`, `  Next: ${d ? nextFor(d) : call("chat_read", { chat: w.id, view: "transcript" })}`];
      // asking
      if (d?.ask && !personOnly(d.ask.ask)) {
        const card = d.ask.ask as QuestionCard;
        return [`${title} · asks a question you can answer:`, ...askCard(d.ask.ask_id, card).map((line) => `  ${line}`), `  Next: ${answerExample(w.id, d.ask.ask_id, card)}`];
      }
      if (d?.ask) return [`${title} · waits for the person in Caveman Code: ${personAsk(d.ask.ask)}.`, `  ${tellYourUser(w)}`];
      const prompt = now.activity?.ask?.prompt;
      return [`${title} · asks something${prompt ? `: "${clip(oneLine(prompt), 200)}"` : ""}.`, `  Next: ${call("chat_read", { chat: w.id })}`];
    }
  }
}
