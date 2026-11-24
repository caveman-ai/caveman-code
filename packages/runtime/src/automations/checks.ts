// Checks the runtime runs after an attempt's agent finishes (SEMANTICS §3.7): command checks in the step's
// workspace with credentials stripped and what they run (package manifests, lockfiles, test and build config,
// files the command names) as it was before the step (SEMANTICS §13 rule 5), then agent checks, whose checker
// sees the step's input, its result and a copy at the step's start commit with the step's commit to read
// through git. The agent never runs its own checks, and never changes what grades it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type PosixShellCommand, posixShellCommand } from "@caveman-app/shared/posixShell";
import * as Effect from "effect/Effect";

import type { ProcessRunner } from "../processRunner.ts";
import { CHECK_TAIL_BYTES } from "./machine.ts";
import { gitOk, type Git, type RunVariables } from "./steps.ts";

export const CHECK_TIMEOUT_MS = 10 * 60_000;

/**
 * Environment variables a check never sees (§3.7): model credentials, gateway keys, anything that pushes or signs
 * in, and cloud, container and package-registry settings. Matched by name, so a new provider's `*_API_KEY` is
 * covered without a list update; any value that is a URL carrying a password (DATABASE_URL) goes too.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const SECRET_PREFIX = /^(AWS_|AZURE_|ARM_|GOOGLE_|GCLOUD_|GCP_|CLOUDSDK_|DOCKER_|KUBE|NPM_CONFIG_|YARN_NPM_|HEROKU_|VERCEL_|NETLIFY_|FLY_|CLOUDFLARE_|DIGITALOCEAN_|GIT_SSH)/i;
const SECRET_EXACT = new Set(["SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS", "SUDO_ASKPASS", "GH_ENTERPRISE_TOKEN", "NETRC", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]);
const ENV_GIT_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^/\s@:]*:[^/\s@]+@/i;

/** Login files and folders, pointed at empty ones in the check's scratch folder. */
const EMPTY_FILES = { AWS_SHARED_CREDENTIALS_FILE: "aws-credentials", AWS_CONFIG_FILE: "aws-config", KUBECONFIG: "kubeconfig", NPM_CONFIG_USERCONFIG: "npmrc", GIT_CONFIG_GLOBAL: "gitconfig" } as const;
const EMPTY_DIRS = { CLOUDSDK_CONFIG: "gcloud", DOCKER_CONFIG: "docker" } as const;
const LOGINS = { ...EMPTY_FILES, ...EMPTY_DIRS };

/** ssh for git with no agent, no keys and no config: nothing a check runs can push or sign in over ssh. */
export const CHECK_GIT_SSH = "ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o IdentityAgent=none -o BatchMode=yes";

/** The runtime's environment with every credential removed, git's credential helpers off, and `gh`, cloud CLIs, docker, kube and npm signed out. */
export function checkEnv(env: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // Git config from the environment goes whole: its values can carry an auth header, and keeping the count while
    // `KEY` in GIT_CONFIG_KEY_<n> strips the key leaves git unable to start.
    const secret = SECRET_NAME.test(name) || SECRET_PREFIX.test(name) || SECRET_EXACT.has(name) || ENV_GIT_CONFIG.test(name) || (value !== undefined && URL_WITH_PASSWORD.test(value));
    // undefined, not absent: the process runner merges into the runtime's own environment, and Node drops undefined values.
    out[name] = secret ? undefined : value;
  }
  // An empty credential.helper clears every configured helper (the keychain's included), so git cannot push.
  return {
    ...out,
    ...emptyLogins(scratch, Object.keys(LOGINS) as Array<keyof typeof LOGINS>),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: CHECK_GIT_SSH,
    // gh reads its login from here: an empty folder signs it out.
    GH_CONFIG_DIR: scratch,
  };
}

/** The person's own git, gh and ssh logins: what a command step keeps that a check never sees. */
const GIT_LOGIN = /^(GIT_|GH_|GITHUB_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|SSH_AUTH_SOCK$|SSH_ASKPASS$)/;

/**
 * A command step's environment (`run`): the person's own command, which grades nothing, so unlike a check it keeps
 * their git, gh and ssh logins and can fetch and push as their terminal would. Model credentials, gateway keys and
 * cloud, container and registry logins still go. Turning the automation on vouches for the command (authorityOf).
 */
