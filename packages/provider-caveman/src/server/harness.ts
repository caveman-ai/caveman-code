/**
 * The Caveman engine is the Caveman harness (`@caveman-ai/harness`, v4; `vendor/`): the loop, surfaces and policy
 * measured against Claude Code and Codex, run in process. The adapter keeps everything a session is in the app (keys
 * and sign-ins, the egress scrub, the journal, approvals, steering, items, Auto); this module is what the harness
 * needs from the app and what the app needs from the harness:
 *
 * - names: the harness's tools (read, edit, write, bash, program on the compact surface; exec and its nested
 *   exec_command, apply_patch on Codex's) under the names the app's approvals, items and plugin hooks already know
 *   (the classic engine's: read_file, edit_file, write_file, bash, `mcp__<server>__<tool>`);
 * - the workspace's file rules, as an ExecEnv around the env the commands run in (this computer's, or a Cloud
 *   computer's tools container: toolsEnv.ts's env streamed over the runtime's exec channel, or the execution backend):
 *   reads and writes stay in the workspace (reads anywhere on a full-access turn), hidden paths are refused, and
 *   memory's copy is the one directory outside it, read and written on the runtime's own disk, its writes handed to
 *   the runtime;
 * - the conversation checkpoint each engine run leaves in the journal directory;
 * - the MCP servers as the harness connects them, and skills as a `load_skill` tool with the skills index.
 *
 * @module provider-caveman/server/harness
 */
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type * as Harness from "@caveman-ai/harness";
import type { AgentEnvironment } from "@caveman-ai/agent/plugins";
import { MEMORY_ROOT, type MemoryCopyWrite } from "@caveman-app/engine-core/server/SessionPlugins";
import type { IgnoreMatcher } from "@caveman-app/shared/ignorePaths";

import type { CavemanEngine } from "./engine.ts";

let loading: Promise<typeof Harness> | undefined;

/** The harness's module: imported on the first session that runs it, shared after. */
export const loadHarness = (): Promise<typeof Harness> => (loading ??= import("@caveman-ai/harness"));

// ── names ─────────────────────────────────────────────────────

/** An MCP tool as the classic engine named it (`mcp__<server>__<tool>`, non-word characters as `_`): approvals and the web know it. */
export const classicMcpName = (server: string, tool: string): string => `mcp__${server.replace(/\W/g, "_")}__${tool.replace(/\W/g, "_")}`;

/** The classic engine's effects (approvals.ts): what a call does decides whether it asks. */
export type HarnessEffect = "read" | "write" | "external";

const READS: ReadonlySet<string> = new Set(["read", "wait", "program", "exec", "view_image", "load_skill"]);
const WRITES: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"]);
const COMMANDS: ReadonlySet<string> = new Set(["bash", "exec_command", "write_stdin"]);

/**
 * A call as the app's approvals see it: its classic name and its effect. Programs and exec cells never ask
 * themselves; each call they make does. MCP tools are outside tools (the runtime's own are exempted by name there).
 */
export function callPolicy(call: { readonly name: string; readonly mcp?: { readonly server: string; readonly tool: string } | undefined }): { readonly name: string; readonly effect: HarnessEffect } {
  if (call.mcp !== undefined) return { name: classicMcpName(call.mcp.server, call.mcp.tool), effect: "external" };
  if (READS.has(call.name)) return { name: call.name, effect: "read" };
  if (WRITES.has(call.name)) return { name: call.name === "write" ? "write_file" : "edit_file", effect: "write" };
  if (COMMANDS.has(call.name)) return { name: "bash", effect: "external" };
  // A tool the host declared itself and did not name as MCP (load_skill is a read above): ask as an outside tool.
  return { name: call.name, effect: "external" };
}

/** Plugin hooks match Claude Code's names through the classic engine's (runtime plugins/hooks.ts): the same tool, the same name. */
export function hookCall(name: string, args: unknown): { readonly name: string; readonly input: unknown } | undefined {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "bash":
      return { name: "bash", input: { command: record.command } };
    case "exec_command":
      return { name: "bash", input: { command: record.cmd, ...(record.workdir === undefined ? {} : { workdir: record.workdir }) } };
    case "read":
      return { name: "read_file", input: record };
    case "write":
      return { name: "write_file", input: record };
    case "edit": {
      const edits = Array.isArray(record.edits) ? record.edits as Array<Record<string, unknown>> : undefined;
      const first = edits?.[0];
      return { name: "edit_file", input: { path: record.path, old_string: first?.oldText ?? record.old_string, new_string: first?.newText ?? record.new_string } };
    }
    case "apply_patch":
      return { name: "edit_file", input: { path: patchFiles(patchText(args))[0]?.path, patch: patchText(args) } };
    case "load_skill":
      return { name: "load_skill", input: record };
    default:
      return undefined;
  }
}

