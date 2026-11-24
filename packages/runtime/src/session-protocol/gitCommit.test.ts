// git.commit on the real runtime runs the repository's own commit hooks, which can take longer than git's generic
// 30 s budget (husky with lint-staged and tsc, say): the commit gets the time a commit through GitManager gets.
import * as fs from "node:fs";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-git-commit-");
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("git.commit lets a pre-commit hook that runs past 30 s finish, and the commit lands", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const hooks = path.join(root, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nsleep 31\n", { mode: 0o755 });
  git(repo, "config", "core.hooksPath", hooks);
  const w = await client.call("workspace.create", {
    request_id: "slow-hook",
    repo: { path: repo },
    title: "Slow hook",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(() => fs.existsSync(w.root_path!));
  fs.writeFileSync(path.join(w.root_path!, "work.md"), "agent work\n");

  const commit = await client.call("git.commit", {
    request_id: "c",
    workspace_id: w.id,
    message: "feat: agent work",
  });
  expect(git(w.root_path!, "log", "-1", "--format=%H %s").trim()).toBe(
    `${commit.sha} feat: agent work`,
  );
}, 90_000);
