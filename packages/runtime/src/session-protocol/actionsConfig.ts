// `.caveman/actions.toml` (docs/computer-config.md "Actions"): the team's
// actions, one table per action in file order, on the same strict TOML
// subset as computer.toml. With [run].command and the project's own actions
// it is what a chat's Actions tab lists (actions.list).
import * as fs from "node:fs";
import * as path from "node:path";

import type { ActionIcon, ProjectAction } from "@caveman-app/session-protocol";

import { ComputerConfigError, parseTomlTables } from "./computerConfig.ts";

export const ACTIONS_PATH = ".caveman/actions.toml";

const ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ICONS: ReadonlyArray<ActionIcon> = ["play", "test", "lint", "configure", "build", "debug", "diff"];
const KEYS = { name: "string", command: "string", icon: "string" } as const;
/** Most suggestions offered: a monorepo's root can have dozens of scripts. */
const MAX_SUGGESTIONS = 12;

/**
 * Text that would show differently from what runs: control characters (a
 * newline hides the rest of a command in a one-line row), bidi overrides
 * and zero-width characters. A checkout's actions can come from an agent.
 */
const HIDDEN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
export const hidesText = (text: string) => HIDDEN.test(text);

/** A table without `name`: "db-migrate" reads "Db migrate". */
const titleOf = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");

/** Parses actions.toml. Empty text is no actions. */
export function parseActions(text: string): ProjectAction[] {
  const actions: ProjectAction[] = [];
  for (const [id, { line, values }] of parseTomlTables(text, ACTIONS_PATH, () => KEYS, "test")) {
    const fail = (message: string): never => {
      throw new ComputerConfigError(`${ACTIONS_PATH}:${line}: ${message}`);
    };
    if (!ID.test(id)) fail(`[${id}]: an action's table name is up to 24 lowercase letters, digits and dashes`);
    const command = (values.command as string | undefined)?.trim();
    if (!command) fail(`[${id}] has no command`);
    const icon = values.icon as string | undefined;
    if (icon !== undefined && !ICONS.includes(icon as ActionIcon)) fail(`[${id}] icon "${icon}" is not one of ${ICONS.join(", ")}`);
    const name = (values.name as string | undefined)?.trim() || titleOf(id);
    if (hidesText(command!) || hidesText(name)) fail(`[${id}] has a line break or an invisible character; an action is one line, chained with && if it must`);
    actions.push({ id, name, command: command!, ...(icon !== undefined ? { icon: icon as ActionIcon } : {}) });
  }
  return actions;
}

/** A checkout's actions.toml; none when it has no such file. Throws ComputerConfigError for a bad one. */
export function readActions(root: string): ProjectAction[] {
  const file = path.join(root, ACTIONS_PATH);
  return fs.existsSync(file) ? parseActions(fs.readFileSync(file, "utf8")) : [];
}

// npm runs these on its own (install, publish), or they are another script's pre/post hook.
const LIFECYCLE = new Set(["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare", "prepublish", "prepublishOnly", "prepack", "postpack", "publish", "postpublish", "preversion", "version", "postversion"]);

/** The package manager the checkout's lockfile names, then package.json's `packageManager`, else npm. */
function packageManagerOf(root: string, packageManager: unknown): string {
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "package-lock.json"))) return "npm";
  const named = typeof packageManager === "string" ? /^(bun|pnpm|yarn|npm)@/.exec(packageManager)?.[1] : undefined;
  return named ?? "npm";
}

/** package.json scripts that no command in `taken` runs yet, as `<manager> run <script>`. */
export function suggestActions(root: string, taken: ReadonlySet<string>): Array<{ name: string; command: string }> {
  let pkg: { scripts?: unknown; packageManager?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return [];
  }
  if (typeof pkg.scripts !== "object" || pkg.scripts === null) return [];
  const scripts = Object.entries(pkg.scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const names = new Set(scripts.map(([name]) => name));
  const manager = packageManagerOf(root, pkg.packageManager);
  const hook = (name: string) => /^(pre|post)/.test(name) && names.has(name.replace(/^(pre|post)/, ""));
  return scripts
    .filter(([name]) => !LIFECYCLE.has(name) && !hook(name))
    .filter(([name]) => !taken.has(`${manager} run ${name}`) && !taken.has(`${manager} ${name}`))
    .slice(0, MAX_SUGGESTIONS)
    .map(([name]) => ({ name, command: `${manager} run ${name}` }));
}
