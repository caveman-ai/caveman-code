// A claude.ai or compact sign-in on a Cloud computer, made where the agent can neither read nor write it (security
// ruling S-R3, 2026-10-21; Caveman Cloud the spec). The CLI's own login runs in a pty in the runtime container (the
// same image as tools, as the runtime's uid), never through the tools channel, with its config folder a fresh 0700
// directory under the runtime's state, which the tools container does not mount. The person opens the link it prints
// and, for Claude, pastes the page's code into the card; the runtime types it in. When the CLI has written its
// credential there, the runtime uploads it (engineLogins.ts captureFrom) and deletes the folder. No tools process
// ever sees a real token, and nothing a tools process writes is ever taken as a sign-in.
//
// That held where the runtime's files are out of the agent's reach (a gVisor pod). On boat the agent is root, so the
// refresh token the CLI writes here is its to read (finding S2). Where the person's credentials stay
// outside the computer (credentialRule.ts) no sign-in is made here at all: `start` and `submit` refuse, with where to
// connect instead (`refusal`).
import * as fs from "node:fs";
import * as path from "node:path";

import { IMAGE_BINARIES, systemFirst } from "./tools.ts";
import type { FollowedEngine, FollowedLogins } from "./engineLogins.ts";

/** The login process, as the runtime drives it (a pty in production; tests give a pipe). */
export interface LoginProcess {
  write(data: string): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number) => void): void;
}

export type SpawnLogin = (input: { readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd: string; readonly env: NodeJS.ProcessEnv }) => Promise<LoginProcess>;

/** What the card shows: the page to open, Codex's one-time code, and whether Claude's page code is to be pasted. */
export interface SignInPrompt {
  readonly url?: string;
  readonly code?: string;
  readonly message: string;
  readonly paste: boolean;
}

export type SignInResult = "captured" | "pending" | "failed";

/** How long a sign-in may stay open. */
export const SIGN_IN_MS = 15 * 60_000;
/** How long the CLI has to show its page. */
const PROMPT_MS = 30_000;
/** How long a pasted code, or "Check again", waits for the CLI to finish. */
const FINISH_MS = 45_000;
/** Where a sign-in's private config folders live, under the runtime's state. */
export const SIGN_INS_DIR = "sign-ins";

