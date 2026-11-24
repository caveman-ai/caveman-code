// Runs oxlint over one fixture with only the named rule on, through the current Node binary (oxlint's bin is a
// shebang script Windows cannot spawn), .ts does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const oxlintBin = NodePath.join(
  NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);
const pluginPath = NodePath.join(import.meta.dirname, "..", "index.ts");

export interface LintResult {
  readonly failed: boolean;
  readonly output: string;
}

export function lintFixture(rule: string, source: string, filename = "fixture.tsx"): LintResult {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-oxlint-"));
  try {
    const config = NodePath.join(dir, ".oxlintrc.json");
    NodeFS.writeFileSync(
      config,
      JSON.stringify({
        jsPlugins: [pluginPath],
        categories: { correctness: "off" },
        rules: { [rule]: "error" },
      }),
    );
    const file = NodePath.join(dir, filename);
    NodeFS.writeFileSync(file, source);
    const run = NodeChildProcess.spawnSync(
      process.execPath,
      [oxlintBin, "--config", config, file],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
    if (run.error) throw run.error;
    return { failed: run.status !== 0, output: `${run.stdout}${run.stderr}` };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
