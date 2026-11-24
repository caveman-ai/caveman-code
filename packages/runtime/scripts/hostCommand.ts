// A command a person installed (pnpm, npm), as a build script spawns it. On win32 those are .cmd shims,
// which Node runs only through cmd.exe, and passing args with `shell: true` prints DEP0190: so the line is
// escaped here, as @caveman-app/shared shell's resolveSpawnCommand escapes it (cross-spawn's rules), and
// handed over as the command with no args. Elsewhere the command runs as is, without a shell.
//
//   const pnpm = hostCommand("pnpm", ["--filter", "@caveman-app/web", "build"]);
//   spawnSync(pnpm.file, pnpm.args, { shell: pnpm.shell, stdio: "inherit" });

/** cmd.exe's metacharacters; `"` among them, so cmd never enters a quoted run and every caret applies. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for `cmd.exe /d /s /c`: quoted for CommandLineToArgvW, then cmd's metacharacters escaped. */
export const escapeCmdArg = (arg: string): string =>
  `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1");

export interface HostCommand {
  readonly file: string;
  readonly args: Array<string>;
  readonly shell: boolean;
}

/**
 * `command` with `args`, spawnable on this platform: on win32 a bare name (pnpm, npm: found on PATH, maybe a
 * .cmd shim) goes through cmd.exe; a path (process.execPath, an .exe) always runs directly.
 */
export function hostCommand(command: string, args: ReadonlyArray<string>, platform: NodeJS.Platform = process.platform): HostCommand {
  if (platform !== "win32" || /[\\/]/.test(command)) return { file: command, args: [...args], shell: false };
  if (!/^[\w.-]+$/.test(command)) throw new Error(`hostCommand: ${command} is neither a path nor a bare command name`);
  return { file: [command, ...args.map(escapeCmdArg)].join(" "), args: [], shell: true };
}

/** A .cmd or .bat file by its path (npm's bin shims on Windows), through cmd.exe. */
export const cmdFile = (file: string, args: ReadonlyArray<string>): HostCommand => ({
  file: [file, ...args].map(escapeCmdArg).join(" "),
  args: [],
  shell: true,
});
