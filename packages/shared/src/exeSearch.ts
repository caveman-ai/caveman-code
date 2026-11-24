// Plain Node, no imports: the runtime's entry calls it before anything spawns.

/**
 * Windows looks for a bare command name (`git`, `taskkill`) in the current directory before PATH: libuv's search
 * for Node's spawn starts in the child's `cwd` (or this process's own), so a project holding a `git.exe` would run
 * it. NoDefaultCurrentDirectoryInExePath in this process's own environment turns that off for every spawn it makes
 * and is inherited by the shells it starts; set only in a child's env, it does nothing for the spawn itself
 * (exeSearch.test.ts proves both on Windows). The desktop's main process (apps/desktop/src/main.ts) and the npm
 * launcher (scripts/npm-launcher.mjs) set it the same way. A no-op elsewhere.
 */
export function stopCurrentDirectoryExeSearch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") env.NoDefaultCurrentDirectoryInExePath = "1";
}
