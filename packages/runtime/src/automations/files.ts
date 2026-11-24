// AutomationFiles: a project's .caveman/ automation and agent files. Read from the working tree (the
// editor, manual runs, Me files) or from the default branch (Project triggers: security rule 1), checked
// with @caveman-app/automations, and watched so an edit made in any editor shows within a second.
//
// The plain functions take a checkout root and run without the runtime, so the CLI's offline `check`,
// `explain`, `list` and `new` read exactly what the runtime reads. The layer adds the project ids, a cache
// (the editor's live check answers from memory) and the watch that invalidates it.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { commonGitDir, DIRS, draftsOf, draftSignature, splitProjectRef, worktreesOf, type Draft } from "./drafts.ts";

import {
  NAME_PATTERN,
  NAME_RULE,
  automationPath,
  checkProject,
  parseAgentFile,
  type AutomationFile,
  type Diagnostic,
  type EnvSnapshot,
  type LoadedAutomation,
  type ParsedAgent,
  type ProjectCheck,
  type Scope,
  type SourceFile,
  type Target,
  type Template,
} from "@caveman-app/automations";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { listAgentTypes, type AgentType } from "../agents/agentTypes.ts";
import { AutomationFiles, type ProjectFiles, type Revision } from "./services.ts";

/** The folders automation.file_read and file_write may reach (the protocol's AutomationFilePath, checked again on disk). */
export const EDITABLE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))\.caveman\/(?:automations|local\/automations|agents)\/[^\0]+$/;
/** The Caveman workflow: when the default branch has it, Project triggers fire in GitHub Actions (SEMANTICS 8.6). */
export const CAVEMAN_WORKFLOW = ".github/workflows/caveman.yml";
/** A file this big in .caveman/ is reported, never read. */
const MAX_FILE_BYTES = 1024 * 1024;
const CLAUDE_AGENTS_DIR = ".claude/agents/";

export class AutomationFilesError extends Schema.TaggedError<AutomationFilesError>()("AutomationFilesError", {
  reason: Schema.Literals(["not_found", "invalid_params", "invalid_state"]),
  message: Schema.String,
}) {}

// ------------------------------------------------------------------ git

/** `git -C root ...`'s stdout; rejects on a non-zero exit, with what git wrote to stderr on the error. */
export function git(root: string, args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }, windowsHide: true }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    ),
  );
}

/** The top of the git checkout `cwd` is in, or undefined outside one. */
export const gitRoot = (cwd: string): Promise<string | undefined> =>
  git(cwd, ["rev-parse", "--show-toplevel"]).then((out) => out.trim() || undefined, () => undefined);

export interface DefaultBranch {
  /** `main`. */
  readonly name: string;
  /** What triggers read: `origin/main` when the remote is known, else the local branch. */
  readonly ref: string;
}

/** `no` when git ran and said no (any exit code, 128 in a folder that is no checkout); a git that never answered rethrows. */
const saidNo =
  <A>(no: A) =>
  (error: { code?: unknown }): A => {
    if (typeof error.code === "number") return no;
    throw error;
  };

/**
 * The default branch: the remote's HEAD, else the first of origin/main, origin/master, main, master that exists. Rejects
 * when git did not answer (it could not start, or died): which branch is the default is then unknown, not none.
 */
export async function defaultBranchOf(root: string): Promise<DefaultBranch | undefined> {
  const head = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).then((s) => s.trim(), saidNo(""));
  // A fetch after the remote renamed its default branch prunes the old one and leaves HEAD pointing at it. Only git
  // saying so (exit 1) passes it over; a git that failed to run says nothing about the branch.
  const gone = head !== "" && (await git(root, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`]).then(() => false, (error: { code?: unknown }) => error.code === 1));
  if (head !== "" && !gone) return { name: head.replace(/^origin\//, ""), ref: head };
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(() => true, saidNo(false))) return { name: ref.replace(/^origin\//, ""), ref };
  }
  return undefined;
}

/** git that may reach a remote: it fails rather than asks (as the Session Protocol's own fetches do). */
const NON_INTERACTIVE_GIT = {
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
  GIT_ALLOW_PROTOCOL: "https:ssh:file",
  ...(process.env.GIT_SSH_COMMAND === undefined && process.env.GIT_SSH === undefined ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
};

/**
 * Brings origin's default branch into `origin/<name>` and nothing else: the person's own branches, FETCH_HEAD and
 * working tree are never touched, so a merged automation goes live without a manual fetch (K9). Quiet: offline, or
 * without access, it fails and the next try is the next one.
 */
export const fetchDefaultBranch = (root: string, name: string): Promise<boolean> =>
  new Promise((resolve) =>
    execFile(
      "git",
      ["-C", root, "-c", "maintenance.auto=false", "-c", "gc.auto=0", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`],
      { timeout: 30_000, killSignal: "SIGKILL", env: { ...process.env, ...NON_INTERACTIVE_GIT }, windowsHide: true },
      (error) => resolve(error === null),
    ),
  );

/** Blob contents by object id, through one `git cat-file --batch`. */
function catBlobs(root: string, ids: ReadonlyArray<string>): Promise<Map<string, Buffer>> {
  if (ids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    // A git that exits before it reads every id fails the write (EPIPE): the read failed, and the runtime must not crash.
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const all = Buffer.concat(chunks);
      const out = new Map<string, Buffer>();
      let at = 0;
      while (at < all.length) {
        const eol = all.indexOf(0x0a, at);
        const [id, type, size] = all.subarray(at, eol).toString("utf8").split(" ");
        if (type === undefined || size === undefined) break;
        const length = Number(size);
        out.set(id!, all.subarray(eol + 1, eol + 1 + length));
        at = eol + 1 + length + 1;
      }
      resolve(out);
    });
    child.stdin.end(`${ids.join("\n")}\n`);
  });
}

