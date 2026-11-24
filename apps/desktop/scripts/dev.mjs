// pnpm --filter @caveman-app/desktop dev: build the web client, bundle the
// main process, and start Electron, which starts packages/runtime from source.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { hostCommand } from "../../../packages/runtime/scripts/hostCommand.ts";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
// pnpm is pnpm.cmd on Windows, which runs only through cmd.exe (hostCommand.ts).
const run = (command, args) => {
  const { file, args: argv, shell } = hostCommand(command, args);
  const result = spawnSync(file, argv, { cwd: desktopDir, shell, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("pnpm", ["--filter", "@caveman-app/web", "build"]);
run(process.execPath, ["scripts/build.mjs"]);

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".", ...process.argv.slice(2)], { cwd: desktopDir, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
