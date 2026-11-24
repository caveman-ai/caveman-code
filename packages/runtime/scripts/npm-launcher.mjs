#!/usr/bin/env node
// `caveman-code`, the bin of the @caveman-ai/code npm package (scripts/pack-npm.ts copies this file to its
// bin/caveman-code.mjs): runs `caveman code` from @caveman-ai/code-<platform>-<arch>, the optional dependency
// npm installed for this machine, on this Node. `code` is an argument, so the runtime never guesses the
// command from how it was started: npm's Windows shim runs `node <this file>`, elsewhere a symlink does.
// Plain Node with no dependencies, , scripts/build-npm-platform-packages.ts).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Before it spawns: Windows looks for a bare command name in the current directory before PATH; off for this process
// and the runtime it starts (packages/shared/src/exeSearch.ts).
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const optional = own.optionalDependencies ?? {};
const key = `${process.platform}-${process.arch}`;
const name = `@caveman-ai/code-${key}`;

/**
 * This machine's platform package: only one this launcher lists, only where npm installs it for this launcher (its
 * own node_modules, or beside it in npm's flat layout), and only at this launcher's version. Never Node's module
 * search, which would also take one from any node_modules above the current folder or the launcher.
 */
function platformDir() {
  if (!Object.hasOwn(optional, name)) return undefined;
  for (const dir of [join(root, "node_modules", "@caveman-ai", `code-${key}`), join(root, "..", `code-${key}`)]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === name && pkg.version === own.version) return dir;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

const dir = platformDir();
if (dir === undefined) {
  const built = Object.keys(optional).map((dep) => dep.replace("@caveman-ai/code-", ""));
  process.stderr.write(
    `caveman-code: no Caveman Code build for ${key} is installed. There are builds for ${built.join(", ")}: ` +
      `if yours is one, install @caveman-ai/code again with optional dependencies on, so npm adds ${name}.\n`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [join(dir, "bin.mjs"), "code", ...process.argv.slice(2)], { stdio: "inherit" });
// `caveman code` stops its runtime on these signals. A terminal sends Ctrl-C and a hangup to both of us, so
// this process only waits for the child's exit; SIGTERM, sent to one process, is passed on. Windows has no
// signal to pass (Node ends another process outright there) and its console's Ctrl-C reaches every process in it.
for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
  process.on(signal, () => {
    if (signal === "SIGTERM" && process.platform !== "win32") child.kill(signal);
  });
}
child.on("error", (error) => {
  process.stderr.write(`caveman-code: ${process.execPath}: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 1)));