/** apply_patch's patch: the freeform input as a string, or `{input}`. */
export const patchText = (args: unknown): string =>
  typeof args === "string" ? args : typeof (args as { input?: unknown } | null)?.input === "string" ? (args as { input: string }).input : "";

export interface PatchFile {
  readonly path: string;
  readonly kind: "add" | "update" | "delete";
  readonly oldStr: string;
  readonly newStr: string;
}

/** The files a Codex patch touches, each with the text it removes and the text it adds (context lines in both). */
export function patchFiles(patch: string): PatchFile[] {
  const files: Array<{ path: string; kind: PatchFile["kind"]; old: string[]; new: string[] }> = [];
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header !== null) {
      files.push({ path: header[2]!.trim(), kind: header[1]!.toLowerCase() as PatchFile["kind"], old: [], new: [] });
      continue;
    }
    const file = files.at(-1);
    if (file === undefined || line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) file.new.push(line.slice(1));
    else if (line.startsWith("-")) file.old.push(line.slice(1));
    else if (line.startsWith(" ")) {
      file.old.push(line.slice(1));
      file.new.push(line.slice(1));
    }
  }
  return files.map((file) => ({ path: file.path, kind: file.kind, oldStr: file.old.join("\n"), newStr: file.new.join("\n") }));
}

/** A transcript item for a harness call: the tool name and arguments the adapter's item mapping reads (bash, write_file, edit_file). */
export function itemCall(name: string, args: unknown, mcp?: { readonly server: string; readonly tool: string }): { readonly toolName: string; readonly args: unknown } {
  if (mcp !== undefined) return { toolName: classicMcpName(mcp.server, mcp.tool), args };
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "bash":
      return { toolName: "bash", args: { command: record.command } };
    case "exec_command":
      return { toolName: "bash", args: { command: record.cmd } };
    case "write":
      return { toolName: "write_file", args: { path: record.path, content: record.content } };
    case "edit": {
      const edits = Array.isArray(record.edits)
        ? (record.edits as Array<Record<string, unknown>>).map((edit) => ({ old_string: edit.oldText ?? edit.old_string, new_string: edit.newText ?? edit.new_string }))
        : [{ old_string: record.oldText ?? record.old_string, new_string: record.newText ?? record.new_string }];
      return { toolName: "edit_file", args: { path: record.path ?? record.file_path, edits } };
    }
    case "read":
      return { toolName: "read_file", args };
    case "exec":
      return { toolName: "exec", args: { code: patchText(args) || record.code } };
    default:
      return { toolName: name, args };
  }
}

/** A nested call's result as transcript text: a command's output led by `exit <code>` (as the classic bash was). */
export function nestedResultText(name: string, result: unknown): string {
  const record = (typeof result === "object" && result !== null ? result : undefined) as Record<string, unknown> | undefined;
  if ((name === "bash" || name === "exec_command") && record !== undefined) {
    const code = typeof record.exit_code === "number" ? record.exit_code : undefined;
    const output = typeof record.output === "string" ? record.output : "";
    return code === undefined ? output : `exit ${code}\n${output}`;
  }
  if (typeof result === "string") return result;
  const content = record?.content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return JSON.stringify(result) ?? "";
}

// ── the workspace ─────────────────────────────────────────────

export interface WorkspaceRules {
  readonly root: string;
  readonly hidden: IgnoreMatcher | null;
  /** A full-access turn on this computer: reads may leave the workspace (writes never do). */
  readonly readAnywhere: boolean;
  readonly memory?: { readonly dir: string; readonly onWrite?: ((write: MemoryCopyWrite) => string | undefined) | undefined } | undefined;
}

const refusal = (message: string, code = "EACCES") => Object.assign(new Error(message), { code });

/**
 * The workspace's file rules around an env: the harness's read, edit and write (and a program's) go through readFile
 * and writeFile, so the rules hold for every one of them. Commands are not paths: bash reads what it can (the UI
 * promises "hidden from search and file tools"). Memory's copy is the runtime's own directory, read and written here
 * even when the env is a Cloud computer's tools container.
 */
