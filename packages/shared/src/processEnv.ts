// Environment allowlists that also hold on Windows, where names are case-insensitive (`Path` is PATH) and a
// process cannot start, open a socket or find its profile without a few variables POSIX has no use for.
// Plain Node: the runtime's launchers and the desktop main process use it without Effect.

/**
 * What a Windows child needs from its parent's environment whatever it does: Winsock and the loader read
 * SystemRoot/windir, cmd.exe and command lookup ComSpec and PATHEXT, temp files TEMP/TMP, and the profile
 * (Go's os.UserHomeDir, Node's os.homedir, app data) USERPROFILE, APPDATA, LOCALAPPDATA. None is a credential.
 */
export const WINDOWS_ESSENTIAL_ENV = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

/** The name `env` holds `name` under: itself off Windows; on Windows the first key equal ignoring case. */
export function envKey(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return name in env ? name : undefined;
  if (name in env) return name;
  const upper = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper);
}

/** `env[name]`, ignoring case on Windows. */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const key = envKey(env, name, platform);
  return key === undefined ? undefined : env[key];
}

/**
 * Only `names` from `env` (matched ignoring case on Windows, each kept under the name `env` uses), plus the
 * Windows essentials on win32.
 */
export function pickEnv(
  env: Readonly<Record<string, string | undefined>>,
  names: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  const wanted = platform === "win32" ? [...names, ...WINDOWS_ESSENTIAL_ENV] : names;
  for (const name of wanted) {
    const key = envKey(env, name, platform);
    if (key === undefined || key in out) continue;
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
