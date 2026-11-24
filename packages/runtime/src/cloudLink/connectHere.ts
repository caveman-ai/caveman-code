// Connecting a plan once, from this Mac (cloud-computers SPEC §4.2 and §4.3, CONTRACT §4). The runtime runs the
// official, unmodified CLI's own sign-in itself, so the person only approves on the provider's page:
//
// - Claude: `claude setup-token` in a pty. `claude` opens Anthropic's own sign-in in the browser; when the person
//   approves it prints a token that lasts a year and only makes model requests. The runtime reads that line off the
//   pty, hands it to Cloud (macConnections.ts connectClaude, which keeps a sealed copy here) and clears what it read.
//   No terminal is shown and nothing is pasted.
// - compact: `codex login` in a fresh, private CODEX_HOME under the runtime's state (browser sign-in; `--device-auth`
//   for a browser that cannot reach this Mac). The runtime reads the `auth.json` codex wrote there, hands its
//   credential to Cloud, which alone refreshes it from then on (formal/SignInOnce.tla), and deletes that home.
//
// Both run with HOME and their config folder pointed at that private folder: this Mac's own `~/.claude` and `~/.codex`
// are never opened, and what the person is signed in to there is never read, copied or uploaded.
//
// A token is in this process only between the CLI printing it and Cloud's answer. It is never part of an error, a log
// line, an event or a file the runtime writes: the pty's output is held in memory while the sign-in is open, never
// stored, and dropped the moment the token is read or the sign-in ends.
import * as fs from "node:fs";
import * as path from "node:path";

import { parseCodexAuth } from "./engineLogins.ts";
import type { ChatGptCredential } from "./modelConnections.ts";
import type { LoginProcess, SpawnLogin } from "./signInHere.ts";

export type ConnectEngine = "claude-agent" | "codex";

/** What the sheet shows while the person approves: the provider's page (the browser opens it too) and Codex's one-time code. */
export interface ConnectPrompt {
  readonly url?: string;
  readonly code?: string;
  readonly message: string;
}

/** `connected`: Cloud keeps it. `pending`: the person has not approved yet. `failed`: it ended without a connection (`why` says so). */
export type ConnectResult =
  | { readonly state: "connected" }
  | { readonly state: "pending" }
  | { readonly state: "failed"; readonly why: string };

/**
 * A wait with a pasted code: `refused`, `claude` did not take it (`why`: its own reason, else CODE_NOT_TAKEN). The
 * sign-in stays open; `url`, the new page `claude` started over on, which from now on is the only one whose code works.
 */
export type WaitResult =
  | ConnectResult
  | { readonly state: "refused"; readonly why: string; readonly url?: string };

/** How long a connect may stay open. */
export const CONNECT_MS = 15 * 60_000;
/** How long the CLI has to show its page. */
const PROMPT_MS = 30_000;
/** How long one wait for the person's approval lasts before it answers "still waiting". */
export const WAIT_MS = 45_000;
/** Once a token is on the pty and nothing more has come for this long, it is whole. */
const SETTLE_MS = 400;
/** Where connects' private folders live, under the runtime's state. */
export const CONNECTS_DIR = "connects";

/** What the CLI keeps of the runtime's environment: where its binaries are, the network's settings and the person's browser. Nothing of theirs that signs in. */
const PASSED_THROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "BROWSER",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

