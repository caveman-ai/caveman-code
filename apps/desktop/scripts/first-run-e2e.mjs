// The first run on a computer that has never seen Caveman Code, through the real window, end to end: the packaged or
// installed app starts from empty profile, state and home folders; this script drives its page over the DevTools
// protocol (playwright-core's CDP client, never the app's own code) and fails on the first step that does not hold.
//
//   1. The window's first screen is the first run (sign-in), never the empty shell, while the runtime starts; it says
//      it is starting, and its ways in turn on when the runtime answers. (A Windows laptop showed the empty shell for
//      the runtime's whole cold start.)
//   2. Sign in through Caveman Cloud's device flow, approved as the activate page approves it: a real Cloud
//      (CAVEMAN_E2E_CLOUD_URL, CAVEMAN_E2E_EMAIL, CAVEMAN_E2E_PASSWORD) or test/e2e-cloud.mjs where none is reachable.
//      Signed in, the page reads Cloud's list of the person's chats and computers, and the window still draws: the
//      stand-in lists another Mac of theirs Cloud has never heard from, as two such Macs once left it blank (0.1.5).
//   3. Your setup finds Claude Code on this computer (the stand-in CLI, scripts/smoke-claude.mjs, reporting
//      SMOKE_CLAUDE_VERSION 2.1.270: a Claude Code from before Opus 5.5), and the project step sets up a local repo.
//   4. The tour runs over the real shell and ends. Only then does the app ask about syncing chats, once; Not now
//      copies nothing and leaves the question in Getting started.
//   5. The model picker lists Claude Opus 5.5 on that older Claude Code (it says what it needs).
//   6. A Chief turn that answers, runs three tool calls and signs off shows its answer as messages with its steps out
//      of view (the Chief's conversation is a messenger: no Worked fold), and a reply a steer cuts off leaves no half
//      line.
//   7. Caveman Code updates that Claude Code with its own updater (`claude update`), and Opus 5.5 runs on it.
//
//   node apps/desktop/scripts/first-run-e2e.mjs --packaged          the app scripts/package.mjs built
//   node apps/desktop/scripts/first-run-e2e.mjs --app <executable>  another copy, e.g. the installed Caveman Code.exe
//   --out <dir>                                                     where the pictures and report.json go
//   --without-git                                                   a Mac without Apple's Command Line Tools: Your setup
//                                                                   and the project step say git is missing (steps 1-3)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { realCloud, startE2eCloud } from "../test/e2e-cloud.mjs";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(desktopDir, "../..");
const win = process.platform === "win32";
const mac = process.platform === "darwin";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const built = win ? "release/win-unpacked/Caveman Code.exe" : `release/${process.arch === "x64" ? "mac" : `mac-${process.arch}`}/Caveman Code.app/Contents/MacOS/Caveman Code`;
const app = arg("--app") ? resolve(arg("--app")) : join(desktopDir, built);
if (!existsSync(app)) throw new Error(`${app} does not exist: run scripts/package.mjs first, or pass --app`);
const out = resolve(arg("--out") ?? join(desktopDir, "dist-electron", "first-run-e2e"));
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(join(repoDir, "packages/runtime/package.json"))("playwright-core");

