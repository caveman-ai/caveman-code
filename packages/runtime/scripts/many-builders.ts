// "Many agents, one result", run for its timings: a lead fans out builders on one repository through real runtimes
// (the stand-in Claude CLI, real git, the stand-in Cloud and its git proxy), and one branch and one pull request come
// of it. The scenario and every check are src/cloudLink/manyBuilders.kit.ts, which the integration test runs too.
//
//   node packages/runtime/scripts/many-builders.ts [--builders 50] [--cells 1|3] [--runs 3]
//
// One computer: 32 vCPUs and 128 GiB, which holds 64 chats. Three cells: 16 vCPUs and 36 GiB each, 18 chats a cell.
// Prints one JSON line a run: when all had started, how long the integration took after the builders finished, and
// where the builders were placed. Everything it makes is under the system's temp folder.
import { manyBuilders } from "../src/cloudLink/manyBuilders.kit.ts";

const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? fallback : Number(process.argv[at + 1]);
  if (!Number.isInteger(value) || value < 1) {
    console.error(
      "usage: node packages/runtime/scripts/many-builders.ts [--builders 50] [--cells 1|3] [--runs 3]",
    );
    process.exit(2);
  }
  return value;
};
const builders = flag("--builders", 50);
const cells = flag("--cells", 1);
const runs = flag("--runs", 1);
const size = cells === 1 ? { cpus: 32, gib: 128 } : { cpus: 16, gib: 36 };

let failed = false;
for (let run = 1; run <= runs; run++) {
  const cleanups: Array<() => unknown> = [];
  try {
    const result = await manyBuilders(
      { builders, cells, size, log: (line) => console.error(`run ${run}: ${line}`) },
      cleanups,
    );
    console.log(
      JSON.stringify({
        run,
        builders,
        cells,
        start_all_ms: result.startAllMs,
        integrate_ms: result.integrateMs,
        total_ms: result.totalMs,
        merged: result.merged,
        left_out: result.leftOut,
        placed: result.placed,
        pull_request: result.pullRequest.number,
      }),
    );
  } catch (error) {
    failed = true;
    console.log(
      JSON.stringify({
        run,
        builders,
        cells,
        failed: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    for (const cleanup of cleanups.splice(0).reverse())
      await Promise.resolve(cleanup()).catch(() => undefined);
  }
}
process.exit(failed ? 1 : 0);
