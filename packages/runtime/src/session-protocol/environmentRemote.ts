// A repository only on GitHub, drafted without a full clone (docs/ D12): a
// blobless, depth-1 clone that checks out only the manifests the drafter reads, in a temporary directory, drafted
// with no Mac seed and no code search, then deleted, also on failure. Git runs through the driver, as everywhere
// else in the runtime; the clone URL (it may carry a token) never appears in an error.
import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { draftEnvironment, type EnvironmentDraft } from "./environmentDraft.ts";
import { ProtocolError } from "./handlers.ts";
import { DEFAULT_SETUP_INPUTS } from "./lifecycle.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

/**
 * What the checkout holds (gitignore patterns, anchored at the root): every file draftEnvironment reads, and
 * nothing else, so a large repo costs a few kilobytes.
 */
export const DRAFT_SPARSE_PATTERNS: ReadonlyArray<string> = [
  ...DEFAULT_SETUP_INPUTS.map((p) => `/${p}`),
  "/mvnw",
  "/gradlew",
  "/Makefile",
  "/makefile",
  "/justfile",
  "/Justfile",
  "/AGENTS.md",
  "/CLAUDE.md",
  "/.env.example",
  "/.env.sample",
  "/.env.template",
  "/.env.dist",
  "/compose*.yml",
  "/compose*.yaml",
  "/docker-compose*.yml",
  "/docker-compose*.yaml",
  "/Dockerfile*",
  "/dockerfile*",
  "/Containerfile*",
  "/*.Dockerfile",
  "/*.dockerfile",
  "/docker/*ockerfile*",
  "/.docker/*ockerfile*",
  "/.github/workflows/",
  "/.devcontainer/",
  "/.devcontainer.json",
  "/schema.prisma",
  "/prisma/schema.prisma",
];

/** Only URLs a GitHub repo is cloned from (and file:// for tests); never a flag or a remote helper such as ext::. */
const CLONE_URL = /^(https:\/\/|ssh:\/\/|file:\/\/|git@[\w.-]+:)/;

/** A URL's credentials out of text git printed. */
const redact = (text: string) => text.replace(/([a-z][\w+.-]*:\/\/)[^@\s/]+@/gi, "$1");

/** What a failed clone means for the person, from git's stderr; the clone URL never appears. */
export function cloneFailure(repo: string, stderr: string): ProtocolError {
  if (/repository not found|not found|does not appear to be a git repository|could not read username|terminal prompts disabled|returned error: 40[34]/i.test(stderr)) {
    return new ProtocolError({
      reason: "not_found",
      message: `GitHub has no repository ${repo} that this account can read: it doesn't exist, or it's private and the account (or the Caveman GitHub app) has no access to it.`,
    });
  }
  if (/authentication failed|invalid username or password|returned error: 401|permission denied/i.test(stderr)) {
    return new ProtocolError({ reason: "forbidden", message: `GitHub refused the credentials for ${repo}: sign in to GitHub again, then retry.` });
  }
  if (/could not resolve host|failed to connect|connection (timed out|refused|reset)|network is unreachable|timed out|ssl|tls/i.test(stderr)) {
    return new ProtocolError({ reason: "unavailable", message: `Couldn't reach GitHub to read ${repo}; check the connection and retry.` });
  }
  const text = redact(stderr);
  const line = text.split("\n").find((l) => /^(fatal|error):/.test(l.trim())) ?? text.trim().split("\n")[0] ?? "";
  return new ProtocolError({ reason: "internal", message: `Couldn't clone ${repo}${line.trim() ? `: ${line.trim().slice(0, 200)}` : ""}` });
}

export function draftFromGitHub(input: {
  readonly repo: string;
  readonly cloneUrl: string;
  readonly git: Git;
  readonly tempRoot: string;
  readonly offered?: Readonly<Record<string, ReadonlyArray<string>>>;
}): Effect.Effect<EnvironmentDraft, ProtocolError> {
  const { repo, git } = input;
  if (!CLONE_URL.test(input.cloneUrl)) return Effect.fail(new ProtocolError({ reason: "invalid_params", message: `${repo} has no clone URL Caveman can use.` }));
  // No prompt to hang on (a private repo without access fails instead), and LFS pointers stay pointers.
  const env = { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  const run = (step: string, cwd: string, args: ReadonlyArray<string>, options: { stdin?: string; timeoutMs?: number } = {}) =>
    git
      .execute({
        operation: `environment.draft.${step}`,
        cwd,
        args,
        env,
        allowNonZeroExit: true,
        timeoutMs: options.timeoutMs ?? 60_000,
        maxOutputBytes: 1024 * 1024,
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      })
      .pipe(
        Effect.mapError((error) =>
          /timed? ?out/i.test(error.detail)
            ? new ProtocolError({ reason: "unavailable", message: `Reading ${repo} from GitHub took too long (git ${step}).` })
            : new ProtocolError({ reason: "internal", message: `Couldn't run git ${step} for ${repo}: ${redact(error.detail).slice(0, 200)}` }),
        ),
      );
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        fs.mkdirSync(input.tempRoot, { recursive: true });
        return fs.mkdtempSync(path.join(input.tempRoot, "draft-"));
      },
      catch: (error) => new ProtocolError({ reason: "internal", message: `Couldn't make a temporary directory to draft ${repo}: ${(error as Error).message}` }),
    }),
    (dir) =>
      Effect.gen(function* () {
        const checkout = path.join(dir, "repo");
        // Symlinks check out as plain files: a repo's link can't point the drafter outside it.
        const clone = yield* run(
          "clone",
          dir,
          ["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", "--quiet", "--config", "core.symlinks=false", "--", input.cloneUrl, checkout],
          { timeoutMs: 120_000 },
        );
        if (clone.exitCode !== 0) return yield* Effect.fail(cloneFailure(repo, clone.stderr));
        const head = yield* run("rev-parse", checkout, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
        if (head.exitCode !== 0) return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: `${repo} has no commits yet, so there is nothing to draft from.` }));
        const sparse = yield* run("sparse-checkout", checkout, ["sparse-checkout", "set", "--no-cone", "--stdin"], { stdin: `${DRAFT_SPARSE_PATTERNS.join("\n")}\n` });
        if (sparse.exitCode !== 0) {
          return yield* Effect.fail(new ProtocolError({ reason: "internal", message: `Couldn't limit the checkout of ${repo} to its manifests: ${redact(sparse.stderr).trim().slice(0, 200)}` }));
        }
        // Fetches the blobs the patterns name, and only those.
        const files = yield* run("checkout", checkout, ["checkout", "--quiet"], { timeoutMs: 120_000 });
        if (files.exitCode !== 0) return yield* Effect.fail(cloneFailure(repo, files.stderr));
        return yield* Effect.tryPromise({
          try: () => draftEnvironment(checkout, { ...(input.offered !== undefined ? { offered: input.offered } : {}), readCode: false }),
          catch: (error) => new ProtocolError({ reason: "internal", message: `Couldn't draft ${repo}: ${(error as Error).message}` }),
        });
      }),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  );
}