export function stepEnv(env: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const secret = !GIT_LOGIN.test(name) && (SECRET_NAME.test(name) || SECRET_PREFIX.test(name) || SECRET_EXACT.has(name) || (value !== undefined && URL_WITH_PASSWORD.test(value)));
    out[name] = secret ? undefined : value;
  }
  const signedOut = (Object.keys(LOGINS) as Array<keyof typeof LOGINS>).filter((name) => name !== "GIT_CONFIG_GLOBAL");
  // No terminal answers a prompt: a login git lacks fails at once instead of hanging until the step's timeout.
  return { ...out, ...emptyLogins(scratch, signedOut), GIT_TERMINAL_PROMPT: "0" };
}

/** The named login files and folders, pointed at the empty ones in scratch. */
const emptyLogins = (scratch: string, names: ReadonlyArray<keyof typeof LOGINS>) => Object.fromEntries(names.map((name) => [name, path.join(scratch, LOGINS[name])]));

/** The empty login files and folders checkEnv and stepEnv point at. */
function makeScratch(): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-check-"));
  for (const rel of Object.values(EMPTY_FILES)) fs.writeFileSync(path.join(scratch, rel), "");
  for (const rel of Object.values(EMPTY_DIRS)) fs.mkdirSync(path.join(scratch, rel));
  return scratch;
}

// ------------------------------------------------------------------ what a check runs (rule 5)

/** Manifests, lockfiles and build or test entry points, by file name anywhere in the tree. */
const ENTRY_NAMES = new Set(
  [
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc", ".yarnrc", ".yarnrc.yml",
    "deno.json", "deno.jsonc", "turbo.json", "nx.json", "lerna.json", ".nvmrc", ".node-version", ".tool-versions",
    "pyproject.toml", "setup.py", "setup.cfg", "pipfile", "pipfile.lock", "poetry.lock", "uv.lock", "tox.ini", "noxfile.py", "pytest.ini", "conftest.py", ".coveragerc",
    "cargo.toml", "cargo.lock", "go.mod", "go.sum", "gemfile", "gemfile.lock", "rakefile", ".rspec", "composer.json", "composer.lock", "phpunit.xml", "phpunit.xml.dist",
    "makefile", "gnumakefile", "justfile", "taskfile.yml", "taskfile.yaml", "cmakelists.txt", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
    "gradlew", "mvnw", "build.sbt", "mix.exs", "dune-project", ".pre-commit-config.yaml",
  ].map((n) => n.toLowerCase()),
);
const ENTRY_PATTERNS: ReadonlyArray<RegExp> = [
  /^(vitest|vite|jest|playwright|babel|webpack|rollup|esbuild|eslint|prettier|karma|cypress|mocha|ava|next|nuxt|svelte|astro|tsup|wdio)\.(config|workspace)(\.[a-z]+)*$/i,
  /^tsconfig[^/]*\.json$/i,
  /^jsconfig[^/]*\.json$/i,
  /^\.(babelrc|mocharc|eslintrc|swcrc)(\..+)?$/i,
  /^jest\.(setup|preset)[^/]*$/i,
  /^requirements[^/]*\.(txt|in)$/i,
];

export const isEntryPoint = (file: string): boolean => {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return ENTRY_NAMES.has(base.toLowerCase()) || ENTRY_PATTERNS.some((p) => p.test(base));
};

const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "node", "deno", "bun", "tsx", "ts-node", "python", "python3", "ruby", "perl", "php", "pwsh", "rscript", "source", ".", "make", "just"]);
const WRAPPERS = new Set(["exec", "time", "env", "nice", "nohup", "xargs", "timeout", "npx", "pnpm", "yarn", "npm", "uv", "poetry"]);
const repoPath = (token: string) => {
  const t = path.posix.normalize(token.replace(/^\.\//, ""));
  return t.startsWith("../") || path.posix.isAbsolute(t) || t === "." || t.includes("://") || t.startsWith("$") ? undefined : t;
};

/**
 * Repo-relative files a command runs: a program named by path (`./scripts/test.sh`), or the script an interpreter
 * is given (`sh check.sh`, `node test/run.mjs`, `make -f ci.mk`). Files it only reads (`grep 42 answer.txt`) are
 * the work being checked, not what checks it.
 */
export function namedFiles(command: string): string[] {
  const found: string[] = [];
  for (const simple of command.split(/[;&|\n()]+/)) {
    const words = simple.match(/'[^']*'|"[^"]*"|\S+/g)?.map((w) => w.replace(/^['"]|['"]$/g, "")) ?? [];
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || WRAPPERS.has(words[i]!.toLowerCase()) || (i > 0 && WRAPPERS.has(words[i - 1]!.toLowerCase()) && words[i]!.startsWith("-")))) i++;
    const program = words[i];
    if (program === undefined) continue;
    if (INTERPRETERS.has(program.toLowerCase())) {
      for (let j = i + 1; j < words.length; j++) {
        const w = words[j]!;
        if (w === "-c") {
          if (words[j + 1] !== undefined) found.push(...namedFiles(words[j + 1]!));
          break;
        }
        if (w === "-f" || w === "--file" || w === "--makefile") continue;
        if (w.startsWith("-")) continue;
        const file = repoPath(w);
        if (file !== undefined && (w.includes("/") || w.includes(".") || program === "make")) found.push(file);
        break;
      }
    } else if (program.includes("/")) {
      const file = repoPath(program);
      if (file !== undefined) found.push(file);
    }
  }
  return found;
}

