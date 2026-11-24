// Skills: what every engine loads (skill.list), and writing one (skill.save,
// skill.record) into my skills, a project's, or a plugin of a folder
// marketplace. A session's transcript becomes a SKILL.md in Claude's skill
// format (skill.record).
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EngineId, SessionEvent, SkillInfo } from "@caveman-app/session-protocol";

import { openNoFollow } from "../openNoFollow.ts";
import { parseFrontmatter } from "../plugins/format.ts";
import type { LoadedPlugin } from "../plugins/load.ts";
import type { SetupHomes } from "./setupScan.ts";

/** What the writer sees: the session's words and tool calls, newest kept when it is long. */
const MAX_TRANSCRIPT_CHARS = 60_000;

export const SKILL_INSTRUCTIONS = `You turn a coding session into a reusable Claude skill.
Answer with exactly one SKILL.md and nothing else: YAML front matter between --- lines with
"name" (lowercase words joined by hyphens, at most 64 characters) and "description" (one
sentence: what the skill does and when to use it), then the instructions in Markdown: when to
use it, the steps in order, the commands and files involved, and the checks that prove it worked.
Write for another agent that never saw this session. Keep what generalizes; drop one-off details.`;

export function transcriptText(events: ReadonlyArray<SessionEvent>): string {
  const lines: Array<string> = [];
  for (const event of events) {
    if (event.type === "message.done") lines.push(`${event.payload.role === "user" ? "User" : "Agent"}: ${event.payload.text}`);
    // The agent's tools; the runtime's own rows (a chat's worktree) come outside any turn.
    else if (event.type === "tool.started" && event.turn_id !== undefined) lines.push(`Tool (${event.payload.kind}): ${event.payload.title}`);
    else if (event.type === "plan.updated" && event.payload.markdown) lines.push(`Plan:\n${event.payload.markdown}`);
  }
  const text = lines.join("\n\n");
  return text.length > MAX_TRANSCRIPT_CHARS ? `[earlier turns cut]\n${text.slice(-MAX_TRANSCRIPT_CHARS)}` : text;
}

export function skillPrompt(input: { readonly transcript: string; readonly name?: string; readonly note?: string }): string {
  return [
    input.name ? `Name the skill "${input.name}".` : "",
    input.note ? `The user says: ${input.note}` : "",
    `The session:\n\n${input.transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What a new skill's name must be: lowercase words joined by hyphens, at most 64 characters. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A skill name: lowercase words joined by hyphens, at most 64 characters. */
const skillSlug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 64).replace(/-+$/, "") || "recorded-skill";

/** The writer's answer as a SKILL.md: front matter with name and description, whatever the model did around it. */
export function normalizeSkill(raw: string, wanted: string | undefined): { name: string; markdown: string } {
  const text = raw.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1").trim();
  // Front matter opens the answer, after at most one line of the model's own ("Here it is:"); a later --- is a rule.
  const match = /^(?:[^\n]*\n\s*)?---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  const isFront = match !== null && /^(?:name|description):/m.test(match[1]!);
  const front = isFront ? match[1]! : "";
  const body = (isFront ? match[2]! : text).trim();
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = skillSlug(wanted ?? field("name") ?? body.split("\n")[0]!.replace(/^#+\s*/, ""));
  const description = field("description") ?? body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "A skill recorded from a session.";
  return { name, markdown: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n` };
}

/**
 * Writes `markdown` as `<dir>/<name>/SKILL.md` (a new skill) or over `file`
 * (an edit of a listed one), through a temp file and a rename. The folder it
 * goes in must really be inside `within` (a link out of it is refused).
 */