// ------------------------------------------------------------------ reading files

export interface ProjectSources {
  /** Every file check reads under .caveman/ (Me files only from the working tree). */
  readonly files: ReadonlyArray<SourceFile>;
  /** `.claude/agents/*.md`: Claude Code's agents, which load in place. */
  readonly claude: ReadonlyArray<SourceFile>;
  /** Files that were found and not read (links out of the repository, files too big), as check reports them. */
  readonly problems: ReadonlyArray<Diagnostic>;
}

const problem = (file: string, message: string, code = "file-unrecognized"): Diagnostic => ({ path: file, line: 1, column: 1, severity: "error", code, message });
/** Security F-1: a Me file that git tracks arrived by a pull or a checkout, not by the person, so it never loads. */
export const TRACKED_ME_FILE = "This file is tracked by git; Me automations live only on this Mac. Remove it from git (git rm --cached) to use it.";
const posix = (p: string) => p.split(path.sep).join("/");

/** Which .caveman/ paths check reads: the files right under it, and everything in the automation and agent folders. */
function scanned(rel: string, isDir: boolean): boolean {
  const inside = rel.slice(".caveman/".length);
  if (!isDir && !inside.includes("/")) return true;
  return ["automations", "agents", "local", "local/automations"].some((dir) => inside === dir || (inside.startsWith(`${dir}/`) && dir !== "local"));
}

/**
 * The working tree's .caveman/ files and .claude/agents, as check and a manual run see them. A Me file git tracks is
 * reported, never read (F-1), and `.caveman/.gitignore` is made whenever a Me file exists, however it got there (B16).
 */
export async function readWorkingTree(root: string): Promise<ProjectSources> {
  const realRoot = await fs.promises.realpath(root);
  const files: SourceFile[] = [];
  const claude: SourceFile[] = [];
  const problems: Diagnostic[] = [];
  const local = await fs.promises.readdir(path.join(root, ".caveman", "local")).catch(() => [] as string[]);
  if (local.length > 0) await ensureGitignore(root).catch(() => undefined);
  const tracked = new Set(local.length === 0 ? [] : (await git(root, ["ls-files", "-z", "--", ".caveman/local"]).catch(() => "")).split("\0").filter(Boolean));
  const readOne = async (rel: string, into: SourceFile[]) => {
    if (tracked.has(rel)) {
      problems.push(problem(rel, TRACKED_ME_FILE, "me-file-tracked"));
      return;
    }
    const abs = path.join(root, rel);
    const stat = await fs.promises.lstat(abs).catch(() => undefined);
    if (stat === undefined) return;
    let target = abs;
    if (stat.isSymbolicLink()) {
      const real = await fs.promises.realpath(abs).catch(() => undefined);
      if (real === undefined || !real.startsWith(`${realRoot}${path.sep}`)) {
        problems.push(problem(rel, "This file is a link to outside the repository, so it is not read; put the file itself here."));
        return;
      }
      target = real;
    }
    const real = await fs.promises.stat(target).catch(() => undefined);
    if (real === undefined || !real.isFile()) return;
    if (real.size > MAX_FILE_BYTES) {
      problems.push(problem(rel, `This file is ${Math.round(real.size / 1024)} KiB, over the 1 MiB check reads; move it out of .caveman/.`));
      return;
    }
    into.push({ path: rel, text: await fs.promises.readFile(target, "utf8") });
  };
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (scanned(child, true)) await walk(child);
      } else if (scanned(child, false)) await readOne(child, files);
    }
  };
  await walk(".caveman");
  const agents = await fs.promises.readdir(path.join(root, CLAUDE_AGENTS_DIR)).catch(() => [] as string[]);
  for (const name of agents.filter((n) => n.endsWith(".md")).sort()) await readOne(`${CLAUDE_AGENTS_DIR}${name}`, claude);
  return { files, claude, problems };
}

/** The same files at a branch: what a Project automation's triggers run (rule 1). Me files never come from git. */
export async function readBranch(root: string, ref: string): Promise<ProjectSources & { readonly workflow: boolean }> {
  const listing = await git(root, ["ls-tree", "-r", "-z", ref, "--", ".caveman", ".claude/agents", CAVEMAN_WORKFLOW]);
  const entries = listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t") as [string, string];
      const [mode, type, id] = meta.split(" ") as [string, string, string];
      return { mode, type, id, file };
    })
    .filter((e) => e.type === "blob");
  const workflow = entries.some((e) => e.file === CAVEMAN_WORKFLOW);
  const problems: Diagnostic[] = [];
  const wanted = entries.filter((e) => {
    if (e.file.startsWith(".caveman/local/")) return false;
    if (e.file.startsWith(".caveman/")) return scanned(e.file, false);
    return e.file.startsWith(CLAUDE_AGENTS_DIR) && e.file.endsWith(".md") && !e.file.slice(CLAUDE_AGENTS_DIR.length).includes("/");
  });
  const links = wanted.filter((e) => e.mode === "120000");
  for (const link of links) problems.push(problem(link.file, "This file is a link, so the default branch's copy is not read; commit the file itself."));
  const blobs = wanted.filter((e) => e.mode !== "120000");
  const contents = await catBlobs(root, blobs.map((e) => e.id));
  const files: SourceFile[] = [];
  const claude: SourceFile[] = [];
  for (const blob of blobs) {
    const buffer = contents.get(blob.id);
    if (buffer === undefined) continue;
    if (buffer.length > MAX_FILE_BYTES) {
      problems.push(problem(blob.file, "This file is over the 1 MiB check reads; move it out of .caveman/."));
      continue;
    }
    (blob.file.startsWith(".caveman/") ? files : claude).push({ path: blob.file, text: buffer.toString("utf8") });
  }
  return { files, claude, problems, workflow };
}

