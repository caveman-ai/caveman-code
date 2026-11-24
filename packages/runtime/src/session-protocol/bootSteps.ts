// What a Cloud computer does at every boot, for each clone it holds: its own checkout and its clones of its project's
// other sources (cloud-computers SPEC §6, "Steps"). Setup is baked into the environment the computer was made from
// (lifecycle.ts setupDecision); these keep that current and bring the project's services up:
//
//   on_wake  1. fetch the clone's default branch through Cloud's git proxy, and fast-forward the clone to it where
//               nothing is in the way;
//            2. when a file setup watches changed since the build, [setup].run in the clone, once per commit, so
//               what the chats' worktrees are given from it is current;
//            3. the project's own [on_wake].run.
//   start    [start].run, once the fetch is done: services and dev servers, left running, ended with the runtime.
//
// None of it holds up the runtime's start or its link, and a chat's first message waits for it only where the
// project says so (wait = true), ten minutes at most (firstMessageGate). What goes wrong is logged and kept as a
// line the next chat's boot note carries. Nothing here is fatal: a computer with no network still serves its chats.
// This Mac runs none of it.
import * as fs from "node:fs";
import * as path from "node:path";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SAFE_GIT_CONFIG } from "../automations/steps.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ComputerConfigError, sharedEnv, type ComputerConfig } from "./computerConfig.ts";
import {
  buildMarker,
  git,
  readComputerConfig,
  readSnapshotMarker,
  runScripts,
  setupDecision,
  setupIdentity,
  setupInputsChanged,
  startScript,
  type ScriptResult,
  type StartedScript,
} from "./lifecycle.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

/** The longest a chat's first message waits for a clone's on_wake or start (wait = true); then it starts anyway. */
export const FIRST_MESSAGE_WAIT_MS = 10 * 60_000;
/** How long a [start] command must have run to count as up. */
export const START_UP_MS = 2_000;
/** The longest the fetch at boot is waited for: a computer with no network goes on to start its services. */
const FETCH_TIMEOUT_MS = 60_000;
/** The last of a failed command's output that a note carries. */
const NOTE_TAIL = 600;

/** The kv key holding where the boot steps last ran [setup].run in the clone at `root`: `{ commit, setup }` (the setup's identity then). */
export const installedKey = (root: string) => `boot-steps:installed:${root}`;

export interface BootStepsDeps {
  readonly driver: Git;
  /** Small state kept on the computer's disk across boots (the store's kv). */
  readonly kvGet: (key: string) => Effect.Effect<string | undefined>;
  readonly kvSet: (key: string, value: string) => Effect.Effect<void>;
  /** Brings origin's `branch` to refs/remotes/origin/<branch> in the clone at `root`, through Cloud's git proxy; fails with why. */
  readonly fetch: (root: string, branch: string) => Effect.Effect<void, Error>;
  /**
   * Takes the clone at `root` for the boot steps unless a chat holds it as its own checkout (the computer's first chat
   * works in the clone itself), so that none is placed there meanwhile. False when one holds it.
   */
  readonly hold: (root: string) => Effect.Effect<boolean>;
  readonly release: (root: string) => Effect.Effect<void>;
  /** Commands run to their end, and one started and left running: lifecycle.ts's, unless a test says otherwise. */
  readonly run?: (
    commands: ReadonlyArray<string>,
    cwd: string,
    env: Record<string, string>,
  ) => Promise<ScriptResult>;
  readonly start?: (command: string, cwd: string, env: Record<string, string>) => StartedScript;
  readonly upAfterMs?: number;
  readonly fetchTimeoutMs?: number;
}

/** One thing a chat's first message may wait for (firstMessageGate). */
export interface BootWait {
  /** What it is, as a note names it: "on_wake", "start", with the source's name for another source's clone. */
  readonly what: string;
  readonly done: Effect.Effect<void>;
  readonly isDone: () => boolean;
}

/**
 * Holds a chat's first message until the boot steps its project said to wait for are done, `boundMs` at most. With
 * nothing to wait for (no wait = true, or all of it done already) it answers at once and the message starts as it
 * always did. `late`: what was still running when the bound passed; the message starts anyway and its chat is told.
 */