export async function writeSkill(input: { readonly dir: string; readonly within: string; readonly name: string; readonly markdown: string; readonly file?: string | undefined }): Promise<string> {
  const target = input.file ?? path.join(input.dir, input.name, "SKILL.md");
  const root = await fs.promises.realpath(input.within);
  const inside = async (dir: string) => {
    // The nearest folder that exists, before anything is made under it.
    let at = dir;
    while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
    const real = await fs.promises.realpath(at);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(`${target} leads outside ${input.within}`);
  };
  await inside(path.dirname(target));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const folder = await fs.promises.realpath(path.dirname(target));
  if (!folder.startsWith(`${root}${path.sep}`)) throw new Error(`${target} leads outside ${input.within}`);
  const real = path.join(folder, "SKILL.md");
  if (input.file === undefined && fs.existsSync(real)) throw new Error(`a skill named ${input.name} is already there`);
  const temp = path.join(folder, `.SKILL.md.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temp, input.markdown, { flag: "wx", mode: 0o644 });
    await fs.promises.rename(temp, real);
  } catch (cause) {
    await fs.promises.rm(temp, { force: true });
    throw cause;
  }
  return real;
}

/**
 * Skill folders the engines read on their own, and who reads each: Claude
 * Agent through settingSources user and project, Codex through its home
 * (only on the person's own Codex home, as setup.scan says) and .agents.
 * The Caveman engine reads plugin skills and, on This Mac only, the
 * repository's own folders (PluginRegistry repoSkillRoots) and ~/.agents/skills;
 * on a Cloud computer the checkout is the agent's to write and the engine reads
 * beside runtime.key.
 */
interface SkillRoot {
  readonly root?: string;
  readonly dir: string;
  readonly engines: ReadonlyArray<EngineId>;
}
function rootsFor(homes: SetupHomes, home: string, codexOwnHome: boolean, onComputer: boolean): { readonly home: ReadonlyArray<Required<SkillRoot>>; readonly repo: ReadonlyArray<SkillRoot> } {
  const codex: ReadonlyArray<EngineId> = ["codex"];
  const caveman: ReadonlyArray<EngineId> = onComputer ? [] : ["caveman"];
  return {
    home: [
      { root: homes.claudeDir, dir: "skills", engines: ["claude-agent"] },
      // Codex reads it itself; the runtime gives it to Claude Agent (as a plugin) and the Caveman engine (PluginRegistry homeSkillRoots).
      { root: home, dir: ".agents/skills", engines: ["codex", "claude-agent", "caveman"] },
      ...(codexOwnHome ? [{ root: homes.codexHome, dir: "skills", engines: codex }] : []),
    ],
    repo: [
      { dir: ".claude/skills", engines: ["claude-agent", ...caveman] },
      { dir: ".agents/skills", engines: ["codex", ...caveman] },
    ],
  };
}

/** Plugin skills reach Claude Agent (plugin copy), Codex (skills index) and the Caveman engine (skill roots); ACP agents get MCP only. */
const PLUGIN_ENGINES: ReadonlyArray<EngineId> = ["claude-agent", "codex", "caveman"];

/** A skill's line in the skills index, at 4 bytes a token, the same estimate plugin.list makes. */
const indexTokens = (s: { readonly name: string; readonly description: string; readonly path: string }) =>
  Math.ceil(Buffer.byteLength(`- ${s.name}: ${s.description} (${s.path})`, "utf8") / 4);

/** A SKILL.md bigger than this is not a skill; it is never read. */
const MAX_SKILL_BYTES = 1024 * 1024;

/**
 * The skill folders directly under `dir`, each with a SKILL.md. A folder may
 * be a symlink (skill installers link ~/.claude/skills to ~/.agents/skills),
 * as Claude Code and Codex follow them, but the file must really live inside
 * one of `within`: a cloned repo's SKILL.md linked to ~/.aws/credentials is
 * left out, so skill.read can never hand that file to a client.
 */
async function scanSkillDir(dir: string, within: ReadonlyArray<string>): Promise<Array<{ name: string; description: string; path: string }>> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const roots = await Promise.all(within.map((root) => fs.promises.realpath(root).catch(() => undefined)));
  const out: Array<{ name: string; description: string; path: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    const real = await fs.promises.realpath(file).catch(() => undefined);
    if (real === undefined || !roots.some((root) => root !== undefined && real.startsWith(`${root}${path.sep}`))) continue;
    const size = (await fs.promises.stat(real).catch(() => undefined))?.size ?? Infinity;
    const text = size <= MAX_SKILL_BYTES ? await fs.promises.readFile(real, "utf8").catch(() => undefined) : undefined;
    if (text === undefined) continue;
    const { data } = parseFrontmatter(text);
    const field = (key: string) => (typeof data[key] === "string" && data[key].trim() !== "" ? data[key].trim() : undefined);
    // The real path, checked above: skill.read reads exactly this file.
    out.push({ name: field("name") ?? entry.name, description: field("description") ?? "", path: real });
  }
  return out;
}

/**
 * Reads a SKILL.md skill.list listed (a real path, checked inside its root then). Refused when the path
 * is no longer its own real path (a folder on it was swapped for a link since), when it is a link, or
 * when it is over 1 MiB.
 */
export async function readListedSkill(file: string): Promise<string> {
  if ((await fs.promises.realpath(file)) !== file) throw new Error(`${file} moved since it was listed`);
  const handle = await openNoFollow(file, fs.constants.O_RDONLY);
  try {
    if ((await handle.stat()).size > MAX_SKILL_BYTES) throw new Error(`${file} is over 1 MiB`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Every skill an engine can load: plugins' first, then home folders, then each project's repository. Reads only. */
export async function listSkills(input: {
  readonly homes: SetupHomes;
  readonly home: string;
  readonly codexOwnHome: boolean;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly root: string }>;
  readonly plugins: ReadonlyArray<{ readonly plugin: LoadedPlugin; readonly enabled: boolean }>;
  /** A Cloud computer: the Caveman engine does not read the repository's own skills there. */
  readonly onComputer?: boolean;
}): Promise<Array<typeof SkillInfo.Type>> {
  const roots = rootsFor(input.homes, input.home, input.codexOwnHome, input.onComputer === true);
  const out: Array<typeof SkillInfo.Type> = [];
  for (const { plugin, enabled } of input.plugins) {
    for (const s of plugin.skills) {
      out.push({ name: s.name, description: s.description, scope: "plugin", path: s.path, engines: [...PLUGIN_ENGINES], plugin_id: plugin.id, marketplace: plugin.space, enabled, idle_tokens_estimate: indexTokens(s) });
    }
  }
  // One row per file: a skill linked into both Claude's and Codex's folders lists once, with both engines.
  const byFile = new Map<string, typeof SkillInfo.Type>();
  const add = async (s: { name: string; description: string; path: string }, engines: ReadonlyArray<EngineId>, project?: string) => {
    const key = `${project ?? ""}\0${await fs.promises.realpath(s.path).catch(() => s.path)}`;
    const seen = byFile.get(key);
    if (seen) {
      byFile.set(key, { ...seen, engines: [...new Set([...seen.engines, ...engines])] });
      return;
    }
    const row = { name: s.name, description: s.description, scope: project === undefined ? ("me" as const) : ("project" as const), path: s.path, engines: [...engines], enabled: true, idle_tokens_estimate: indexTokens(s) };
    byFile.set(key, project === undefined ? row : { ...row, project_id: project });
  };
  for (const { root, dir, engines } of roots.home) {
    for (const s of await scanSkillDir(path.join(root, dir), [input.home, root])) await add(s, engines);
  }
  for (const project of input.projects) {
    for (const { dir, engines } of roots.repo) {
      for (const s of await scanSkillDir(path.join(project.root, dir), [project.root])) await add(s, engines, project.id);
    }
  }
  return [...out, ...byFile.values()];
}