interface HeldFile {
  readonly path: string;
  readonly kind: "file" | "link" | "absent";
  readonly mode?: number;
  readonly link?: string;
}
const HELD_MANIFEST = "held.json";

/**
 * Puts back a link the step made. Windows makes a symlink only in Developer Mode or as an administrator (EPERM
 * otherwise): there a link to a folder comes back as a junction, which needs neither, and any other as a small
 * file holding the link's text, as Git for Windows checks out a link it cannot make. Never a copy of the target:
 * a file outside the checkout must not land in the step's work.
 */
export function putBackLink(link: string, at: string, symlink: (target: string, at: string) => void = fs.symlinkSync): void {
  try {
    symlink(link, at);
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    const target = path.resolve(path.dirname(at), link);
    if (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) fs.symlinkSync(target, at, "junction");
    else fs.writeFileSync(at, link.replaceAll("\\", "/"));
  }
}

/** Puts back the step's own versions a check set aside (also after a restart left them aside), then forgets them. */
export function putBackHeld(held: string, cwd: string): void {
  let entries: HeldFile[] = [];
  try {
    entries = JSON.parse(fs.readFileSync(path.join(held, HELD_MANIFEST), "utf8")) as HeldFile[];
  } catch {
    fs.rmSync(held, { recursive: true, force: true });
    return;
  }
  entries.forEach((entry, i) => {
    const at = path.join(cwd, entry.path);
    fs.rmSync(at, { recursive: true, force: true });
    if (entry.kind === "absent") return;
    fs.mkdirSync(path.dirname(at), { recursive: true });
    if (entry.kind === "link") putBackLink(entry.link!, at);
    else {
      fs.copyFileSync(path.join(held, String(i)), at);
      fs.chmodSync(at, entry.mode ?? 0o644);
    }
  });
  fs.rmSync(held, { recursive: true, force: true });
}

/**
 * Rule 5 (F-2): before a command check runs in a step's workspace, every entry point the step changed since
 * `start` (manifests, lockfiles, test and build config, files the command names) goes back to its version at
 * `start`; the step's own versions wait in `held` and `putBack` returns them. `refused` names a file that could
 * not be put back to its old version, so the check must not run.
 */
export const holdEntryPoints = (git: Git, input: { readonly cwd: string; readonly start: string; readonly command: string; readonly held: string }) =>
  Effect.gen(function* () {
    putBackHeld(input.held, input.cwd);
    // Staged, so files the step added count too (ignored files, such as installed dependencies, never do).
    yield* gitOk(git, input.cwd, ["add", "-A"]);
    const listed = yield* git(input.cwd, ["diff", "--cached", "-z", "--no-renames", "--name-only", input.start]);
    const named = new Set(namedFiles(input.command));
    const changed = (listed.code === 0 ? listed.stdout.split("\0") : []).filter((f) => f.length > 0 && (isEntryPoint(f) || named.has(f)));
    if (changed.length === 0) return { restored: [] as string[], refused: undefined as string | undefined };
    // A file the step turned into a folder can't be set aside whole: refused before anything moves.
    const folder = changed.find((file) => fs.lstatSync(path.join(input.cwd, file), { throwIfNoEntry: false })?.isDirectory() === true);
    if (folder !== undefined) return { restored: [] as string[], refused: folder };
    fs.mkdirSync(input.held, { recursive: true });
    const entries: HeldFile[] = changed.map((file, i) => {
      const at = path.join(input.cwd, file);
      const stat = fs.lstatSync(at, { throwIfNoEntry: false });
      if (stat === undefined) return { path: file, kind: "absent" };
      if (stat.isSymbolicLink()) return { path: file, kind: "link", link: fs.readlinkSync(at) };
      fs.copyFileSync(at, path.join(input.held, String(i)));
      return { path: file, kind: "file", mode: stat.mode & 0o777 };
    });
    fs.writeFileSync(path.join(input.held, HELD_MANIFEST), JSON.stringify(entries));
    for (const file of changed) {
      const existed = (yield* git(input.cwd, ["cat-file", "-e", `${input.start}:${file}`])).code === 0;
      const back = existed
        ? (yield* git(input.cwd, ["checkout", input.start, "--", file])).code === 0
        : (() => {
            try {
              fs.rmSync(path.join(input.cwd, file), { recursive: true, force: true });
              return true;
            } catch {
              return false;
            }
          })();
      if (!back) return { restored: changed, refused: file };
    }
    return { restored: changed, refused: undefined as string | undefined };
  });