export const firstMessageGate = (waits: ReadonlyArray<BootWait>, boundMs = FIRST_MESSAGE_WAIT_MS) =>
  Effect.gen(function* () {
    const pending = waits.filter((wait) => !wait.isDone());
    if (pending.length === 0) return { waited: false, late: [] as ReadonlyArray<string> };
    yield* Effect.all(
      pending.map((wait) => wait.done),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeoutOption(boundMs));
    return {
      waited: true,
      late: pending
        .filter((wait) => !wait.isDone())
        .map((wait) => wait.what) as ReadonlyArray<string>,
    };
  });

/**
 * The clone's default branch: the one origin/HEAD names (a clone has it, and so does one ensureCheckout made), else
 * the branch its build's marker names. Undefined when neither says, or says something that is no plain branch name.
 */
export const defaultBranchOf = (driver: Git, root: string) =>
  Effect.gen(function* () {
    const head = yield* git(
      driver,
      root,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { allowNonZeroExit: true },
    );
    const built = readSnapshotMarker(root)?.branch;
    const named =
      head.exitCode === 0 && head.stdout.trim().startsWith("origin/")
        ? head.stdout.trim().slice("origin/".length)
        : typeof built === "string"
          ? built
          : "";
    return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(named) && named !== "HEAD" ? named : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** The last lines of what a command wrote, for a note; "" when it wrote nothing. */
const tailOf = (output: string) => {
  const tail = output.trim().slice(-NOTE_TAIL).trim();
  return tail === "" ? "" : ` It said: ${tail.split("\n").slice(-6).join(" / ")}`;
};
/** What the command that failed wrote, out of runScripts' output (each command's is under a `$ command` line). */
const saidBy = (result: ScriptResult) => {
  const head = `$ ${result.failed}\n`;
  const at = result.output.lastIndexOf(head);
  return tailOf(at < 0 ? result.output : result.output.slice(at + head.length));
};

/** What installedKey holds, read back: undefined for nothing, or anything that is not it. */
const installedAt = (
  value: string | undefined,
): { readonly commit: string; readonly setup: string } | undefined => {
  try {
    const read: unknown = value === undefined ? undefined : JSON.parse(value);
    if (typeof read !== "object" || read === null) return undefined;
    const { commit, setup } = read as { readonly commit?: unknown; readonly setup?: unknown };
    return typeof commit === "string" &&
      /^[0-9a-f]{40,64}$/.test(commit) &&
      typeof setup === "string"
      ? { commit, setup }
      : undefined;
  } catch {
    return undefined;
  }
};

interface Clone {
  readonly root: string;
  /** "" for the computer's own checkout; "<name>: " for its clone of another source. */
  readonly label: string;
  /** What a chat's first message waits for here: the clone's [on_wake].wait and [start].wait. */
  wait: { onWake: boolean; start: boolean };
  readonly onWake: Deferred.Deferred<void>;
  readonly started: Deferred.Deferred<void>;
  readonly done: { onWake: boolean; start: boolean };
  readonly problems: Array<string>;
  readonly running: Set<StartedScript>;
}

export interface BootSteps {
  /**
   * Begins the boot steps for the clone at `root`, in the background. Once per clone per runtime: asked again for
   * the same clone, it does nothing. `name`: the source's name, for another source's clone.
   */
  readonly begin: (root: string, name?: string) => Effect.Effect<void>;
  /** What went wrong at this boot in these clones (every clone when none is named), one sentence each: for a chat's boot note. */
  readonly notes: (roots?: ReadonlyArray<string>) => ReadonlyArray<string>;
  /** What a chat that works in these clones waits for before its first message (firstMessageGate): only what says wait = true. */
  readonly waits: (roots: ReadonlyArray<string>) => ReadonlyArray<BootWait>;
  /** Done once the on_wake steps and the start commands of the clone at `root` have settled; at once for a clone never begun. */
  readonly settled: (root: string) => Effect.Effect<void>;
}

/** A clone's place in the map: its real path, so the checkout named two ways is one clone. */
const keyOf = (root: string) => {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
};

/**
 * The boot steps of one runtime. Scoped: when the scope closes, every command it started and left running is ended.
 */
export const makeBootSteps = (deps: BootStepsDeps) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const { driver } = deps;
    const run = deps.run ?? runScripts;
    const start = deps.start ?? startScript;
    const upAfterMs = deps.upAfterMs ?? START_UP_MS;
    const clones = new Map<string, Clone>();
    let stopping = false;
    // For what a started command's end says, which arrives outside any fiber.
    const fork = Effect.runForkWith(yield* Effect.context<never>());

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        stopping = true;
        const running = [...clones.values()].flatMap((clone) => [...clone.running]);
        for (const one of running) one.stop();
        // Each is given a moment to go: the runtime's own stop never waits on a service that ignores its signal.
        await Promise.race([
          Promise.all(running.map((one) => one.done)),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      }),
    );

    const say = (clone: Clone, problem: string) =>
      Effect.suspend(() => {
        clone.problems.push(`${clone.label}${problem}`);
        return Effect.logWarning(`boot steps, ${clone.root}: ${problem}`);
      });

    /** The clone's computer.toml (or the setup its build ran); null without one, and for one with an error, which is said. */
    const configOf = (clone: Clone): Effect.Effect<ComputerConfig | null> =>
      Effect.suspend(() => {
        try {
          const config = readComputerConfig(clone.root);
          clone.wait = {
            onWake: config?.on_wake.wait === true,
            start: config?.start.wait === true,
          };
          return Effect.succeed(config);
        } catch (error) {
          if (!(error instanceof ComputerConfigError)) throw error;
          const message = error.message;
          return (
            clone.problems.some((problem) => problem.includes(message))
              ? Effect.void
              : say(
                  clone,
                  `computer.toml has an error, so its on_wake and start commands did not run: ${message}.`,
                )
          ).pipe(Effect.as(null));
        }
      });

    const rev = (root: string, ref: string) =>
      git(driver, root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        allowNonZeroExit: true,
      }).pipe(
        Effect.map((r) =>
          r.exitCode === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      );
    const ok = (root: string, args: ReadonlyArray<string>) =>
      git(driver, root, args, { allowNonZeroExit: true }).pipe(
        Effect.map((r) => r.exitCode === 0),
        Effect.orElseSucceed(() => false),
      );

    /**
     * on_wake's first step: origin's default branch fetched, and the clone brought to it where nothing is in the way.
     * The clone's own checkout moves (a fast-forward) only when it is on that branch with no tracked change and no
     * chat holds it; then it stays taken for the install that may follow, and the answer says so. A default branch
     * that is checked out nowhere moves as a ref, so a chat cut from it starts from what was fetched.
     */
    const fetchStep = (clone: Clone) =>
      Effect.gen(function* () {
        const { root } = clone;
        const branch = yield* defaultBranchOf(driver, root);
        if (branch === undefined) {
          yield* say(
            clone,
            "This clone names no default branch (origin/HEAD), so nothing was fetched.",
          );
          return { taken: false };
        }
        const fetched = yield* deps.fetch(root, branch).pipe(
          Effect.timeoutOption(deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS),
          Effect.map((done) => (Option.isSome(done) ? undefined : "it did not answer in time")),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
        if (fetched !== undefined)
          yield* say(
            clone,
            `Could not fetch ${branch} from GitHub, so this computer has it as of its last fetch: ${fetched.trim().replace(/\.$/, "").slice(0, 300)}.`,
          );
        const target = yield* rev(root, `refs/remotes/origin/${branch}`);
        if (target === undefined) return { taken: false };
        const head = yield* git(driver, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          allowNonZeroExit: true,
        }).pipe(
          Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim() : "")),
          Effect.orElseSucceed(() => ""),
        );
        if (head !== branch) {
          // Not the clone's own checkout. Checked out in a chat's worktree: that chat's to move. Nowhere: the ref moves.
          const listed = yield* git(driver, root, ["worktree", "list", "--porcelain"], {
            allowNonZeroExit: true,
          }).pipe(
            Effect.map((r) => r.stdout),
            Effect.orElseSucceed(() => `branch refs/heads/${branch}\n`),
          );
          const local = yield* rev(root, `refs/heads/${branch}`);
          if (
            !listed.split("\n").includes(`branch refs/heads/${branch}`) &&
            local !== undefined &&
            local !== target &&
            (yield* ok(root, ["merge-base", "--is-ancestor", local, target]))
          ) {
            yield* ok(root, ["update-ref", `refs/heads/${branch}`, target, local]);
          }
          return { taken: false };
        }
        if (!(yield* deps.hold(root))) return { taken: false };
        const clean = yield* git(
          driver,
          root,
          [...SAFE_GIT_CONFIG, "status", "--porcelain", "--untracked-files=no"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((r) => r.exitCode === 0 && r.stdout.trim() === ""),
          Effect.orElseSucceed(() => false),
        );
        if (!clean) {
          yield* deps.release(root);
          return { taken: false };
        }
        const at = yield* rev(root, "HEAD");
        // Forward only: a clone that is ahead of GitHub, or beside it, stays as it is.
        if (
          at !== undefined &&
          at !== target &&
          (yield* ok(root, ["merge-base", "--is-ancestor", at, target]))
        ) {
          yield* ok(root, [...SAFE_GIT_CONFIG, "merge", "--ff-only", "-q", target]);
        }
        return { taken: true };
      });

    /**
     * on_wake's second step, in a clone the fetch step took: [setup].run there when a build filled this clone and a
     * file setup watches (or the setup itself) differs between the build's commit and where the clone is now. Once:
     * where it ran is kept (the commit, and the setup's identity), so a later boot runs it again only when a watched
     * file or the setup changed again since.
     */
    const installStep = (clone: Clone, config: ComputerConfig | null) =>
      Effect.gen(function* () {
        const { root } = clone;
        const commands = config?.setup.run ?? [];
        if (config === null || commands.length === 0) return;
        const found = yield* buildMarker(driver, root).pipe(Effect.orElseSucceed(() => undefined));
        if (found?.commit === undefined) return;
        const decision = yield* setupDecision(driver, root, config).pipe(
          Effect.orElseSucceed(() => ({ run: false, marker: false })),
        );
        if (!decision.run) return;
        const at = yield* rev(root, "HEAD");
        if (at === undefined) return;
        const setup = setupIdentity(config);
        const last = yield* deps.kvGet(installedKey(root)).pipe(Effect.map(installedAt));
        if (
          last !== undefined &&
          last.setup === setup &&
          (last.commit === at ||
            ((yield* rev(root, last.commit)) !== undefined &&
              !(yield* setupInputsChanged(driver, root, config, last.commit, at).pipe(
                Effect.orElseSucceed(() => true),
              ))))
        )
          return;
        yield* Effect.logInfo(
          `boot steps, ${root}: a file setup watches changed since the build (${found.commit.slice(0, 7)} to ${at.slice(0, 7)}); running [setup].run here`,
        );
        const result = yield* Effect.promise(() => run(commands, root, sharedEnv(config)));
        if (result.ok) yield* deps.kvSet(installedKey(root), JSON.stringify({ commit: at, setup }));
        else
          yield* say(
            clone,
            `Setup ([setup].run) failed in this computer's clone after a lockfile changed: \`${result.failed}\`.${saidBy(result)}`,
          );
      });

    const onWake = (clone: Clone, started: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        const { taken } = yield* fetchStep(clone).pipe(
          Effect.ensuring(Deferred.succeed(started, undefined)),
        );
        const config = yield* Effect.gen(function* () {
          // Read after the fetch: the clone may have moved to a newer computer.toml.
          const read = yield* configOf(clone);
          if (taken) yield* installStep(clone, read);
          return read;
        }).pipe(Effect.ensuring(taken ? deps.release(clone.root) : Effect.void));
        const commands = config?.on_wake.run ?? [];
        if (commands.length === 0) return;
        const result = yield* Effect.promise(() => run(commands, clone.root, sharedEnv(config)));
        if (!result.ok)
          yield* say(clone, `\`${result.failed}\` ([on_wake]) failed.${saidBy(result)}`);
      });

    /**
     * [start].run, one after another: each is left running, and the next begins once it has exited or has been up
     * for a moment. One that exits with an error is said, whenever it does, and the rest still start.
     */
    const startAll = (clone: Clone) =>
      Effect.gen(function* () {
        // Read once the clone has been fetched, as on_wake reads it: the same file for both.
        const config = yield* configOf(clone);
        // [on_wake].wait: what start brings up may need what on_wake installs.
        if (clone.wait.onWake) yield* Deferred.await(clone.onWake);
        const env = sharedEnv(config);
        for (const command of config?.start.run ?? []) {
          if (stopping) return;
          const began = Date.now();
          const one = start(command, clone.root, env);
          clone.running.add(one);
          const ended = one.done.then((end) => {
            clone.running.delete(one);
            if (end.code !== 0 && !stopping) {
              const problem = `\`${command}\` ([start]) exited with code ${end.code} after ${((Date.now() - began) / 1000).toFixed(1)} s.${tailOf(end.output)}`;
              fork(say(clone, problem));
            }
          });
          yield* Effect.promise(() =>
            Promise.race([ended, new Promise((resolve) => setTimeout(resolve, upAfterMs))]),
          );
        }
      });

    const steps = (clone: Clone) =>
      Effect.gen(function* () {
        const fetched = Deferred.makeUnsafe<void>();
        const finish = (which: "onWake" | "start") =>
          Effect.suspend(() => {
            clone.done[which] = true;
            return Deferred.succeed(which === "onWake" ? clone.onWake : clone.started, undefined);
          });
        // The runtime stopping is no problem to tell a chat about.
        const failed = (what: string) => (cause: Cause.Cause<unknown>) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : say(clone, `${what} stopped on an error of the runtime's own.`).pipe(
                Effect.andThen(Effect.logWarning(`boot steps, ${clone.root}: ${what}`, cause)),
              );
        yield* Deferred.await(fetched).pipe(
          Effect.andThen(startAll(clone)),
          Effect.catchCause(failed("start")),
          Effect.ensuring(finish("start")),
          Effect.forkIn(scope),
        );
        yield* onWake(clone, fetched).pipe(
          Effect.catchCause(failed("on_wake")),
          Effect.ensuring(Deferred.succeed(fetched, undefined)),
          Effect.ensuring(finish("onWake")),
        );
      });

    const begin = (root: string, name = "") =>
      Effect.suspend(() => {
        const key = keyOf(root);
        if (clones.has(key)) return Effect.void;
        const clone: Clone = {
          root,
          label: name === "" ? "" : `${name}: `,
          wait: { onWake: false, start: false },
          onWake: Deferred.makeUnsafe<void>(),
          started: Deferred.makeUnsafe<void>(),
          done: { onWake: false, start: false },
          problems: [],
          running: new Set(),
        };
        clones.set(key, clone);
        // Read here, before anything runs, for what a chat's first message waits for: a chat that starts this instant
        // is held too. Read again once the clone has been fetched.
        // A file that cannot be read at all is the steps' own to report, never the caller's to fail on.
        return configOf(clone).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.andThen(steps(clone).pipe(Effect.forkIn(scope))),
          Effect.asVoid,
        );
      });

    const named = (roots: ReadonlyArray<string> | undefined) =>
      roots === undefined
        ? [...clones.values()]
        : [...new Set(roots.map(keyOf))].flatMap((key) => clones.get(key) ?? []);

    return {
      begin,
      notes: (roots) => named(roots).flatMap((clone) => clone.problems),
      waits: (roots) =>
        named(roots).flatMap((clone) => [
          ...(clone.wait.onWake
            ? [
                {
                  what: `${clone.label}on_wake`,
                  done: Deferred.await(clone.onWake),
                  isDone: () => clone.done.onWake,
                },
              ]
            : []),
          ...(clone.wait.start
            ? [
                {
                  what: `${clone.label}start`,
                  done: Deferred.await(clone.started),
                  isDone: () => clone.done.start,
                },
              ]
            : []),
        ]),
      settled: (root) =>
        Effect.suspend(() => {
          const clone = clones.get(keyOf(root));
          return clone === undefined
            ? Effect.void
            : Effect.all([Deferred.await(clone.onWake), Deferred.await(clone.started)], {
                discard: true,
              });
        }),
    } satisfies BootSteps;
  });