const report = { platform: `${process.platform}-${process.arch}`, app, steps: [], timeline: [] };
const t0 = Date.now();
const since = () => Date.now() - t0;
const step = (name, detail = {}) => {
  report.steps.push({ name, at_ms: since(), ...detail });
  console.log(`[${(since() / 1000).toFixed(1)}s] ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
};
const fail = (why) => {
  throw new Error(why);
};

// --- A computer that has never seen Caveman Code: every folder the app, its runtime and the CLIs read is new.
const temp = mkdtempSync(join(tmpdir(), "caveman-first-run-"));
const home = join(temp, "home");
const userData = join(temp, "user-data");
mkdirSync(home, { recursive: true });
mkdirSync(userData, { recursive: true });
// Claude Code on this computer: the stand-in CLI as `claude`, reporting a version from before Opus 5.5.
const bin = join(temp, "bin");
mkdirSync(bin);
const standIn = join(repoDir, "packages/runtime/scripts/smoke-claude.mjs");
if (win) {
  writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "${standIn}" %*\r\n`);
  // The Agent SDK can't spawn a .cmd: the runtime follows an npm shim to the package entry beside it
  // (ClaudeExecutable.ts), so the stand-in has one. No package.json: then the updater can't take it for an npm global
  // install and runs its own `claude update`, as a native install's (a real npm install updates through npm).
  const entry = join(bin, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "cli.js"), `import(${JSON.stringify(pathToFileURL(standIn).href)});\n`);
} else {
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${standIn}" "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);
}
// A repository to set up, as one a person cloned.
const repo = join(home, "code", "demo-app");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "README.md"), "# demo-app\n");
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo-app", scripts: { test: "node -e 0" } }, null, 2));
for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "commit", "-qm", "init"]])
  if (spawnSync("git", args, { cwd: repo, stdio: "ignore" }).status !== 0) fail(`git ${args[0]} failed: is git installed?`);
// The macOS app outside Applications asks to move there first; this run says Not Now for its version, as a person might.
if (mac) {
  const plist = readFileSync(resolve(dirname(app), "../Info.plist"), "utf8");
  const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  writeFileSync(join(userData, "move-to-applications.json"), JSON.stringify({ notNow: version }));
}

const cloudUrl = process.env.CAVEMAN_E2E_CLOUD_URL;
const cloud = cloudUrl ? await realCloud(cloudUrl, process.env.CAVEMAN_E2E_EMAIL, process.env.CAVEMAN_E2E_PASSWORD) : await startE2eCloud();
step("cloud", { origin: cloud.origin, real: Boolean(cloudUrl) });

// --without-git: a Mac that never installed Apple's Command Line Tools. Its /usr/bin/git is Apple's stub; no developer
// folder holds git (DEVELOPER_DIR names an empty one, which xcode-select then reports, and the stub then fails without
// opening Apple's installer); and its login shell's PATH is Apple's own, with nothing Homebrew added. The run checks Your
// setup and the project step say so and offer the install, then stops.
const withoutGit = process.argv.includes("--without-git");
if (withoutGit && !mac) throw new Error("--without-git is a Mac without the Command Line Tools");
const noDeveloperTools = join(temp, "no-developer-tools");
const freshLoginShell = join(temp, "fresh-mac-login-shell");
if (withoutGit) {
  mkdirSync(noDeveloperTools);
  // Called as `<shell> -ilc <command>`: runs the command with a fresh Mac's PATH.
  writeFileSync(freshLoginShell, `#!/bin/sh\nPATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH\nwhile [ $# -gt 1 ]; do shift; done\nexec /bin/sh -c "$1"\n`);
  chmodSync(freshLoginShell, 0o755);
}

