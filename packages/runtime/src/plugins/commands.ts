/**
 * A plugin's commands (`commands/*.md`) on every engine. Claude Agent runs
 * them itself from the plugin copy, as `/<plugin>:<command>` (subfolders
 * become `plugin:dir:name`, verified on the CLI). Codex and the Caveman engine
 * have no plugin commands, so a message that starts with one is sent to them
 * as the command's text, the way Claude Code expands it (`$ARGUMENTS`, `$1`
 * to `$9`), framed as the Caveman SDK frames an invoked plugin command. The
 * transcript keeps what was typed.
 *
 * @module plugins/commands
 */
import * as fs from "node:fs/promises";

import { parseFrontmatter } from "./format.ts";
import type { PluginSession } from "./PluginRegistry.ts";

export interface PluginCommand {
  /** As typed after the slash: `<plugin>:<command>`. */
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

/** The commands of a checkout's plugin session, named as Claude names them. */
export function pluginCommandsOf(session: Pick<PluginSession, "bundle" | "plugins">): ReadonlyArray<PluginCommand> {
  return session.bundle.commands.flatMap((command) => {
    const plugin = session.plugins.find((p) => p.id === command.plugin);
    return plugin === undefined ? [] : [{ name: `${plugin.name}:${command.name}`, description: command.description, path: command.path }];
  });
}

/** The command a message starts with (`/plugin:command args`), and its arguments; undefined when it names none. */
export function leadingPluginCommand(text: string, commands: ReadonlyArray<PluginCommand>): { readonly command: PluginCommand; readonly args: string } | undefined {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null || !match[1]!.includes(":")) return undefined;
  const command = commands.find((c) => c.name === match[1]);
  return command === undefined ? undefined : { command, args: (match[2] ?? "").trim() };
}

/**
 * A command's text with its arguments in, as Claude Code fills them: `$ARGUMENTS` whole, `$1`.. by position.
 * Claude Code runs a command's !`cmd` lines before the turn, under its allowed-tools; nothing here runs a
 * plugin's shell outside the engine's own permissions, so each becomes an ask to run it first.
 */
export function fillCommand(body: string, args: string): string {
  const positional = args === "" ? [] : args.split(/\s+/);
  return body
    .replaceAll("$ARGUMENTS", args)
    .replace(/\$([1-9])/g, (_all, i: string) => positional[Number(i) - 1] ?? "")
    .replace(/!`([^`\n]+)`/g, "(run `$1` first and use its output)");
}

/**
 * What an engine without plugin commands gets for a message that starts with one, or undefined
 * (not a plugin command, or one whose file cannot be read: the message goes as typed).
 */
export async function expandPluginCommand(text: string, commands: ReadonlyArray<PluginCommand>): Promise<string | undefined> {
  const picked = leadingPluginCommand(text, commands);
  if (picked === undefined) return undefined;
  const markdown = await fs.readFile(picked.command.path, "utf8").catch(() => undefined);
  if (markdown === undefined) return undefined;
  const id = JSON.stringify(picked.command.name);
  return [
    `Execute explicitly invoked Agent Plugin command ${id}. Follow it for this turn.`,
    `<agent-plugin-command id=${id}>`,
    fillCommand(parseFrontmatter(markdown).body.trim(), picked.args),
    "</agent-plugin-command>",
    ...(picked.args === "" ? [] : ["User arguments:", picked.args]),
  ].join("\n\n");
}