export class WorkspaceEnv implements Harness.ExecEnv {
  readonly #base: Harness.ExecEnv;
  readonly #rules: WorkspaceRules;
  /** Mutable: the turn's access mode decides it (rules.readAnywhere is the session's start). */
  readAnywhere: boolean;

  constructor(base: Harness.ExecEnv, rules: WorkspaceRules) {
    this.#base = base;
    this.#rules = rules;
    this.readAnywhere = rules.readAnywhere;
  }

  get id() {
    return this.#base.id;
  }
  get cwd() {
    return this.#base.cwd;
  }
  get user() {
    return this.#base.user;
  }
  get os() {
    return this.#base.os;
  }
  /** Which shell runs commands, where the model needs telling (Windows: Git Bash). */
  get shellNote() {
    return this.#base.shellNote;
  }

  /** The path a file call reaches, or a refusal saying why not. `memory`: it is in memory's copy. */
  #target(path: string, write: boolean): { readonly full: string; readonly memory: boolean } {
    const { root, hidden, memory } = this.#rules;
    if (memory !== undefined && (path === MEMORY_ROOT || path.startsWith(`${MEMORY_ROOT}/`))) {
      const full = NodePath.join(memory.dir, path.slice(MEMORY_ROOT.length));
      const relative = NodePath.relative(memory.dir, full);
      if (relative.startsWith("..") || NodePath.isAbsolute(relative)) throw refusal(`${path}: outside ${MEMORY_ROOT}`);
      return { full, memory: true };
    }
    const full = NodePath.resolve(root, path);
    if (memory !== undefined) {
      const relative = NodePath.relative(memory.dir, full);
      if (relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative)) return { full, memory: true };
    }
    const relative = NodePath.relative(root, full);
    const inside = relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
    if (inside) {
      const posix = relative.split(NodePath.sep).join("/");
      if (posix !== "" && hidden !== null && hidden(posix)) throw refusal(`${path} is hidden in this project (Settings > Projects). Ask the user before using it.`);
      return { full, memory: false };
    }
    if (write) throw refusal(`${path} is outside the workspace (${root}); file tools write only inside it.`);
    if (!this.readAnywhere) throw refusal(`${path} is outside the workspace (${root}); file tools read only inside it in this access mode.`);
    return { full, memory: false };
  }

  exec(command: string, options?: Harness.ExecOptions) {
    return this.#base.exec(command, options);
  }
  poll(handle: string) {
    return this.#base.poll(handle);
  }
  wait(handle: string, ms: number, signal?: AbortSignal) {
    return this.#base.wait(handle, ms, signal);
  }
  kill(handle: string) {
    return this.#base.kill(handle);
  }
  async readFile(path: string, range?: Harness.ReadRange) {
    const target = this.#target(path, false);
    if (!target.memory) return this.#base.readFile(target.full, range);
    const bytes = await NodeFS.promises.readFile(target.full);
    const offset = range?.offset ?? 0;
    return bytes.subarray(offset, range?.length === undefined ? undefined : offset + range.length);
  }
  /** The workspace's files in one batch when the env batches (one request on a Cloud computer), memory's one by one. */
  async readFiles(paths: string[]): Promise<(Uint8Array | Error)[]> {
    const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
    const results: (Uint8Array | Error | undefined)[] = paths.map(() => undefined);
    const batch: { readonly at: number; readonly full: string }[] = [];
    for (const [at, path] of paths.entries()) {
      try {
        const target = this.#target(path, false);
        if (target.memory) results[at] = await this.readFile(path).catch(asError);
        else batch.push({ at, full: target.full });
      } catch (error) {
        results[at] = asError(error);
      }
    }
    if (batch.length > 0) {
      const base = this.#base;
      const read =
        base.readFiles === undefined
          ? await Promise.all(batch.map(({ full }) => base.readFile(full).catch(asError)))
          : await base.readFiles(batch.map(({ full }) => full));
      for (const [n, { at }] of batch.entries()) results[at] = read[n] ?? new Error(`${paths[at]}: no result`);
    }
    return results as (Uint8Array | Error)[];
  }
  async stat(path: string): Promise<Harness.FileStat | undefined> {
    const target = this.#target(path, false);
    if (!target.memory) return this.#base.stat(target.full);
    const info = await NodeFS.promises.stat(target.full).catch(() => undefined);
    return info === undefined ? undefined : { kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, mtimeMs: info.mtimeMs };
  }
  async listDir(path: string): Promise<Harness.DirEntry[]> {
    const target = this.#target(path, false);
    if (target.memory) {
      const entries = await NodeFS.promises.readdir(target.full, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
    }
    const entries = await this.#base.listDir(target.full);
    const { hidden, root } = this.#rules;
    if (hidden === null) return entries;
    return entries.filter((entry) => {
      const relative = NodePath.relative(root, NodePath.join(target.full, entry.name)).split(NodePath.sep).join("/");
      return relative.startsWith("..") || !hidden(relative);
    });
  }
  async writeFile(path: string, data: Uint8Array | string) {
    const target = this.#target(path, true);
    if (!target.memory) return this.#base.writeFile(target.full, data);
    const onWrite = this.#rules.memory?.onWrite;
    if (onWrite === undefined) throw refusal("Memory is read-only here; report what you learned instead.");
    await NodeFS.promises.mkdir(NodePath.dirname(target.full), { recursive: true });
    const content = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    await NodeFS.promises.writeFile(target.full, content);
    const refused = onWrite({ tool: "Write", path: target.full, content });
    if (refused !== undefined) throw refusal(`not saved: ${refused}`);
  }
  scratchDir() {
    return this.#base.scratchDir();
  }
  resolvePath(path: string) {
    return this.#base.resolvePath(path);
  }
  close() {
    return this.#base.close();
  }
  configureShell(settings: Record<string, unknown>) {
    this.#base.configureShell?.(settings);
  }
}