// The PATH of a fresh login: the system's, then the stand-in claude (and git, which the project step needs).
const gitDir = dirname(spawnSync(win ? "where" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim());
const basePath = win ? process.env.PATH : "/usr/bin:/bin:/usr/sbin:/sbin";
const env = {
  ...(win ? process.env : { LANG: "en_US.UTF-8", TMPDIR: tmpdir(), USER: process.env.USER, LOGNAME: process.env.LOGNAME, SHELL: withoutGit ? freshLoginShell : "/bin/zsh" }),
  ...(withoutGit ? { DEVELOPER_DIR: noDeveloperTools } : {}),
  HOME: home,
  ...(win ? { USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") } : {}),
  PATH: (withoutGit ? [bin, basePath] : [bin, gitDir, basePath]).join(win ? ";" : ":"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: join(home, ".config"),
  SMOKE_CLAUDE_VERSION: process.env.SMOKE_CLAUDE_VERSION ?? "2.1.270",
  // What `claude update` brings it to, as the real updater would: a Claude Code that runs every bundled model itself.
  SMOKE_CLAUDE_UPDATE_TO: "2.1.321",
  // The bundled model list only: a model models.dev lists tomorrow would need a newer Claude Code than the stand-in's.
  CAVEMAN_MODELS_DEV_URL: "off",
  SMOKE_CLAUDE_VERSION_FILE: join(temp, "claude-version"),
  // The update holds until step 5 has seen the picker on the old Claude Code.
  SMOKE_CLAUDE_UPDATE_GATE: join(temp, "claude-update-may-finish"),
  CAVEMAN_CLOUD_URL: cloud.origin,
  // Test builds only (scripts/package.mjs without --release): no update download, no telemetry leaving this computer.
  CAVEMAN_UPDATE_FEED_URL: `${cloud.origin}/e2e-no-updates`,
  CAVEMAN_TELEMETRY_URL: `${cloud.origin}/e2e-telemetry`,
};
delete env.ELECTRON_RUN_AS_NODE;

// --use-mock-keychain: a test build is ad-hoc signed, so on a Mac that has the release app, Chromium's safe storage
// key ("Caveman Code Safe Storage" in the login keychain) belongs to another signature and macOS asks for the login
// password before the window opens. The test keeps off the person's keychain.
const child = spawn(app, [`--user-data-dir=${userData}`, "--remote-debugging-port=0", ...(mac ? ["--use-mock-keychain"] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const s of [child.stdout, child.stderr]) s.on("data", (d) => (output += d));
/** The window's DevTools port, as Chromium prints it once it listens. */
const devtoolsPort = () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
step("launched", { pid: child.pid });
const killApp = () => {
  if (child.exitCode !== null) return;
  if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
};

let browser;
let page;
const shot = async (name) => {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  report.steps.at(-1).picture = file;
  return file;
};
const until = async (what, check, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out after ${timeoutMs} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** Every step, in order; each fails the run with fail() or a timeout. The --without-git run ends after the project step. */
const steps = async () => {
  // --- 1. The first screen.
  const port = await until("the window's DevTools endpoint", async () => devtoolsPort(), 60_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
  page = await until("the app's page", async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("caveman-code://app/") && !p.url().includes("capture")), 60_000);
  step("attached", { page: page.url() });
  // What the window shows, every 100 ms, from the first frame the page has until the first run's ways in turn on.
  const seen = () =>
    page.evaluate(() => ({
      firstRun: document.querySelector('ol[aria-label="Setup steps"]') !== null,
      shell: document.querySelector("aside[data-sidebar]") !== null,
      starting: /Starting Caveman Code/.test(document.body.innerText),
      ready: [...document.querySelectorAll("button")].some((b) => /Continue with GitHub/.test(b.textContent ?? "") && !b.disabled),
    }));
  let firstFrame = null;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
    const now = await seen().catch(() => null);
    if (now) {
      report.timeline.push({ at_ms: since(), ...now });
      if (now.shell) fail(`the empty shell showed at ${since()} ms, before the first run`);
      if (now.firstRun && firstFrame === null) {
        firstFrame = since();
        step("first run on screen", { starting: now.starting });
        await shot("1-first-screen");
      }
      if (now.ready) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (firstFrame === null) fail("the first run never showed");
  const ready = report.timeline.find((f) => f.ready);
  if (!ready) fail("the sign-in buttons never turned on: the runtime never answered");
  step("runtime answered; ways in on", { first_run_ms: firstFrame, ready_ms: ready.at_ms, said_starting: report.timeline.some((f) => f.starting) });
  await shot("2-sign-in-ready");

  // --- 2. Sign in through the device flow. The browser it would open is caught: the page's window.open.
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url) => (window.__opened.push(String(url)), null);
  });
  await page.getByRole("button", { name: /Continue with GitHub/ }).click();
  const opened = await until("the sign-in page link", () => page.evaluate(() => window.__opened[0]), 30_000);
  if (new URL(opened).origin !== new URL(cloud.origin).origin) fail(`the sign-in opened ${opened}, not ${cloud.origin}`);
  const code = await until("the code to approve on screen", () => page.evaluate(() => /Only approve the code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(document.body.innerText)?.[1]), 30_000);
  if (new URL(opened).searchParams.get("user_code") !== code) fail(`the page shows ${code}, the link carries ${new URL(opened).searchParams.get("user_code")}`);
  step("device sign-in waiting in the browser", { link: opened.replace(/user_code=[^&]+/, "user_code=…"), code });
  await shot("3-finish-in-browser");
  await cloud.approve(code);
  const signedIn = await until(
    "Welcome",
    async () => ((await page.evaluate(() => document.getElementById("root")?.childElementCount === 0)) ? "blank" : (await page.getByRole("heading", { name: /^Welcome/ }).isVisible()) && "welcome"),
    60_000,
  );
  if (signedIn === "blank") fail("the window drew nothing after sign-in");
  step("signed in", { title: await page.getByRole("heading", { name: /^Welcome/ }).textContent() });
  if (!cloudUrl) {
    await until("Cloud's chat list read by the page", async () => cloud.requests.some((r) => r.method === "GET" && r.path === "/api/v1/code/chats"), 30_000);
    // A frame or two for what the list changes to draw, or to throw.
    await new Promise((r) => setTimeout(r, 1_000));
    if (!(await page.getByRole("heading", { name: /^Welcome/ }).isVisible())) fail(`the window stopped drawing once Cloud's list came: ${(await page.evaluate(() => document.body.innerText)).slice(0, 200) || "nothing on it"}`);
    step("Cloud's list read; the window still draws");
  }
  await shot("4-signed-in");
  await page.getByRole("button", { name: /^Continue/ }).click();

  // --- 3. Your setup, then the project.
  await until("Your setup to finish looking", () => page.getByRole("heading", { name: /Here's what you already have|Nothing to run on yet/ }).isVisible(), 90_000);
  const setupTitle = await page.getByRole("heading", { name: /Here's what you already have|Nothing to run on yet/ }).textContent();
  const setupText = await page.evaluate(() => document.body.innerText);
  step("your setup", { title: setupTitle, claude_found: /Runs Claude Agent/.test(setupText) });
  await shot("5-your-setup");
  if (!/Runs Claude Agent/.test(setupText)) fail("Your setup did not find Claude Code on this computer");
  if (withoutGit) {
    // Your setup says git is missing and offers Apple's installer; the project step says it again, and adding a folder
    // fails with that reason, not "is not a git repository".
    await until("the Tools card", () => page.getByRole("button", { name: "Install developer tools" }).isVisible(), 30_000);
    const said = await page.evaluate(() => document.body.innerText);
    step("Your setup says git is missing", { card: /Git comes with Apple's Command Line Tools/.test(said) });
    await shot("5b-your-setup-without-git");
    if (!/Git comes with Apple's Command Line Tools/.test(said)) fail("Your setup does not say git is missing");
    await page.getByRole("button", { name: /^Continue/ }).click();
    await until("Pick a project", () => page.getByRole("heading", { name: "Pick a project" }).isVisible(), 30_000);
    await until("the Tools card on the project step", () => page.getByRole("button", { name: "Install developer tools" }).isVisible(), 30_000);
    await page.getByRole("combobox", { name: "Folder path, or search" }).fill(repo);
    await until("Add to turn on for the pasted path", () => page.getByRole("button", { name: "Add", exact: true }).isEnabled(), 30_000);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const refusal = await until("adding the folder to fail", () => page.locator('[role="alert"]').filter({ hasText: /\S/ }).first().textContent(), 60_000);
    step("adding a folder says why", { refusal });
    await shot("6b-pick-a-project-without-git");
    if (!/Command Line Tools/.test(refusal)) fail(`adding a folder without git said: ${refusal}`);
    return;
  }
  await page.getByRole("button", { name: /^Continue/ }).click();
  await until("Pick a project", () => page.getByRole("heading", { name: "Pick a project" }).isVisible(), 30_000);
  // The path pasted, as a person whose repo the scan has not found would; then Add.
  await page.getByRole("combobox", { name: "Folder path, or search" }).fill(repo);
  await until("Add to turn on for the pasted path", () => page.getByRole("button", { name: "Add", exact: true }).isEnabled(), 30_000);
  await shot("6-pick-a-project");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await until("the project set up", () => page.getByRole("button", { name: /Show me around/ }).isEnabled(), 120_000);
  step("project set up", { heading: await page.locator("h1").first().textContent() });
  await shot("7-project-ready");
  await page.getByRole("button", { name: /Show me around/ }).click();

  // --- 4. The tour over the real shell, every stop.
  await until("the tour", () => page.getByRole("dialog", { name: "Tour" }).isVisible(), 30_000);
  await shot("8-tour");
  let stops = 0;
  for (; stops < 12; stops++) {
    const last = page.getByRole("button", { name: "Start building" });
    if (await last.isVisible().catch(() => false)) {
      await last.click();
      break;
    }
    await page.getByRole("button", { name: "Next" }).click();
  }
  await until("the tour to end", async () => !(await page.getByRole("dialog", { name: "Tour" }).isVisible()), 15_000);
  step("tour ended over the shell", { stops: stops + 1, shell: await page.locator("aside[data-sidebar]").isVisible() });
  await shot("9-shell");

  // Signed in and never asked: the sync question comes up over the shell, after the tour and never over it. Not now
  // closes it with nothing turned on, and it waits as a step in Getting started.
  const syncAsk = page.getByRole("dialog", { name: "Your chats on every device" });
  await until("the sync question", () => syncAsk.isVisible(), 30_000);
  await shot("9b-sync-question");
  await syncAsk.getByRole("button", { name: "Not now" }).click();
  await until("the sync question to close", async () => !(await syncAsk.isVisible()), 15_000);
  await until("sync waiting in Getting started", () => page.getByRole("button", { name: "Sync chats to your devices" }).isVisible(), 15_000);
  step("sync put off: it waits in Getting started");
  await shot("9c-sync-in-getting-started");

  // --- 5. The model picker on a Claude Code from before Opus 5.5.
  await page.evaluate(() => (location.hash = "#/new"));
  const picker = page.getByRole("button", { name: /^Model: |^Choose a model/ }).first();
  await until("the model picker", () => picker.isVisible(), 30_000);
  await picker.click();
  await page.getByRole("combobox", { name: "Search models" }).fill("Opus");
  await until("Opus 5.5 in the picker", () => page.getByRole("option", { name: /Claude Opus 5\.5/ }).first().isVisible(), 30_000);
  const opusRows = await page.getByRole("option", { name: /Claude Opus/ }).evaluateAll((rows) => rows.map((r) => r.querySelector(".sr-only")?.textContent ?? r.textContent));
  const tip = await page.getByRole("option", { name: /Claude Opus 5\.5/ }).first().getAttribute("title");
  step("model picker lists Opus 5.5", { rows: opusRows, title: tip });
  await shot("10-model-picker-opus-5-5");
  // In its place: the newest Opus, above Opus 5 (not under Opus 4.5), saying what it needs.
  if (opusRows.indexOf("Claude Opus 5.5") !== opusRows.indexOf("Claude Opus 5") - 1) fail(`Opus 5.5 is not listed above Opus 5: ${opusRows.join(" | ")}`);
  if (!tip?.startsWith("Needs Claude Code 2.1.280")) fail(`Opus 5.5 on Claude Code 2.1.270 does not say what it needs: ${tip}`);
  writeFileSync(env.SMOKE_CLAUDE_UPDATE_GATE, "");
  await page.keyboard.press("Escape");

  // --- 6. A Chief turn: answer, three tool calls, sign-off; then a reply a steer cuts off.
  await page.evaluate(() => (location.hash = "#/chief"));
  // "Message <name>", or "Guide <name> while it works" while it thinks.
  const box = page.getByPlaceholder(/^(Message|Guide) .+/);
  await until("the Chief's box", () => box.isVisible(), 60_000);
  const answer = "I coordinate your work: you type notes, and I sort each one, answering quick questions, queueing things for later, or starting chats that do the actual coding in your projects.";
  await box.fill(`chief-shape: ${answer}`);
  await box.press("Enter");
  await until("the Chief's sign-off", () => page.getByText("All set. Let me know what you'd like to work on.").isVisible(), 120_000);
  await until("the turn to settle", () => page.getByPlaceholder(/^Message .+/).isVisible(), 60_000);
  const shape = await page.evaluate((answerText) => {
    const visible = (el) => el !== null && el.getClientRects().length > 0;
    // The Chief's own reply: the person's message above it quotes the same words, and the reply's words are spans
    // while they fade in.
    const answerEl = [...document.querySelectorAll("[data-slot='message'][data-from='assistant']")].find((el) => el.textContent?.includes(answerText.slice(0, 40)));
    const folds = [...document.querySelectorAll("button[aria-expanded]")].filter((b) => /^Worked/.test(b.textContent ?? ""));
    const toolRows = [...document.querySelectorAll("*")].filter((el) => el.childElementCount === 0 && /echo item [123]|Update item [123]/.test(el.textContent ?? ""));
    return { answerVisible: visible(answerEl ?? null), asReply: answerEl !== undefined, folds: folds.length, toolRowsVisible: toolRows.filter(visible).length };
  }, answer);
  step("Chief turn settled", shape);
  await shot("11-chief-turn");
  if (!shape.answerVisible || !shape.asReply) fail("the Chief's answer is not a visible message");
  if (shape.folds > 0) fail("the Chief's conversation drew a Worked fold");
  if (shape.toolRowsVisible > 0) fail("the Chief's tool calls show in its conversation");

  const partial = "I'm the Chief for your Caveman Code setup. You type notes to me, and I sort each one: I answer quick questions, queue things for later, and start chats that do the coding in your projects. When one of";
  await box.fill(`steer-cut: ${partial}`);
  await box.press("Enter");
  // The half reply streams onto the screen (the stand-in holds it, unfinished) before the steer: what the Windows
  // install left behind as "I'm the Chief for your Caveman Code setup. You type notes to".
  const halfLineCount = () => page.evaluate(() => document.body.innerText.split("\n").filter((line) => line.startsWith("I'm the Chief for your Caveman Code setup. You type notes to")).length);
  await until("the half reply on screen", async () => (await halfLineCount()) > 0, 60_000);
  await shot("13-chief-streaming-before-steer");
  await box.fill("s");
  await box.press("Enter");
  // The stand-in answers with what it was sent: the Chief's note around the steer ("smoke ok: <note …> s </note>").
  await until("the steer's answer", () => page.getByText(/^smoke ok:/).first().isVisible(), 120_000);
  await new Promise((r) => setTimeout(r, 2_000));
  const halfLines = await halfLineCount();
  step("steered turn settled", { half_lines: halfLines });
  await shot("14-chief-after-steer");
  if (halfLines > 0) fail("a reply the steer cut off still shows");

  // --- 7. Caveman Code brought that Claude Code up to date with its own updater: Opus 5.5 runs on it now.
  await page.evaluate(() => (location.hash = "#/new"));
  await until("the model picker", () => picker.isVisible(), 30_000);
  const updated = await until(
    "Claude Code updated: Opus 5.5 runnable",
    async () => {
      await picker.click();
      await page.getByRole("combobox", { name: "Search models" }).fill("Opus 5.5");
      const title = await page.getByRole("option", { name: /Claude Opus 5\.5/ }).first().getAttribute("title", { timeout: 5_000 });
      const version = existsSync(env.SMOKE_CLAUDE_VERSION_FILE) ? readFileSync(env.SMOKE_CLAUDE_VERSION_FILE, "utf8").trim() : null;
      if (title?.startsWith("Needs ") || version !== env.SMOKE_CLAUDE_UPDATE_TO) {
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 2_000));
        return undefined;
      }
      return { version, title };
    },
    180_000,
  );
  step("Claude Code updated; Opus 5.5 runs on it", updated);
  await shot("15-model-picker-after-update");
  await page.keyboard.press("Escape");

};
try {
  await steps();
  report.passed = true;
  step("PASS");
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${report.error}`);
  try {
    if (page) await page.screenshot({ path: join(out, "failure.png") });
  } catch {}
} finally {
  report.requests = cloud.requests.map((r) => `${r.method} ${r.path}`);
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "app.log"), output);
  await browser?.close().catch(() => undefined);
  killApp();
  await new Promise((r) => setTimeout(r, 3_000));
  await cloud.close();
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    console.error(`could not remove ${temp}: ${error.message}`);
  }
  console.log(`report: ${join(out, "report.json")}`);
  process.exit(report.passed ? 0 : 1);
}
