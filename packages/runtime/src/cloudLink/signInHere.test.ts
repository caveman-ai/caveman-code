// The sign-in on a Cloud computer, made in the runtime container (signInHere.ts, security ruling S-R3), against a
// pretend claude and codex (node scripts, run with pipes here; a pty in the runtime) and a pretend Caveman Cloud. A
// pretend tools process watches everything the tools container can see the whole time and never finds a real token.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FollowedLogins, type FollowedCloud, type LoginProfile } from "./engineLogins.ts";
import { pageCode, SIGN_INS_DIR, SignInsHere, type SpawnLogin } from "./signInHere.ts";

const REAL = {
  claudeAccess: ("sk-" + "ant-oat01-REALFIXTURE-signin-access"),
  claudeRefresh: ("sk-" + "ant-ort01-REALFIXTURE-signin-refresh"),
  codexAccess: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJSRUFMRklYVFVSRSJ9.REALFIXTURE-codex-access",
  codexRefresh: "rt_REALFIXTURE-codex-signin-refresh",
};

let root = "";
let stateDir = "";
let toolsHome = "";
let codexHome = "";
let report = "";
let scripts = "";

/** A pretend claude and codex: print their page, take the page code (claude), write their credential, end. */
const writeClis = (behaviour: { claudeExit?: number } = {}) => {
  const common = `
const fs = require("node:fs");
const dir = process.env.CLAUDE_CONFIG_DIR ?? process.env.CODEX_HOME;
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ argv: process.argv.slice(2), dir, home: process.env.HOME, cwd: process.cwd(), mode: fs.statSync(dir).mode & 0o777, env: Object.keys(process.env) }) + "\\n");
`;
  fs.writeFileSync(
    path.join(scripts, "claude.cjs"),
    `${common}
process.stdout.write("Browser didn't open? Use the url below to sign in\\r\\n\\x1b[1mhttps://claude.com/cai/oauth/authorize?code=true&client_id=c&state=st4te\\x1b[0m\\r\\nPaste code here if prompted > ");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\r")) return;
  const line = input.split("\\r")[0];
  if (line !== "thecode1234#st4te") { process.stdout.write("Invalid code\\r\\n"); process.exit(1); }
  ${behaviour.claudeExit === undefined ? "" : `process.exit(${behaviour.claudeExit});`}
  fs.writeFileSync(dir + "/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: ${JSON.stringify(REAL.claudeAccess)}, refreshToken: ${JSON.stringify(REAL.claudeRefresh)}, expiresAt: Date.now() + 8 * 3600000, scopes: ["user:inference"], subscriptionType: "max" } }), { mode: 0o600 });
  process.stdout.write("Login successful.\\r\\n");
  process.exit(0);
});
`,
  );
  fs.writeFileSync(
    path.join(scripts, "codex.cjs"),
    `${common}
process.stdout.write("Follow these steps to sign in with ChatGPT using device code authorization:\\n1. Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n2. Enter this one-time code (expires in 15 minutes)\\n   WXYZ-12345\\n");
setTimeout(() => {
  fs.writeFileSync(dir + "/auth.json", JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFAYi5jIn0.x", access_token: ${JSON.stringify(REAL.codexAccess)}, refresh_token: ${JSON.stringify(REAL.codexRefresh)}, account_id: "acct-1" } }), { mode: 0o600 });
  process.exit(0);
}, 300);
`,
  );
};

/** Starts a pretend CLI with pipes (the runtime's pty gives the real one a terminal). */
const pipeSpawn =
  (started: Array<{ command: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }>): SpawnLogin =>
  async (input) => {
    started.push({ command: input.command, args: input.args, env: input.env });
    const child = spawn(process.execPath, [path.join(scripts, input.command.endsWith("claude") ? "claude.cjs" : "codex.cjs"), ...input.args], { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] });
    // A CLI that already ended takes no more input: not a failure of the test.
    child.stdin.on("error", () => undefined);
    return {
      write: (data) => void child.stdin.write(data),
      kill: () => void child.kill(),
      onData: (listener) => {
        child.stdout.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
      },
      onExit: (listener) => void child.on("exit", (code) => listener(code ?? 1)),
    };
  };