// eslint-disable-next-line no-control-regex -- ANSI escapes are control characters: this strips them from the CLI's output
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CLAUDE_URL = /https:\/\/[^\s"'<>\x1b]+\/oauth\/authorize\?[^\s"'<>\x1b]+/;
const CODEX_URL = /https:\/\/auth\.openai\.com\/[^\s"'<>\x1b]+/;
const CODEX_CODE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;
/**
 * The line `claude setup-token` prints (the form Cloud takes). While the CLI still prints, a token counts only once
 * the line it is on has ended: one that stops where a piece of output stops may be cut short. Once the CLI has exited,
 * whatever it printed last is whole.
 */
const CLAUDE_TOKEN = /(sk-ant-oat[A-Za-z0-9_-]{32,})(?=\s)/g;
const CLAUDE_TOKEN_AT_EXIT = /(sk-ant-oat[A-Za-z0-9_-]{32,})(?![A-Za-z0-9_-])/g;
/** What `claude` prints under the token: once it shows, the token above it is whole. */
const AFTER_TOKEN = "Store this token securely";
/** A page code (Claude's `code#state`), for a browser that could not reach this Mac: nothing a terminal would take as a key. */
const PAGE_CODE = /^[A-Za-z0-9._~-]{8,2048}#[A-Za-z0-9._~-]{4,512}$/;
/**
 * What `claude setup-token` (2.1.x) prints when it does not take a pasted code: "OAuth error: That code wasn't accepted.
 * … Sign in again to get a new code." and "Press Enter to retry." It stays open, and Enter starts the sign-in over on a
 * new page (a new state): the page before it cannot give a code it takes any more.
 */
const CLAUDE_REFUSED = /OAuth error:\s*([^\r\n]+)/;
const CLAUDE_RETRY = "Press Enter to retry";
/** Ink moves the cursor right in place of some spaces. */
// eslint-disable-next-line no-control-regex -- the escape is a control character: this reads it as the spaces it draws
const CURSOR_RIGHT = /\x1b\[(\d*)C/g;

// Where the person approves: the browser on the Mac the sign-in runs on, whatever device asked for it.
export const CONNECT_MESSAGE: Record<ConnectEngine, string> = {
  "claude-agent": "Approve in the browser on your Mac.",
  codex: "Approve in the browser on your Mac.",
};
export const DEVICE_CODE_MESSAGE = (code: string) => `Open the page and enter the code ${code}.`;
export const NO_PAGE: Record<ConnectEngine, string> = {
  "claude-agent":
    "Claude did not show its sign-in page. Check that claude is installed on this Mac, then try again.",
  codex:
    "Codex did not show its sign-in page. Check that codex is installed on this Mac, then try again.",
};
export const TIMED_OUT = "The sign-in was not approved in time. Start it again.";
export const GAVE_UP = "The sign-in ended before it was approved. Start it again.";
export const NOT_A_PLAN =
  "That signed in with an API key, not a ChatGPT plan. Start it again and choose Sign in with ChatGPT.";
export const NOT_THE_CODE =
  "That is not the code the sign-in page shows. Copy the whole code and paste it again.";
/** A pasted code `claude` neither took nor said anything about while the wait lasted. */
export const CODE_NOT_TAKEN =
  "Claude didn't take that code. Copy it again from the page you just signed in on.";
/** What a failed hand-over to Cloud says when Cloud gave no sentence of its own. */
export const NOT_KEPT = "Caveman couldn't save the sign-in. Try again.";

interface Running {
  readonly dir: string;
  readonly process: LoginProcess;
  /** The engine.account.add that started it (its request id): only it gives the connect up or starts it over. */
  readonly owner: string;
  readonly since: number;
  readonly until: number;
  prompt: ConnectPrompt | undefined;
  /** The CLI's page once it shows: what its starter, and every caller while it is open, is answered. */
  readonly shown: Promise<ConnectPrompt>;
  /** The pty's output while the sign-in is open; cleared when a token is read and when it ends. Never stored. */
  output: string;
  /** The pty's output since a code was pasted (or `claude` was told to start over), while that is being answered. */
  tail: string | undefined;
  /** When the pty last printed anything. */
  printedAt: number;
  result: ConnectResult;
  taking: boolean;
  settle: ReturnType<typeof setTimeout> | undefined;
  readonly stop: () => void;
}

/**
 * This Mac's connects: at most one per engine, each in a folder of its own under the runtime's state that is gone
 * once it ends (connected, failed, given up or timed out), and swept at start. An open one is the runtime's, not its
 * starter's window's: any caller is answered its page and may wait for it, every listener hears it start and end,
 * and only the request that started it gives it up or starts it over.
 */
export class ConnectsHere {
  readonly #running = new Map<ConnectEngine, Running>();
  /** The last call per engine that decided whether a connect is open: the next decides after it, so two that ask at once never run two CLIs. */
  readonly #opening = new Map<ConnectEngine, Promise<unknown>>();
  readonly #listeners = new Set<(engine: ConnectEngine) => void>();
  readonly #root: string;
  readonly #spawn: SpawnLogin;
  readonly #binaries: () => Promise<{ readonly claude: string; readonly codex: string }>;
  readonly #keep: {
    readonly claude: (token: string) => Promise<unknown>;
    readonly chatgpt: (credential: ChatGptCredential) => Promise<unknown>;
  };
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;

  constructor(input: {
    readonly stateDir: string;
    readonly spawn: SpawnLogin;
    readonly binaries: () => Promise<{ readonly claude: string; readonly codex: string }>;
    /** Hands what the CLI produced to Cloud for the person (macConnections.ts); a rejection's message is shown as is. */
    readonly keep: {
      readonly claude: (token: string) => Promise<unknown>;
      readonly chatgpt: (credential: ChatGptCredential) => Promise<unknown>;
    };
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => number;
  }) {
    this.#root = path.join(input.stateDir, CONNECTS_DIR);
    this.#spawn = input.spawn;
    this.#binaries = input.binaries;
    this.#keep = input.keep;
    this.#env = input.env ?? process.env;
    this.#now = input.now ?? Date.now;
    // A connect a restart cut short left its folder: nothing in it is kept.
    fs.rmSync(this.#root, { recursive: true, force: true });
  }

  /** The folder connects are made in: the runtime's own, 0700, never a link. */
  #rootDir() {
    fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("The sign-in couldn't start. Try again.");
    fs.chmodSync(this.#root, 0o700);
    return this.#root;
  }

  /** Hears `engine`'s connect start and end, however it ends (connected, failed, timed out, given up, its CLI gone). */
  onChange(listener: (engine: ConnectEngine) => void) {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #changed(engine: ConnectEngine) {
    for (const listener of this.#listeners) {
      try {
        listener(engine);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** `engine`'s connect that waits for the person's approval now: the request that started it, and when. */
  pending(engine: ConnectEngine): { readonly owner: string; readonly since: number } | undefined {
    const run = this.#running.get(engine);
    return run !== undefined && this.#waits(run)
      ? { owner: run.owner, since: run.since }
      : undefined;
  }

  #waits(run: Running) {
    return run.result.state === "pending" && this.#now() < run.until;
  }

  /**
   * Starts `engine`'s connect for `owner` (the request that asks) and resolves once the CLI shows its page. While one
   * is open any other call is answered that one's page and changes nothing about it, whatever it asks for: only its
   * owner starts it over, by naming it (`restarts`: the owner of the open connect to end first).
   */
  async start(
    engine: ConnectEngine,
    options: { readonly owner: string; readonly deviceCode?: boolean; readonly restarts?: string },
  ): Promise<ConnectPrompt> {
    const open = () => this.#open(engine, options);
    const opening = (this.#opening.get(engine) ?? Promise.resolve()).then(open, open);
    this.#opening.set(engine, opening);
    const run = await opening;
    const first = await run.shown;
    // Its page now: the one `claude` started over on after a code it did not take.
    return run.prompt ?? first;
  }

  /** The connect a call is answered from: the one that is open, or a new one of `owner`'s. */
  async #open(
    engine: ConnectEngine,
    options: { readonly owner: string; readonly deviceCode?: boolean; readonly restarts?: string },
  ): Promise<Running> {
    const open = this.#running.get(engine);
    if (open !== undefined && this.#waits(open) && options.restarts !== open.owner) return open;
    if (open !== undefined) this.#end(engine, open, { state: "failed", why: GAVE_UP });
    const binaries = await this.#binaries();
    const dir = fs.mkdtempSync(path.join(this.#rootDir(), `${engine}-`));
    fs.chmodSync(dir, 0o700);
    const env: NodeJS.ProcessEnv = { HOME: dir, TERM: "xterm-256color" };
    for (const name of PASSED_THROUGH)
      if (this.#env[name] !== undefined) env[name] = this.#env[name];
    const [command, args] =
      engine === "claude-agent"
        ? [binaries.claude, ["setup-token"]]
        : [
            binaries.codex,
            [
              "-c",
              'cli_auth_credentials_store="file"',
              "login",
              ...(options.deviceCode ? ["--device-auth"] : []),
            ],
          ];
    if (engine === "claude-agent") env.CLAUDE_CONFIG_DIR = dir;
    else env.CODEX_HOME = dir;
    let child: LoginProcess;
    try {
      child = await this.#spawn({ command, args, cwd: dir, env });
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(NO_PAGE[engine]);
    }
    const timer = setTimeout(
      () => this.#end(engine, run, { state: "failed", why: TIMED_OUT }),
      CONNECT_MS,
    );
    timer.unref?.();
    let page!: (shown: Promise<ConnectPrompt>) => void;
    const shown = new Promise<ConnectPrompt>((resolve) => (page = resolve));
    // A page that never shows is for its callers to hear: with none left asking, it is no failure of the process's.
    shown.catch(() => undefined);
    const since = this.#now();
    const run: Running = {
      dir,
      process: child,
      owner: options.owner,
      since,
      until: since + CONNECT_MS,
      prompt: undefined,
      shown,
      output: "",
      tail: undefined,
      printedAt: since,
      result: { state: "pending" },
      taking: false,
      settle: undefined,
      stop: () => clearTimeout(timer),
    };
    this.#running.set(engine, run);
    child.onData((data) => {
      if (run.result.state !== "pending" || run.taking) return;
      run.output = (run.output + data).slice(-64 * 1024);
      if (run.tail !== undefined) run.tail = (run.tail + data).slice(-16 * 1024);
      run.printedAt = this.#now();
      const text = run.output.replace(ANSI, "");
      if (run.prompt === undefined)
        run.prompt = this.#promptIn(engine, text, options.deviceCode === true);
      if (engine === "claude-agent") this.#lookForToken(run, text);
    });
    child.onExit((code) => {
      if (run.result.state !== "pending" || run.taking) return;
      if (engine === "claude-agent") {
        // Whatever it printed last is whole now.
        const token = this.#tokenIn(run.output.replace(ANSI, ""), CLAUDE_TOKEN_AT_EXIT);
        return void (token === undefined
          ? this.#end(engine, run, { state: "failed", why: GAVE_UP })
          : this.#takeClaude(run, token));
      }
      void (code === 0
        ? this.#takeCodex(run)
        : Promise.resolve(this.#end(engine, run, { state: "failed", why: GAVE_UP })));
    });
    // codex ends a sign-in by writing its credential; one that keeps running after that is not waited for.
    if (engine === "codex") void this.#watchFile(run);
    page(this.#page(engine, run));
    this.#changed(engine);
    return run;
  }

  /** The page of a connect that just started, once its CLI shows it; one that shows none ends. */
  async #page(engine: ConnectEngine, run: Running): Promise<ConnectPrompt> {
    const shown = await this.#until(
      () => run.prompt !== undefined || run.result.state !== "pending",
      PROMPT_MS,
    );
    if (run.result.state === "connected") return { message: CONNECT_MESSAGE[engine] };
    if (!shown || run.prompt === undefined) {
      const why = run.result.state === "failed" ? run.result.why : NO_PAGE[engine];
      this.#end(engine, run, { state: "failed", why });
      throw new Error(why === GAVE_UP ? NO_PAGE[engine] : why);
    }
    return run.prompt;
  }

  /** The page the CLI printed: its link, and Codex's one-time code when it signs in by device code. */
  #promptIn(engine: ConnectEngine, text: string, deviceCode: boolean): ConnectPrompt | undefined {
    if (engine === "claude-agent") {
      const url = CLAUDE_URL.exec(text)?.[0];
      return url === undefined ? undefined : { url, message: CONNECT_MESSAGE[engine] };
    }
    const url = CODEX_URL.exec(text)?.[0];
    if (url === undefined) return undefined;
    if (!deviceCode) return { url, message: CONNECT_MESSAGE[engine] };
    const code = CODEX_CODE.exec(text)?.[0];
    return code === undefined ? undefined : { url, code, message: DEVICE_CODE_MESSAGE(code) };
  }

  /** The last whole token on the pty, if any. */
  #tokenIn(text: string, form = CLAUDE_TOKEN): string | undefined {
    let found: string | undefined;
    for (const match of text.matchAll(form)) found = match[1];
    return found;
  }

  /** A token is on the pty: it is taken once what `claude` prints under it shows, or nothing more comes for a moment. */
  #lookForToken(run: Running, text: string) {
    const token = this.#tokenIn(text);
    if (token === undefined) return;
    if (run.settle !== undefined) clearTimeout(run.settle);
    if (text.lastIndexOf(AFTER_TOKEN) > text.lastIndexOf(token))
      return void this.#takeClaude(run, token);
    run.settle = setTimeout(() => {
      const now = this.#tokenIn(run.output.replace(ANSI, ""));
      if (now !== undefined) void this.#takeClaude(run, now);
    }, SETTLE_MS);
    run.settle.unref?.();
  }

  /** Hands the token to Cloud. What the pty printed is dropped first: from here on the token is in no buffer of this run. */
  async #takeClaude(run: Running, token: string) {
    if (run.result.state !== "pending" || run.taking) return;
    run.taking = true;
    run.output = "";
    run.tail = undefined;
    if (run.settle !== undefined) clearTimeout(run.settle);
    try {
      run.process.kill();
    } catch {
      // Already gone.
    }
    let result: ConnectResult;
    try {
      await this.#keep.claude(token);
      result = { state: "connected" };
    } catch (error) {
      result = { state: "failed", why: this.#whyNotKept(error) };
    }
    this.#end("claude-agent", run, result);
  }

  /** Reads the credential codex wrote in its private home (never through a link), hands it to Cloud, and the home goes. */
  async #takeCodex(run: Running) {
    if (run.result.state !== "pending" || run.taking) return;
    run.taking = true;
    run.output = "";
    let text: string | undefined;
    try {
      const fd = fs.openSync(
        path.join(run.dir, "auth.json"),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      text = undefined;
    }
    const found = text === undefined ? undefined : parseCodexAuth(text);
    // The home, and the sign-in in it, go before anything else happens: Cloud's copy is the only one from here on.
    fs.rmSync(run.dir, { recursive: true, force: true });
    let result: ConnectResult;
    if (found === undefined)
      result = { state: "failed", why: text === undefined ? GAVE_UP : NOT_A_PLAN };
    else {
      try {
        const { access_token, refresh_token, id_token, expires_at } = found.credential;
        await this.#keep.chatgpt({
          access_token,
          refresh_token,
          ...(id_token ? { id_token } : {}),
          ...(expires_at ? { expires_at } : {}),
        });
        result = { state: "connected" };
      } catch (error) {
        result = { state: "failed", why: this.#whyNotKept(error) };
      }
    }
    this.#end("codex", run, result);
  }

  /** Cloud's own sentence for a refusal (it never repeats a credential), else a plain one. */
  #whyNotKept(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    return message !== "" && !/sk-ant-|eyJ/.test(message) ? message : NOT_KEPT;
  }

  /** The credential landing in the private home, every half second while the sign-in is open. */
  async #watchFile(run: Running) {
    const file = path.join(run.dir, "auth.json");
    while (run.result.state === "pending" && !run.taking && this.#now() < run.until) {
      await new Promise((resolve) => setTimeout(resolve, 500).unref?.());
      if (run.result.state !== "pending" || run.taking) return;
      if (fs.existsSync(file)) {
        // codex writes it in one step; give it a moment to finish its own last writes, then take it.
        await new Promise((resolve) => setTimeout(resolve, 250).unref?.());
        return this.#takeCodex(run);
      }
    }
  }

  /**
   * Waits for the person's approval, up to WAIT_MS. `pasted`: the code Claude's page shows when the browser could not
   * reach this Mac, typed into the CLI (only a `code#state`, nothing a terminal would read as a key). A code `claude`
   * does not take is answered at once, `refused`: `claude` is told to start over, and its new page is the sign-in's.
   */
  async wait(engine: ConnectEngine, pasted = ""): Promise<WaitResult> {
    const run = this.#running.get(engine) ?? this.#ended.get(engine);
    if (run === undefined) return { state: "failed", why: GAVE_UP };
    if (run.result.state !== "pending") return run.result;
    const code = pasted.trim();
    if (code === "") {
      await this.#until(() => run.result.state !== "pending", WAIT_MS);
      return run.result;
    }
    if (engine !== "claude-agent" || !PAGE_CODE.test(code)) throw new Error(NOT_THE_CODE);
    run.tail = "";
    run.process.write(`${code}\r`);
    await this.#until(
      () => run.result.state !== "pending" || this.#refusal(run, code) !== undefined,
      WAIT_MS,
    );
    const refusal = run.result.state === "pending" ? this.#refusal(run, code) : undefined;
    run.tail = undefined;
    if (run.result.state !== "pending") return run.result;
    if (refusal === undefined) return { state: "refused", why: CODE_NOT_TAKEN };
    // Enter: `claude` starts over, on a new page that the line links to from here on.
    run.tail = "";
    run.process.write("\r");
    await this.#until(
      () => run.result.state !== "pending" || this.#newPage(run) !== undefined,
      PROMPT_MS,
    );
    const url = this.#newPage(run);
    run.tail = undefined;
    if (run.result.state !== "pending") return run.result;
    if (url !== undefined) run.prompt = { url, message: CONNECT_MESSAGE[engine] };
    return { state: "refused", why: refusal.why ?? CODE_NOT_TAKEN, ...(url ? { url } : {}) };
  }

  /** What `claude` printed since the paste, as it reads on screen. */
  #tailText(run: Running): string {
    return (run.tail ?? "")
      .replace(CURSOR_RIGHT, (_, n: string) => " ".repeat(Number(n || "1")))
      .replace(ANSI, "");
  }

  /**
   * `claude` did not take the pasted code: it asks for Enter. Its reason, when it gave one that repeats nothing pasted
   * and holds nothing like a credential.
   */
  #refusal(run: Running, code: string): { readonly why: string | undefined } | undefined {
    const text = this.#tailText(run);
    if (!text.includes(CLAUDE_RETRY)) return undefined;
    const said = CLAUDE_REFUSED.exec(text)?.[1]?.trim().slice(0, 400);
    const pastedPart = code.split("#")[0]!;
    return {
      why: said && !said.includes(pastedPart) && !/sk-ant-|eyJ/.test(said) ? said : undefined,
    };
  }

  /**
   * The page `claude` shows after starting over: the last one printed, once it is whole, that is once something
   * follows it or the pty has been quiet a moment. (Ink redraws only the lines that change: what is under the page
   * may never be printed again.)
   */
  #newPage(run: Running): string | undefined {
    const text = this.#tailText(run);
    const found = [...text.matchAll(new RegExp(CLAUDE_URL.source, "g"))].at(-1);
    if (found === undefined) return undefined;
    const followed = found.index + found[0].length < text.length;
    return followed || this.#now() - run.printedAt >= SETTLE_MS ? found[0] : undefined;
  }

  /**
   * Gives `engine`'s open connect up when `owner` started it: the CLI stops and its folder goes. Any other call ends
   * nothing. Answers whether one ended.
   */
  async cancel(engine: ConnectEngine, owner: string): Promise<boolean> {
    // One that is still starting is found once its CLI runs.
    await this.#opening.get(engine)?.catch(() => undefined);
    const run = this.#running.get(engine);
    if (run === undefined || run.owner !== owner) return false;
    this.#end(engine, run, { state: "failed", why: GAVE_UP });
    return true;
  }

  /** The last connect that ended, per engine, so a wait that arrives after it still hears how it ended. */
  readonly #ended = new Map<ConnectEngine, Running>();

  /** Ends a connect: the CLI stops, what the pty printed is dropped, and its folder, with whatever the CLI wrote, is deleted. */
  #end(engine: ConnectEngine, run: Running, result: ConnectResult) {
    if (run.result.state === "pending") run.result = result;
    run.output = "";
    run.tail = undefined;
    if (run.settle !== undefined) clearTimeout(run.settle);
    try {
      run.process.kill();
    } catch {
      // Already gone.
    }
    fs.rmSync(run.dir, { recursive: true, force: true });
    const open = this.#running.get(engine) === run;
    if (open) this.#running.delete(engine);
    this.#ended.set(engine, run);
    run.stop();
    if (open) this.#changed(engine);
  }

  async #until(ready: () => boolean, ms: number) {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }
}
