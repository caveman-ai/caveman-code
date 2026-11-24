// ), apps/server/vite.config.ts (test block) @ ab3a3cd1.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

import baseConfig from "../../vitest.config.ts";

/**
 * CI runs this suite in shards (ci.yml). Vitest's own split hashes file paths, and once put the heaviest files
 * (moveEngines.e2e, chaos, the replay fixtures) in one shard: 23 minutes of tests against 8 and 10 in the others.
 * This split goes by measured time (vitest.weights.json): heaviest first, each file to the lightest shard so far, ties
 * by path, so every job computes the same split. Order within a shard stays vitest's.
 */
const weights = JSON.parse(NodeFS.readFileSync(new URL("./vitest.weights.json", import.meta.url), "utf8")) as {
  readonly defaultSeconds: number;
  readonly files: Readonly<Record<string, number>>;
};
class WeightedSequencer extends BaseSequencer {
  override async shard(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const { index, count } = this.ctx.config.shard!;
    const root = this.ctx.config.root;
    const weighed = files
      .map((spec) => {
        const file = NodePath.relative(root, spec.moduleId).split(NodePath.sep).join("/");
        return { spec, file, seconds: weights.files[file] ?? weights.defaultSeconds };
      })
      .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const load = Array.from({ length: count }, () => 0);
    const mine: Array<TestSpecification> = [];
    for (const { spec, seconds } of weighed) {
      const lightest = load.indexOf(Math.min(...load));
      load[lightest]! += seconds;
      if (lightest === index - 1) mine.push(spec);
    }
    return mine;
  }
}

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Appended to the root setup, which mergeConfig concatenates.
      setupFiles: [
        NodeURL.fileURLToPath(new URL("./src/testUtils/gitConfig.setup.ts", import.meta.url)),
      ],
 // upstream suite runs on Linux. On macOS the temp dir is a symlink
      // (/var -> /private/var), and realpath-based guards then disagree with
      // the paths the tests build. Hand the tests the resolved directory.
      // DISABLE_AUTOUPDATER: Claude Code's own opt-out, which the runtime honours (session-protocol/engineUpdates.ts).
      // Every test runtime's stand-in Claude Code reports a version older than the current models, so each would run
      // its updater and probe again: extra processes on every runtime, which on Windows held worktrees open.
      env: { TMPDIR: NodeFS.realpathSync(NodeOS.tmpdir()), DISABLE_AUTOUPDATER: "1" },
      hookTimeout: 120_000,
      testTimeout: 120_000,
      sequence: { sequencer: WeightedSequencer },
    },
  }),
);
