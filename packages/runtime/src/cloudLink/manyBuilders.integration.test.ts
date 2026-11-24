// The headline check of "many agents, one result" (PLAN §7: "50 agents start on one repo without a failure, and end
// in one pull request"), on one computer that holds them all and across three cells the stand-in Cloud places them on.
// The scenario and its checks are manyBuilders.kit.ts; scripts/many-builders.ts runs the same for timings.
import { execFile } from "node:child_process";

import { afterEach, expect, test } from "vitest";

import { makeRepo, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn } from "./builders.kit.ts";
import { gitProxyEnv } from "./index.ts";
import { manyBuilders } from "./manyBuilders.kit.ts";
import { pushedRefs, startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.skipIf(process.platform === "win32")(
  "the stand-in git proxy takes pushes to caveman/ branches and refuses any other ref whole, as Cloud's does",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    const { startTools, githubWith, checkoutOf, computerRuntime } = builderKit(cleanups);
    await startTools();
    cloud.state.gitBackend = githubWith(
      makeRepo(tempRoot("proxy-source-"), { "README.md": "widgets\n" }),
    );
    const checkout = checkoutOf(cloud.state.gitBackend, "proxy-");
    const computer = await computerRuntime(cloud, checkout, "proxy");
    await until(() => gitProxyEnv(computer.link) !== undefined, 15_000);
    // git as the runtime runs it against GitHub: the proxy in place of github.com, the link's token in a header. Never
    // a blocking call: the proxy it talks to is served by this same process.
    const push = (...refspecs: Array<string>) =>
      new Promise<{ status: number }>((resolve) =>
        execFile(
          "git",
          ["push", "origin", ...refspecs],
          {
            cwd: checkout,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...gitProxyEnv(computer.link) },
          },
          (error) => resolve({ status: error === null ? 0 : 1 }),
        ),
      );
    const bare = gitIn(`${cloud.state.gitBackend}/acme/widgets.git`);
    const git = gitIn(checkout);
    git("commit", "--allow-empty", "-qm", "work");
    const head = git("rev-parse", "HEAD");
    // A caveman/ branch goes through.
    expect((await push("HEAD:refs/heads/caveman/builder-01-abc123")).status).toBe(0);
    expect(bare("rev-parse", "refs/heads/caveman/builder-01-abc123")).toBe(head);
    // The default branch does not, nor a tag, nor a ref beside the branches; and a push naming one of each moves none.
    const main = bare("rev-parse", "refs/heads/main");
    expect((await push("HEAD:refs/heads/main")).status).not.toBe(0);
    expect((await push("HEAD:refs/tags/v1")).status).not.toBe(0);
    expect(
      (await push("HEAD:refs/heads/caveman/builder-02-def456", "HEAD:refs/heads/main")).status,
    ).not.toBe(0);
    expect(bare("rev-parse", "refs/heads/main")).toBe(main);
    expect(bare("for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/caveman/builder-01-abc123\nrefs/heads/main",
    );
    expect(cloud.state.gitRefused).toEqual(["refs/heads/main", "refs/tags/v1", "refs/heads/main"]);
    // What a push says it moves, before its pack (two commands, then the flush).
    const zero = "0".repeat(40);
    const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
    expect(
      pushedRefs(
        Buffer.from(
          `${line(`${zero} ${head} refs/heads/caveman/a\0report-status\n`)}${line(`${zero} ${head} refs/heads/main\n`)}0000PACK...`,
        ),
      ),
    ).toEqual(["refs/heads/caveman/a", "refs/heads/main"]);
  },
  120_000,
);

// Skipped on Windows: Cloud computers are Linux, with tools channels on Unix sockets.
test.skipIf(process.platform === "win32")(
  "a lead fans out 50 builders on one computer: all start, each commits, and one branch and one pull request come of it",
  async () => {
    // 32 vCPUs and 128 GiB: 64 chats (capacity.ts), room for the lead and its fifty.
    const result = await manyBuilders(
      { builders: 50, cells: 1, size: { cpus: 32, gib: 128 } },
      cleanups,
    );
    expect(result.placed).toEqual([50]);
    // Forty-nine are in; the one that never brought its branch up to date is left out, and said so.
    expect([result.merged, result.leftOut]).toEqual([49, 1]);
  },
  1_200_000,
);

test.skipIf(process.platform === "win32")(
  "the same fifty across three cells: the stand-in Cloud places them by capacity, their branches travel through the git proxy, and one pull request comes of it",
  async () => {
    // 16 vCPUs and 36 GiB: 18 chats a computer. The lead's holds it and 17 builders; the other two take the rest.
    const result = await manyBuilders(
      { builders: 50, cells: 3, size: { cpus: 16, gib: 36 } },
      cleanups,
    );
    expect(result.placed).toEqual([17, 18, 15]);
    expect([result.merged, result.leftOut]).toEqual([49, 1]);
  },
  1_200_000,
);