/** What a check's record says about the entry points it ran with. */
export const heldNote = (restored: ReadonlyArray<string>): string =>
  restored.length === 0
    ? ""
    : `[This check ran with ${restored.slice(0, 6).join(", ")}${restored.length > 6 ? ` and ${restored.length - 6} more` : ""} as before the step: a step never changes what grades it. The step's own versions stay in its change.]\n`;

/** The record of a check that could not run with the old version of a file it depends on. */
export const refusedText = (file: string): string => `The step changed ${file}, which this check runs; checks use the version from before the step, and it could not be put back.`;

export interface CommandCheckResult {
  readonly passed: boolean;
  /** Absent when the command did not finish (its 10 minutes ran out). */
  readonly exit?: number;
  readonly ms: number;
  /** The last 8 KiB of stdout and stderr together. */
  readonly tail: string;
}

/** The last `max` bytes seen, kept as chunks arrive. */
function tailKeeper(max: number) {
  let kept = Buffer.alloc(0);
  return {
    push: (chunk: Uint8Array) => {
      kept = Buffer.concat([kept, Buffer.from(chunk)]);
      if (kept.length > max) kept = kept.subarray(kept.length - max);
    },
    text: () => kept.toString("utf8").replace(/^�+/, ""),
  };
}

interface CommandInput {
  readonly command: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The run's own variables, on top of `env`. */
  readonly variables?: RunVariables;
}

/** A check's command: `checkEnv`, 10 minutes at most. */
export const runCommandCheck = (runner: ProcessRunner["Service"], input: CommandInput) => runCommand(runner, { ...input, what: "check", envOf: checkEnv, timeoutMs: CHECK_TIMEOUT_MS });

/** A command step's command (`run`): `stepEnv`, for as long as the step may take. */
export const runCommandStep = (runner: ProcessRunner["Service"], input: CommandInput & { readonly timeoutMs: number }) =>
  runCommand(runner, { ...input, what: "command", envOf: stepEnv });

/** Failures common enough to name, each with what to do about it; the first that matches the output wins. */
const COMMAND_CAUSES: ReadonlyArray<{ readonly when: RegExp; readonly exit?: number; readonly say: (m: RegExpMatchArray) => string }> = [
  {
    when: /could not read (?:Username|Password) for '(?:https?:\/\/)?([^'/]+)|Authentication failed for '(?:https?:\/\/)?([^'/]+)/,
    say: (m) =>
      `Git couldn't sign in to ${m[1] ?? m[2]}. The command uses your own git login: sign in once in Terminal (\`gh auth login\`, then \`gh auth setup-git\`), then run it again.`,
  },
  { when: /Permission denied \(publickey\)/, say: () => "Git couldn't sign in over ssh: your ssh agent has no key this host accepts. Add one with `ssh-add`, then run it again." },
  { when: /Could not resolve host:? '?([\w.-]+)|Network is unreachable/, say: (m) => `There was no network${m[1] ? `: ${m[1]} could not be reached` : ""}. Run it again once you are online.` },
  { when: /No space left on device/, say: () => "The disk is full. Free some space, then run it again." },
  {
    when: /([\w./-]+): (?:command )?not found/,
    exit: 127,
    say: (m) => `\`${m[1]}\` isn't installed, or isn't on the PATH Caveman Code sees. Install it, or write its full path in the command.`,
  },
];

