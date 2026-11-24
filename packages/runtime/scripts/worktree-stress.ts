// Many agents starting on one repository at once, through the runtime's own worktree code (the per-repository lock of
// docs/ §8.3, finding P3). Each agent gets its
// worktree the way a chat does: on This Mac through GitVcsDriver.createWorktree, on a Cloud computer through the git
// helper session-protocol/handlers.ts uses there (lifecycle.git: prune, then worktree add -b, hooks and fsmonitor
// off). Then it runs 10 rounds of edit, commit, checkpoint ref and status with plain git, the
// way an agent's own shell does, which no lock of the runtime's covers.
//
//   node packages/runtime/scripts/worktree-stress.ts <scratch clone> <agents> [--path driver|cloud|both] [--rounds <n>]
//
// Prints one JSON line: wall time, when the first, median and last worktree was ready, and every failure. The
// worktrees go in a new folder beside the clone and stay there. Only ever point it at a scratch clone.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SAFE_GIT_CONFIG } from "../src/automations/steps.ts";
import * as ServerConfig from "../src/config.ts";
import { git as lifecycleGit } from "../src/session-protocol/lifecycle.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";

const [repoArg, agentsArg, ...flags] = process.argv.slice(2);
const flag = (name: string) => {
  const i = flags.indexOf(name);
  return i < 0 ? undefined : flags[i + 1];
};
const agents = Number(agentsArg);
const rounds = Number(flag("--rounds") ?? 10);
const via = flag("--path") ?? "both";
if (
  repoArg === undefined ||
  !Number.isInteger(agents) ||
  agents < 1 ||
  !Number.isInteger(rounds) ||
  !["driver", "cloud", "both"].includes(via)
) {
  console.error(
    "usage: node packages/runtime/scripts/worktree-stress.ts <scratch clone> <agents> [--path driver|cloud|both] [--rounds <n>]",
  );
  process.exit(2);
}
const repo = fs.realpathSync(repoArg);
const checkout = fs.realpathSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
);
if (
  repo === checkout ||
  checkout.startsWith(repo + path.sep) ||
  repo.startsWith(checkout + path.sep)
) {
  console.error(
    `${repo} is the checkout this script runs from. Clone it to a temporary folder and pass that.`,
  );
  process.exit(2);
}

const stamp = `${process.pid}-${Date.now().toString(36)}`;
const worktrees = path.join(path.dirname(repo), `wt-${stamp}`);
fs.mkdirSync(worktrees, { recursive: true });

/** Plain git, as an agent's shell runs it: not the runtime's driver, so outside its locks. */
const shellGit = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (resolve) => {
      execFile("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
      );
    },
  );

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

const program = Effect.gen(function* () {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const started = performance.now();
  const ready: Array<number> = [];
  const worktreeFailures: Array<string> = [];
  const roundFailures: Array<string> = [];

  const agent = (i: number) =>
    Effect.gen(function* () {
      const at = path.join(worktrees, String(i));
      const branch = `caveman/agent-${stamp}-${i}`;
      const onCloudPath = via === "cloud" || (via === "both" && i % 2 === 1);
      // handlers.ts worktreeOnComputer, for a new branch: prune what a crash left, then add.
      const made: Effect.Effect<void, { readonly message: string }> = onCloudPath
        ? lifecycleGit(driver, repo, [...SAFE_GIT_CONFIG, "worktree", "prune"], {
            allowNonZeroExit: true,
          }).pipe(
            Effect.ignore,
            Effect.andThen(
              lifecycleGit(driver, repo, [
                ...SAFE_GIT_CONFIG,
                "worktree",
                "add",
                "-b",
                branch,
                "--",
                at,
                "HEAD",
              ]),
            ),
            Effect.asVoid,
          )
        : driver
            .createWorktree({ cwd: repo, refName: "HEAD", newRefName: branch, path: at })
            .pipe(Effect.asVoid);
      const failure = yield* made.pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed<string | undefined>(error.message)),
      );
      if (failure !== undefined) {
        worktreeFailures.push(`agent ${i} (${onCloudPath ? "cloud" : "driver"}): ${failure}`);
        return;
      }
      ready.push(performance.now() - started);
      yield* Effect.promise(async () => {
        for (let k = 1; k <= rounds; k++) {
          fs.appendFileSync(path.join(at, `agent-notes-${i}.md`), `change ${k} by ${i}\n`);
          const steps: ReadonlyArray<readonly [name: string, args: ReadonlyArray<string>]> = [
            ["add", ["add", "-A"]],
            [
              "commit",
              [
                "-c",
                "user.name=a",
                "-c",
                "user.email=a@a",
                "commit",
                "-qm",
                `agent ${i} step ${k}`,
              ],
            ],
            [
              "update-ref",
              ["update-ref", `refs/caveman/sessions/agent-${stamp}-${i}/turn-${k}`, "HEAD"],
            ],
            ["status", ["status", "--porcelain"]],
          ];
          for (const [name, args] of steps) {
            const result = await shellGit(at, args);
            if (result.code !== 0)
              roundFailures.push(`agent ${i} round ${k} git ${name}: ${firstLine(result.stderr)}`);
          }
        }
      });
    });

  yield* Effect.forEach(
    Array.from({ length: agents }, (_, index) => index + 1),
    agent,
    { concurrency: "unbounded", discard: true },
  );
  const wall = performance.now() - started;

  // What git itself now says: every agent's worktree registered, on its own branch, with nothing uncommitted.
  const listed = (yield* Effect.promise(() => shellGit(repo, ["worktree", "list", "--porcelain"])))
    .stdout;
  const registered = new Map(
    listed
      .split("\n\n")
      .map(
        (entry) =>
          [
            /^worktree (.+)$/m.exec(entry)?.[1],
            /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1],
          ] as const,
      )
      .filter((entry): entry is readonly [string, string | undefined] => entry[0] !== undefined),
  );
  let intact = 0;
  for (let i = 1; i <= agents; i++) {
    const at = path.join(worktrees, String(i));
    if (registered.get(at) !== `caveman/agent-${stamp}-${i}`) continue;
    const status = yield* Effect.promise(() => shellGit(at, ["status", "--porcelain"]));
    if (status.code === 0 && status.stdout === "") intact++;
  }

  ready.sort((a, b) => a - b);
  const seconds = (ms: number | undefined) =>
    ms === undefined ? null : Number((ms / 1000).toFixed(2));
  console.log(
    JSON.stringify({
      agents,
      path: via,
      rounds,
      wall_s: seconds(wall),
      ready_first_s: seconds(ready[0]),
      ready_median_s: seconds(ready[Math.floor(ready.length / 2)]),
      ready_last_s: seconds(ready.at(-1)),
      worktree_failures: worktreeFailures.length,
      round_failures: roundFailures.length,
      registered_clean_on_branch: intact,
      failures: [...worktreeFailures, ...roundFailures].slice(0, 12),
      worktrees,
    }),
  );
  return worktreeFailures.length + roundFailures.length === 0 && intact === agents;
});

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.layerTest(repo, path.join(path.dirname(repo), `runtime-home-${stamp}`)),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const ok = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
process.exit(ok ? 0 : 1);