// ── the journal ───────────────────────────────────────────────

const CHECKPOINT_FORMAT = "caveman-harness/1";
const RUN_ID = /^[A-Za-z0-9_-]{1,120}$/;

export interface HarnessCheckpoint {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly runId: string;
  readonly model: string;
  readonly loadout: string;
  readonly messages: ReadonlyArray<Harness.HarnessMessage>;
  readonly messagesSha256: string;
}

/** A checkpoint's digest of its messages: recomputed on every read, so a torn or edited one never becomes a conversation. */
export const messagesSha = (messages: ReadonlyArray<unknown>) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");

const checkpointPath = (dir: string, runId: string) => {
  if (!RUN_ID.test(runId)) throw new Error(`Caveman run id ${JSON.stringify(runId)} is not a journal name`);
  return NodePath.join(dir, `${runId}.json`);
};

/** The conversation as of the end of `runId`: written whole, then renamed into place, so a reader never sees half. */
export async function writeHarnessCheckpoint(dir: string, checkpoint: Omit<HarnessCheckpoint, "format" | "messagesSha256">): Promise<void> {
  const file = checkpointPath(dir, checkpoint.runId);
  await NodeFS.promises.mkdir(dir, { recursive: true });
  const body: HarnessCheckpoint = { format: CHECKPOINT_FORMAT, ...checkpoint, messagesSha256: messagesSha(checkpoint.messages) };
  const temp = `${file}.${process.pid}.tmp`;
  await NodeFS.promises.writeFile(temp, JSON.stringify(body));
  await NodeFS.promises.rename(temp, file);
}

/**
 * A harness run's checkpoint: its messages, undefined when the run is not a harness run (a classic one), and a throw
 * when the file is there but corrupt (its digest is recomputed, so a torn or edited checkpoint never becomes a conversation).
 */