/** The variables the login keeps from the runtime's own environment: none of its secrets, only the network's. */
const PASSED_THROUGH = ["LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];

// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CLAUDE_URL = /https:\/\/[^\s"'<>\x1b]+\/oauth\/authorize\?[^\s"'<>\x1b]+/;
const CODEX_URL = /https:\/\/auth\.openai\.com\/[^\s"'<>\x1b]+/;
const CODEX_CODE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;
/** A page code (Claude's `code#state`): base64url text and one `#`, nothing a terminal would take as a key. */
const PAGE_CODE = /^[A-Za-z0-9._~-]{8,2048}#[A-Za-z0-9._~-]{4,512}$/;

/** What the person pasted, as the CLI wants it: the page's `code#state`, from the code itself or the page's address. */
export const pageCode = (pasted: string): string | undefined => {
  const text = pasted.trim();
  if (PAGE_CODE.test(text)) return text;
  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const joined = code !== null && state !== null ? `${code}#${state}` : undefined;
    return joined !== undefined && PAGE_CODE.test(joined) ? joined : undefined;
  } catch {
    return undefined;
  }
};

interface Running {
  readonly dir: string;
  readonly process: LoginProcess;
  readonly until: number;
  prompt: SignInPrompt | undefined;
  output: string;
  result: SignInResult;
  readonly settle: (result: SignInResult) => void;
}

/**
 * The runtime's sign-ins in its own container: at most one per engine, each in a config folder of its own that is
 * gone once it ends (taken, failed, given up or timed out), and swept at start.
 */
export class SignInsHere {
  private readonly running = new Map<FollowedEngine, Running>();
  private readonly root: string;
  private readonly spawn: SpawnLogin;
  private readonly logins: FollowedLogins;
  private readonly binaries: { readonly claude: string; readonly codex: string };
  private readonly now: () => number;
  /** Why no sign-in may be made on this computer now, in the words the card shows; undefined: one may. */
  private readonly refusal: () => Promise<string | undefined>;

  constructor(input: {
    readonly stateDir: string;
    readonly logins: FollowedLogins;
    readonly spawn: SpawnLogin;
    readonly binaries?: { readonly claude: string; readonly codex: string };
    readonly now?: () => number;
    readonly refusal?: () => Promise<string | undefined>;
  }) {
    this.root = path.join(input.stateDir, SIGN_INS_DIR);
    this.spawn = input.spawn;
    this.logins = input.logins;
    this.binaries = input.binaries ?? { claude: IMAGE_BINARIES.claude!, codex: IMAGE_BINARIES.codex! };
    this.now = input.now ?? Date.now;
    this.refusal = input.refusal ?? (() => Promise.resolve(undefined));
    // A sign-in a restart cut short left its folder: nothing in it is kept.
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** The folder sign-ins are made in: the runtime's own, 0700, never a link. */
  private rootDir() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The sign-in folder is not the runtime's own");
    fs.chmodSync(this.root, 0o700);
    return this.root;
  }

  /** The sign-in for `engine`: the one already open, or a new one. Resolves once the CLI shows its page. */
  async start(engine: FollowedEngine): Promise<SignInPrompt> {
    const refusal = await this.refusal();
    if (refusal !== undefined) {
      // One opened before the rule came on ends with it: its folder, and whatever the CLI wrote there, goes.
      this.cancel(engine);
      throw new Error(refusal);
    }
    const open = this.running.get(engine);
    if (open !== undefined && open.result === "pending" && this.now() < open.until && open.prompt !== undefined) return open.prompt;
    if (open !== undefined) this.end(engine, open, "failed");
    const dir = fs.mkdtempSync(path.join(this.rootDir(), `${engine}-`));
    fs.chmodSync(dir, 0o700);
    const env: NodeJS.ProcessEnv = { PATH: systemFirst(""), HOME: dir, TERM: "xterm-256color" };
    for (const name of PASSED_THROUGH) if (process.env[name] !== undefined) env[name] = process.env[name];
    const [command, args] =
      engine === "claude-agent"
        ? [this.binaries.claude, ["auth", "login", "--claudeai"]]
        : [this.binaries.codex, ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]];
    if (engine === "claude-agent") env.CLAUDE_CONFIG_DIR = dir;
    else env.CODEX_HOME = dir;
    let child: LoginProcess;
    try {
      child = await this.spawn({ command, args, cwd: dir, env });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`The sign-in could not start on this computer (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    const timer = setTimeout(() => this.end(engine, run, "failed"), SIGN_IN_MS);
    timer.unref?.();
    const run: Running = { dir, process: child, until: this.now() + SIGN_IN_MS, prompt: undefined, output: "", result: "pending", settle: () => clearTimeout(timer) };
    this.running.set(engine, run);
    child.onData((data) => {
      run.output = (run.output + data).slice(-64 * 1024);
      if (run.prompt === undefined) run.prompt = this.promptIn(engine, run.output.replace(ANSI, ""));
    });
    child.onExit((code) => {
      if (run.result !== "pending") return;
      void (code === 0 ? this.take(engine, run) : Promise.resolve(this.end(engine, run, "failed")));
    });
    // The CLI ends a sign-in by writing its credential; one that keeps running after that is not waited for.
    void this.watchFile(engine, run);
    const shown = await this.until(() => run.prompt !== undefined || run.result !== "pending", PROMPT_MS);
    if (!shown || run.prompt === undefined) {
      this.end(engine, run, "failed");
      throw new Error(engine === "claude-agent" ? "Claude did not show its sign-in page. Try again." : "Codex did not show its sign-in page. Try again.");
    }
    return run.prompt;
  }

  /** The page the CLI printed: its link, and Codex's one-time code. */
  private promptIn(engine: FollowedEngine, text: string): SignInPrompt | undefined {
    if (engine === "claude-agent") {
      const url = CLAUDE_URL.exec(text)?.[0];
      return url === undefined
        ? undefined
        : { url, paste: true, message: "Open the link, sign in with your Claude account, then paste the code the page shows here. This sign-in will follow you to your Cloud computers." };
    }
    const url = CODEX_URL.exec(text)?.[0];
    const code = CODEX_CODE.exec(text)?.[0];
    return url === undefined || code === undefined
      ? undefined
      : { url, code, paste: false, message: `Open the link, sign in with ChatGPT and enter the code ${code}. This sign-in will follow you to your Cloud computers.` };
  }

  /**
   * Claude's page code, typed into the CLI (only a `code#state`, nothing a terminal would read as a key), then the
   * wait for it to finish. Codex needs nothing typed: this is its "Check again".
   */
  async submit(engine: FollowedEngine, pasted: string): Promise<SignInResult> {
    const refusal = await this.refusal();
    if (refusal !== undefined) {
      this.cancel(engine);
      throw new Error(refusal);
    }
    const run = this.running.get(engine);
    if (run === undefined || run.result !== "pending") return run?.result ?? "failed";
    if (engine === "claude-agent") {
      const code = pageCode(pasted);
      if (code === undefined) throw new Error("That is not the code the sign-in page shows. Copy the whole code and paste it again.");
      run.process.write(`${code}\r`);
    }
    const finished = await this.until(() => run.result !== "pending", FINISH_MS);
    return finished ? run.result : "pending";
  }

  /** Gives `engine`'s open sign-in up: the CLI stops and its folder goes. */
  cancel(engine: FollowedEngine) {
    const run = this.running.get(engine);
    if (run !== undefined) this.end(engine, run, "failed");
  }

  private credentialFile(engine: FollowedEngine, dir: string) {
    return path.join(dir, engine === "claude-agent" ? ".credentials.json" : "auth.json");
  }

  /** Reads the CLI's credential from its private folder (never through a link) and hands it to engineLogins. */
  private async take(engine: FollowedEngine, run: Running) {
    if (run.result !== "pending") return;
    let text: string | undefined;
    try {
      const fd = fs.openSync(this.credentialFile(engine, run.dir), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      text = undefined;
    }
    const result = text === undefined ? "failed" : await this.logins.captureFrom(engine, text);
    this.end(engine, run, result === "captured" ? "captured" : "failed");
  }

  /** The credential landing in the private folder, every half second while the sign-in is open. */
  private async watchFile(engine: FollowedEngine, run: Running) {
    const file = this.credentialFile(engine, run.dir);
    while (run.result === "pending" && this.now() < run.until) {
      await new Promise((resolve) => setTimeout(resolve, 500).unref?.());
      if (run.result !== "pending") return;
      if (fs.existsSync(file)) {
        // The CLI writes it in one step; give it a moment to finish its own last writes, then take it.
        await new Promise((resolve) => setTimeout(resolve, 250).unref?.());
        return this.take(engine, run);
      }
    }
  }

  /** Ends a sign-in: the CLI stops and its folder, with whatever it wrote, is deleted. */
  private end(engine: FollowedEngine, run: Running, result: SignInResult) {
    if (run.result === "pending") run.result = result;
    try {
      run.process.kill();
    } catch {
      // Already gone.
    }
    fs.rmSync(run.dir, { recursive: true, force: true });
    if (this.running.get(engine) === run) this.running.delete(engine);
    run.settle(run.result);
  }

  private async until(ready: () => boolean, ms: number) {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }
}