// ------------------------------------------------------------------ the agent registry

const parsedOf = (type: AgentType): ParsedAgent => ({
  name: type.name,
  description: type.description,
  ...(type.engine ? { engine: type.engine } : {}),
  ...(type.model ? { model: type.model } : {}),
  ...(type.effort ? { effort: type.effort } : {}),
  ...(type.tools ? { tools: type.tools } : {}),
  ...(type.disallowedTools ? { disallowedTools: type.disallowedTools } : {}),
  ...(type.decides ? { decides: type.decides } : {}),
  ...(type.returns ? { returns: type.returns } : {}),
  ...(type.isolation ? { isolation: type.isolation } : {}),
  role: type.role,
  source: type.source,
  instructions: type.instructions,
  ignoredKeys: [],
});

/** The agents a project's files do not define: ~/.caveman/agents, enabled plugins' agents, then the built-ins (agents/agentTypes.ts). */
export async function registryAgents(input: { readonly home: string; readonly pluginAgentFiles?: ReadonlyArray<string> }): Promise<ReadonlyArray<ParsedAgent>> {
  return (await listAgentTypes({ home: input.home, pluginAgentFiles: input.pluginAgentFiles ?? [] })).map(parsedOf);
}

/** A project's own agents, with instructions: .caveman/agents first, then .claude/agents (the registry's order). */
export function projectAgents(sources: Pick<ProjectSources, "files" | "claude">): ReadonlyArray<ParsedAgent> {
  const out: ParsedAgent[] = [];
  const agentFiles = sources.files.filter((f) => /^\.caveman\/agents\/[^/]+\.md$/.test(f.path));
  for (const file of [...agentFiles, ...sources.claude]) {
    const { agent } = parseAgentFile(file, "project");
    if (agent !== undefined && !out.some((a) => a.name === agent.name)) out.push(agent);
  }
  return out;
}

const withoutBody = ({ instructions: _i, ignoredKeys: _k, ...info }: ParsedAgent) => info;