export async function readHarnessCheckpoint(dir: string, runId: string): Promise<HarnessCheckpoint | undefined> {
  let text: string;
  try {
    text = await NodeFS.promises.readFile(checkpointPath(dir, runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text) as Partial<HarnessCheckpoint>;
  if (value.format !== CHECKPOINT_FORMAT || !Array.isArray(value.messages) || value.messagesSha256 !== messagesSha(value.messages)) {
    throw new Error(`Caveman journal ${runId}: the harness checkpoint is corrupt`);
  }
  return value as HarnessCheckpoint;
}

// ── MCP and skills ────────────────────────────────────────────

/** One MCP server a thread reaches (adapter.ts cavemanMcpServers): over HTTP (the runtime's, its hub's) or a stdio command. */
export interface CavemanMcpServerEntry {
  readonly name: string;
  /** `caveman-app` (the runtime's own servers) or `space` (a Space's, the person's). */
  readonly source: string;
  readonly config:
    | { readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly description?: string }
    | { readonly command: string; readonly args?: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string };
}

/** The adapter's MCP entries (cavemanMcpServers) as the harness connects them. */
export function harnessMcpServers(entries: ReadonlyArray<CavemanMcpServerEntry>): Record<string, Harness.McpServerConfig> {
  const out: Record<string, Harness.McpServerConfig> = {};
  for (const entry of entries) {
    const config = entry.config as { url?: string; headers?: Readonly<Record<string, string>>; command?: string; args?: ReadonlyArray<string>; env?: Readonly<Record<string, string>>; cwd?: string };
    if (typeof config.url === "string") out[entry.name] = { type: "http", url: config.url, ...(config.headers === undefined ? {} : { headers: { ...config.headers } }) };
    else if (typeof config.command === "string") {
      out[entry.name] = { command: config.command, ...(config.args === undefined ? {} : { args: [...config.args] }), ...(config.env === undefined ? {} : { env: { ...config.env } }), ...(config.cwd === undefined ? {} : { cwd: config.cwd }) };
    }
  }
  return out;
}

/** `load_skill`: a skill's SKILL.md or one of its contained resources. */
export function skillTool(plugins: CavemanEngine["plugins"], environment: AgentEnvironment): Harness.HarnessTool {
  const byId = new Map(environment.skills.map((skill) => [skill.id, skill]));
  return {
    name: "load_skill",
    label: "load_skill",
    description: "Load instructions or a contained resource from an available Agent Skill.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, resource: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { name?: unknown; resource?: unknown }) {
      const skill = byId.get(String(params.name));
      const text = skill === undefined
        ? `Unknown skill ${JSON.stringify(params.name)}. Available skills: ${[...byId.keys()].join(", ")}`
        : await plugins.readAgentSkillResource(skill, typeof params.resource === "string" ? params.resource : "SKILL.md");
      return { content: [{ type: "text", text }], details: { truncated: false } };
    },
  };
}

/** Instruction sections as `# title`, then the text (the Chief's are rendered the same way: ChiefSessions). */
export function renderSections(sections: ReadonlyArray<{ readonly title: string; readonly text: string }>): string | undefined {
  const rendered = sections.flatMap((section) => {
    const text = section.text.trim();
    return text === "" ? [] : [`# ${section.title.trim()}\n\n${text}`];
  });
  return rendered.length === 0 ? undefined : rendered.join("\n\n");
}

// ── turns ─────────────────────────────────────────────────────

/** The env block the harness puts at the head of a thread's first message (`<env>` cwd, os `</env>`): not the person's words. */
const ENV_BLOCK = /^<env>\n[\s\S]*?\n<\/env>(?:\n\n|$)/;

/** A user message's text as the person wrote it: without the harness's env block. */
export const userWords = (text: string): string => text.replace(ENV_BLOCK, "");

/** A turn's input as the harness takes it: text, or text and base64 images. */
export type TurnInput = string | ReadonlyArray<Harness.TextPart | Harness.ImagePart>;

/** Why the harness's policy ended a turn, for the chat: it stopped on its own, and says so. */
export function harnessStopNotice(stopReason: string): string {
  switch (stopReason) {
    case "loop_repeat":
      return "Stopped: the same call kept returning the same result.";
    case "empty_turns":
      return "Stopped: the model kept answering with nothing.";
    case "output_cap":
      return "Stopped: the answer kept running past the output limit.";
    default:
      return `Stopped (${stopReason}).`;
  }
}

/**
 * Events from a callback, read in order as an async iterable: push until end, then the reader finishes. A reader that
 * stops early (an interrupted drive) ends the channel at once: an async generator's return() would wait behind the
 * pending next(), that is, for the run's next event, which a hung call or a long command never sends.
 */
export function eventChannel<T>(): { readonly push: (event: T) => void; readonly end: () => void; readonly events: AsyncIterable<T> } {
  const queue: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const end = () => {
    ended = true;
    notify();
  };
  return {
    push: (event) => {
      if (ended) return;
      queue.push(event);
      notify();
    },
    end,
    events: {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<T, undefined>> => {
          while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
          return queue.length > 0 ? { done: false, value: queue.shift()! } : { done: true, value: undefined };
        },
        return: async (): Promise<IteratorResult<T, undefined>> => {
          end();
          return { done: true, value: undefined };
        },
      }),
    },
  };
}
