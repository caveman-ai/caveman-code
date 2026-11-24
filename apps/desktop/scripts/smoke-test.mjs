// ), apps/desktop/scripts/smoke-test.mjs @ ab3a3cd1.
// Launches the built app with --smoke-test (window never shown). Main waits
// for the runtime child to answer Session Protocol engine.list with the token,
// the page repeats the call through window.cavemanDesktop, then the app quits
// and stops the runtime. --fixture runs the stand-in in test/ instead of
// packages/runtime. --packaged launches the app scripts/package.mjs built
// (release/mac-*/Caveman Code.app, release/win-unpacked/Caveman Code.exe)
// instead of the dev build; --app <executable> launches that one, for example
// the installed %LOCALAPPDATA%\Programs\caveman-code\Caveman Code.exe. Every
// config dir the runtime could touch is a temp dir.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { hostCommand } from "../../../packages/runtime/scripts/hostCommand.ts";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const win = process.platform === "win32";
const fixture = process.argv.includes("--fixture");
const appArg = process.argv.indexOf("--app");
const appOverride = appArg < 0 ? undefined : process.argv[appArg + 1];
if (appArg >= 0 && !appOverride) throw new Error("--app needs the app's executable");
const packaged = process.argv.includes("--packaged") || appOverride !== undefined;

if (!existsSync(join(desktopDir, "../web/dist/index.html"))) {
  // pnpm is pnpm.cmd on Windows, which runs only through cmd.exe (hostCommand.ts).
  const web = hostCommand("pnpm", ["--filter", "@caveman-app/web", "build"]);
  spawnSync(web.file, web.args, { shell: web.shell, stdio: "inherit" });
}
if (!packaged) {
  const built = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: desktopDir, stdio: "inherit" });
  if (built.status !== 0) process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "caveman-desktop-smoke-"));
const env = {
  ...process.env,
  HOME: temp,
  // Windows' os.homedir() reads USERPROFILE, and apps keep their config in APPDATA and LOCALAPPDATA.
  ...(win ? { USERPROFILE: temp, APPDATA: join(temp, "AppData", "Roaming"), LOCALAPPDATA: join(temp, "AppData", "Local") } : {}),
  CLAUDE_CONFIG_DIR: join(temp, "claude"),
  CODEX_HOME: join(temp, "codex"),
  XDG_CONFIG_HOME: join(temp, "config"),
  ELECTRON_ENABLE_LOGGING: "1",
  ...(fixture ? { CAVEMAN_RUNTIME_ENTRY: join(desktopDir, "test/fixture-runtime.mjs") } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;

const built = win
  ? `release/${process.arch === "x64" ? "win-unpacked" : `win-${process.arch}-unpacked`}/Caveman Code.exe`
  : `release/${process.arch === "x64" ? "mac" : `mac-${process.arch}`}/Caveman Code.app/Contents/MacOS/Caveman Code`;
const app = appOverride === undefined ? join(desktopDir, built) : resolve(appOverride);
if (packaged && !existsSync(app)) throw new Error(`${app} does not exist: run scripts/package.mjs first`);
const [executable, ...appArgs] = packaged ? [app] : [createRequire(import.meta.url)("electron"), "."];
console.log(`Launching ${packaged ? app : "Electron"} smoke test (${fixture ? "fixture runtime" : "packages/runtime"})...`);
const started = Date.now();
const child = spawn(executable, [...appArgs, "--smoke-test", `--user-data-dir=${join(temp, "user-data")}`], {
  cwd: desktopDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
// The app and its runtime: on Windows killing the app alone would leave the runtime holding the temp dir.
const timeout = setTimeout(() => {
  if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}, 90_000);

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  mkdirSync(join(desktopDir, "dist-electron"), { recursive: true });
  const shot = join(temp, "user-data", "smoke.png");
  if (existsSync(shot)) copyFileSync(shot, join(desktopDir, "dist-electron", packaged ? "smoke-packaged.png" : "smoke.png"));
  const capShot = join(temp, "user-data", "smoke-capture.png");
  if (existsSync(capShot)) copyFileSync(capShot, join(desktopDir, "dist-electron", packaged ? "smoke-capture-packaged.png" : "smoke-capture.png"));
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    // Still in use: a process the app started outlived it.
    console.error(`could not remove ${temp}: ${error.message}`);
  }
  const lines = output.split(/\r?\n/).filter((line) => /SMOKE|runtime:|capture:|fixture runtime|Content Security Policy|Uncaught/.test(line));
  console.log(lines.join("\n"));
  const fatal = ["Cannot find module", "MODULE_NOT_FOUND", "Refused to", "Uncaught Error", "Uncaught TypeError", "Uncaught ReferenceError", "Debugger listening"].filter((p) =>
    output.includes(p),
  );
  const passed = code === 0 && output.includes("SMOKE PASS") && fatal.length === 0;
  console.log(`electron exit code=${code} signal=${signal} after ${Date.now() - started} ms`);
  if (!passed) {
    console.error(`\nDesktop smoke test failed${fatal.length ? `: ${fatal.join(", ")}` : ""}\n\nFull output:\n${output}`);
    process.exit(1);
  }
  console.log("Desktop smoke test passed.");
});