/** check over the files, with `overrides` (unsaved editor text) in place of the files at their paths. */
export function checkSources(input: {
  readonly sources: ProjectSources;
  readonly registry: ReadonlyArray<ParsedAgent>;
  readonly overrides?: ReadonlyArray<SourceFile> | undefined;
  readonly env?: EnvSnapshot | undefined;
  /** Where it will run (check --target); Caveman Code by default. */
  readonly target?: Target | undefined;
}): ProjectCheck {
  const overrides = new Map((input.overrides ?? []).map((f) => [f.path.replace(/^\.\//, ""), f.text]));
  const files = [
    ...input.sources.files.map((f) => (overrides.has(f.path) ? { path: f.path, text: overrides.get(f.path)! } : f)),
    ...[...overrides].filter(([p]) => !input.sources.files.some((f) => f.path === p) && p.startsWith(".caveman/")).map(([p, text]) => ({ path: p, text })),
  ];
  // Claude's agents load in place; the registry's come after them.
  const claude = projectAgents({ files: [], claude: input.sources.claude }).map(withoutBody);
  const agents = [...claude, ...input.registry.filter((a) => !claude.some((c) => c.name === a.name)).map(withoutBody)];
  const check = checkProject({ files, agents, target: input.target ?? "code", ...(input.env ? { env: input.env } : {}) });
  const shadowed = new Set(input.overrides?.map((f) => f.path));
  return { ...check, diagnostics: [...input.sources.problems.filter((p) => !shadowed.has(p.path)), ...check.diagnostics] };
}

// ------------------------------------------------------------------ revisions

/** The agents a file's steps and agent checks name. */
export function agentsUsed(file: AutomationFile): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const step of Object.values(file.steps)) {
    if (step.agent !== undefined) names.add(step.agent);
    for (const check of step.checks ?? []) if (typeof check !== "string") names.add(check.agent);
  }
  return [...names].sort();
}

/** The error diagnostics that keep this automation from running: its own file's, and those of the agent files it uses. */
export function blockingErrors(check: ProjectCheck, automation: LoadedAutomation): ReadonlyArray<Diagnostic> {
  const used = new Set(agentsUsed(automation.file));
  const paths = new Set([automation.path, ...check.agents.filter((a) => used.has(a.name) && a.path !== undefined).map((a) => a.path!)]);
  return check.diagnostics.filter((d) => d.severity === "error" && paths.has(d.path));
}

/**
 * One automation as a run sees it. The digest covers the automation file and every agent file it uses
 * (their returns schemas too), so an edit to any of them is a new revision; built-in and user agents enter
 * by their definition.
 */
export function revisionFrom(input: {
  readonly sources: ProjectSources;
  readonly registry: ReadonlyArray<ParsedAgent>;
  readonly check: ProjectCheck;
  readonly name: string;
  readonly scope: Scope;
  readonly from: Revision["from"];
}): Revision | undefined {
  const automation = input.check.automations.find((a) => a.name === input.name && a.scope === input.scope);
  if (automation === undefined) return undefined;
  const own = projectAgents(input.sources);
  const agents = [...own, ...input.registry.filter((a) => !own.some((o) => o.name === a.name))];
  const byPath = new Map([...input.sources.files, ...input.sources.claude].map((f) => [f.path, f.text]));
  const hash = createHash("sha256").update(`${automation.path}\0${automation.text}\0`);
  const returnsSchemas: Record<string, unknown> = {};
  for (const name of agentsUsed(automation.file)) {
    const agent = agents.find((a) => a.name === name);
    if (agent === undefined) continue;
    if (agent.path !== undefined && byPath.has(agent.path)) {
      hash.update(`${agent.path}\0${byPath.get(agent.path)}\0`);
      if (agent.returns !== undefined) {
        const schema = path.posix.join(path.posix.dirname(agent.path), agent.returns);
        const text = byPath.get(schema);
        hash.update(`${schema}\0${text ?? ""}\0`);
        // From the same source as the agent, so a run validates against what it was admitted with (K1).
        try {
          if (text !== undefined) returnsSchemas[name] = JSON.parse(text);
        } catch {}
      }
    } else hash.update(`${agent.source}:${name}\0${JSON.stringify(withoutBody(agent))}\0${agent.instructions}\0`);
  }
  return { digest: hash.digest("hex"), automation, agents, from: input.from, ...(Object.keys(returnsSchemas).length > 0 ? { returnsSchemas } : {}) };
}

// ------------------------------------------------------------------ writing

/** `.caveman/.gitignore` keeps Me files and generated state out of git: created, or appended to, never rewritten. */
export async function ensureGitignore(root: string): Promise<void> {
  const file = path.join(root, ".caveman", ".gitignore");
  const text = await fs.promises.readFile(file, "utf8").catch(() => undefined);
  const lines = new Set((text ?? "").split(/\r?\n/).map((l) => l.trim().replace(/^\//, "").replace(/\/?$/, "/")));
  const missing = ["local/", "state/"].filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const head = text === undefined ? "# Caveman Code: your own automations (Me) and generated state stay out of git.\n" : text === "" || text.endsWith("\n") ? "" : "\n";
  await fs.promises.appendFile(file, `${head}${missing.join("\n")}\n`);
}

/**
 * The absolute path of an editable file, after checking it stays where file_read and file_write may reach:
 * the pattern, then the real path on disk (a link out of the repository, or out of those folders, is refused).
 */
export async function editablePath(root: string, rel: string, mode: "read" | "write"): Promise<string> {
  const refuse = (message: string) => Promise.reject(new AutomationFilesError({ reason: "invalid_params", message }));
  if (!EDITABLE_PATH.test(rel)) return refuse(`${rel} is not an automation or agent file; use a path under .caveman/automations/, .caveman/local/automations/ or .caveman/agents/.`);
  const realRoot = await fs.promises.realpath(root);
  const abs = path.join(realRoot, rel);
  const insideFolders = (real: string) => real.startsWith(`${realRoot}${path.sep}`) && EDITABLE_PATH.test(posix(path.relative(realRoot, real)));
  const stat = await fs.promises.lstat(abs).catch(() => undefined);
  if (mode === "read") {
    if (stat === undefined) return Promise.reject(new AutomationFilesError({ reason: "not_found", message: `${rel} does not exist; create it with automation.file_write or a template.` }));
    const real = await fs.promises.realpath(abs);
    if (!insideFolders(real)) return refuse(`${rel} is a link out of the automation and agent folders, so it is not read; put the file itself there.`);
    if (!(await fs.promises.stat(real)).isFile()) return refuse(`${rel} is a folder; name a file in it.`);
    return real;
  }
  if (stat?.isSymbolicLink()) return refuse(`${rel} is a link, so it is not written; delete the link and save again.`);
  if (stat !== undefined && !stat.isFile()) return refuse(`${rel} is a folder; name a file in it.`);
  // The nearest folder that exists must be itself, not a link: a linked .caveman/agents could lead anywhere, even
  // elsewhere inside the repository (A14).
  let at = path.dirname(abs);
  while (!fs.existsSync(at) && at !== realRoot) at = path.dirname(at);
  const real = await fs.promises.realpath(at);
  if (real !== at) return refuse(`${rel} leads through a link (${posix(path.relative(realRoot, at))}); make it a real folder and save again.`);
  return abs;
}

/** Writes through a temp file and a rename, so a watcher or a reader never sees half a file. */
export async function writeEditable(root: string, rel: string, text: string): Promise<void> {
  const abs = await editablePath(root, rel, "write");
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  // The folders made above must not have become links meanwhile.
  await editablePath(root, rel, "write");
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.promises.writeFile(temp, text, { flag: "wx", mode: 0o644 });
    await fs.promises.rename(temp, abs);
  } catch (cause) {
    await fs.promises.rm(temp, { force: true });
    throw cause;
  }
  await ensureGitignore(root);
}

/** This machine's IANA time zone, which a template's schedule is written in. */
export const machineTimeZone = (): string | undefined => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && zone !== "Etc/Unknown" ? zone : undefined;
};

export interface Created {
  readonly name: string;
  readonly scope: Scope;
  /** The automation file, repo-relative. */
  readonly path: string;
  /** Every file written, repo-relative; a file already there with the same text is not written again. */
  readonly written: ReadonlyArray<string>;
  /** Names taken by a different file already, and the names used instead. */
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

const exists = (abs: string) => fs.promises.readFile(abs, "utf8").then((t) => t, () => undefined);

/** A name not taken by a different file: `name`, else `name-2`, `name-3`... */
async function freeName(root: string, name: string, pathOf: (n: string) => string, text: string): Promise<{ name: string; same: boolean }> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const current = await exists(path.join(root, pathOf(candidate)));
    if (current === undefined || current === text) return { name: candidate, same: current === text };
  }
}

/**
 * A template's files into a project: the automation into .caveman/automations/ (Project) or
 * .caveman/local/automations/ (Me), its agents into .caveman/agents/. A file already there with other text
 * is never overwritten: the new one takes the next free name, and the automation is pointed at it. A
 * schedule is written in this machine's time zone; the rest of the file is the template's, byte for byte.
 */
export async function createFromTemplate(root: string, template: Template, scope: Scope, timeZone = machineTimeZone()): Promise<Created> {
  const [automationFile, ...rest] = template.files;
  let text = automationFile!.text;
  if (timeZone !== undefined) text = text.replace(/(\btimezone:[ \t]*)("?)([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*)\2/, `$1$2${timeZone}$2`);
  const renamed: Array<{ from: string; to: string }> = [];
  const pending: Array<{ rel: string; text: string }> = [];
  for (const file of rest) {
    const match = /^\.caveman\/agents\/([^/]+)\.md$/.exec(file.path);
    if (match === null) {
      const current = await exists(path.join(root, file.path));
      if (current !== undefined && current !== file.text) {
        throw new AutomationFilesError({ reason: "invalid_state", message: `${file.path} is already there with other content; rename or remove it, then create again.` });
      }
      if (current === undefined) pending.push({ rel: file.path, text: file.text });
      continue;
    }
    const name = match[1]!;
    let agentText = file.text;
    let free = await freeName(root, name, (n) => `.caveman/agents/${n}.md`, agentText);
    if (free.name !== name) {
      agentText = agentText.replace(/^(---\r?\n(?:[\s\S]*?\r?\n)?name:[ \t]*)["']?[^\s"']+["']?/m, `$1${free.name}`);
      free = await freeName(root, name, (n) => `.caveman/agents/${n}.md`, agentText);
      renamed.push({ from: name, to: free.name });
      text = text.replace(new RegExp(`(\\bagent:[ \\t]*)${name.replace(/[-]/g, "\\-")}(?![\\w-])`, "g"), `$1${free.name}`);
    }
    if (!free.same) pending.push({ rel: `.caveman/agents/${free.name}.md`, text: agentText });
  }
  const own = await freeName(root, template.id, (n) => automationPath(n, scope), text);
  if (own.name !== template.id) renamed.push({ from: template.id, to: own.name });
  if (!own.same) pending.push({ rel: automationPath(own.name, scope), text });
  for (const file of pending) await writeEditable(root, file.rel, file.text);
  await ensureGitignore(root);
  return { name: own.name, scope, path: automationPath(own.name, scope), written: pending.map((f) => f.rel), renamed };
}

/** An automation file from text (Save as file, Write the file): never over another file of that name. */
export async function createFromText(root: string, name: string, text: string, scope: Scope): Promise<Created> {
  if (!NAME_PATTERN.test(name)) {
    throw new AutomationFilesError({ reason: "invalid_params", message: `"${name}" cannot name an automation; use ${NAME_RULE}, like morning-digest.` });
  }
  const own = await freeName(root, name, (n) => automationPath(n, scope), text);
  if (!own.same) await writeEditable(root, automationPath(own.name, scope), text);
  await ensureGitignore(root);
  return { name: own.name, scope, path: automationPath(own.name, scope), written: own.same ? [] : [automationPath(own.name, scope)], renamed: own.name === name ? [] : [{ from: name, to: own.name }] };
}

// ------------------------------------------------------------------ the service

/** A project's default branch as triggers see it: its name, the automation files on it, and the trigger home. */
export interface BranchView {
  /** Undefined when there is no default branch, or when it is `unreadable` and git has never named it. */
  readonly branch: DefaultBranch | undefined;
  /** Undefined when there is no default branch, or it is `unreadable`. */
  readonly sources: ProjectSources | undefined;
  /** The default branch has the Caveman workflow, so Project triggers fire in GitHub Actions (SEMANTICS 8.6). */
  readonly workflow: boolean;
  /** git failed to read the branch, and no earlier read of it stands in: what is on it is unknown, not absent. */
  readonly unreadable?: true;
}

/** What the handlers, the triggers and the agent tools use beyond AutomationFiles: checks with unsaved text, any checkout, the default branch. */
export class AutomationProjects extends Context.Service<
  AutomationProjects,
  {
    /** The checkout a project's files are read from. */
    readonly rootOf: (projectId: string) => Effect.Effect<string, AutomationFilesError>;
    /** Session Protocol projects whose checkouts exist. */
    readonly projects: Effect.Effect<ReadonlyArray<{ readonly projectId: string; readonly root: string }>>;
    /** The working tree's files at `root` (a project's checkout or a chat's worktree), cached until they change. */
    readonly sources: (root: string) => Effect.Effect<ProjectSources>;
    /** The registry beyond the project's own files, cached briefly. */
    readonly registry: Effect.Effect<ReadonlyArray<ParsedAgent>>;
    readonly check: (root: string, overrides?: ReadonlyArray<SourceFile>, env?: EnvSnapshot) => Effect.Effect<ProjectCheck>;
    readonly branch: (root: string) => Effect.Effect<BranchView>;
    readonly revisionAt: (root: string, name: string, scope: Scope, from: Revision["from"]) => Effect.Effect<{ readonly revision?: Revision; readonly check: ProjectCheck }>;
    readonly write: (root: string, rel: string, text: string) => Effect.Effect<void, AutomationFilesError>;
    readonly read: (root: string, rel: string) => Effect.Effect<string, AutomationFilesError>;
    /** Forget what is cached for `root` (after a write the watch has not seen yet). */
    readonly invalidate: (root: string) => Effect.Effect<void>;
    /** Automation files only in one of the project's other worktrees (drafts.ts), cached until the watch sees a change. */
    readonly drafts: (root: string) => Effect.Effect<ReadonlyArray<Draft>>;
  }
>()("caveman/automations/AutomationProjects") {}

const REGISTRY_TTL_MS = 10_000;
const BRANCH_TTL_MS = 60_000;
/** The look that backs the watches up, in case one missed an event. */
const POLL_MS = 30_000;

const filesError = (cause: unknown) =>
  cause instanceof AutomationFilesError ? cause : new AutomationFilesError({ reason: "invalid_state", message: `The files could not be read or written: ${(cause as Error).message ?? String(cause)}.` });

/** A folder the watch follows: recursively or not, and only the entries `only` names when it has one. */
interface WatchTarget {
  readonly dir: string;
  readonly recursive: boolean;
  readonly only?: ReadonlySet<string>;
  /** While `dir` is missing, its nearest parent at or under `top` is watched for it to appear. */
  readonly top?: string;
}

/** What a checkout's watch follows: its own automation folders, and every other worktree's and origin's heads (drafts.ts). */
function watchTargets(root: string): Array<WatchTarget> {
  const targets: Array<WatchTarget> = [
    { dir: root, recursive: false, only: new Set([".caveman", ".claude"]) },
    { dir: path.join(root, ".caveman"), recursive: true, top: root },
    { dir: path.join(root, ".claude", "agents"), recursive: false, top: root },
  ];
  const common = commonGitDir(root);
  if (common === undefined) return targets;
  targets.push(
    { dir: common, recursive: false, only: new Set(["packed-refs", "worktrees"]) },
    { dir: path.join(common, "worktrees"), recursive: false, top: common },
    { dir: path.join(common, "refs", "remotes", "origin"), recursive: true, top: common },
  );
  for (const worktree of worktreesOf(root)) for (const { rel } of DIRS) targets.push({ dir: path.join(worktree.path, rel), recursive: false, top: worktree.path });
  return targets;
}

/** A cheap signature of what the watch looks at, for the poll that backs fs.watch up. */
function signature(root: string): string {
  const parts: string[] = [];
  const visit = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      try {
        const stat = fs.lstatSync(path.join(root, child));
        parts.push(`${child}:${stat.mtimeMs}:${stat.size}`);
      } catch {}
      if (entry.isDirectory() && depth < 3 && entry.name !== "state") visit(child, depth + 1);
    }
  };
  visit(".caveman", 0);
  visit(".claude/agents", 2);
  return parts.sort().join("|");
}

export const make = Effect.gen(function* () {
  // Imported here, not at the top: the offline CLI reads files through this module and must not load the server's.
  const [{ ProjectStoreV2 }, { PluginRegistry }, { isSessionProtocolProject }, { ProjectId }] = yield* Effect.promise(() =>
    Promise.all([import("../orchestration-v2/ProjectStore.ts"), import("../plugins/PluginRegistry.ts"), import("../orchestration-v2/ProjectCommands.ts"), import("@caveman-app/protocol")]),
  );
  const projects = yield* Effect.serviceOption(ProjectStoreV2);
  const plugins = yield* Effect.serviceOption(PluginRegistry);
  const home = os.homedir();
  const listeners = new Set<(projectId: string) => void>();
  const watched = new Map<string, { close: () => void; projectIds: Set<string> }>();
  const working = new Map<string, Promise<ProjectSources>>();
  const branches = new Map<string, { head: string; view: Promise<BranchView> }>();
  /** Each root's last read of its default branch that worked, served while a later read fails. */
  const lastRead = new Map<string, BranchView>();
  const branchSeen = new Map<string, { at: number; name: Promise<DefaultBranch | undefined> }>();
  /** Each root's last answer to which branch is the default, served while git cannot answer. */
  const branchNamed = new Map<string, DefaultBranch | undefined>();
  let registry: { at: number; agents: Promise<ReadonlyArray<ParsedAgent>> } | undefined;

  const draftCache = new Map<string, Promise<ReadonlyArray<Draft>>>();
  const changed = (root: string) => {
    working.delete(root);
    branchSeen.delete(root);
    draftCache.delete(root);
    for (const projectId of watched.get(root)?.projectIds ?? []) for (const listener of listeners) listener(projectId);
  };

  /**
   * fs.watch on every folder that holds automation files or moves the default branch (recursive on macOS, Windows and
   * Linux on Node 20+), so an edit, a draft in another worktree or a merge shows within a second. A folder that does not
   * exist yet is waited for on its nearest parent, and the watches are placed again whenever one appears or a worktree
   * comes or goes. A slow poll backs them up in case an event is missed.
   */
  const watch = (root: string, projectId: string) => {
    const known = watched.get(root);
    if (known !== undefined) {
      known.projectIds.add(projectId);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    /** Each folder watched (and how), with what of it counts, as last placed. */
    const watchers = new Map<string, { readonly watcher: fs.FSWatcher; readonly only: string }>();
    let closed = false;
    const place = () => {
      if (closed) return;
      const wanted = new Map<string, { readonly dir: string; readonly recursive: boolean; only: Set<string> | undefined }>();
      for (const target of watchTargets(root)) {
        let { dir, recursive } = target;
        let only = target.only === undefined ? undefined : new Set(target.only);
        // Missing: its nearest parent that is there, for the next folder down to appear.
        while (target.top !== undefined && dir !== target.top && !fs.existsSync(dir)) {
          only = new Set([path.basename(dir)]);
          recursive = false;
          dir = path.dirname(dir);
        }
        const key = `${recursive ? "tree" : "folder"}:${dir}`;
        const seen = wanted.get(key);
        if (seen === undefined) wanted.set(key, { dir, recursive, only });
        else seen.only = seen.only === undefined || only === undefined ? undefined : new Set([...seen.only, ...only]);
      }
      for (const [key, { watcher }] of watchers) {
        if (wanted.has(key)) continue;
        watcher.close();
        watchers.delete(key);
      }
      for (const [key, { dir, recursive, only }] of wanted) {
        const filter = only === undefined ? "*" : [...only].sort().join("/");
        const placed = watchers.get(key);
        if (placed?.only === filter) continue;
        placed?.watcher.close();
        watchers.delete(key);
        try {
          const watcher = fs.watch(dir, { recursive, persistent: false }, (_event, name) =>
            only === undefined || (name !== null && only.has(String(name).split(/[\\/]/)[0]!)) ? bump() : undefined,
          );
          watchers.set(key, { watcher: watcher.on("error", () => undefined), only: filter });
        } catch {}
      }
    };
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        place();
        changed(root);
      }, 50);
    };
    place();
    const both = () => `${signature(root)}#${draftSignature(root)}`;
    let last = both();
    const poll = setInterval(() => {
      const now = both();
      if (now !== last) {
        last = now;
        place();
        changed(root);
      }
    }, POLL_MS);
    poll.unref();
    watched.set(root, {
      projectIds: new Set([projectId]),
      close: () => {
        closed = true;
        clearTimeout(timer);
        clearInterval(poll);
        for (const { watcher } of watchers.values()) watcher.close();
        watchers.clear();
      },
    });
  };
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    for (const w of watched.values()) w.close();
    watched.clear();
  }));

  const pluginAgentFiles = Option.isSome(plugins)
    ? plugins.value.known.pipe(
        Effect.map((known) => known.plugins.filter((p) => p.enabled).flatMap((p) => p.plugin.agents.map((agent) => agent.path))),
        Effect.orElseSucceed(() => [] as string[]),
      )
    : Effect.succeed([] as string[]);

  const registryNow: Effect.Effect<ReadonlyArray<ParsedAgent>> = Effect.gen(function* () {
    if (registry === undefined || Date.now() - registry.at > REGISTRY_TTL_MS) {
      const files = yield* pluginAgentFiles;
      registry = { at: Date.now(), agents: registryAgents({ home, pluginAgentFiles: files }) };
    }
    const pending = registry.agents;
    return yield* Effect.promise(() => pending);
  });

  // A project's checkout is watched and cached; any other root (a chat's worktree) is read fresh each time.
  const sources = (root: string) =>
    Effect.promise(() => {
      if (!watched.has(root)) return readWorkingTree(root).catch((error: unknown) => ({ files: [], claude: [], problems: [problem(".caveman", `The files could not be read: ${(error as Error).message}.`)] }));
      let pending = working.get(root);
      if (pending === undefined) {
        pending = readWorkingTree(root).catch((error: unknown) => {
          working.delete(root);
          return { files: [], claude: [], problems: [problem(".caveman", `The files could not be read: ${(error as Error).message}.`)] };
        });
        working.set(root, pending);
      }
      return pending;
    });

  const check = (root: string, overrides?: ReadonlyArray<SourceFile>, env?: EnvSnapshot) =>
    Effect.all([sources(root), registryNow]).pipe(Effect.map(([s, agents]) => checkSources({ sources: s, registry: agents, overrides, env })));

  // Which branch is the default rarely changes: asked again after BRANCH_TTL_MS. Its head is read every time (one git call),
  // since a fetch or a merge moves it without touching .caveman/.
  const branchName = (root: string): Promise<DefaultBranch | undefined> => {
    const seen = branchSeen.get(root);
    if (seen !== undefined && Date.now() - seen.at < BRANCH_TTL_MS) return seen.name;
    const name: Promise<DefaultBranch | undefined> = defaultBranchOf(root).then(
      (found) => {
        branchNamed.set(root, found);
        return found;
      },
      (error: unknown) => {
        // git did not answer: the last answer stands, and git is asked again on the next look, not a minute later.
        if (branchSeen.get(root)?.name === name) branchSeen.delete(root);
        if (branchNamed.has(root)) return branchNamed.get(root);
        throw error;
      },
    );
    branchSeen.set(root, { at: Date.now(), name });
    return name;
  };
  const branch = (root: string): Effect.Effect<BranchView> =>
    Effect.promise(async () => {
      let found: DefaultBranch | undefined;
      try {
        found = await branchName(root);
      } catch {
        // git has never said which branch is the default: what is on it is unknown, not absent.
        return { branch: undefined, sources: undefined, workflow: false, unreadable: true };
      }
      if (found === undefined) return { branch: undefined, sources: undefined, workflow: false };
      const head = await git(root, ["rev-parse", "--verify", "--quiet", `${found.ref}^{commit}`]).then((s) => s.trim(), () => "");
      const cached = branches.get(root);
      if (cached !== undefined && cached.head === head) return cached.view;
      const view: Promise<BranchView> = readBranch(root, found.ref).then(
        ({ workflow, ...read }) => {
          const good: BranchView = { branch: found, sources: read, workflow };
          if (branches.get(root)?.view === view) lastRead.set(root, good);
          return good;
        },
        () => {
          // A failed read says nothing about what is on the branch: it is read again next time, and until then the copy
          // read last stands, so its triggers neither stop nor lose their place.
          if (branches.get(root)?.view === view) branches.delete(root);
          const last = lastRead.get(root);
          return last?.branch?.ref === found.ref ? last : { branch: found, sources: undefined, workflow: false, unreadable: true };
        },
      );
      branches.set(root, { head, view });
      return view;
    });

  const revisionAt = (root: string, name: string, scope: Scope, from: Revision["from"]) =>
    Effect.gen(function* () {
      const agents = yield* registryNow;
      // Me files are read from the working tree (whether they may fire is the triggers' call, F-1); a Project file's triggers run the default branch's copy.
      const read = from === "default_branch" && scope === "project" ? (yield* branch(root)).sources : yield* sources(root);
      const s = read ?? { files: [], claude: [], problems: [] };
      const result = checkSources({ sources: s, registry: agents });
      const revision = revisionFrom({ sources: s, registry: agents, check: result, name, scope, from });
      return { check: result, ...(revision ? { revision } : {}) };
    });

  const rootOf = (ref: string): Effect.Effect<string, AutomationFilesError> =>
    Effect.gen(function* () {
      const { projectId, branch: draftBranch } = splitProjectRef(ref);
      if (draftBranch === undefined) return yield* projectRoot(projectId);
      // A draft: the worktree its branch is checked out in, read fresh (never watched or cached on its own).
      const worktree = worktreesOf(yield* projectRoot(projectId)).find((w) => w.branch === draftBranch);
      if (worktree === undefined) return yield* new AutomationFilesError({ reason: "not_found", message: `No worktree has ${draftBranch} checked out any more; the draft went with it.` });
      return worktree.path;
    });
  const projectRoot = (projectId: string): Effect.Effect<string, AutomationFilesError> =>
    Effect.gen(function* () {
      if (Option.isNone(projects)) return yield* new AutomationFilesError({ reason: "not_found", message: `No project ${projectId}; add the repository in Caveman Code first.` });
      const row = yield* projects.value.get(ProjectId.make(projectId)).pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(row) || row.value.deletedAt !== null) return yield* new AutomationFilesError({ reason: "not_found", message: `No project ${projectId}; add the repository in Caveman Code first.` });
      const root = row.value.workspaceRoot;
      watch(root, projectId);
      return root;
    });

  const store: AutomationProjects["Service"] = {
    rootOf,
    projects: Option.isNone(projects)
      ? Effect.succeed([])
      : projects.value.list().pipe(
          Effect.map((rows) => rows.filter((r) => isSessionProtocolProject(r.projectId) && r.deletedAt === null && fs.existsSync(r.workspaceRoot))),
          Effect.tap((rows) => Effect.sync(() => rows.forEach((r) => watch(r.workspaceRoot, r.projectId)))),
          Effect.map((rows) => rows.map((r) => ({ projectId: r.projectId as string, root: r.workspaceRoot }))),
          Effect.orElseSucceed(() => []),
        ),
    sources,
    registry: registryNow,
    check,
    branch,
    revisionAt,
    write: (root, rel, text) =>
      Effect.tryPromise({ try: () => writeEditable(root, rel, text), catch: filesError }).pipe(Effect.ensuring(Effect.sync(() => changed(root)))),
    read: (root, rel) =>
      Effect.tryPromise({ try: () => editablePath(root, rel, "read").then((abs) => fs.promises.readFile(abs, "utf8")), catch: filesError }),
    invalidate: (root) => Effect.sync(() => changed(root)),
    drafts: (root) =>
      Effect.gen(function* () {
        const cached = draftCache.get(root);
        if (cached !== undefined) return yield* Effect.promise(() => cached);
        const [checkout, view] = yield* Effect.all([sources(root), branch(root)]);
        const textOf = (s: ProjectSources | undefined) => new Map((s?.files ?? []).map((f) => [f.path, f.text] as const));
        const pending = draftsOf({ root, checkout: textOf(checkout), defaultBranch: textOf(view.sources), defaultRef: view.branch?.ref }).catch(() => [] as Draft[]);
        // Only a watched checkout's answer is kept: the watch is what clears it.
        if (watched.has(root)) draftCache.set(root, pending);
        return yield* Effect.promise(() => pending);
      }),
  };

  const files: AutomationFiles["Service"] = {
    load: (projectId) =>
      Effect.gen(function* () {
        const root = yield* rootOf(projectId).pipe(Effect.orDie);
        const result = yield* check(root);
        const view = yield* branch(root);
        return { ...result, projectId, root, defaultBranch: view.branch?.name } satisfies ProjectFiles;
      }),
    revision: (projectId, name, scope, from) =>
      rootOf(projectId).pipe(
        Effect.orDie,
        Effect.flatMap((root) => revisionAt(root, name, scope, from)),
        Effect.map((r) => r.revision),
      ),
    agents: (projectId) =>
      Effect.gen(function* () {
        const root = yield* rootOf(projectId).pipe(Effect.orDie);
        const own = projectAgents(yield* sources(root));
        return [...own, ...(yield* registryNow).filter((a) => !own.some((o) => o.name === a.name))];
      }),
    read: (projectId, rel) => rootOf(projectId).pipe(Effect.flatMap((root) => store.read(root, rel)), Effect.orDie),
    write: (projectId, rel, text) =>
      Effect.gen(function* () {
        const root = yield* rootOf(projectId).pipe(Effect.orDie);
        yield* store.write(root, rel, text).pipe(Effect.orDie);
        return (yield* check(root)).diagnostics;
      }),
    changes: Stream.callback<{ readonly projectId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (projectId: string) => void Queue.offerUnsafe(queue, { projectId });
          listeners.add(listener);
          return listener;
        }),
        (listener) => Effect.sync(() => void listeners.delete(listener)),
      ),
    ),
  };
  return Context.make(AutomationFiles, files).pipe(Context.add(AutomationProjects, store));
});

/** AutomationFiles and AutomationProjects, one cache and one watch per checkout. */
export const layer = Layer.effectContext(make);
