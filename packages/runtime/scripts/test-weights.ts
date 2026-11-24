// Rewrites vitest.weights.json from a CI run: every runtime test file's seconds, its setup included, as the "Runtime
// tests" shards of that run took them (each file's time from the one before it in its shard's log). Files the run did
// not report (a shard that failed early, a file added since) keep their weights; files gone from the repo lose theirs.
// Run it on a green run of main when a shard comes near the job's 10 minutes or a heavy file lands:
//
//   node packages/runtime/scripts/test-weights.ts <run id>     (gh run list --workflow ci.yml --branch main)
//
// Needs gh, signed in. vitest.config.ts's WeightedSequencer splits the shards by these weights.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// A file under this many seconds weighs the mean of all such files (defaultSeconds), which keeps the list short.
const LISTED_FROM_SECONDS = 5;

const runId = process.argv[2];
if (!runId || !/^\d+$/.test(runId))
  throw new Error("usage: node packages/runtime/scripts/test-weights.ts <run id>");

const gh = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 30 });

const run = JSON.parse(gh(["run", "view", runId, "--json", "jobs,createdAt"])) as {
  readonly createdAt: string;
  readonly jobs: ReadonlyArray<{ readonly databaseId: number; readonly name: string }>;
};
const shards = run.jobs.filter((job) => job.name.startsWith("Runtime tests"));
if (shards.length === 0) throw new Error(`run ${runId} has no Runtime tests jobs`);

// "2026-11-14T02:20:36.2400299Z  ✓ src/vcs/GitVcsDriverCore.test.ts (294 tests) 94632ms", colours removed.
const fileLine = /^(\S+Z)\s+[✓❯×↓]\s+(\S+\.test\.tsx?)\s+\(\d+ tests?/;
const runLine = /^(\S+Z)\s.*\bRUN\s+v\d/;
const measured = new Map<string, number>();
for (const shard of shards) {
  const log = gh(["api", `repos/{owner}/{repo}/actions/jobs/${shard.databaseId}/logs`]).replace(
    /\x1b\[[0-9;]*m/g,
    "",
  );
  let previous: number | undefined;
  for (const line of log.split(/\r?\n/)) {
    const file = fileLine.exec(line);
    if (file && previous !== undefined) {
      const at = Date.parse(file[1]!);
      measured.set(file[2]!, (at - previous) / 1000);
      previous = at;
      continue;
    }
    const run = previous === undefined ? runLine.exec(line) : null;
    if (run) previous = Date.parse(run[1]!);
  }
}

const path = new URL("../vitest.weights.json", import.meta.url);
const old = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
  readonly about: string;
  readonly defaultSeconds: number;
  readonly files: Readonly<Record<string, number>>;
};
const seconds = new Map<string, number>(Object.entries(old.files));
for (const [file, s] of measured) seconds.set(file, s);
const light = [...measured.values()].filter((s) => s < LISTED_FROM_SECONDS);
const defaultSeconds = light.length
  ? Math.max(1, Math.round(light.reduce((sum, s) => sum + s, 0) / light.length))
  : old.defaultSeconds;
const files = Object.fromEntries(
  [...seconds]
    .filter(
      ([file, s]) =>
        s >= LISTED_FROM_SECONDS && NodeFS.existsSync(new URL(`../${file}`, import.meta.url)),
    )
    .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([file, s]) => [file, Math.round(s)]),
);
const about = old.about.replace(
  /in run \d+ \([^)]*\)/,
  `in run ${runId} (${run.createdAt.slice(0, 10)})`,
);
NodeFS.writeFileSync(path, `${JSON.stringify({ about, defaultSeconds, files }, null, 2)}\n`);
console.log(
  `${measured.size} files measured in ${shards.length} shards; ${Object.keys(files).length} listed, the rest ${defaultSeconds}s`,
);
