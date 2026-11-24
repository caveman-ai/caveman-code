// Connecting a plan from this Mac (connectHere.ts), against a scripted CLI: what the runtime starts, in which folder
// and with which environment; how it reads the token `claude setup-token` prints however the pty cuts it up; how it
// takes the sign-in `codex login` writes; and that nothing of either stays behind. The token and sign-in here are made
// up for the test. The real pty and the CLIs' stand-ins run in signInOnce.e2e.test.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  CODE_NOT_TAKEN,
  CONNECT_MESSAGE,
  CONNECTS_DIR,
  ConnectsHere,
  DEVICE_CODE_MESSAGE,
  GAVE_UP,
  NO_PAGE,
  NOT_A_PLAN,
  NOT_KEPT,
  NOT_THE_CODE,
  TIMED_OUT,
} from "./connectHere.ts";
import type { ChatGptCredential } from "./modelConnections.ts";
import type { LoginProcess } from "./signInHere.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const TOKEN = `sk-ant-oat01-${"made-up_for-this-test-0123456789".repeat(3)}`;
const CLAUDE_PAGE = "https://claude.ai/oauth/authorize?code=true&client_id=test&state=abc";
const jwt = (claims: object) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** A CLI the test drives by hand: what it was started with, what it was sent, and whether it was stopped. */
function scripted() {
  const cli = {
    started: [] as Array<{
      command: string;
      args: ReadonlyArray<string>;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }>,
    written: [] as Array<string>,
    killed: 0,
    print: (_data: string) => {},
    exit: (_code: number) => {},
  };
  const spawn = async (input: {
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<LoginProcess> => {
    cli.started.push(input);
    return {
      write: (data) => void cli.written.push(data),
      kill: () => void cli.killed++,
      onData: (listener) => void (cli.print = listener),
      onExit: (listener) => void (cli.exit = listener),
    };
  };
  return { cli, spawn };
}

function connects(
  options: {
    keepClaude?: (token: string) => Promise<unknown>;
    keepChatGpt?: (credential: ChatGptCredential) => Promise<unknown>;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-here-"));
  roots.push(stateDir);
  const { cli, spawn } = scripted();
  const kept = { claude: [] as Array<string>, chatgpt: [] as Array<ChatGptCredential> };
  const here = new ConnectsHere({
    stateDir,
    spawn,
    binaries: async () => ({ claude: "/opt/bin/claude", codex: "/opt/bin/codex" }),
    keep: {
      claude: options.keepClaude ?? (async (token) => void kept.claude.push(token)),
      chatgpt: options.keepChatGpt ?? (async (credential) => void kept.chatgpt.push(credential)),
    },
    env: options.env ?? { PATH: "/usr/bin", HOME: "/Users/someone" },
  });
  return { here, cli, kept, stateDir, root: path.join(stateDir, CONNECTS_DIR) };
}

/** The request that starts a connect in these tests: the window that pressed the button. */
const MINE = "add-from-this-window";

/** Starts a connect and shows the CLI's page once it runs. */
async function started(
  c: ReturnType<typeof connects>,
  engine: "claude-agent" | "codex",
  page: string,
  options: { deviceCode?: boolean; owner?: string; restarts?: string } = {},
) {
  const before = c.cli.started.length;
  const prompt = c.here.start(engine, { owner: MINE, ...options });
  while (c.cli.started.length === before) await new Promise((resolve) => setTimeout(resolve, 5));
  c.cli.print(page);
  return prompt;
}

test("Claude: the official setup-token runs in a private folder with nothing of the person's sign-ins, and its page is shown", async () => {
  const c = connects({
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      BROWSER: "open",
      CLAUDE_CODE_OAUTH_TOKEN: "x",
      ANTHROPIC_API_KEY: "y",
      CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
      CODEX_HOME: "/Users/someone/.codex",
    },
  });
  const prompt = await started(
    c,
    "claude-agent",
    `\x1b[2K\x1b[GOpening browser to sign in…\r\n\x1b[38;5;246m${CLAUDE_PAGE}\x1b[39m\r\nPaste code here if prompted > `,
  );
  expect(prompt).toEqual({ url: CLAUDE_PAGE, message: CONNECT_MESSAGE["claude-agent"] });

  const [run] = c.cli.started;
  expect(run!.command).toBe("/opt/bin/claude");
  expect(run!.args).toEqual(["setup-token"]);
  // Its HOME and its config folder are one folder of the runtime's own, 0700: the person's ~/.claude is never opened.
  expect(path.dirname(run!.cwd)).toBe(c.root);
  expect(run!.env.HOME).toBe(run!.cwd);
  expect(run!.env.CLAUDE_CONFIG_DIR).toBe(run!.cwd);
  expect(fs.statSync(run!.cwd).mode & 0o777).toBe(0o700);
  expect(fs.statSync(c.root).mode & 0o777).toBe(0o700);
  // Where its binaries are and the person's browser pass through; nothing that signs in does.
  expect(Object.keys(run!.env).sort()).toEqual([
    "BROWSER",
    "CLAUDE_CONFIG_DIR",
    "HOME",
    "PATH",
    "TERM",
  ]);
  expect(await c.here.cancel("claude-agent", MINE)).toBe(true);
});

test("Claude: the token is read however the pty cuts it up, handed over once, and nothing of it stays", async () => {
  const c = connects();
  await started(c, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  // The screen is redrawn, in colour, and the token arrives in pieces.
  c.cli.print(
    "\x1b[2K\x1b[1A\x1b[2K\x1b[G\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n",
  );
  c.cli.print(`\x1b[38;5;246m${TOKEN.slice(0, 20)}`);
  c.cli.print(TOKEN.slice(20, 61));
  // A piece that ends inside the token is never taken for the whole of it.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(c.kept.claude).toEqual([]);
  c.cli.print(
    `${TOKEN.slice(61)}\x1b[39m\r\n\r\nStore this token securely. You won't be able to see it again.\r\n\r\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\r\n`,
  );
  expect(await c.here.wait("claude-agent")).toEqual({ state: "connected" });
  expect(c.kept.claude).toEqual([TOKEN]);
  // The CLI is stopped and its folder, with whatever it wrote, is gone.
  expect(c.cli.killed).toBeGreaterThan(0);
  expect(fs.readdirSync(c.root)).toEqual([]);
  // What it prints afterwards is not read: a second token is never handed over.
  c.cli.print(`${TOKEN}x\r\nStore this token securely\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(c.kept.claude).toEqual([TOKEN]);
  // A wait that arrives late still hears how it ended.
  expect(await c.here.wait("claude-agent")).toEqual({ state: "connected" });
});

test("Claude: a token with nothing printed under it is taken once its line ended and the pty went quiet, or when the CLI exits", async () => {
  const quiet = connects();
  await started(quiet, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  quiet.cli.print(`Your token:\r\n${TOKEN}\r\n`);
  expect(await quiet.here.wait("claude-agent")).toEqual({ state: "connected" });
  expect(quiet.kept.claude).toEqual([TOKEN]);

  const exits = connects();
  await started(exits, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  exits.cli.print(TOKEN);
  exits.cli.exit(0);
  expect(await exits.here.wait("claude-agent")).toEqual({ state: "connected" });
  expect(exits.kept.claude).toEqual([TOKEN]);
});

test("Claude: a CLI that ends with no token, shows no page, or is given up leaves a plain sentence and no folder", async () => {
  const ended = connects();
  await started(ended, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  ended.cli.exit(1);
  expect(await ended.here.wait("claude-agent")).toEqual({ state: "failed", why: GAVE_UP });
  expect(fs.readdirSync(ended.root)).toEqual([]);

  const noPage = connects();
  const prompt = noPage.here.start("claude-agent", { owner: MINE });
  while (noPage.cli.started.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  noPage.cli.print("claude: command not understood\r\n");
  noPage.cli.exit(2);
  await expect(prompt).rejects.toThrow(NO_PAGE["claude-agent"]);
  expect(fs.readdirSync(noPage.root)).toEqual([]);

  const given = connects();
  await started(given, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  expect(await given.here.cancel("claude-agent", MINE)).toBe(true);
  expect(given.cli.killed).toBeGreaterThan(0);
  expect(await given.here.wait("claude-agent")).toEqual({ state: "failed", why: GAVE_UP });
  expect(fs.readdirSync(given.root)).toEqual([]);
  // Nothing was ever started for Codex: a wait for it says so.
  expect(await given.here.wait("codex")).toEqual({ state: "failed", why: GAVE_UP });
});

test("Claude: Cloud's own sentence for a refusal is shown, and never one that repeats a credential", async () => {
  const refused = connects({
    keepClaude: async () =>
      Promise.reject(new Error("Claude plan connections are switched off on this Caveman Cloud.")),
  });
  await started(refused, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  refused.cli.print(`${TOKEN}\r\nStore this token securely\r\n`);
  expect(await refused.here.wait("claude-agent")).toEqual({
    state: "failed",
    why: "Claude plan connections are switched off on this Caveman Cloud.",
  });

  const echoed = connects({
    keepClaude: async (token) => Promise.reject(new Error(`could not store ${token}`)),
  });
  await started(echoed, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  echoed.cli.print(`${TOKEN}\r\nStore this token securely\r\n`);
  expect(await echoed.here.wait("claude-agent")).toEqual({ state: "failed", why: NOT_KEPT });
});

test("Claude: only the code its page shows is typed into the CLI", async () => {
  const c = connects();
  await started(c, "claude-agent", `${CLAUDE_PAGE}\r\n`);
  await expect(c.here.wait("claude-agent", "rm -rf ~")).rejects.toThrow(NOT_THE_CODE);
  await expect(c.here.wait("claude-agent", TOKEN)).rejects.toThrow(NOT_THE_CODE);
  expect(c.cli.written).toEqual([]);
  const waiting = c.here.wait("claude-agent", " abcDEF123456#state-7890 ");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(c.cli.written).toEqual(["abcDEF123456#state-7890\r"]);
  c.cli.print(`${TOKEN}\r\nStore this token securely\r\n`);
  expect(await waiting).toEqual({ state: "connected" });
});

/** What `claude setup-token` 2.1.322 printed for a code it did not take, as the person's own run showed it. */
const NOT_ACCEPTED =
  "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";
const ASKS = "Browser didn't open? Use the url below to sign in\r\n";
const PASTE_HERE = "Paste code here if prompted > ";

test("Claude: a code it does not take is answered at once in its own words; it starts over, and its new page is the sign-in's from then on", async () => {
  const c = connects();
  await started(c, "claude-agent", `${ASKS}${CLAUDE_PAGE}\r\n${PASTE_HERE}`);
  const refused = c.here.wait("claude-agent", "abcdefgh#wrong-state");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // As claude draws it: in colour, a space drawn as a cursor move, then what it waits for.
  c.cli.print(
    `\x1b[2K\x1b[G\x1b[31mOAuth error: ${NOT_ACCEPTED.replace(" Sign in", "\x1b[1CSign in")}\x1b[39m\r\n\r\nPress Enter to retry.\r\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  // Enter after the code: claude starts over.
  expect(c.cli.written).toEqual(["abcdefgh#wrong-state\r", "\r"]);
  const NEW_PAGE = "https://claude.ai/oauth/authorize?code=true&client_id=test&state=def";
  let answered = false;
  void refused.then(() => (answered = true));
  // Ink redraws only what changed: the new page, and nothing under it. A page cut off mid-line is never handed out.
  c.cli.print(`\x1b[2K\x1b[GRetrying…\r\n${ASKS}${NEW_PAGE.slice(0, 40)}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(answered).toBe(false);
  c.cli.print(`${NEW_PAGE.slice(40)}\x1b[39m\r\n`);
  expect(await refused).toEqual({ state: "refused", why: NOT_ACCEPTED, url: NEW_PAGE });
  // Still open, still this window's, and on the new page: another window asking is answered that one.
  expect(c.here.pending("claude-agent")?.owner).toBe(MINE);
  expect((await c.here.start("claude-agent", { owner: "another-window" })).url).toBe(NEW_PAGE);
  expect(c.cli.started).toHaveLength(1);
  // The new page's code is taken.
  const taken = c.here.wait("claude-agent", "ghijklmn#def0");
  await new Promise((resolve) => setTimeout(resolve, 20));
  c.cli.print(`${TOKEN}\r\nStore this token securely\r\n`);
  expect(await taken).toEqual({ state: "connected" });
  expect(c.kept.claude).toEqual([TOKEN]);
});

test("Claude: a reason that repeats what was pasted is not shown, and a code it says nothing about is not taken", async () => {
  const repeats = connects();
  await started(repeats, "claude-agent", `${ASKS}${CLAUDE_PAGE}\r\n${PASTE_HERE}`);
  const refused = repeats.here.wait("claude-agent", "abcdefgh#wrong-state");
  await new Promise((resolve) => setTimeout(resolve, 20));
  repeats.cli.print("OAuth error: abcdefgh is not a code\r\nPress Enter to retry.\r\n");
  await new Promise((resolve) => setTimeout(resolve, 150));
  // The last thing printed: it counts once the pty has been quiet a moment.
  repeats.cli.print(`Retrying…\r\n${ASKS}${CLAUDE_PAGE}2`);
  expect(await refused).toEqual({ state: "refused", why: CODE_NOT_TAKEN, url: `${CLAUDE_PAGE}2` });

  const silent = connects();
  await started(silent, "claude-agent", `${ASKS}${CLAUDE_PAGE}\r\n${PASTE_HERE}`);
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  try {
    const waited = silent.here.wait("claude-agent", "abcdefgh#abcd");
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await waited).toEqual({ state: "refused", why: CODE_NOT_TAKEN });
  } finally {
    vi.useRealTimers();
  }
  // Nothing was pressed for it: claude never said it started over.
  expect(silent.cli.written).toEqual(["abcdefgh#abcd\r"]);
  expect(silent.here.pending("claude-agent")?.owner).toBe(MINE);
});

test("ChatGPT: the official codex login runs in a private CODEX_HOME, and the sign-in it writes there is handed over and deleted", async () => {
  const c = connects({
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      CODEX_HOME: "/Users/someone/.codex",
      OPENAI_API_KEY: "z",
    },
  });
  const page =
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=test&state=xyz";
  const prompt = await started(
    c,
    "codex",
    `Starting local login server on http://localhost:1455.\r\nIf your browser did not open, navigate to this URL to authenticate:\r\n\r\n${page}\r\n`,
  );
  expect(prompt).toEqual({ url: page, message: CONNECT_MESSAGE.codex });

  const [run] = c.cli.started;
  expect(run!.command).toBe("/opt/bin/codex");
  // The sign-in must land in a file: a person's own config may send it to the keyring.
  expect(run!.args).toEqual(["-c", 'cli_auth_credentials_store="file"', "login"]);
  expect(path.dirname(run!.cwd)).toBe(c.root);
  expect(run!.env.CODEX_HOME).toBe(run!.cwd);
  expect(run!.env.HOME).toBe(run!.cwd);
  expect(Object.keys(run!.env).sort()).toEqual(["CODEX_HOME", "HOME", "PATH", "TERM"]);

  const access = jwt({
    exp: 1_900_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  });
  const id = jwt({ email: "person@example.test" });
  fs.writeFileSync(
    path.join(run!.cwd, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: id,
        access_token: access,
        refresh_token: "rt_made-up",
        account_id: "acct-1",
      },
      last_refresh: "2026-11-09T00:00:00Z",
    }),
  );
  expect(await c.here.wait("codex")).toEqual({ state: "connected" });
  expect(c.kept.chatgpt).toEqual([
    {
      access_token: access,
      refresh_token: "rt_made-up",
      id_token: id,
      expires_at: new Date(1_900_000_000_000).toISOString(),
    },
  ]);
  // The private home, and the sign-in in it, are gone: Cloud's copy is the only one.
  expect(fs.readdirSync(c.root)).toEqual([]);
});

test("ChatGPT: a device code is shown with its page; a sign-in with an API key is not a plan", async () => {
  const device = connects();
  const prompt = await started(
    device,
    "codex",
    "1. Open this link\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n2. Enter this one-time code\r\n   \x1b[94mAB12-CD345\x1b[0m\r\n",
    { deviceCode: true },
  );
  expect(prompt).toEqual({
    url: "https://auth.openai.com/codex/device",
    code: "AB12-CD345",
    message: DEVICE_CODE_MESSAGE("AB12-CD345"),
  });
  expect(device.cli.started[0]!.args).toEqual([
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
    "--device-auth",
  ]);
  await expect(device.here.wait("codex", "abcDEF123456#state-7890")).rejects.toThrow(NOT_THE_CODE);
  expect(await device.here.cancel("codex", MINE)).toBe(true);

  const key = connects();
  await started(key, "codex", "https://auth.openai.com/oauth/authorize?state=1\r\n");
  fs.writeFileSync(
    path.join(key.cli.started[0]!.cwd, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-made-up" }),
  );
  expect(await key.here.wait("codex")).toEqual({ state: "failed", why: NOT_A_PLAN });
  expect(key.kept.chatgpt).toEqual([]);
  expect(fs.readdirSync(key.root)).toEqual([]);

  const nothing = connects();
  await started(nothing, "codex", "https://auth.openai.com/oauth/authorize?state=2\r\n");
  nothing.cli.exit(0);
  expect(await nothing.here.wait("codex")).toEqual({ state: "failed", why: GAVE_UP });
});

test("an open sign-in is the runtime's: a second window is answered its page, waits for it, hears it start and end, and cannot end it", async () => {
  const c = connects();
  const heard: Array<string> = [];
  c.here.onChange((engine) => heard.push(`${engine}:${c.here.pending(engine)?.owner ?? "none"}`));
  expect(c.here.pending("claude-agent")).toBeUndefined();
  const first = await started(c, "claude-agent", `${CLAUDE_PAGE}\r\n`, { owner: "window-a" });
  // Every listener heard it start, with who started it and when: what engine.list then says (auth.connecting).
  expect(heard).toEqual(["claude-agent:window-a"]);
  const open = c.here.pending("claude-agent");
  expect(open?.owner).toBe("window-a");
  expect(Math.abs(Date.now() - open!.since)).toBeLessThan(5_000);
  // A second window that presses the same button starts no second CLI: it is answered the page that is open.
  expect(await c.here.start("claude-agent", { owner: "window-b" })).toEqual(first);
  expect(c.cli.started).toHaveLength(1);
  expect(c.here.pending("claude-agent")?.owner).toBe("window-a");
  // Its Cancel, Escape or closing ends nothing: not by its own request, not by a bare name.
  expect(await c.here.cancel("claude-agent", "window-b")).toBe(false);
  expect(await c.here.cancel("claude-agent", "")).toBe(false);
  expect(c.cli.killed).toBe(0);
  expect(c.here.pending("claude-agent")?.owner).toBe("window-a");
  expect(heard).toHaveLength(1);
  // Either window may wait for it, and both hear how it ends.
  const a = c.here.wait("claude-agent");
  const b = c.here.wait("claude-agent");
  c.cli.print(`${TOKEN}\r\nStore this token securely\r\n`);
  expect(await a).toEqual({ state: "connected" });
  expect(await b).toEqual({ state: "connected" });
  expect(c.here.pending("claude-agent")).toBeUndefined();
  expect(heard).toEqual(["claude-agent:window-a", "claude-agent:none"]);
});

test("only the window that started a sign-in gives it up, and every window hears that", async () => {
  const c = connects();
  const heard: Array<string> = [];
  c.here.onChange((engine) => heard.push(`${engine}:${c.here.pending(engine)?.owner ?? "none"}`));
  await started(c, "codex", "https://auth.openai.com/oauth/authorize?state=1\r\n", {
    owner: "window-a",
  });
  expect(await c.here.cancel("codex", "window-b")).toBe(false);
  expect(c.here.pending("codex")?.owner).toBe("window-a");
  expect(await c.here.cancel("codex", "window-a")).toBe(true);
  expect(c.cli.killed).toBeGreaterThan(0);
  expect(c.here.pending("codex")).toBeUndefined();
  expect(heard).toEqual(["codex:window-a", "codex:none"]);
  expect(await c.here.wait("codex")).toEqual({ state: "failed", why: GAVE_UP });
  expect(fs.readdirSync(c.root)).toEqual([]);
  // Nothing is open: a cancel ends nothing and says so.
  expect(await c.here.cancel("codex", "window-a")).toBe(false);
});

test("its starter starts a sign-in over with a code; another window asking for a code is answered the page that is open", async () => {
  const c = connects();
  const page = "https://auth.openai.com/oauth/authorize?state=1\r\n";
  const first = await started(c, "codex", page, { owner: "window-a" });
  // Another window cannot swap the open sign-in for one of its own, whatever it names.
  expect(await c.here.start("codex", { owner: "window-b", deviceCode: true })).toEqual(first);
  expect(
    await c.here.start("codex", { owner: "window-b", deviceCode: true, restarts: "window-b" }),
  ).toEqual(first);
  expect(c.cli.started).toHaveLength(1);
  expect(c.cli.killed).toBe(0);
  // Its starter names it: the first CLI stops and one with a code runs in its place, the starter's still.
  const code = await started(
    c,
    "codex",
    "1. Open this link\r\n   https://auth.openai.com/codex/device\r\n2. Enter this one-time code\r\n   AB12-CD345\r\n",
    { owner: "window-a-again", deviceCode: true, restarts: "window-a" },
  );
  expect(code).toEqual({
    url: "https://auth.openai.com/codex/device",
    code: "AB12-CD345",
    message: DEVICE_CODE_MESSAGE("AB12-CD345"),
  });
  expect(c.cli.started).toHaveLength(2);
  expect(c.cli.started[1]!.args).toEqual([
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
    "--device-auth",
  ]);
  expect(c.cli.killed).toBeGreaterThan(0);
  expect(c.here.pending("codex")?.owner).toBe("window-a-again");
  expect(await c.here.cancel("codex", "window-a")).toBe(false);
  expect(await c.here.cancel("codex", "window-a-again")).toBe(true);
});

test("two windows that press at the same moment run one CLI, and the first to ask is its starter", async () => {
  const c = connects();
  const a = c.here.start("claude-agent", { owner: "window-a" });
  const b = c.here.start("claude-agent", { owner: "window-b" });
  while (c.cli.started.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  c.cli.print(`${CLAUDE_PAGE}\r\n`);
  expect(await a).toEqual({ url: CLAUDE_PAGE, message: CONNECT_MESSAGE["claude-agent"] });
  expect(await b).toEqual({ url: CLAUDE_PAGE, message: CONNECT_MESSAGE["claude-agent"] });
  expect(c.cli.started).toHaveLength(1);
  expect(c.here.pending("claude-agent")?.owner).toBe("window-a");
  expect(await c.here.cancel("claude-agent", "window-a")).toBe(true);
});

test("a folder a restart left behind is swept, and every sentence a person can see is plain", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-here-"));
  roots.push(stateDir);
  const left = path.join(stateDir, CONNECTS_DIR, "codex-left");
  fs.mkdirSync(left, { recursive: true });
  fs.writeFileSync(path.join(left, "auth.json"), "{}");
  new ConnectsHere({
    stateDir,
    spawn: scripted().spawn,
    binaries: async () => ({ claude: "claude", codex: "codex" }),
    keep: { claude: async () => undefined, chatgpt: async () => undefined },
  });
  expect(fs.existsSync(path.join(stateDir, CONNECTS_DIR))).toBe(false);

  expect(CONNECT_MESSAGE).toEqual({
    "claude-agent": "Approve in the browser on your Mac.",
    codex: "Approve in the browser on your Mac.",
  });
  expect(DEVICE_CODE_MESSAGE("AB12-CD345")).toBe("Open the page and enter the code AB12-CD345.");
  expect(NO_PAGE).toEqual({
    "claude-agent":
      "Claude did not show its sign-in page. Check that claude is installed on this Mac, then try again.",
    codex:
      "Codex did not show its sign-in page. Check that codex is installed on this Mac, then try again.",
  });
  expect(TIMED_OUT).toBe("The sign-in was not approved in time. Start it again.");
  expect(GAVE_UP).toBe("The sign-in ended before it was approved. Start it again.");
  expect(NOT_A_PLAN).toBe(
    "That signed in with an API key, not a ChatGPT plan. Start it again and choose Sign in with ChatGPT.",
  );
  expect(NOT_THE_CODE).toBe(
    "That is not the code the sign-in page shows. Copy the whole code and paste it again.",
  );
  expect(NOT_KEPT).toBe("Caveman couldn't save the sign-in. Try again.");
});