/** A pretend Caveman Cloud's runtime routes, in memory. */
const fakeCloud = () => {
  const puts: Array<{ engine: string; body: { consent: true; credential: { access_token: string; refresh_token: string }; profile: LoginProfile; label: string } }> = [];
  const cloud: FollowedCloud = {
    list: async () => [],
    lanes: async () => ({ followed: [] }),
    get: async () => undefined,
    refresh: async () => {
      throw new Error("no refresh here");
    },
    put: async (engine, body) => {
      puts.push({ engine, body });
      return { version: puts.length };
    },
    remove: async () => undefined,
  };
  return { cloud, puts };
};

/** A tools process: reads everything the tools container can see, every few milliseconds, and keeps what it found. */
const toolsWatcher = () => {
  const found: string[] = [];
  let stop = false;
  const scan = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
      for (const value of Object.values(REAL)) if (text.includes(value)) found.push(`${entry.name}: ${value}`);
    }
  };
  const loop = (async () => {
    while (!stop) {
      // The tools container mounts its home, the active Codex home, and two read-only state folders: never sign-ins.
      for (const dir of [toolsHome, codexHome, path.join(stateDir, "spaces"), path.join(stateDir, "profile-skills")]) scan(dir);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    found,
    stop: async () => {
      stop = true;
      await loop;
    },
  };
};

const reported = () => (fs.existsSync(report) ? fs.readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; dir: string; home: string; cwd: string; mode: number; env: string[] }) : []);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sign-in-here-"));
  stateDir = path.join(root, "state");
  toolsHome = path.join(root, "tools-home");
  codexHome = path.join(stateDir, "providers", "codex", "active", "home");
  scripts = path.join(root, "clis");
  report = path.join(root, "report.jsonl");
  for (const dir of [stateDir, toolsHome, codexHome, scripts]) fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.CAVEMAN_TEST_RUNTIME_SECRET;
});

