// A builder on another Cloud computer pushes its branch to GitHub and its lead's computer fetches it to merge
// (session-protocol/builders.ts integrate). A branch that never arrives is left out of the merge for good, so a fetch
// that fails for a moment is tried again before it counts as that. Real runtimes against the stand-in Cloud, whose
// git proxy can be told to refuse its next fetches.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn, userTexts } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { startTools, githubWith, checkoutOf, computerRuntime, delegate } = builderKit(cleanups);

test.skipIf(process.platform === "win32")(
  "a builder's branch the git proxy refuses once is fetched again and merged; while it keeps refusing, a branch that never arrived is left out by name and one merged before stays merged",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    await startTools();
    // 2 vCPU x 4 GiB: one chat a computer, so the lead's builders go to other computers.
    process.env.CAVEMAN_COMPUTER_CPUS = "2";
    process.env.CAVEMAN_COMPUTER_MEMORY_GIB = "4";
    cleanups.push(
      () => (
        delete process.env.CAVEMAN_COMPUTER_CPUS,
        delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB
      ),
    );
    cloud.state.gitBackend = githubWith(
      makeRepo(tempRoot("fetch-source-"), { "README.md": "widgets\n" }),
    );
    const leadComputer = await computerRuntime(
      cloud,
      checkoutOf(cloud.state.gitBackend, "fetch-lead-"),
      "lead",
    );
    const one = await computerRuntime(
      cloud,
      checkoutOf(cloud.state.gitBackend, "fetch-one-"),
      "one",
    );
    const two = await computerRuntime(
      cloud,
      checkoutOf(cloud.state.gitBackend, "fetch-two-"),
      "two",
    );
    const lead = await createReady(leadComputer.client, {
      request_id: "lead",
      repo: { url: "https://github.com/acme/widgets" },
      title: "Lead",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const events: Array<SessionEvent> = [];
    await leadComputer.client.attach(lead.session_id, 0, (event) => events.push(event));
    const summaries = () =>
      userTexts(events).filter((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      );
    const task = (file: string) =>
      `sh: echo ${file} > ${file}.txt && git add -A && git commit -qm "${file}"\nslow 3000: say: wrote ${file}.txt`;
    /** Its builder's chat is on `computer` and at work: what it needed from GitHub to start is fetched. */
    const atWork = (computer: typeof one) =>
      until(
        async () =>
          (await computer.client.call("workspace.list", {})).workspaces.some(
            (w) => w.status === "working",
          ),
        60_000,
      );

    // The first builder: the lead's computer is refused its branch once, asks again, and merges it.
    cloud.state.tree.nextComputers.push(one.identity.computerId);
    await delegate(leadComputer.builders, lead, "k1", "Part one", { task: task("one") });
    await atWork(one);
    cloud.state.gitFetchDown = 1;
    await until(() => summaries().length === 1, 120_000);
    expect(cloud.state.gitFetchDown).toBe(0);
    expect(summaries()[0]).toContain(`1 of 1 branch is merged into ${lead.branch}: Part one.`);
    expect(gitIn(leadComputer.checkout)("log", "--format=%s", "-3")).toContain("one");

    // The second: every fetch is refused from here on. Its branch never arrives, so it is left out, and said so. The
    // first, fetched in an earlier pass, stays merged though its fetch fails now too.
    cloud.state.tree.nextComputers.push(two.identity.computerId);
    await delegate(leadComputer.builders, lead, "k2", "Part two", { task: task("two") });
    await atWork(two);
    cloud.state.gitFetchDown = 1_000;
    await until(() => summaries().length === 2, 180_000);
    expect(summaries()[1]).toContain(`1 of 2 branches are merged into ${lead.branch}: Part one.`);
    expect(summaries()[1]).toContain("Not in: Part two (its branch did not arrive)");
    // Part one's fetch is tried four times (2, 4 and 8 s apart); the proxy is then known not to answer, and Part two's
    // is asked once.
    expect(1_000 - cloud.state.gitFetchDown).toBe(5);
  },
  400_000,
);