/** A failed command step in plain words: what most likely went wrong and what to do, then the last lines it printed. */
export function commandFailure(result: CommandCheckResult, timeoutMs: number): string {
  // A timeout is said once, up front, not again as the output's last line.
  const output = result.tail.replace(/\[The command ran out of its \d+ minutes and was stopped\.\]\s*$/, "").trim();
  const named = COMMAND_CAUSES.filter((c) => c.exit === undefined || c.exit === result.exit)
    .map((c) => ({ c, m: output.match(c.when) }))
    .find((x) => x.m !== null);
  const what =
    result.exit === undefined
      ? `It ran past its ${Math.round(timeoutMs / 60_000)}-minute timeout and was stopped. Raise \`timeout:\` on the step if it needs longer.`
      : named !== undefined
        ? named.c.say(named.m!)
        : `It stopped with exit code ${result.exit}.`;
  const last = output.split("\n").slice(-COMMAND_FAILURE_LINES).join("\n");
  return last === "" ? what : `${what}\n\nThe end of its output:\n${last}`;
}
const COMMAND_FAILURE_LINES = 12;

/** `sh -c <command>` (Git Bash on Windows) at the workspace root, stdout and stderr as one stream. */
const runCommand = (
  runner: ProcessRunner["Service"],
  input: CommandInput & { readonly what: string; readonly envOf: (env: NodeJS.ProcessEnv, scratch: string) => NodeJS.ProcessEnv; readonly timeoutMs: number },
) =>
  Effect.gen(function* () {
    const tail = tailKeeper(CHECK_TAIL_BYTES);
    const started = Date.now();
    // stderr joins stdout so the tail keeps both in the order they were written.
    let shell: PosixShellCommand;
    try {
      shell = posixShellCommand(`exec 2>&1\n${input.command}`);
    } catch (error) {
      return { passed: false, exit: 127, ms: Date.now() - started, tail: (error as Error).message } satisfies CommandCheckResult;
    }
    const scratch = makeScratch();
    const result = yield* runner
      .run({
        command: shell.command,
        args: [...shell.args],
        cwd: input.cwd,
        // [env] goes through the same strip as the runtime's own environment: the repository writes it. What the
        // runtime set for the run goes on after: none of it is a login, though the strip would take some for one
        // (AGENT_BROWSER_SESSION by its name; the run's own service URLs by their password, which is the fixed
        // development one of a service on this computer's loopback, for a database and an index that are the run's alone).
        env: { ...input.envOf({ ...(input.env ?? process.env), ...input.variables?.env }, scratch), ...input.variables?.own },
        timeout: input.timeoutMs,
        timeoutBehavior: "timedOutResult",
        onStdoutChunk: tail.push,
        maxOutputBytes: CHECK_TAIL_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((r) => ({ code: r.timedOut ? undefined : Number(r.code ?? 1), timedOut: r.timedOut })),
        Effect.catch((error) => Effect.sync(() => (tail.push(Buffer.from(`\n${error.message}`)), { code: 127, timedOut: false }))),
        Effect.ensuring(Effect.sync(() => fs.rmSync(scratch, { recursive: true, force: true }))),
      );
    const ms = Date.now() - started;
    const text = result.timedOut ? `${tail.text()}\n[The ${input.what} ran out of its ${Math.round(input.timeoutMs / 60_000)} minutes and was stopped.]` : tail.text();
    return {
      passed: result.code === 0,
      ...(result.code === undefined ? {} : { exit: result.code }),
      ms,
      tail: text,
    } satisfies CommandCheckResult;
  });

/**
 * What an agent check's checker is told about the change it reviews (§3.7). Its checkout is a copy at the step's
 * start commit, so files the step changed (AGENTS.md, engine settings) never steer the checker: the change is read
 * through git.
 */
export function reviewMessage(input: { readonly step: string; readonly start: string | null; readonly sha: string | null; readonly tests?: string }): string {
  if (input.sha === null || input.start === null) return `Review the result of the ${input.step} step in the data blocks. It changed no files.`;
  return [
    `Review the change the ${input.step} step made: \`git diff ${input.start}..${input.sha}\` (or \`git show ${input.sha}\`) in this checkout.`,
    `The checkout is a copy at the commit before the step, so the step's changes are not in its files: read them through git. Whatever you change in the copy is discarded.`,
    ...(input.tests ? [input.tests] : []),
  ].join(" ");
}