const setUp = (behaviour?: { claudeExit?: number }) => {
  writeClis(behaviour);
  const { cloud, puts } = fakeCloud();
  const logins = new FollowedLogins();
  logins.connect({
    cloud,
    files: { read: async () => undefined, write: async () => undefined, removeStandIn: async () => undefined },
    paths: { claude: async () => path.join(toolsHome, ".claude", ".credentials.json"), codex: async () => path.join(codexHome, "auth.json") },
  });
  const started: Array<{ command: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> = [];
  const here = new SignInsHere({ stateDir, logins, spawn: pipeSpawn(started), binaries: { claude: "/image/claude", codex: "/image/codex" } });
  return { here, logins, puts, started };
};

// Skipped on Windows: the runtime container is a Cloud computer's, which is Linux.
describe.skipIf(process.platform === "win32")("a sign-in in the runtime container", () => {
  it("Claude: the page, the pasted code, the upload; no tools process ever sees a real token, and the private folder is gone", async () => {
    // Something of the runtime's own: never handed to the CLI.
    process.env.CAVEMAN_TEST_RUNTIME_SECRET = "runtime-only";
    const { here, logins, puts, started } = setUp();
    const watcher = toolsWatcher();
    const prompt = await here.start("claude-agent");
    expect(prompt).toMatchObject({ url: "https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=st4te", paste: true });
    expect(prompt.message).toContain("This sign-in will follow you to your Cloud computers");
    // The page's address, pasted whole, is read as its code#state.
    expect(await here.submit("claude-agent", "https://platform.claude.com/oauth/code/callback?code=thecode1234&state=st4te")).toBe("captured");
    await watcher.stop();

    expect(watcher.found).toEqual([]);
    expect(puts.map((p) => [p.engine, p.body.consent, p.body.credential.refresh_token, p.body.profile.subscription_type])).toEqual([["claude", true, REAL.claudeRefresh, "max"]]);
    expect(logins.hasLogin("claude-agent")).toBe(true);
    // The CLI ran from the image path, in a 0700 folder of its own under the runtime's sign-ins, with none of the
    // runtime's environment.
    const [run] = reported();
    expect(started[0]!.command).toBe("/image/claude");
    expect(run!.argv).toEqual(["auth", "login", "--claudeai"]);
    expect(path.dirname(run!.dir)).toBe(path.join(stateDir, SIGN_INS_DIR));
    expect([run!.home, path.basename(run!.cwd), run!.mode]).toEqual([run!.dir, path.basename(run!.dir), 0o700]);
    expect(run!.env).not.toContain("CAVEMAN_TEST_RUNTIME_SECRET");
    expect(fs.statSync(path.join(stateDir, SIGN_INS_DIR)).mode & 0o777).toBe(0o700);
    // Its folder, credential and all, is gone; nothing landed where tools can see.
    expect(fs.readdirSync(path.join(stateDir, SIGN_INS_DIR))).toEqual([]);
    expect(fs.readdirSync(toolsHome)).toEqual([]);
  });

  it("Codex: the device page and code; taken when the CLI finishes, from its private folder only", async () => {
    const { here, puts, started } = setUp();
    const watcher = toolsWatcher();
    // A tools process plants another account's auth.json where codex keeps its own: never read as a sign-in.
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "planted-access", refresh_token: "planted-refresh" } }));
    const prompt = await here.start("codex");
    expect(prompt).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "WXYZ-12345", paste: false });
    expect(await here.submit("codex", "")).toBe("captured");
    await watcher.stop();
    expect(watcher.found).toEqual([]);
    expect(puts.map((p) => [p.engine, p.body.credential.access_token, p.body.credential.refresh_token, p.body.profile.account_id])).toEqual([["codex", REAL.codexAccess, REAL.codexRefresh, "acct-1"]]);
    expect(started[0]!.args).toEqual(["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]);
    expect(reported()[0]!.dir).toBe(started[0]!.env.CODEX_HOME);
    expect(fs.readdirSync(path.join(stateDir, SIGN_INS_DIR))).toEqual([]);
  });

  it("refuses a paste that is not a page code: nothing reaches the CLI that a terminal would read as keys", async () => {
    const { here, puts } = setUp();
    await here.start("claude-agent");
    for (const bad of ["thecode1234#st4te\rrm -rf ~\r", "\u0003", "thecode1234", "a b#c", "https://evil.example/?x=1"]) {
      await expect(here.submit("claude-agent", bad)).rejects.toThrow("not the code");
    }
    expect(puts).toHaveLength(0);
    expect(pageCode("  thecode1234#st4te ")).toBe("thecode1234#st4te");
    expect(pageCode("https://platform.claude.com/oauth/code/callback?code=thecode1234&state=st4te")).toBe("thecode1234#st4te");
    here.cancel("claude-agent");
    expect(fs.readdirSync(path.join(stateDir, SIGN_INS_DIR))).toEqual([]);
  });

  it("a CLI that fails uploads nothing and leaves no folder; a restart sweeps one a crash left", async () => {
    const { here, puts } = setUp({ claudeExit: 3 });
    await here.start("claude-agent");
    expect(await here.submit("claude-agent", "thecode1234#st4te")).toBe("failed");
    expect(puts).toHaveLength(0);
    expect(fs.readdirSync(path.join(stateDir, SIGN_INS_DIR))).toEqual([]);

    const left = path.join(stateDir, SIGN_INS_DIR, "claude-agent-crashed");
    fs.mkdirSync(left, { recursive: true });
    fs.writeFileSync(path.join(left, ".credentials.json"), "{}");
    new SignInsHere({ stateDir, logins: new FollowedLogins(), spawn: pipeSpawn([]) });
    expect(fs.existsSync(path.join(stateDir, SIGN_INS_DIR))).toBe(false);
  });

  it("asking again while a sign-in is open shows the same page and starts no second CLI", async () => {
    const { here, started } = setUp();
    const first = await here.start("claude-agent");
    const second = await here.start("claude-agent");
    expect(second).toEqual(first);
    expect(started).toHaveLength(1);
    here.cancel("claude-agent");
  });
});
